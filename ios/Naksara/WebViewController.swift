import UIKit
import WebKit

/// Naksara panelini (app.aykutbulunmaz35.workers.dev) tam ekran gösteren WebView.
/// Sitenin ihtiyaç duyduğu tarayıcı özelliklerini yerel olarak karşılar:
/// JavaScript alert / confirm / prompt pencereleri, dosya indirme (Excel, CSV, JSON yedek),
/// fotoğraf yükleme, yazdırma, dış bağlantılar, çevrimdışı ekranı ve aşağı çekip yenileme.
final class WebViewController: UIViewController {

    static let homeURL = URL(string: "https://app.aykutbulunmaz35.workers.dev/")!
    static let appHost = "app.aykutbulunmaz35.workers.dev"
    static let background = UIColor(red: 0.957, green: 0.965, blue: 0.976, alpha: 1) // #f4f6f9
    static let brand = UIColor(red: 0.122, green: 0.420, blue: 0.455, alpha: 1)       // #1f6b74

    private var webView: WKWebView!
    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let refreshControl = UIRefreshControl()
    private var errorView: UIView?
    private var observations: [NSKeyValueObservation] = []
    private var downloads: [WKDownload: URL] = [:]

    // MARK: - Kurulum

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let contentController = WKUserContentController()
        contentController.add(WeakScriptHandler(self), name: "nativePrint")
        // window.print() WebView'da çalışmaz; iOS yazdırma ekranına yönlendirilir (iframe'ler dahil).
        contentController.addUserScript(WKUserScript(
            source: "window.print = function () { try { window.webkit.messageHandlers.nativePrint.postMessage(null); } catch (e) {} };",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false))

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // oturum çerezi, localStorage ve IndexedDB kalıcı
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1 NaksaraiOS/1.0"

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        refreshControl.addTarget(self, action: #selector(pullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl

        progressView.progressTintColor = Self.brand
        progressView.trackTintColor = .clear

        webView.translatesAutoresizingMaskIntoConstraints = false
        progressView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(progressView)
        NSLayoutConstraint.activate([
            // Üstte durum çubuğunun altından başlar; altta sayfa kendi güvenli alan boşluğunu kullanır.
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            progressView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 2),
        ])

        observations.append(webView.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
            guard let self else { return }
            self.progressView.setProgress(Float(wv.estimatedProgress), animated: true)
            self.progressView.isHidden = wv.estimatedProgress >= 1
        })

        webView.load(URLRequest(url: Self.homeURL))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }

    @objc private func pullToRefresh() {
        if webView.url == nil { webView.load(URLRequest(url: Self.homeURL)) } else { webView.reload() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.refreshControl.endRefreshing() }
    }

    // MARK: - Yardımcılar

    /// Ekranda o an en üstte olan görünüm denetleyicisi (pencere üstüne pencere açmak için).
    private var topController: UIViewController? {
        guard view.window != nil else { return nil }
        var top: UIViewController = self
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }

    private func isAppURL(_ url: URL) -> Bool {
        url.host?.lowercased() == Self.appHost
    }

    private func openExternally(_ url: URL) {
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    private func share(fileAt url: URL) {
        guard let top = topController else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let pop = sheet.popoverPresentationController { // iPad
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        top.present(sheet, animated: true)
    }

    private func showMessage(_ title: String, _ message: String) {
        guard let top = topController else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Tamam", style: .default))
        top.present(alert, animated: true)
    }

    // MARK: - Çevrimdışı / hata ekranı

    private func showErrorView(_ error: Error) {
        hideErrorView()
        let box = UIView()
        box.backgroundColor = Self.background
        box.translatesAutoresizingMaskIntoConstraints = false

        let icon = UIImageView(image: UIImage(systemName: "wifi.exclamationmark"))
        icon.tintColor = Self.brand
        icon.contentMode = .scaleAspectFit
        icon.heightAnchor.constraint(equalToConstant: 48).isActive = true

        let title = UILabel()
        title.text = "Bağlantı kurulamadı"
        title.font = .systemFont(ofSize: 20, weight: .bold)
        title.textColor = UIColor(red: 0.11, green: 0.15, blue: 0.20, alpha: 1)
        title.textAlignment = .center

        let detail = UILabel()
        detail.text = "İnternet bağlantınızı kontrol edip tekrar deneyin.\n(\(error.localizedDescription))"
        detail.font = .systemFont(ofSize: 14)
        detail.textColor = .secondaryLabel
        detail.numberOfLines = 0
        detail.textAlignment = .center

        var buttonConfig = UIButton.Configuration.filled()
        buttonConfig.title = "Tekrar dene"
        buttonConfig.baseBackgroundColor = Self.brand
        buttonConfig.cornerStyle = .large
        buttonConfig.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 28, bottom: 12, trailing: 28)
        let retry = UIButton(configuration: buttonConfig)
        retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [icon, title, detail, retry])
        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(stack)
        view.addSubview(box)
        NSLayoutConstraint.activate([
            box.topAnchor.constraint(equalTo: view.topAnchor),
            box.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            box.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            box.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -32),
        ])
        errorView = box
    }

    private func hideErrorView() {
        errorView?.removeFromSuperview()
        errorView = nil
    }

    @objc private func retryTapped() {
        hideErrorView()
        if let url = webView.url, isAppURL(url) { webView.reload() } else { webView.load(URLRequest(url: Self.homeURL)) }
    }

    fileprivate func handlePrint() {
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = webView.title ?? "Naksara"
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        controller.present(animated: true, completionHandler: nil)
    }
}

// MARK: - Gezinme

extension WebViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        switch scheme {
        case "about", "blob", "data", "javascript":
            decisionHandler(.allow)
        case "http", "https":
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if isAppURL(url) || !isMainFrame {
                decisionHandler(.allow)
            } else {
                openExternally(url) // site dışı bağlantılar Safari'de açılır
                decisionHandler(.cancel)
            }
        default: // tel:, mailto:, whatsapp: vb.
            openExternally(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().contains("attachment") {
            decisionHandler(.download) // ör. sürüm geçmişinden JSON indirme
            return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideErrorView()
        refreshControl.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    private func handleFailure(_ error: Error) {
        refreshControl.endRefreshing()
        let nsError = error as NSError
        // İptal edilen yüklemeler ve indirmeye dönüşen gezinmeler hata sayılmaz.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204) { return }
        showErrorView(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload() // bellek nedeniyle kapanan sayfayı geri yükle
    }
}

// MARK: - JavaScript pencereleri ve yeni pencereler

extension WebViewController: WKUIDelegate {

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let top = topController else { completionHandler(); return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in completionHandler() })
        top.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let top = topController else { completionHandler(false); return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "İptal", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in completionHandler(true) })
        top.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard let top = topController else { completionHandler(nil); return }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "İptal", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text ?? "")
        })
        top.present(alert, animated: true)
    }

    // target="_blank" / window.open: site içiyse aynı ekranda, değilse Safari'de aç.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isAppURL(url) || url.scheme == "blob" || url.scheme == "data" {
                webView.load(navigationAction.request)
            } else {
                openExternally(url)
            }
        }
        return nil
    }
}

// MARK: - İndirmeler (Excel, CSV, JSON yedek)

extension WebViewController: WKDownloadDelegate {

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Indirilenler", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = suggestedFilename.isEmpty ? "naksara-dosya" : suggestedFilename
        let destination = folder.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: destination)
        downloads[download] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: download) else { return }
        share(fileAt: url) // Dosyalar'a kaydet, WhatsApp, Mail vb.
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: download)
        showMessage("İndirilemedi", error.localizedDescription)
    }
}

// MARK: - Sayfadan gelen mesajlar

/// WKUserContentController betik işleyicisini güçlü tuttuğu için zayıf aracı kullanılır (bellek sızıntısı olmasın).
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var owner: WebViewController?
    init(_ owner: WebViewController) { self.owner = owner }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "nativePrint" { owner?.handlePrint() }
    }
}
