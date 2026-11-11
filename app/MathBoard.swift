// Math Board: the board in a window of its own, instead of a browser tab.
//
// A thin viewer. The board is still the local page the board server serves on 127.0.0.1; this
// app shows that page in a WKWebView and adds what a browser gave for free or got in the way of:
// a window that remembers its place and can float over the terminal, the page's Clear and New
// board questions as native dialogs, and copying an item's reference without the browser's
// clipboard rules. It holds no board state and talks to nothing but the board's own address.
//
//   Math Board.app/Contents/MacOS/MathBoard --url 'http://127.0.0.1:<port>/#token=...'
//       what board_open runs (through `open -a`). The address is remembered.
//   ... --data-dir <folder>      find the board from <folder>/token.json and board.lock instead
//   ... --print-url              print the address it would open, then exit (no window)
//   ... --snapshot <file.png>    load the board, write a picture of it, then exit (for checking)
//
// Without arguments it opens the address it was last given, else the board of the default data
// folder (~/Library/Application Support/math-board, or $MATH_BOARD_DATA_DIR). While no board
// server answers it says so and keeps trying.
//
// Build: app/build.sh (swiftc from the Xcode command line tools; no Xcode project).

import Cocoa
import WebKit
import CryptoKit

// MARK: - Finding the board

let defaults = UserDefaults.standard

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// A board address is http://127.0.0.1:<port>/#token=<64 hex>, and nothing else is ever loaded.
func boardURL(_ text: String?) -> URL? {
    guard let text = text, let url = URL(string: text), url.scheme == "http", url.host == "127.0.0.1",
          let port = url.port, port > 0, url.path == "/" || url.path.isEmpty,
          let fragment = url.fragment, fragment.range(of: "^token=[a-f0-9]{64}(&[A-Za-z0-9=&._-]*)?$", options: .regularExpression) != nil
    else { return nil }
    return url
}

/// The address of the board that keeps its data in `dir`: the token from token.json, the port of
/// the running server (board.lock) or else the one it used last (token.json).
func discover(in dir: String) -> URL? {
    func json(_ name: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: (dir as NSString).appendingPathComponent(name)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    guard let session = json("token.json"), let token = session["token"] as? String else { return nil }
    guard let port = (json("board.lock")?["port"] as? Int) ?? (session["port"] as? Int) else { return nil }
    return boardURL("http://127.0.0.1:\(port)/#token=\(token)")
}

func defaultDataDir() -> String {
    if let dir = ProcessInfo.processInfo.environment["MATH_BOARD_DATA_DIR"], !dir.isEmpty { return dir }
    return (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/math-board")
}

/// The addresses this app was asked to show, newest first: --url at launch, then each address
/// board_open left in `lastURL` before it brought the running app to the front.
var wanted: [URL] = [boardURL(argument("--url"))].compactMap { $0 }

/// Where to look, in order: --data-dir alone; else the addresses asked for, the address given
/// last time and the default data folder. Several may be known; the first whose server answers
/// is shown.
func candidateURLs() -> [URL] {
    if let dir = argument("--data-dir") { return [discover(in: dir)].compactMap { $0 } }
    var found: [URL] = wanted
    if let dir = defaults.string(forKey: "dataDir"), let url = discover(in: dir), !found.contains(url) { found.append(url) }
    if let url = boardURL(defaults.string(forKey: "lastURL")), !found.contains(url) { found.append(url) }
    if let url = discover(in: defaultDataDir()), !found.contains(url) { found.append(url) }
    return found
}

func resolveURL() -> URL? { candidateURLs().first }

// MARK: - The window

final class BoardController: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var placeholder: NSTextField!
    var url: URL?
    var retry: Timer?
    var watch: Timer?
    var titleWatch: NSKeyValueObservation?
    let snapshotFile = argument("--snapshot")

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // no cookies, cache or history kept: the address carries the token
        config.userContentController.add(self, name: "mathBoard")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground") // black from the first frame, not a white flash
        web.autoresizingMask = [.width, .height]
        web.allowsMagnification = false // the page zooms the board itself (pinch, cmd-scroll)

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Math Board"
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 320, height: 220)
        window.isReleasedWhenClosed = false
        window.contentView = NSView(frame: web.frame)
        window.contentView!.addSubview(web)

        placeholder = NSTextField(wrappingLabelWithString: "")
        placeholder.alignment = .center
        placeholder.textColor = NSColor(white: 0.62, alpha: 1)
        placeholder.font = NSFont.systemFont(ofSize: 14)
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
            placeholder.widthAnchor.constraint(lessThanOrEqualTo: window.contentView!.widthAnchor, constant: -40),
        ])

        titleWatch = web.observe(\.title, options: [.new]) { [weak self] web, _ in
            let title = web.title ?? ""
            self?.window.title = title.isEmpty || title == "Blackboard" ? "Math Board" : title
        }
        buildMenu()
        if snapshotFile == nil {
            window.center()
            window.setFrameAutosaveName("board") // the window comes back where it was left
            setFloating(defaults.bool(forKey: "floating"))
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        connect()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // `open -a "Math Board" --args --url ...` while the app runs starts no second copy and the
    // arguments are dropped; macOS hands a reopen to this one, which shows its window again.
    // board_open writes the address to `lastURL` first, so a board other than the one on screen
    // (another data folder, or a new token) is picked up here.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        defaults.synchronize()
        if argument("--data-dir") == nil, let asked = boardURL(defaults.string(forKey: "lastURL")), asked != url || web.isHidden {
            wanted = [asked] + wanted.filter { $0 != asked }
            connect()
        }
        return true
    }

    /// Show the first known board whose server answers; otherwise say what to do and look again
    /// every 2 s.
    func connect() {
        retry?.invalidate()
        let known = candidateURLs()
        guard !known.isEmpty else {
            url = nil
            show("No board found.\n\nAsk the tutor to open the board (board_open, or /board in pi), then choose View > Reload.")
            retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.connect() }
            return
        }
        tryBoard(known[...])
    }

    func tryBoard(_ known: ArraySlice<URL>) {
        guard let url = known.first else {
            show("The board isn't running.\n\nIt starts when the tutor opens it (board_open, or /board in pi).\nThis window connects by itself.")
            retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.connect() }
            return
        }
        answers(url) { [weak self] ok in
            guard let self = self else { return }
            ok ? self.load(url) : self.tryBoard(known.dropFirst())
        }
    }

    /// Whether the board at `url` answers. Only the board can answer the question (see pingKey in
    /// server.mjs); a program that merely listens on its port is not shown and never sees the token.
    func answers(_ url: URL, then: @escaping (Bool) -> Void) {
        func hmac(_ key: String, _ message: String) -> String {
            HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: Data(key.utf8))).map { String(format: "%02x", $0) }.joined()
        }
        let token = String((url.fragment ?? "").dropFirst("token=".count).prefix(64))
        let nonce = (0..<24).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        let proof = hmac(hmac(token, "math-board ping"), nonce)
        var ping = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        ping.fragment = nil
        ping.path = "/api/ping"
        ping.queryItems = [URLQueryItem(name: "n", value: nonce)]
        var request = URLRequest(url: ping.url!)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let body = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            DispatchQueue.main.async { then(body?["name"] as? String == "math-board" && body?["proof"] as? String == proof) }
        }.resume()
    }

    func load(_ url: URL) {
        self.url = url
        if wanted.contains(url) { defaults.set(url.absoluteString, forKey: "lastURL") }
        placeholder.isHidden = true
        web.isHidden = false
        // A snapshot shows the board at rest (the page's static mode: nothing mid-fade).
        let shown = snapshotFile == nil ? url : URL(string: url.absoluteString + "&static=1") ?? url
        web.load(URLRequest(url: shown))
        // The page reconnects to its own address by itself. A board that came back at another
        // address (a new token, another known folder) is found here: the page on screen stays
        // until one answers.
        watch?.invalidate()
        if snapshotFile == nil { watch = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.lookElsewhere() } }
    }

    func lookElsewhere() {
        guard let shown = url, !web.isHidden else { return }
        answers(shown) { [weak self] ok in
            guard let self = self, !ok, self.url == shown else { return }
            func next(_ rest: ArraySlice<URL>) {
                guard let other = rest.first else { return }
                self.answers(other) { ok in
                    guard self.url == shown else { return }
                    ok ? self.load(other) : next(rest.dropFirst())
                }
            }
            next(candidateURLs().filter { $0 != shown }[...])
        }
    }

    func show(_ message: String) {
        placeholder.stringValue = message
        placeholder.isHidden = false
        web.isHidden = true
        if snapshotFile != nil { FileHandle.standardError.write("\(message)\n".data(using: .utf8)!); exit(2) }
    }

    // MARK: Navigation: the board's own address only

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let to = action.request.url
        let own = url != nil && to?.scheme == "http" && to?.host == "127.0.0.1" && to?.port == url?.port
        // An html artifact's frame may load about:blank and srcdoc documents inside itself.
        let inner = action.targetFrame?.isMainFrame == false && (to?.scheme == "about" || to?.scheme == "blob" || to?.scheme == "data")
        decisionHandler(own || inner ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { connect() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { connect() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { connect() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let file = snapshotFile else { return }
        waitThenSnapshot(file, tries: 0)
    }

    // MARK: The page's questions (Clear, New board) as dialogs

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, snapshotFile == nil else { return completionHandler(false) }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, snapshotFile == nil else { return completionHandler() }
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    // A new window (window.open, target=_blank) is never opened.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    // MARK: Copying an item's reference

    // The page posts { copy: "step 3, eq2 (chapter c1)" } when the learner clicks an item. Only the
    // board page itself may: an html artifact's frame must not write the clipboard.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let text = body["copy"] as? String, text.count <= 400 else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: Menu

    func buildMenu() {
        let main = NSMenu()
        let app = NSMenu()
        app.addItem(withTitle: "About Math Board", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Math Board", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Math Board", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = app; main.addItem(appItem)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        let float = view.addItem(withTitle: "Float on Top", action: #selector(toggleFloating), keyEquivalent: "t")
        float.keyEquivalentModifierMask = [.command, .shift]
        float.target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        let viewItem = NSMenuItem(); viewItem.submenu = view; main.addItem(viewItem)

        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let winItem = NSMenuItem(); winItem.submenu = win; main.addItem(winItem)
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    @objc func reload() { connect() }

    @objc func toggleFloating() { setFloating(window.level != .floating) }

    /// Float on top: the board stays over the terminal while you type in it.
    func setFloating(_ on: Bool) {
        window.level = on ? .floating : .normal
        defaults.set(on, forKey: "floating")
        for item in NSApp.mainMenu?.items ?? [] { item.submenu?.item(withTitle: "Float on Top")?.state = on ? .on : .off }
    }

    // MARK: --snapshot (checking that the page renders in this web view)

    func waitThenSnapshot(_ file: String, tries: Int) {
        web.evaluateJavaScript("window.__board ? [window.__board.revision, window.__board.pending] : null") { [weak self] value, _ in
            guard let self = self else { return }
            let state = value as? [Int]
            if let state = state, state[0] >= 0, state[1] == 0 {
                // Two frames later the last layout is on screen.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    self.web.takeSnapshot(with: nil) { image, _ in
                        guard let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
                            FileHandle.standardError.write("no picture\n".data(using: .utf8)!); exit(3)
                        }
                        try? png.write(to: URL(fileURLWithPath: file))
                        self.web.evaluateJavaScript("JSON.stringify({ revision: window.__board.revision, items: document.querySelectorAll('#blackboard > g[data-id]').length, issues: window.__boardLint().issues })") { summary, _ in
                            print(summary as? String ?? "{}")
                            exit(0)
                        }
                    }
                }
            } else if tries > 100 {
                FileHandle.standardError.write("the page did not get ready\n".data(using: .utf8)!); exit(4)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitThenSnapshot(file, tries: tries + 1) }
            }
        }
    }
}

// MARK: - Start

if CommandLine.arguments.contains("--print-url") {
    if let url = resolveURL() { print(url.absoluteString); exit(0) }
    FileHandle.standardError.write("no board found\n".data(using: .utf8)!)
    exit(1)
}

let application = NSApplication.shared
let controller = BoardController()
application.delegate = controller
application.setActivationPolicy(controller.snapshotFile == nil ? .regular : .prohibited)
application.run()
