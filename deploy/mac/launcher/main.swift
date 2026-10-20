import AppKit
import ServiceManagement

// Sterio Server for Mac. While the app is open the server runs; quitting
// the app stops it. Everything it knows (music folder, paired phones, library)
// stays in ~/Library/Application Support/Sterio Server between launches.
// Each launch, and a click on the Dock icon, opens the dashboard in the browser.
// The Sterio mark in the menu bar shows whether the server runs, its library
// and the address phones use, with the dashboard, music folder and Quit.
// The same app runs from the DMG and, sandboxed, from the Mac App Store: the
// launcher shows the folder window and keeps a security-scoped bookmark, and
// the server it starts inherits the access to that folder.
final class Server: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let dashboard = URL(string: "http://127.0.0.1:7767/")!
  private var process: Process?
  private var stopping = false
  private var failures: [Date] = []
  private var awake: NSObjectProtocol?
  private var input: FileHandle?
  private var output = Data()
  private var folderAccess: URL?
  private var dashboardShown = Date.distantPast
  private var restarting = false
  private var statusItem: NSStatusItem?
  private var summary = "Starting…"
  private let sandboxed = ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil
  private let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Sterio Server")
  private let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs/Sterio Server")
  private var settingsFile: URL { support.appendingPathComponent("settings.json") }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // A second copy (another location, or opened twice) only shows the page:
    // the ports belong to the one already running.
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
      .filter { $0 != NSRunningApplication.current }
    if let running = others.first {
      running.activate()
      NSWorkspace.shared.open(dashboard)
      NSApp.terminate(nil)
      return
    }
    let files = FileManager.default
    for folder in [support, support.appendingPathComponent("data"), support.appendingPathComponent("No music yet"), logs] {
      try? files.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    buildMenu()
    buildStatusItem()
    // The Mac stays awake for the phones while the server runs; the display may sleep.
    awake = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled], reason: "Sterio Server is sharing music")
    start()
    openWhenReady(attempt: 0)
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    NSWorkspace.shared.open(dashboard)
    return false
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    stopping = true
    guard let process, process.isRunning else { return .terminateNow }
    process.terminate()
    // The server closes its library cleanly; never wait longer than 8 seconds.
    DispatchQueue.global().async {
      let deadline = Date().addingTimeInterval(8)
      while process.isRunning && Date() < deadline { usleep(100_000) }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  private func settings() -> [String: Any] {
    guard let data = try? Data(contentsOf: settingsFile),
          let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return saved
  }
  private func save(_ settings: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted]) {
      try? data.write(to: settingsFile, options: [.atomic])
    }
  }
  private func musicFolder() -> String? {
    var saved = settings()
    if let encoded = saved["bookmark"] as? String, let bookmark = Data(base64Encoded: encoded) {
      var stale = false
      if let url = try? URL(resolvingBookmarkData: bookmark, options: sandboxed ? [.withSecurityScope] : [], relativeTo: nil, bookmarkDataIsStale: &stale) {
        folderAccess?.stopAccessingSecurityScopedResource()
        folderAccess = url.startAccessingSecurityScopedResource() ? url : nil
        if stale, let fresh = try? url.bookmarkData(options: sandboxed ? [.withSecurityScope, .securityScopeAllowOnlyReadAccess] : [], includingResourceValuesForKeys: nil, relativeTo: nil) {
          saved["bookmark"] = fresh.base64EncodedString()
          saved["musicDir"] = url.path
          save(saved)
        }
        if FileManager.default.fileExists(atPath: url.path) { return url.path }
      }
    }
    guard let folder = saved["musicDir"] as? String, FileManager.default.fileExists(atPath: folder) else { return nil }
    return folder
  }
  // The dashboard's "Choose music folder" button: the server asks on its
  // output and waits for the answer on its input.
  private func chooseFolder() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.message = "Choose the folder with your music"
    panel.prompt = "Choose"
    NSApp.activate(ignoringOtherApps: true)
    guard panel.runModal() == .OK, let url = panel.url else { return answer("cancelled") }
    guard let bookmark = try? url.bookmarkData(options: sandboxed ? [.withSecurityScope, .securityScopeAllowOnlyReadAccess] : [], includingResourceValuesForKeys: nil, relativeTo: nil) else {
      return answer("failed")
    }
    var saved = settings()
    saved["musicDir"] = url.path
    saved["bookmark"] = bookmark.base64EncodedString()
    save(saved)
    answer("chosen\t" + url.path)
  }
  private func answer(_ line: String) {
    try? input?.write(contentsOf: Data((line + "\n").utf8))
  }
  private func received(_ data: Data, log: FileHandle?) {
    log?.write(data)
    output.append(data)
    while let end = output.firstIndex(of: 10) {
      let line = String(decoding: output[output.startIndex..<end], as: UTF8.self)
      output.removeSubrange(output.startIndex...end)
      if line == "@@sterio choose-folder" { chooseFolder() }
      // A phone or another server asks to connect: show the page with the request.
      if line == "@@sterio open-dashboard", Date().timeIntervalSince(dashboardShown) > 30 {
        dashboardShown = Date()
        NSWorkspace.shared.open(dashboard)
        NSApp.requestUserAttention(.informationalRequest)
      }
    }
  }
  private func start() {
    guard !stopping, let resources = Bundle.main.resourceURL?.appendingPathComponent("server") else { return }
    // Node, FFmpeg and metaflac are signed helper tools in Contents/Helpers.
    let helpers = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers")
    let task = Process()
    task.executableURL = helpers.appendingPathComponent("node")
    task.arguments = [resources.appendingPathComponent("src/index.mjs").path]
    task.currentDirectoryURL = resources
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = helpers.path + ":/usr/bin:/bin:/usr/sbin:/sbin"
    environment["NODE_ENV"] = "production"
    environment["PORT"] = "7766"
    environment["MUSIC_DIR"] = musicFolder() ?? support.appendingPathComponent("No music yet").path
    environment["DATA_DIR"] = support.appendingPathComponent("data").path
    environment["SERVER_NAME"] = Host.current().localizedName ?? "Sterio on Mac"
    environment["ADMIN_ENABLED"] = "true"
    environment["ADMIN_BIND_ADDRESS"] = "127.0.0.1"
    environment["ADMIN_ALLOWED_HOSTS"] = "127.0.0.1:7767,localhost:7767"
    environment["STERIO_MAC_SETTINGS"] = settingsFile.path
    if sandboxed { environment["STERIO_MAC_SANDBOX"] = "1" }
    task.environment = environment
    let logFile = logs.appendingPathComponent("server.log")
    if (try? FileManager.default.attributesOfItem(atPath: logFile.path)[.size] as? Int) ?? 0 > 20_000_000 {
      try? FileManager.default.removeItem(at: logs.appendingPathComponent("server.old.log"))
      try? FileManager.default.moveItem(at: logFile, to: logs.appendingPathComponent("server.old.log"))
    }
    if !FileManager.default.fileExists(atPath: logFile.path) { FileManager.default.createFile(atPath: logFile.path, contents: nil) }
    let log = try? FileHandle(forWritingTo: logFile)
    log?.seekToEndOfFile()
    if let log { task.standardError = log }
    let stdout = Pipe(), stdin = Pipe()
    output = Data()
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { handle.readabilityHandler = nil; return }
      DispatchQueue.main.async { self?.received(data, log: log) }
    }
    task.standardOutput = stdout
    task.standardInput = stdin
    input = stdin.fileHandleForWriting
    task.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async { self?.ended(finished.terminationStatus) }
    }
    do { try task.run(); process = task } catch { fail("The server could not start: \(error.localizedDescription)") }
  }
  // 75: a new music folder was chosen, start again at once. Anything else is
  // a crash: start again, unless it keeps failing.
  private func ended(_ status: Int32) {
    process = nil
    input = nil
    if stopping { return }
    if restarting { restarting = false; return start() }
    if status != 75 {
      failures = failures.filter { $0.timeIntervalSinceNow > -60 } + [Date()]
      if failures.count >= 5 {
        let log = (try? String(contentsOf: logs.appendingPathComponent("server.log"), encoding: .utf8)) ?? ""
        fail(log.suffix(4000).contains("EADDRINUSE")
          ? "Another program on this Mac is using port 7766 or 7767, perhaps another Sterio Server. Close it, then open Sterio Server again."
          : "The server stopped several times in a row. The log is in ~/Library/Logs/Sterio Server.")
        return
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + (status == 75 ? 0.2 : 2)) { [weak self] in self?.start() }
  }
  private func openWhenReady(attempt: Int) {
    var request = URLRequest(url: dashboard.appendingPathComponent("api/status"))
    request.timeoutInterval = 1
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        if (response as? HTTPURLResponse)?.statusCode == 200 || attempt >= 40 { NSWorkspace.shared.open(self.dashboard) }
        else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.openWhenReady(attempt: attempt + 1) } }
      }
    }.resume()
  }
  private func fail(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Sterio Server"
    alert.informativeText = message
    alert.addButton(withTitle: "Show Log")
    alert.addButton(withTitle: "Quit")
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn { showLog() }
    NSApp.terminate(nil)
  }

  private func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Open Sterio Server", action: #selector(openDashboard), keyEquivalent: "o")
    appMenu.addItem(withTitle: "Show Server Log", action: #selector(showLog), keyEquivalent: "l")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Sterio Server", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)
    NSApp.mainMenu = main
  }
  @objc private func openDashboard() { NSWorkspace.shared.open(dashboard) }

  // The menu bar: the Sterio mark (a template image, so it follows the menu
  // bar's colour). Its menu is rebuilt each time it opens.
  private func buildStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let image = Bundle.main.image(forResource: "MenuBarIcon")
    image?.isTemplate = true
    image?.size = NSSize(width: 18, height: 18)
    item.button?.image = image
    item.button?.toolTip = "Sterio Server"
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    statusItem = item
  }
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let running = process?.isRunning == true
    let title = NSMenuItem(title: running ? "Sterio Server is running" : "Sterio Server is starting…", action: nil, keyEquivalent: "")
    title.image = NSImage(systemSymbolName: running ? "circle.fill" : "circle.dotted", accessibilityDescription: nil)?
      .withSymbolConfiguration(.init(paletteColors: [running ? .systemGreen : .systemOrange]))
    menu.addItem(title)
    menu.addItem(withTitle: summary, action: nil, keyEquivalent: "")
    if let address = phoneAddress() {
      let copy = NSMenuItem(title: "Phones connect to \(address)", action: #selector(copyAddress(_:)), keyEquivalent: "")
      copy.representedObject = address
      copy.toolTip = "Click to copy"
      copy.target = self
      menu.addItem(copy)
    }
    menu.addItem(.separator())
    add(menu, "Open Dashboard", #selector(openDashboard), "o")
    menu.addItem(.separator())
    let folder = musicFolder()
    menu.addItem(withTitle: "Music: " + (folder.map { FileManager.default.displayName(atPath: $0) } ?? "no folder chosen"), action: nil, keyEquivalent: "")
    add(menu, "Choose Music Folder…", #selector(chooseFromMenu), "")
    if folder != nil { add(menu, "Show Music in Finder", #selector(showMusic), "") }
    menu.addItem(.separator())
    if #available(macOS 13.0, *) {
      let login = add(menu, "Open at Login", #selector(toggleLogin), "")
      login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }
    add(menu, "Show Server Log", #selector(showLog), "l")
    menu.addItem(.separator())
    add(menu, "Quit Sterio Server", #selector(NSApplication.terminate(_:)), "q").target = NSApp
    refreshSummary()
  }
  @discardableResult private func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
    let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
    item.target = self
    return item
  }
  // The library line comes from the dashboard; it shows on the next opening.
  private func refreshSummary() {
    var request = URLRequest(url: dashboard.appendingPathComponent("api/status"))
    request.timeoutInterval = 2
    URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
      guard let data, let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
      let number = { (key: String) in NumberFormatter.localizedString(from: (status[key] as? NSNumber) ?? 0, number: .decimal) }
      let scanning = (status["scan"] as? [String: Any])?["running"] as? Bool == true
      let line = "\(number("albums")) albums · \(number("tracks")) tracks · \(number("devices")) devices" + (scanning ? " · scanning" : "")
      DispatchQueue.main.async { self?.summary = line }
    }.resume()
  }
  // The address of this Mac on the local network, as phones type it.
  private func phoneAddress() -> String? {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return nil }
    defer { freeifaddrs(list) }
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let entry = pointer.pointee
      guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
            String(cString: entry.ifa_name).hasPrefix("en") else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
      let ip = String(cString: host)
      if ip.hasPrefix("192.168.") || ip.hasPrefix("10.") || ip.range(of: #"^172\.(1[6-9]|2\d|3[01])\."#, options: .regularExpression) != nil { return ip }
    }
    return nil
  }
  @objc private func copyAddress(_ sender: NSMenuItem) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(sender.representedObject as? String ?? "", forType: .string)
  }
  @objc private func showMusic() {
    if let folder = musicFolder() { NSWorkspace.shared.open(URL(fileURLWithPath: folder)) }
  }
  // A folder chosen here is saved like one chosen on the dashboard; the
  // server then starts again with it.
  @objc private func chooseFromMenu() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.message = "Choose the folder with your music"
    panel.prompt = "Choose"
    NSApp.activate(ignoringOtherApps: true)
    guard panel.runModal() == .OK, let url = panel.url,
          let bookmark = try? url.bookmarkData(options: sandboxed ? [.withSecurityScope, .securityScopeAllowOnlyReadAccess] : [], includingResourceValuesForKeys: nil, relativeTo: nil) else { return }
    var saved = settings()
    saved["musicDir"] = url.path
    saved["bookmark"] = bookmark.base64EncodedString()
    save(saved)
    if let process, process.isRunning { restarting = true; process.terminate() } else { start() }
  }
  @available(macOS 13.0, *)
  @objc private func toggleLogin() {
    let service = SMAppService.mainApp
    do { if service.status == .enabled { try service.unregister() } else { try service.register() } }
    catch { NSSound.beep() }
  }
  @objc private func showLog() { NSWorkspace.shared.open(logs.appendingPathComponent("server.log")) }
  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Sterio Server", action: #selector(openDashboard), keyEquivalent: "")
    return menu
  }
}

// An answer written after the server stopped must not end the launcher.
signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = Server()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
