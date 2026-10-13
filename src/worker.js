// Naksara · Cloudflare Worker
// - Uygulama dosyalarını (statik) şifre korumalı sunar
// - Finans ve stok verisini D1 veritabanında saklar, cihazlar arasında eşitler
// - Her kaydın sürüm geçmişini tutar (yedek / geri dönüş)

const DOCS = { finance: 20_000_000, stock: 40_000_000 }; // belge başına azami boyut (karakter)
const CHUNK = 400_000;            // D1 satır sınırı 2 MB → güvenli parça boyu
const KEEP_RECENT = 60;           // son N kaydın tam içeriği saklanır
const KEEP_DAILY_DAYS = 365;      // günlük anlık görüntüler bu kadar gün saklanır
const KEEP_CONFLICT_DAYS = 120;   // çakışma kopyaları
const SESSION_DAYS = 90;
const PBKDF2_ITER = 20_000;
const TZ_OFFSET = 3 * 3600_000;   // Europe/Istanbul (UTC+3, yaz saati yok)
const DAY = 86400_000;

const enc = new TextEncoder();

// ---------- yardımcılar ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Robots-Tag': 'noindex, nofollow',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra },
  });
}

// ---------- ayarlar (isolate içinde 60 sn önbellek) ----------
let settingsCache = null;
let settingsAt = 0;
async function settings(env, fresh = false) {
  if (!fresh && settingsCache && Date.now() - settingsAt < 60_000) return settingsCache;
  let rows = (await env.DB.prepare("SELECT k, v FROM settings WHERE k IN ('session_secret','session_ver','pw_hash')").all()).results;
  let s = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  if (!s.session_secret || !s.session_ver) {
    const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('session_secret', ?)").bind(secret),
      env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('session_ver', '1')"),
    ]);
    rows = (await env.DB.prepare("SELECT k, v FROM settings WHERE k IN ('session_secret','session_ver','pw_hash')").all()).results;
    s = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  }
  settingsCache = s;
  settingsAt = Date.now();
  return s;
}

const hmacKeys = new Map();
async function hmac(secret, msg) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', unhex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, key);
  }
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function pbkdf2(password, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: iter }, key, 256));
}
async function checkPassword(s, password) {
  if (!s.pw_hash || typeof password !== 'string' || !password) return false;
  const [algo, iter, salt, hash] = s.pw_hash.split('$');
  if (algo !== 'pbkdf2-sha256') return false;
  return safeEqual(await pbkdf2(password, salt, Number(iter)), hash);
}
async function makePasswordHash(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2-sha256$${PBKDF2_ITER}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}

async function sessionCookie(s) {
  const exp = Date.now() + SESSION_DAYS * DAY;
  const payload = `${exp}.${s.session_ver}`;
  const val = `${payload}.${await hmac(s.session_secret, payload)}`;
  return `nks=${val}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
async function authed(req, env) {
  const v = cookies(req).nks;
  if (!v) return false;
  const parts = v.split('.');
  if (parts.length !== 3) return false;
  const [exp, ver, sig] = parts;
  if (!(Number(exp) > Date.now())) return false;
  let s = await settings(env);
  if (ver !== s.session_ver) {
    s = await settings(env, true);
    if (ver !== s.session_ver) return false;
  }
  return safeEqual(sig, await hmac(s.session_secret, `${exp}.${ver}`));
}

// ---------- giriş sayfası ----------
function loginPage(msg = '', status = 200) {
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f4f6f9"><meta name="robots" content="noindex"><title>Naksara • Giriş</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#f4f6f9;color:#1c2632;font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
form{width:100%;max-width:360px;background:#fff;border:1px solid #e4e8ee;border-radius:16px;padding:28px;box-shadow:0 1px 2px #1c26320a,0 6px 18px #1c26320a}
.b{display:flex;align-items:center;gap:10px;margin-bottom:22px}.l{width:38px;height:38px;border-radius:10px;background:#1f6b74;color:#fff;display:grid;place-items:center;font-weight:800}
.b b{display:block;letter-spacing:.06em}.b small{color:#6b7684}label{display:block;font-weight:600;font-size:13px;margin-bottom:6px}
input{width:100%;border:1px solid #d6dde6;border-radius:10px;padding:11px 12px;font:inherit}input:focus{outline:0;border-color:#1f6b74;box-shadow:0 0 0 3px #1f6b7438}
button{margin-top:14px;width:100%;border:0;border-radius:10px;background:#1f6b74;color:#fff;padding:12px;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#16545b}
.e{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#fcecee;color:#c2394a;font-size:13px}.n{margin:14px 0 0;color:#6b7684;font-size:12px}
@media(prefers-color-scheme:dark){body{background:#11161c;color:#e6ebf0}form{background:#1a2129;border-color:#2a333d}input{background:#11161c;color:#e6ebf0;border-color:#2f3a46}.b small,.n{color:#93a0ad}}
</style></head><body><form method="post" action="/login"><div class="b"><span class="l">N</span><div><b>NAKSARA</b><small>Finans & Performans</small></div></div>
${msg ? `<p class="e" role="alert">${msg}</p>` : ''}<label for="p">Şifre</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus maxlength="200">
<button type="submit">Giriş yap</button><p class="n">Bu cihazda ${SESSION_DAYS} gün oturum açık kalır.</p></form></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS },
  });
}

async function handleLogin(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const lock = await env.DB.prepare('SELECT n, until, last FROM login_fail WHERE ip = ?').bind(ip).first();
  if (lock && lock.until > now) {
    return loginPage(`Çok fazla hatalı deneme. ${Math.ceil((lock.until - now) / 60000)} dakika sonra tekrar deneyin.`, 429);
  }
  let password = '';
  try { password = String((await req.formData()).get('password') || ''); } catch {}
  const s = await settings(env, true);
  if (await checkPassword(s, password)) {
    await env.DB.prepare('DELETE FROM login_fail WHERE ip = ?').bind(ip).run();
    return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': await sessionCookie(s), 'Cache-Control': 'no-store' } });
  }
  // Son 1 saatteki hatalı denemeler sayılır; kilit süresi bitince sayaç sıfırlanır
  const n = lock && !lock.until && now - lock.last < 3600_000 ? lock.n + 1 : 1;
  const until = n >= 5 ? now + 15 * 60_000 : 0;
  await env.DB.prepare(
    'INSERT INTO login_fail (ip, n, until, last) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(ip) DO UPDATE SET n = ?2, until = ?3, last = ?4'
  ).bind(ip, until ? 0 : n, until, now).run();
  return loginPage(until ? '5 hatalı deneme. 15 dakika bekleyin.' : 'Şifre yanlış.', 401);
}

// ---------- belge okuma / yazma ----------
async function readDoc(env, key, rev = null) {
  const q = rev == null
    ? env.DB.prepare('SELECT d.rev AS rev, c.data AS data FROM docs d JOIN chunks c ON c.key = d.key AND c.rev = d.rev WHERE d.key = ? ORDER BY c.idx').bind(key)
    : env.DB.prepare('SELECT rev, data FROM chunks WHERE key = ? AND rev = ? ORDER BY idx').bind(key, rev);
  const rows = (await q.all()).results;
  if (!rows.length) return null;
  return { rev: rows[0].rev, raw: rows.map((r) => r.data).join('') };
}

function chunkStmts(env, key, rev, raw) {
  const out = [];
  let i = 0, idx = 0;
  do {
    let end = Math.min(raw.length, i + CHUNK);
    // Emoji gibi iki parçalı karakterler ortadan bölünmesin
    if (end < raw.length) { const c = raw.charCodeAt(end - 1); if (c >= 0xd800 && c <= 0xdbff) end--; }
    out.push(env.DB.prepare('INSERT INTO chunks (key, rev, idx, data) VALUES (?, ?, ?, ?)').bind(key, rev, idx++, raw.slice(i, end)));
    i = end;
  } while (i < raw.length);
  return out;
}

async function saveConflictCopy(env, key, raw, device) {
  const ck = `${key}~conflict`;
  const rev = Date.now();
  await env.DB.batch([
    ...chunkStmts(env, ck, rev, raw),
    env.DB.prepare("INSERT INTO versions (key, rev, size, created_at, device, kind, keep) VALUES (?, ?, ?, ?, ?, 'conflict', 1)").bind(ck, rev, raw.length, rev, device),
  ]);
}

async function writeDoc(env, ctx, key, base, raw, device) {
  const rev = base + 1;
  const now = Date.now();
  const dayStart = Math.floor((now + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;
  const stmts = [
    // Önce sürüm kontrolü: tetikleyici, sürüm atlarsa tüm işlemi geri alır
    // İlk kayıt: anahtar zaten varsa UNIQUE hatası → çakışma. Sonrakiler: tetikleyici sürüm atlamasını reddeder.
    base === 0
      ? env.DB.prepare('INSERT INTO docs (key, rev, size, chunks, updated_at, device) VALUES (?1, 1, ?2, ?3, ?4, ?5)')
          .bind(key, raw.length, Math.max(1, Math.ceil(raw.length / CHUNK)), now, device)
      : env.DB.prepare('UPDATE docs SET rev = ?2, size = ?3, chunks = ?4, updated_at = ?5, device = ?6 WHERE key = ?1')
          .bind(key, rev, raw.length, Math.max(1, Math.ceil(raw.length / CHUNK)), now, device),
    env.DB.prepare('DELETE FROM chunks WHERE key = ? AND rev = ?').bind(key, rev),
    ...chunkStmts(env, key, rev, raw),
    env.DB.prepare(
      "INSERT OR REPLACE INTO versions (key, rev, size, created_at, device, kind, keep) VALUES (?1, ?2, ?3, ?4, ?5, 'save', " +
      'CASE WHEN EXISTS (SELECT 1 FROM versions WHERE key = ?1 AND keep = 1 AND created_at >= ?6) THEN 0 ELSE 1 END)'
    ).bind(key, rev, raw.length, now, device, dayStart),
  ];
  let results;
  try {
    results = await env.DB.batch(stmts);
  } catch (e) {
    const msg = String(e && (e.message || e));
    if (msg.includes('NK_CONFLICT') || msg.includes('UNIQUE constraint failed')) return { conflict: true };
    throw e;
  }
  const changed = results && results[0] && (results[0].meta ? results[0].meta.changes : results[0].changes);
  if (base > 0 && changed === 0) {
    // Sunucuda bu belge yok (ör. veritabanı sıfırlandı): yazılan parçaları geri al, çakışma say
    await env.DB.batch([
      env.DB.prepare('DELETE FROM chunks WHERE key = ? AND rev = ?').bind(key, rev),
      env.DB.prepare("DELETE FROM versions WHERE key = ? AND rev = ? AND created_at = ?").bind(key, rev, now),
    ]);
    return { conflict: true };
  }
  if (rev % 25 === 0) ctx.waitUntil(prune(env, key).catch(() => {}));
  return { rev, at: now };
}

async function prune(env, key) {
  const now = Date.now();
  const dailyCut = now - KEEP_DAILY_DAYS * DAY;
  const cur = await env.DB.prepare('SELECT rev FROM docs WHERE key = ?').bind(key).first('rev');
  const stmts = [];
  if (cur) {
    const limit = cur - KEEP_RECENT;
    stmts.push(
      env.DB.prepare('DELETE FROM chunks WHERE key = ?1 AND rev < ?2 AND rev NOT IN (SELECT rev FROM versions WHERE key = ?1 AND keep = 1 AND created_at > ?3)').bind(key, limit, dailyCut),
      env.DB.prepare('DELETE FROM versions WHERE key = ?1 AND rev < ?2 AND NOT (keep = 1 AND created_at > ?3)').bind(key, limit, dailyCut)
    );
  }
  const ck = `${key}~conflict`;
  const ccut = now - KEEP_CONFLICT_DAYS * DAY;
  stmts.push(
    env.DB.prepare('DELETE FROM chunks WHERE key = ? AND rev < ?').bind(ck, ccut),
    env.DB.prepare('DELETE FROM versions WHERE key = ? AND rev < ?').bind(ck, ccut),
    env.DB.prepare('DELETE FROM login_fail WHERE last < ?').bind(now - 7 * DAY)
  );
  await env.DB.batch(stmts);
}

async function revs(env) {
  const rows = (await env.DB.prepare('SELECT key, rev, updated_at FROM docs').all()).results;
  const out = {};
  for (const r of rows) if (r.key in DOCS) out[r.key] = r.rev;
  return out;
}

// İstemcinin elindeki sürümler çerezden okunur ("finance.12_stock.5")
function clientRevs(req) {
  const out = {};
  for (const p of decodeURIComponent(cookies(req).nkr || '').split('_')) {
    const [k, v] = p.split('.');
    if (k in DOCS && /^\d+$/.test(v || '')) out[k] = Number(v);
  }
  return out;
}

async function bootScript(req, env) {
  const server = await revs(env);
  const local = clientRevs(req);
  const data = {};
  // Finans verisi sayfa açılışında eşzamanlı gerekir: cihazdaki sürüm farklıysa bu yanıta gömülür
  if (server.finance && server.finance !== local.finance) {
    const d = await readDoc(env, 'finance');
    if (d) { data.finance = d.raw; server.finance = d.rev; }
  }
  const body = `window.__NK=${JSON.stringify({ v: 1, revs: server, data, now: Date.now() }).replace(/[<\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))};`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS },
  });
}

// ---------- API ----------
async function api(req, env, ctx, url) {
  const path = url.pathname;
  const method = req.method;
  if (path === '/api/boot.js' && method === 'GET') return bootScript(req, env);
  if (method !== 'GET' && req.headers.get('X-NK') !== '1') return json({ error: 'csrf' }, 403);

  if (path === '/api/revs' && method === 'GET') return json({ revs: await revs(env), now: Date.now() });

  let m = path.match(/^\/api\/doc\/([a-z]+)$/);
  if (m && m[1] in DOCS) {
    const key = m[1];
    if (method === 'GET') {
      const d = await readDoc(env, key);
      if (!d) return json({ rev: 0, raw: null });
      return new Response(d.raw, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-NK-Rev': String(d.rev), 'Cache-Control': 'no-store', ...SEC_HEADERS },
      });
    }
    if (method === 'PUT') {
      const base = Number(req.headers.get('X-NK-Base'));
      const device = (req.headers.get('X-NK-Device') || '').slice(0, 60) || null;
      if (!Number.isInteger(base) || base < 0) return json({ error: 'base' }, 400);
      const raw = await req.text();
      if (!raw || raw.length > DOCS[key]) return json({ error: 'size' }, 413);
      try { JSON.parse(raw); } catch { return json({ error: 'json' }, 400); }
      const r = await writeDoc(env, ctx, key, base, raw, device);
      if (r.conflict) {
        // Kaybolmasın: reddedilen içerik çakışma kopyası olarak saklanır, istemciye güncel veri döner
        ctx.waitUntil(saveConflictCopy(env, key, raw, device).catch(() => {}));
        const cur = await readDoc(env, key);
        return json({ conflict: true, rev: cur ? cur.rev : 0, raw: cur ? cur.raw : null }, 409);
      }
      return json({ rev: r.rev, at: r.at });
    }
  }

  m = path.match(/^\/api\/conflict\/([a-z]+)$/);
  if (m && m[1] in DOCS && method === 'POST') {
    const raw = await req.text();
    if (!raw || raw.length > DOCS[m[1]]) return json({ error: 'size' }, 413);
    await saveConflictCopy(env, m[1], raw, (req.headers.get('X-NK-Device') || '').slice(0, 60) || null);
    return json({ ok: true });
  }

  m = path.match(/^\/api\/history\/([a-z]+)$/);
  if (m && m[1] in DOCS && method === 'GET') {
    const key = m[1];
    const rows = (await env.DB.prepare(
      "SELECT v.key, v.rev, v.size, v.created_at, v.device, v.kind, v.keep, EXISTS (SELECT 1 FROM chunks c WHERE c.key = v.key AND c.rev = v.rev) AS has_data " +
      'FROM versions v WHERE v.key IN (?1, ?2) ORDER BY v.created_at DESC LIMIT 200'
    ).bind(key, `${key}~conflict`).all()).results;
    return json({ versions: rows.filter((r) => r.has_data).map((r) => ({ rev: r.rev, size: r.size, at: r.created_at, device: r.device, kind: r.kind, daily: !!r.keep })) });
  }
  m = path.match(/^\/api\/history\/([a-z]+)\/(conflict\/)?(\d+)$/);
  if (m && m[1] in DOCS && method === 'GET') {
    const d = await readDoc(env, m[2] ? `${m[1]}~conflict` : m[1], Number(m[3]));
    if (!d) return json({ error: 'not_found' }, 404);
    return new Response(d.raw, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="naksara-${m[1]}-${m[2] ? 'cakisma-' : 'surum-'}${m[3]}.json"`,
        'Cache-Control': 'no-store',
        ...SEC_HEADERS,
      },
    });
  }

  if (path === '/api/password' && method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch {}
    const s = await settings(env, true);
    if (!(await checkPassword(s, body.current))) return json({ error: 'Mevcut şifre yanlış.' }, 400);
    if (typeof body.next !== 'string' || body.next.length < 10 || body.next.length > 200) return json({ error: 'Yeni şifre en az 10 karakter olmalı.' }, 400);
    const ver = String(Number(s.session_ver || 1) + 1);
    await env.DB.batch([
      env.DB.prepare("UPDATE settings SET v = ? WHERE k = 'pw_hash'").bind(await makePasswordHash(body.next)),
      env.DB.prepare("UPDATE settings SET v = ? WHERE k = 'session_ver'").bind(ver),
    ]);
    const fresh = await settings(env, true);
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(fresh) });
  }

  return json({ error: 'not_found' }, 404);
}

// ---------- statik dosyalar ----------
async function asset(req, env, url) {
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin), req));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);
  if (/^\/stock\.[0-9a-f]{8,}\.html$/.test(path)) out.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  else out.headers.set('Cache-Control', 'private, no-cache');
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/login') {
        if (req.method === 'POST') return handleLogin(req, env);
        return Response.redirect(new URL('/', url), 303);
      }
      if (url.pathname === '/logout') {
        return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': 'nks=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax', 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });

      const ok = await authed(req, env);
      if (url.pathname.startsWith('/api/')) {
        if (!ok) {
          if (url.pathname === '/api/boot.js') return new Response('window.__NK={auth:false};', { status: 401, headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } });
          return json({ error: 'auth' }, 401);
        }
        return await api(req, env, ctx, url);
      }
      if (!ok) return loginPage();
      return await asset(req, env, url);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ error: 'server', message: String(e && e.message || e) }, 500);
    }
  },

  // Günlük bakım: eski sürümleri temizle (son 60 kayıt + 1 yıllık günlük görüntüler kalır)
  async scheduled(_event, env, ctx) {
    for (const key of Object.keys(DOCS)) ctx.waitUntil(prune(env, key));
  },
};
