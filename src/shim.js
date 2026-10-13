/* Naksara bulut eşitleme katmanı.
   Uygulama verisini tarayıcıda (localStorage / IndexedDB) tutmaya devam eder; bu katman
   her kaydı arka planda buluta gönderir, başka cihazdaki değişiklikleri çekip uygulamaya
   "başka sekmede değişti" olayı olarak iletir. Uygulamanın kendi çakışma korumaları aynen çalışır. */
(function () {
  'use strict';
  var NK = window.__NK;
  if (!NK || NK.auth === false || location.protocol === 'file:') return;

  var FIN_KEY = 'naksara-finans-v1-ekim-2026-temiz-r2';
  var STOCK_LS = 'naksara-stock-standalone-v1';
  var META = 'nk-sync-meta';
  var KEYS = ['finance', 'stock'];
  var P = Storage.prototype, oSet = P.setItem, oGet = P.getItem, oRem = P.removeItem;
  var ls;
  try { ls = window.localStorage; } catch (e) { return; }

  function g(k) { try { return oGet.call(ls, k); } catch (e) { return null; } }
  function s(k, v) { try { oSet.call(ls, k, v); return true; } catch (e) { return false; } }
  function meta() { try { var m = JSON.parse(g(META)); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; } }
  function doc(m, k) { return m[k] || (m[k] = { rev: 0, dirty: false }); }
  function setMeta(fn) { var m = meta(); fn(m); s(META, JSON.stringify(m)); cookie(m); return m; }
  function cookie(m) {
    var p = [];
    KEYS.forEach(function (k) { if (m[k] && m[k].rev) p.push(k + '.' + m[k].rev); });
    try { document.cookie = 'nkr=' + p.join('_') + '; Path=/; Max-Age=31536000; SameSite=Lax; Secure'; } catch (e) {}
  }
  var device = g('nk-device');
  if (!device) {
    var ua = navigator.userAgent || '';
    var kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Cihaz';
    device = kind + '-' + Math.random().toString(36).slice(2, 6);
    s('nk-device', device);
  }

  var srv = NK.revs || {}, inline = NK.data || {};
  var lastRaw = {};          // sunucudaki son bilinen içerik (gereksiz gönderimi önler)
  var notices = [];
  var conflictCopies = {};   // çakışmada bu cihazdan kurtarılan içerik (indirilebilir)

  function hdr(extra) {
    var h = { 'X-NK': '1', 'X-NK-Device': device };
    for (var k in extra) h[k] = extra[k];
    return h;
  }
  function fetchSync(key) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/api/doc/' + key, false);
      x.send();
      if (x.status === 200 && x.getResponseHeader('X-NK-Rev')) return { rev: Number(x.getResponseHeader('X-NK-Rev')), raw: x.responseText };
    } catch (e) {}
    return null;
  }
  function uploadConflict(key, raw) {
    if (!raw) return;
    conflictCopies[key] = raw;
    fetch('/api/conflict/' + key, { method: 'POST', headers: hdr({ 'Content-Type': 'text/plain;charset=utf-8' }), body: raw, credentials: 'same-origin' }).catch(function () {});
  }

  /* ---------- 1) Açılış: finans verisi uygulama başlamadan yerine konur (eşzamanlı) ---------- */
  (function bootFinance() {
    var m = meta(), d = doc(m, 'finance'), R = srv.finance || 0, local = g(FIN_KEY);
    if (!R) { if (local != null) setMeta(function (m) { doc(m, 'finance').dirty = true; }); return; }
    var serverRaw = function () {
      if (inline.finance != null) return { rev: R, raw: inline.finance };
      return fetchSync('finance');
    };
    if (d.dirty && local != null) {
      if (d.rev === R) return; // bu cihazdaki gönderilmemiş değişiklik en güncel sürümün üstünde → gönderilecek
      var sr = serverRaw();
      if (!sr) return;
      uploadConflict('finance', local);
      if (s(FIN_KEY, sr.raw)) {
        lastRaw.finance = sr.raw;
        setMeta(function (m) { m.finance = { rev: sr.rev, dirty: false }; });
        notices.push('finance');
      }
      return;
    }
    if (d.rev !== R || local == null) {
      var r = serverRaw();
      if (r && s(FIN_KEY, r.raw)) {
        lastRaw.finance = r.raw;
        setMeta(function (m) { m.finance = { rev: r.rev, dirty: false }; });
      } else if (r) notices.push('quota');
    } else {
      lastRaw.finance = local;
    }
  })();

  /* ---------- 2) Stok verisi (IndexedDB 'naksara-stok') ---------- */
  var idbP = null;
  function idb() {
    if (!idbP) idbP = new Promise(function (res, rej) {
      if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
      var q;
      try { q = indexedDB.open('naksara-stok', 1); } catch (e) { return rej(e); }
      q.onupgradeneeded = function () { if (!q.result.objectStoreNames.contains('kv')) q.result.createObjectStore('kv'); };
      q.onsuccess = function () { var db = q.result; db.onversionchange = function () { db.close(); idbP = null; }; res(db); };
      q.onerror = function () { rej(q.error); };
      q.onblocked = function () { rej(new Error('blocked')); };
    });
    return idbP;
  }
  function revOf(raw) { try { var r = JSON.parse(raw).revision; return Number.isInteger(r) ? r : 0; } catch (e) { return 0; } }
  async function readStock() {
    var lsRaw = g(STOCK_LS), rec = null;
    try {
      var db = await idb();
      rec = await new Promise(function (res) {
        var q = db.transaction('kv', 'readonly').objectStore('kv').get('state');
        q.onsuccess = function () { res(q.result && typeof q.result.raw === 'string' ? q.result : null); };
        q.onerror = function () { res(null); };
      });
    } catch (e) { return lsRaw; }
    if (lsRaw && (!rec || revOf(lsRaw) > rec.rev)) return lsRaw;
    return rec ? rec.raw : null;
  }
  async function writeStock(raw) {
    var rev = revOf(raw);
    try {
      var db = await idb();
      await new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ rev: rev, raw: raw }, 'state');
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error); };
      });
      if (g(STOCK_LS) != null) { try { oRem.call(ls, STOCK_LS); } catch (e) {} }
    } catch (e) {
      if (!s(STOCK_LS, raw)) throw e;
    }
    try { var bc = new BroadcastChannel(STOCK_LS + '-sync'); bc.postMessage(rev); bc.close(); } catch (e) {}
    try {
      var f = document.getElementById('stockFrame');
      if (f && f.contentWindow && f.contentWindow.__nkStock) await f.contentWindow.__nkStock.reload();
    } catch (e) {}
  }
  async function getDoc(key) {
    var r = await fetch('/api/doc/' + key, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { status('auth'); return null; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var rev = Number(r.headers.get('X-NK-Rev') || 0);
    if (!rev) return null;
    return { rev: rev, raw: await r.text() };
  }

  window.__nkStockReady = (async function bootStock() {
    var m = meta(), d = doc(m, 'stock'), R = srv.stock || 0;
    if (!R) {
      if (!d.rev && await readStock()) { setMeta(function (m) { doc(m, 'stock').dirty = true; }); schedule('stock', 1500); }
      return;
    }
    if (d.dirty) {
      if (d.rev === R) { schedule('stock', 1500); return; }
      var local = await readStock();
      var r = await getDoc('stock');
      if (!r) return;
      uploadConflict('stock', local);
      await writeStock(r.raw);
      lastRaw.stock = r.raw;
      setMeta(function (m) { m.stock = { rev: r.rev, dirty: false }; });
      notices.push('stock');
      showNotices();
      return;
    }
    if (d.rev !== R) {
      var r2 = await getDoc('stock');
      if (!r2) return;
      await writeStock(r2.raw);
      lastRaw.stock = r2.raw;
      setMeta(function (m) { m.stock = { rev: r2.rev, dirty: false }; });
    }
  })().catch(function () {});

  /* ---------- 3) Yerel değişiklikleri yakala ---------- */
  P.setItem = function (k, v) {
    oSet.call(this, k, v);
    if (k === FIN_KEY && this === ls) changed('finance', String(v));
  };
  window.__nkPush = function (key, raw) { if (key === 'stock') changed('stock', raw); };

  function changed(key, raw) {
    if (raw != null && raw === lastRaw[key]) return;
    var d = doc(meta(), key);
    if (!d.dirty) setMeta(function (m) { doc(m, key).dirty = true; });
    schedule(key, 350);
  }

  /* ---------- 4) Gönderme (sekmeler arası kilitli, iyimser sürüm kontrolü) ---------- */
  var timers = {}, busy = {}, again = {}, failures = 0, retryTimer = null;
  function schedule(key, ms) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(function () { push(key); }, ms);
  }
  function withLock(name, fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(name, fn);
    return fn();
  }
  async function push(key) {
    if (busy[key]) { again[key] = true; return; }
    busy[key] = true;
    try {
      await withLock('nk-sync-' + key, async function () {
        var d = doc(meta(), key);
        if (!d.dirty) return;
        var raw = key === 'finance' ? g(FIN_KEY) : await readStock();
        if (raw == null) { setMeta(function (m) { doc(m, key).dirty = false; }); return; }
        status('sync');
        var r = await fetch('/api/doc/' + key, {
          method: 'PUT', credentials: 'same-origin', body: raw,
          headers: hdr({ 'X-NK-Base': String(d.rev), 'Content-Type': 'text/plain;charset=utf-8' }),
        });
        if (r.status === 401) { status('auth'); return; }
        if (r.status === 409) {
          var c = await r.json();
          conflictCopies[key] = raw;
          await adopt(key, c.raw, c.rev);
          // Finans uygulaması kendi çakışma uyarısını gösterir (yedekle / güncel kaydı aç); göstermezse bizimki çıkar
          setTimeout(function () { if (!document.getElementById('conflictAlert')) { notices.push(key); showNotices(); } }, key === 'finance' ? 600 : 0);
          return;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var j = await r.json();
        var cur = key === 'finance' ? g(FIN_KEY) : await readStock();
        lastRaw[key] = raw;
        setMeta(function (m) { var x = doc(m, key); x.rev = j.rev; x.dirty = cur !== raw; x.at = j.at; });
        if (cur !== raw) again[key] = true;
      });
      failures = 0;
      lastOk = Date.now();
      status(anyDirty() ? 'sync' : 'ok');
    } catch (e) {
      failures++;
      status(navigator.onLine === false ? 'offline' : 'error');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(function () { KEYS.forEach(function (k) { if (doc(meta(), k).dirty) push(k); }); }, Math.min(60000, 2000 * Math.pow(2, failures - 1)));
    } finally {
      busy[key] = false;
      if (again[key]) { again[key] = false; schedule(key, 50); }
    }
  }
  function anyDirty() { var m = meta(); return KEYS.some(function (k) { return doc(m, k).dirty; }); }

  async function adopt(key, raw, rev) {
    if (raw == null) return;
    if (key === 'finance') {
      var old = g(FIN_KEY);
      if (!s(FIN_KEY, raw)) { notices.push('quota'); showNotices(); return; }
      lastRaw.finance = raw;
      setMeta(function (m) { m.finance = { rev: rev, dirty: false }; });
      try { window.dispatchEvent(new StorageEvent('storage', { key: FIN_KEY, oldValue: old, newValue: raw, storageArea: ls, url: location.href })); } catch (e) {}
    } else {
      await writeStock(raw);
      lastRaw.stock = raw;
      setMeta(function (m) { m.stock = { rev: rev, dirty: false }; });
    }
  }

  /* ---------- 5) Çekme: başka cihazdaki değişiklikler ---------- */
  var lastOk = Date.now(), polling = false;
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      var r = await fetch('/api/revs', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { status('auth'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      for (var i = 0; i < KEYS.length; i++) {
        var key = KEYS[i], R = j.revs[key] || 0, d = doc(meta(), key);
        if (d.dirty) { if (!busy[key]) push(key); continue; }
        if (R && R !== d.rev) {
          await withLock('nk-sync-' + key, async function () {
            var d2 = doc(meta(), key);
            if (d2.dirty || d2.rev === R) return;
            var x = await getDoc(key);
            if (x) await adopt(key, x.raw, x.rev);
          });
        }
      }
      lastOk = Date.now();
      if (!anyDirty()) status('ok');
    } catch (e) {
      status(navigator.onLine === false ? 'offline' : 'error');
    } finally { polling = false; }
  }
  setInterval(poll, 15000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) KEYS.forEach(function (k) { if (doc(meta(), k).dirty) { clearTimeout(timers[k]); push(k); } });
    else poll();
  });
  window.addEventListener('focus', poll);
  window.addEventListener('online', function () { poll(); KEYS.forEach(function (k) { if (doc(meta(), k).dirty) push(k); }); });
  window.addEventListener('storage', function (e) { if (e.key === META) refreshUi(); });

  // Açılışta bekleyen gönderim varsa (ör. sekme kapanmadan önce gönderilemedi)
  setTimeout(function () { if (doc(meta(), 'finance').dirty) push('finance'); }, 800);

  /* ---------- 6) Arayüz: durum göstergesi, sürüm geçmişi, şifre, çıkış ---------- */
  var state = 'ok';
  var LABEL = {
    ok: 'Bulutla eşitlendi', sync: 'Eşitleniyor…', offline: 'Çevrimdışı · bağlantı gelince gönderilecek',
    error: 'Eşitleme bekliyor · tekrar denenecek', auth: 'Oturum kapandı · tekrar giriş yap',
  };
  function status(st) { state = st; refreshUi(); }
  function fmtTime(t) { try { return new Date(t).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' }); } catch (e) { return String(t); } }
  function fmtSize(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'; }
  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function refreshUi() {
    var st = state === 'ok' && anyDirty() ? 'sync' : state;
    document.querySelectorAll('[data-nk-status]').forEach(function (b) {
      b.setAttribute('data-state', st);
      var t = b.querySelector('.nk-t');
      if (t) t.textContent = LABEL[st];
      b.title = LABEL[st] + ' · son kontrol ' + fmtTime(lastOk);
    });
    var s2 = document.getElementById('nkDlgStatus');
    if (s2) s2.textContent = LABEL[st] + ' · son başarılı bağlantı ' + fmtTime(lastOk) + ' · bu cihaz: ' + device;
  }

  var CSS = '.nk-cloud{margin-top:10px;width:100%;justify-content:flex-start;gap:8px;min-height:34px;padding:7px 10px;font-size:12px;font-weight:600;background:transparent;border:1px solid var(--line,#e4e8ee);color:var(--ink-2,#3b4756)}' +
    '.nk-cloud .nk-d,.nk-mcloud .nk-d{width:8px;height:8px;border-radius:50%;background:var(--green,#12805c);flex:none}' +
    '[data-state=sync] .nk-d,[data-state=offline] .nk-d,[data-state=error] .nk-d{background:var(--amber,#8f620e)}[data-state=auth] .nk-d{background:var(--red,#c2394a)}' +
    '[data-state=sync] .nk-d{animation:nkp 1s ease-in-out infinite}@keyframes nkp{50%{opacity:.35}}' +
    '.nk-cloud .nk-t{white-space:normal;text-align:left;line-height:1.3}' +
    '.nk-mcloud{position:relative;padding:0;width:36px;min-height:36px;height:36px;border-radius:10px;margin-left:6px;flex:none}.nk-mcloud .nk-d{position:absolute;top:6px;right:6px;width:7px;height:7px;box-shadow:0 0 0 2px var(--surface,#fff)}' +
    '#nkDlg{border:0;border-radius:var(--radius,16px);padding:0;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);box-shadow:var(--shadow-lg,0 24px 70px #1c263236);color:var(--ink,#1c2632);background:var(--surface,#fff)}' +
    '#nkDlg::backdrop{background:#1c26324d}#nkDlg .nk-h{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border-bottom:1px solid var(--line,#e4e8ee)}#nkDlg h2{margin:0;font-size:17px}' +
    '#nkDlg .nk-b{padding:16px 20px 20px;overflow:auto;max-height:calc(100vh - 140px)}#nkDlg h3{font-size:13px;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#6b7684)}' +
    '#nkDlg .nk-s{color:var(--muted,#6b7684);font-size:13px;margin:0 0 10px}#nkDlg .nk-row{display:flex;gap:8px;flex-wrap:wrap}' +
    '#nkDlg .nk-tabs button{min-height:32px;padding:6px 12px;font-size:12px}#nkDlg .nk-tabs button[aria-pressed=true]{background:var(--brand,#1f6b74);color:#fff;border-color:var(--brand,#1f6b74)}' +
    '#nkDlg ul{list-style:none;margin:10px 0 0;padding:0;border:1px solid var(--line,#e4e8ee);border-radius:10px;max-height:300px;overflow:auto}' +
    '#nkDlg li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid var(--line-2,#eef1f5);font-size:13px}#nkDlg li:first-child{border-top:0}' +
    '#nkDlg li small{display:block;color:var(--muted,#6b7684);font-size:11.5px}#nkDlg .nk-tag{font-size:11px;padding:2px 7px;border-radius:99px;background:var(--brand-soft,#e8f3f4);color:var(--brand-d,#16545b);margin-left:6px}' +
    '#nkDlg .nk-tag.c{background:var(--amber-soft,#fff6e3);color:var(--amber,#8f620e)}#nkDlg form{display:grid;gap:8px}#nkDlg input{width:100%}' +
    '#nkDlg .nk-msg{font-size:13px;margin:4px 0 0}#nkDlg .nk-msg.err{color:var(--red,#c2394a)}#nkDlg .nk-msg.ok{color:var(--green,#12805c)}' +
    '.nk-banner{margin:0 0 14px;padding:12px 14px;border-radius:12px;background:var(--amber-soft,#fff6e3);border:1px solid var(--amber-line,#f0dfb6);color:var(--ink,#1c2632);font-size:13px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}' +
    '@media(max-width:860px){.nk-cloud{display:none}}';

  function download(text, name) {
    var b = new Blob([text], { type: 'application/json' }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 6000);
  }
  // İndirilen dosya, uygulamanın kendi "JSON yedeği yükle" özelliğiyle açılabilecek biçimde hazırlanır
  function exportable(key, raw) {
    try {
      if (key === 'finance') return JSON.stringify(typeof window.readStoreText === 'function' ? window.readStoreText(raw) : JSON.parse(raw), null, 2);
      var o = JSON.parse(raw);
      return JSON.stringify(o && o.state ? o.state : o, null, 2);
    } catch (e) { return raw; }
  }

  function showNotices() {
    if (!document.body) return;
    var main = document.getElementById('content');
    notices.splice(0).forEach(function (n) {
      var id = 'nkNotice-' + n;
      if (document.getElementById(id)) return;
      var name = n === 'finance' ? 'finans' : 'stok';
      var b;
      if (n === 'quota') {
        b = el('div', { class: 'nk-banner', id: id, role: 'alert', 'data-nk': '' }, '<span>Buluttaki güncel veri bu tarayıcının kayıt alanına sığmadı. Tarayıcı depolamasında yer açıp sayfayı yenileyin.</span>');
      } else {
        b = el('div', { class: 'nk-banner', id: id, role: 'alert', 'data-nk': '' },
          '<span>Başka bir cihazda daha yeni ' + name + ' kaydı yapılmış; güncel veri açıldı. Bu cihazdaki son değişiklikler kaybolmadı: “Bulut” menüsündeki sürüm geçmişinde <b>çakışma kopyası</b> olarak saklandı.</span>' +
          '<span class="nk-row"><button type="button" class="small" data-a="dl">Bu cihazdaki sürümü indir</button><button type="button" class="small" data-a="x">Tamam</button></span>');
        b.querySelector('[data-a=dl]').onclick = function () { if (conflictCopies[n]) download(exportable(n, conflictCopies[n]), 'naksara-' + name + '-bu-cihaz-' + Date.now() + '.json'); };
        b.querySelector('[data-a=x]').onclick = function () { b.remove(); };
      }
      if (main && main.parentNode) main.parentNode.insertBefore(b, main); else document.body.prepend(b);
    });
  }

  var dlg;
  function openDialog() {
    if (!dlg) {
      dlg = el('dialog', { id: 'nkDlg', 'aria-labelledby': 'nkDlgT', 'data-nk': '' },
        '<div class="nk-h"><h2 id="nkDlgT">Bulut ve yedekler</h2><button type="button" class="icon" data-a="close" aria-label="Kapat">✕</button></div>' +
        '<div class="nk-b"><p class="nk-s" id="nkDlgStatus"></p><div class="nk-row"><button type="button" class="primary small" data-a="sync">Şimdi eşitle</button><a href="/logout"><button type="button" class="small">Çıkış yap</button></a></div>' +
        '<h3>Sürüm geçmişi</h3><p class="nk-s">Her kayıt buluta ayrı bir sürüm olarak yazılır: son 60 kayıt ve 1 yıl boyunca her günün ilk kaydı saklanır. İndirdiğin dosyayı uygulamanın JSON yedeği yükleme özelliğiyle geri açabilirsin.</p>' +
        '<div class="nk-row nk-tabs"><button type="button" class="small" data-k="finance" aria-pressed="true">Finans</button><button type="button" class="small" data-k="stock" aria-pressed="false">Stok</button></div><ul id="nkHist"><li>Yükleniyor…</li></ul>' +
        '<h3>Giriş şifresi</h3><form id="nkPw" autocomplete="off"><input type="password" name="current" placeholder="Mevcut şifre" required autocomplete="current-password"><input type="password" name="next" placeholder="Yeni şifre (en az 10 karakter)" minlength="10" required autocomplete="new-password"><input type="password" name="next2" placeholder="Yeni şifre (tekrar)" minlength="10" required autocomplete="new-password"><div class="nk-row"><button type="submit" class="small">Şifreyi değiştir</button></div><p class="nk-msg" id="nkPwMsg"></p></form>' +
        '<p class="nk-s" style="margin-top:14px">Şifre değişince diğer tüm cihazların oturumu kapanır; yeni şifreyle tekrar giriş yapılır.</p></div>');
      document.body.appendChild(dlg);
      dlg.querySelector('[data-a=close]').onclick = function () { dlg.close(); };
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
      dlg.querySelector('[data-a=sync]').onclick = function () { KEYS.forEach(function (k) { if (doc(meta(), k).dirty) push(k); }); poll(); };
      dlg.querySelectorAll('[data-k]').forEach(function (b) {
        b.onclick = function () {
          dlg.querySelectorAll('[data-k]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          loadHistory(b.getAttribute('data-k'));
        };
      });
      dlg.querySelector('#nkPw').onsubmit = async function (e) {
        e.preventDefault();
        var f = new FormData(e.target), msg = dlg.querySelector('#nkPwMsg');
        msg.className = 'nk-msg';
        if (f.get('next') !== f.get('next2')) { msg.className = 'nk-msg err'; msg.textContent = 'Yeni şifreler aynı değil.'; return; }
        try {
          var r = await fetch('/api/password', { method: 'POST', credentials: 'same-origin', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ current: f.get('current'), next: f.get('next') }) });
          var j = await r.json();
          if (!r.ok) throw new Error(j.error || 'Değiştirilemedi.');
          msg.className = 'nk-msg ok'; msg.textContent = 'Şifre değişti. Diğer cihazlarda yeniden giriş gerekecek.'; e.target.reset();
        } catch (err) { msg.className = 'nk-msg err'; msg.textContent = err.message; }
      };
    }
    refreshUi();
    var active = dlg.querySelector('[data-k][aria-pressed=true]');
    loadHistory(active ? active.getAttribute('data-k') : 'finance');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  async function loadHistory(key) {
    var ul = dlg.querySelector('#nkHist');
    ul.innerHTML = '<li>Yükleniyor…</li>';
    try {
      var r = await fetch('/api/history/' + key, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error();
      var j = await r.json();
      if (!j.versions.length) { ul.innerHTML = '<li>Henüz buluta kayıt yok.</li>'; return; }
      ul.innerHTML = j.versions.map(function (v) {
        var tag = v.kind === 'conflict' ? '<span class="nk-tag c">çakışma kopyası</span>' : v.daily ? '<span class="nk-tag">günlük</span>' : '';
        var label = v.kind === 'conflict' ? 'Kurtarılan sürüm' : 'Sürüm ' + v.rev;
        return '<li><span><b>' + esc(label) + '</b>' + tag + '<small>' + esc(fmtTime(v.at)) + ' · ' + esc(v.device || 'bilinmeyen cihaz') + ' · ' + fmtSize(v.size) + '</small></span>' +
          '<button type="button" class="small" data-rev="' + v.rev + '" data-c="' + (v.kind === 'conflict' ? 1 : 0) + '">İndir</button></li>';
      }).join('');
      ul.querySelectorAll('button[data-rev]').forEach(function (b) {
        b.onclick = async function () {
          b.disabled = true;
          try {
            var rr = await fetch('/api/history/' + key + '/' + (b.getAttribute('data-c') === '1' ? 'conflict/' : '') + b.getAttribute('data-rev'), { credentials: 'same-origin' });
            if (!rr.ok) throw new Error();
            download(exportable(key, await rr.text()), 'naksara-' + (key === 'finance' ? 'finans' : 'stok') + '-surum-' + b.getAttribute('data-rev') + '.json');
          } catch (e) { b.textContent = 'Hata'; }
          b.disabled = false;
        };
      });
    } catch (e) { ul.innerHTML = '<li>Geçmiş alınamadı. Bağlantıyı kontrol edin.</li>'; }
  }

  function mountUi() {
    var st = document.createElement('style'); st.setAttribute('data-nk', ''); st.textContent = CSS; document.head.appendChild(st);
    var ab = document.querySelector('.aside-bottom');
    if (ab) {
      var b = el('button', { type: 'button', class: 'nk-cloud', 'data-nk-status': '', 'data-nk': '' }, '<span class="nk-d"></span><span class="nk-t"></span>');
      b.onclick = openDialog; ab.appendChild(b);
    }
    var mb = document.querySelector('.mobilebar');
    if (mb) {
      var mbtn = el('button', { type: 'button', class: 'icon nk-mcloud', 'data-nk-status': '', 'data-nk': '', 'aria-label': 'Bulut ve yedekler' },
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H7a5 5 0 1 1 1.6-9.7A6 6 0 0 1 20 11.5 3.8 3.8 0 0 1 17.5 19Z"/></svg><span class="nk-d"></span>');
      mbtn.onclick = openDialog; mb.appendChild(mbtn);
    }
    refreshUi();
    showNotices();
    // Stok uygulamasını boşta önceden yükle (açıldığında anında görünür; HTML kopyası için de gerekir)
    var warm = function () {
      if (!window.__NK_STOCK_URL) return;
      fetch(window.__NK_STOCK_URL, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (t) { if (t) window.__nkStockHtml = t; }).catch(function () {});
    };
    setTimeout(function () { if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 4000 }); else warm(); }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUi); else mountUi();
})();
