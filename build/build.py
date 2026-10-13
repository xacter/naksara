#!/usr/bin/env python3
"""Kaynak HTML'den yayınlanacak dosyaları üretir.

- Gömülü stok uygulaması ayrı, uzun süre önbelleklenen bir dosyaya taşınır (ana sayfa ~400 KB küçülür)
- Bulut eşitleme katmanı (shim.js) ana uygulamadan önce yüklenir
- Stok uygulamasına eşitleme kancaları eklenir
Kullanım: python3 build/build.py <kaynak.html>
"""
import hashlib, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'source', 'naksara.html')
out_dir = os.path.join(ROOT, 'public')
html = open(src_path, encoding='utf-8').read()
shim = open(os.path.join(ROOT, 'src', 'shim.js'), encoding='utf-8').read()


def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f'HATA: "{label}" için {n} eşleşme bulundu (1 bekleniyordu)')
    return text.replace(old, new)


# ---------- 1) Stok uygulamasını ayır ----------
m = re.search(r'(<script id="stockApp" type="application/json">)(.*?)(</script>)', html, re.S)
if not m:
    sys.exit('HATA: stockApp bulunamadı')
stock = json.loads(m.group(2))
html = html[:m.start(2)] + '"@external"' + html[m.end(2):]

# Stok: her kayıttan sonra buluta gönder
stock = replace_once(stock,
    'nfMem.cache=obj?{raw,obj}:null}async function nfEstimate',
    'nfMem.cache=obj?{raw,obj}:null;try{parent.__nkPush&&parent.__nkPush("stock",raw)}catch{}}async function nfEstimate',
    'stock push hook')
# Stok: dışarıdan (başka cihaz) gelen veriyi belleğe al ve ekranı yenile
stock = replace_once(stock,
    'async function nfInit(){',
    'window.__nkStock={reload:async function(){try{if(nfMem.mode==="idb"){let r=await nfGetRec();if(r){nfMem.raw=r.raw;nfMem.rev=r.rev}}nfMem.cache=null}catch{}window.dispatchEvent(new StorageEvent("storage",{key:st}))}};async function nfInit(){',
    'stock reload hook')
# Stok: ilk açılışta buluttaki güncel veri yazılana kadar bekle (en çok 4 sn)
stock = replace_once(stock,
    'nfInit().catch(()=>{nfMem.mode="ls"}).finally(',
    'nfInit().catch(()=>{nfMem.mode="ls"}).then(async()=>{try{let p=parent.__nkStockReady;if(p&&parent!==window){await Promise.race([p,new Promise(r=>setTimeout(r,4000))]);if(nfMem.mode==="idb"){let r=await nfGetRec();if(r){nfMem.raw=r.raw;nfMem.rev=r.rev}}nfMem.cache=null}}catch{}}).finally(',
    'stock boot hook')

stock_bytes = stock.encode('utf-8')
stock_name = f'stock.{hashlib.sha256(stock_bytes).hexdigest()[:12]}.html'

# ---------- 2) Ana uygulama yamaları ----------
html = replace_once(html,
    "f.srcdoc=html;",
    "if(html==='@external')f.src=window.__NK_STOCK_URL;else f.srcdoc=html;",
    'iframe src')
# "Verileri içeren HTML kopyası": bulut parçalarını çıkar, stok uygulamasını geri göm
html = replace_once(html,
    "root.querySelector('#stockFrame')?.remove();",
    "root.querySelector('#stockFrame')?.remove();root.querySelectorAll('[data-nk]').forEach(e=>e.remove());{const s=root.querySelector('#stockApp');if(s&&window.__nkStockHtml)s.textContent=JSON.stringify(window.__nkStockHtml).replace(/</g,'\\\\u003c')}",
    'snapshot')
html = replace_once(html,
    'Veriler yalnızca bu tarayıcıda saklanır; başka cihaz veya adresle paylaşılmaz.',
    'Veriler bu cihazda ve şifreli bağlantıyla bulut veritabanında saklanır; giriş yaptığın tüm cihazlarda aynı veri görünür.',
    'footer')
html = replace_once(html,
    'Tarayıcıda çalışan kişisel panel',
    'Bulutla eşitlenen kişisel panel',
    'aside meta')

# Uygulamanın "başka sekme" uyarıları artık başka cihazdan gelen kayıtlar için de geçerli
for a, b in [('Başka sekmedeki', 'Başka sekme/cihazdaki'), ('Başka sekmede', 'Başka sekme/cihazda'), ('başka sekmede', 'başka sekme/cihazda'),
             ('Diğer sekmenin verisini aç<', 'Güncel kaydı aç<'), ('diğer sekmenin verisini açabilirsin', 'güncel kaydı açabilirsin'),
             ('diğer sekmenin verisini açıp', 'güncel kaydı açıp'), ('bırakılıp diğer sekmenin kaydı açılsın mı', 'bırakılıp güncel kayıt açılsın mı'),
             ('aynı anda kayıt yapan başka bir sekme yüzünden', 'aynı anda kayıt yapan başka bir sekme veya cihaz yüzünden')]:
    if a not in html:
        sys.exit(f'HATA: metin bulunamadı: {a}')
    html = html.replace(a, b)

# ---------- 3) Eşitleme katmanını yerleştir (ana betikten önce) ----------
inject = (
    '<script data-nk src="/api/boot.js"></script>'
    f'<script data-nk>window.__NK_STOCK_URL="/{stock_name}";\n{shim}</script>'
)
html = replace_once(html, '<script id="seed" type="application/json">', inject + '<script id="seed" type="application/json">', 'inject point')

# ---------- 4) Yaz ----------
os.makedirs(out_dir, exist_ok=True)
for f in os.listdir(out_dir):
    if f.startswith('stock.') and f.endswith('.html'):
        os.remove(os.path.join(out_dir, f))
open(os.path.join(out_dir, 'index.html'), 'w', encoding='utf-8').write(html)
open(os.path.join(out_dir, stock_name), 'wb').write(stock_bytes)
print(f'index.html {len(html.encode())/1e3:.0f} KB · {stock_name} {len(stock_bytes)/1e3:.0f} KB')
