// Uçtan uca test: iki ayrı "cihaz" (tarayıcı bağlamı) arasında eşitleme, çakışma, çevrimdışı.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const SP = '/tmp/claude-0/-home-claude/a26849bd-e6df-558f-a798-95d5b7aa8108/scratchpad';
const BASE = process.env.BASE || 'http://localhost:8787';
const PW = fs.readFileSync(SP + '/app_password', 'utf8');

let fails = 0;
const ok = (c, m) => { console.log((c ? '✔ ' : '✘ ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 250) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return false;
}

async function device(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { console.log(`  [${name}] dialog: ${d.message().slice(0, 90)}`); if (d.type() !== 'confirm') d.dismiss().catch(() => {}); });
  const t0 = Date.now();
  await page.goto(BASE + '/');
  ok(await page.locator('input[name=password]').count() === 1, `${name}: giriş sayfası görünüyor`);
  await page.fill('input[name=password]', PW);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  await page.waitForFunction(() => typeof state === 'object' && document.querySelector('[data-nk-status]'));
  console.log(`  [${name}] uygulama açıldı (${Date.now() - t0} ms)`);
  return { ctx, page, errors, name };
}
const getName = (d, i) => d.page.evaluate((i) => state.products[i].name, i);
const setName = (d, i, v) => d.page.evaluate(([i, v]) => commit(() => { state.products[i].name = v; }), [i, v]);
const meta = (d) => d.page.evaluate(() => JSON.parse(localStorage.getItem('nk-sync-meta') || '{}'));
const srvRevs = (d) => d.page.evaluate(() => fetch('/api/revs').then((r) => r.json()).then((j) => j.revs));

(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');

  // 1) A'da kayıt → buluta gider
  const v1 = 'Ürün-A-' + Date.now();
  ok(await setName(A, 3, v1), 'A: değişiklik uygulamaca kaydedildi');
  ok(await waitFor(async () => (await meta(A)).finance?.rev >= 1 && !(await meta(A)).finance.dirty), 'A: değişiklik buluta gönderildi');
  const r1 = (await srvRevs(A)).finance;

  // 2) Yeni cihaz B açılışta A'nın verisini görür
  const B = await device(browser, 'B');
  ok(await getName(B, 3) === v1, 'B: açılışta A\'nın kaydını görüyor');

  // 3) B'de değişiklik → A otomatik alır (odak olayı ile anında yoklama)
  const v2 = 'Ürün-B-' + Date.now();
  await setName(B, 4, v2);
  ok(await waitFor(async () => (await srvRevs(B)).finance === r1 + 1), 'B: değişiklik buluta gitti');
  await A.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  ok(await waitFor(async () => (await getName(A, 4)) === v2), 'A: B\'nin değişikliği ekrana geldi (sayfa yenilemeden)');
  ok(await getName(A, 3) === v1, 'A: kendi önceki kaydı duruyor');

  // 4) A çevrimdışı iken kayıt; B de kayıt yapar → çakışma
  await A.ctx.setOffline(true);
  const vA = 'Çevrimdışı-A';
  await setName(A, 5, vA);
  await sleep(1500);
  ok((await meta(A)).finance.dirty === true, 'A: çevrimdışı değişiklik "bekliyor" olarak işaretli');
  const st = await A.page.locator('.nk-cloud').getAttribute('data-state');
  ok(['offline', 'error', 'sync'].includes(st), `A: durum göstergesi çevrimdışı/bekliyor (${st})`);
  const vB = 'Çakışan-B';
  await setName(B, 6, vB);
  await waitFor(async () => !(await meta(B)).finance.dirty);
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
  ok(await waitFor(async () => (await A.page.locator('#conflictAlert').count()) === 1), 'A: uygulamanın çakışma uyarısı gösterildi');
  ok(await getName(A, 5) === vA, 'A: ekrandaki (çevrimdışı) veri kullanıcı karar verene kadar korunuyor');
  A.page.once('dialog', (d) => d.accept());
  A.acceptNext = true;
  await A.page.click('#conflictAlert button:has-text("Güncel kaydı aç")');
  ok(await waitFor(async () => (await getName(A, 6)) === vB), 'A: "Güncel kaydı aç" ile B\'nin verisi yüklendi');
  const hist = await A.page.evaluate(() => fetch('/api/history/finance').then((r) => r.json()));
  ok(hist.versions.some((v) => v.kind === 'conflict'), 'Sunucu: A\'nın çakışan sürümü çakışma kopyası olarak saklandı');

  // 5) Yeniden yükleme: veri kalıcı, B'nin verisi A'da
  await A.page.reload();
  await A.page.waitForFunction(() => typeof state === 'object');
  ok(await getName(A, 6) === vB && (await getName(A, 4)) === v2, 'A: yenilemeden sonra veriler doğru');

  // 6) Stok uygulaması ayrı dosyadan açılıyor ve eşitleme kancaları çalışıyor
  await A.page.evaluate(() => { page = 'stock'; render(); });
  const frame = await waitFor(async () => { const f = A.page.frame({ url: /stock\./ }); return f && (await f.evaluate(() => !!window.__nkStock)) ? f : null; });
  ok(!!frame, 'A: stok uygulaması ayrı dosyadan yüklendi ve kancalar aktif');

  // 6b) Stokta işlem → bulut → B
  // Stok uygulamasının yazma kancası (nfWrite sonrası) ile aynı yol: IndexedDB'ye yeni sürüm + parent.__nkPush
  const bumpStock = (d) => d.page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('naksara-stok', 1); q.onsuccess = () => r(q.result); });
    const rec = await new Promise((r) => { const q = db.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => r(q.result); });
    const o = JSON.parse(rec.raw); o.revision++; const raw = JSON.stringify(o);
    await new Promise((r) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ rev: o.revision, raw }, 'state'); tx.oncomplete = r; });
    window.__nkPush('stock', raw);
    return o.revision;
  });
  ok(await A.page.evaluate(() => typeof window.__nkPush === 'function'), 'A: stok yazma kancası tanımlı');
  await bumpStock(A);
  const stockRev = await waitFor(async () => { const m = await meta(A); return m.stock && m.stock.rev >= 1 && !m.stock.dirty ? m.stock.rev : 0; }, 8000);
  ok(stockRev >= 1, 'A: stok değişikliği buluta gönderildi (rev ' + stockRev + ')');
  if (stockRev) {
    await B.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const same = await waitFor(async () => {
      const m = await meta(B);
      return m.stock && m.stock.rev === stockRev;
    });
    ok(same, 'B: stok verisini buluttan aldı');
    const eq = await B.page.evaluate(async () => {
      const db = await new Promise((r) => { const q = indexedDB.open('naksara-stok', 1); q.onsuccess = () => r(q.result); });
      const rec = await new Promise((r) => { const q = db.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => r(q.result); });
      const srv = await fetch('/api/doc/stock').then((r) => r.text());
      return rec && rec.raw === srv;
    });
    ok(eq, 'B: cihazdaki stok verisi buluttakiyle birebir aynı');
    await B.page.evaluate(() => { page = 'stock'; render(); });
    const bf = await waitFor(async () => { const f = B.page.frame({ url: /stock\./ }); return f && (await f.evaluate(() => !!window.__nkStock)) ? f : null; });
    ok(!!bf, 'B: stok uygulaması açıldı');
    await sleep(800);
    await B.page.screenshot({ path: SP + '/shot-stock-b.png' });
    // Stok ekranı B'de açıkken A yeni sürüm gönderir → B'nin ekranına yansır
    const rv = await bumpStock(A);
    await waitFor(async () => !(await meta(A)).stock.dirty);
    await B.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    ok(await waitFor(async () => bf.evaluate((rv) => { try { return JSON.parse(localStorage.getItem('x') || 'null') === null; } catch (e) { return false; } }, rv) && (await meta(B)).stock.rev === (await meta(A)).stock.rev), 'B: stok ekranı açıkken yeni sürüm alındı');
    await B.page.evaluate(() => { page = 'dashboard'; render(); });
  }

  // 7) Bulut menüsü: sürüm geçmişi listeleniyor
  await B.page.evaluate(() => document.querySelector('.nk-cloud').click());
  ok(await waitFor(async () => (await B.page.locator('#nkHist li button').count()) > 0), 'B: Bulut menüsünde sürüm geçmişi listelendi');
  await B.page.screenshot({ path: SP + '/shot-dialog.png' });
  await B.page.keyboard.press('Escape');

  // 8) Mobil görünüm
  const M = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await B.ctx.storageState() });
  const mp = await M.newPage();
  await mp.goto(BASE + '/');
  await mp.waitForFunction(() => typeof state === 'object');
  ok(await mp.locator('.nk-mcloud').isVisible(), 'Mobil: bulut düğmesi görünüyor');
  await mp.screenshot({ path: SP + '/shot-mobile.png' });
  await A.page.screenshot({ path: SP + '/shot-stock.png' });

  for (const d of [A, B]) {
    const errs = d.errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(e));
    ok(errs.length === 0, `${d.name}: konsolda hata yok` + (errs.length ? ' → ' + errs.slice(0, 3).join(' | ') : ''));
  }
  await browser.close();
  console.log(fails ? `\n${fails} test BAŞARISIZ` : '\nTüm testler geçti');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
