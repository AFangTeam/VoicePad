import AppKit
import WebKit

final class VoicePadApp: NSObject, NSApplicationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var outputPipe: Pipe?
    private var outputBuffer = ""
    private var isQuitting = false
    private var loadedPage = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = self
        webView.loadHTMLString("""
            <html><body style="margin:0;background:#101720;color:#dce6ed;display:grid;place-items:center;height:100vh;font:16px -apple-system,BlinkMacSystemFont,sans-serif">正在启动 VoicePad…</body></html>
            """, baseURL: nil)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "VoicePad"
        window.minSize = NSSize(width: 850, height: 600)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        isQuitting = true
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        if let server, server.isRunning { server.terminate() }
    }

    private func startServer() {
        guard let resources = Bundle.main.resourceURL else {
            showFailure("应用资源缺失。请重新构建 VoicePad.app。")
            return
        }

        let executableDir = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS")
        let node = executableDir.appendingPathComponent("node")
        let webRoot = resources.appendingPathComponent("web")
        let process = Process()
        process.executableURL = node
        process.arguments = [webRoot.appendingPathComponent("server.js").path]
        process.currentDirectoryURL = webRoot

        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = "0"
        environment["PATH"] = "\(executableDir.path):/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let chunk = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.consumeOutput(chunk) }
        }
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, !self.isQuitting else { return }
                self.showFailure("本地服务已退出（代码 \(finished.terminationStatus)）。请重新打开应用。")
            }
        }

        do {
            try process.run()
            server = process
            outputPipe = pipe
        } catch {
            showFailure("无法启动本地服务：\(error.localizedDescription)")
        }
    }

    private func consumeOutput(_ chunk: String) {
        outputBuffer += chunk
        if outputBuffer.count > 16_000 { outputBuffer = String(outputBuffer.suffix(8_000)) }
        guard !loadedPage,
              let range = outputBuffer.range(of: #"http://localhost:(\d+)"#, options: .regularExpression),
              let port = Int(outputBuffer[range].split(separator: ":").last ?? ""),
              let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        loadedPage = true
        webView.load(URLRequest(url: url))
    }

    private func showFailure(_ message: String) {
        let escaped = message.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        webView.loadHTMLString("""
            <html><body style="margin:0;background:#101720;color:#dce6ed;display:grid;place-items:center;height:100vh;font:16px -apple-system,BlinkMacSystemFont,sans-serif"><div><h2>VoicePad 启动失败</h2><p>\(escaped)</p></div></body></html>
            """, baseURL: nil)
    }

    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

let app = NSApplication.shared
let delegate = VoicePadApp()
app.delegate = delegate
app.run()
