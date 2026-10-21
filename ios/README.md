# Naksara iOS uygulaması

`app.aykutbulunmaz35.workers.dev` panelini tam ekran açan iOS uygulaması (WKWebView, iOS 15+, iPhone ve iPad).

## Neler yerel olarak karşılanıyor
- **Oturum ve veriler kalıcı:** Giriş çerezi, yerel kayıtlar ve stok veritabanı uygulama kapansa da kalır.
- **Onay pencereleri:** Sitenin `confirm` / `alert` / `prompt` pencereleri iOS penceresi olarak açılır. WebView'da bunlar varsayılan olarak sessizce "Hayır" döner.
- **İndirmeler:** Excel, CSV ve JSON yedek indirmeleri paylaşım ekranıyla açılır (Dosyalar'a kaydet, WhatsApp, Mail).
- **Fotoğraf yükleme:** Kamera veya fotoğraf arşivinden yükleme yapılabilir.
- **Yazdırma:** "Yazdır / PDF" düğmesi iOS yazdırma ekranını açar.
- **Bağlantılar:** Site dışı bağlantılar Safari'de, `tel:` ve `mailto:` bağlantıları ilgili uygulamada açılır.
- **Yenileme ve hata ekranı:** Aşağı çekip yenileme, bağlantı yoksa "Tekrar dene" ekranı, yükleme çubuğu.

## Derleme (GitHub Actions — `.github/workflows/ios.yml`)
- **`ios-app` dalına her gönderimde:** Uygulama derlenir, iPhone simülatöründe açılır, ekran görüntüsü `naksara-simulator` çıktısına konur. Apple hesabı gerekmez.
- **TestFlight'a yükleme:** Actions → "iOS uygulaması" → **Run workflow** → "İmzalı sürümü … yükle" kutusunu işaretle.

### TestFlight / App Store için gerekenler (bir kez)
1. **Apple Developer Program üyeliği:** Yıllık 99 $.
2. **Uygulama kaydı:** App Store Connect → Uygulamalar → **+** → Bundle ID `com.naksara.panel`. Bundle ID'yi değiştirmek istersen `ios/project.yml` ve iş akışındaki `com.naksara.panel` değerlerini birlikte değiştir.
3. **API anahtarı:** App Store Connect → Kullanıcılar ve Erişim → Entegrasyonlar → **App Store Connect API**. "Admin" rolünde bir anahtar oluştur ve `.p8` dosyasını indir.
4. **GitHub Secrets:** Depo → Settings → Secrets and variables → Actions:
   - `APPLE_TEAM_ID`: Developer hesabındaki 10 karakterlik Team ID.
   - `ASC_KEY_ID`: Anahtarın Key ID'si.
   - `ASC_ISSUER_ID`: Issuer ID.
   - `ASC_KEY_P8`: `.p8` dosyasının tüm metni.

İmzalama sertifikası ve profil, bu anahtarla Xcode tarafından otomatik oluşturulur.

## Not: App Store incelemesi
Yalnızca bir web sitesini gösteren ve girişle kullanılan iç işletme uygulamaları App Store incelemesinde (Kural 4.2 – asgari işlevsellik) reddedilebilir. Kendi ekibin için en hızlı yol **TestFlight dahili test**tir: 100 kişiye kadar, incelemesiz. Mağazaya çıkmak istenirse incelemeye bir deneme hesabı verilmesi gerekir.
