# Naksara · Cloudflare

Finans & stok paneli, Cloudflare Workers + D1 üzerinde.

- `source/naksara.html` — uygulamanın kendisi (tek dosya). Güncellemek için bu dosyayı değiştirip `main`'e gönder; GitHub Actions otomatik yayınlar.
- `src/worker.js` — sunucu: şifreli giriş, veri eşitleme API'si, sürüm geçmişi.
- `src/shim.js` — tarayıcı tarafı eşitleme katmanı (uygulamadan önce yüklenir).
- `build/build.py` — yayın dosyalarını `public/` altına üretir (stok uygulamasını ayrı, önbelleklenen dosyaya taşır).
- `migrations/` — D1 şeması.
- `test/` — yerel test sunucusu (Node + SQLite) ve iki cihazlı uçtan uca test.

Yerel test: `python3 build/build.py && ./test/restart.sh && node test/e2e.cjs`
