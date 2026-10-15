// grayout-overlay: turns every display grayscale with a click-through overlay
// window, so the Mac App Store edition can gray the screen inside the App
// Sandbox without the private Color Filters API the direct download uses.
//
// How it looks gray: each display gets a borderless, transparent window just
// below Grayout's red border (screen-saver level minus one) whose only layer
// is mid-gray composited with the "saturationBlendMode" Core Animation blend
// mode. The window server blends it with whatever is beneath, keeping the hue
// and brightness of the content but taking the layer's saturation, which is
// zero. Measured on macOS 26.5: chroma 0.000 under the overlay, luminance
// correlation 1.000 with the uncovered content. (A CIFilter object in place of
// the string draws a flat gray square instead; do not "fix" it to one.)
//
// The window ignores the mouse, so everything underneath keeps working.
//
// Two ways to run it:
//   grayout-overlay            persistent; one command per line on stdin,
//                              exactly one reply line on stdout:
//                                on | off | status | front | ping
//   grayout-overlay front      one shot; prints the frontmost app as JSON
//                              {"name": "...", "bundleId": "..."} and exits
//
// The persistent process exits when stdin closes (or its parent dies), so if
// Grayout quits or crashes the overlay windows die with it and the screen can
// never be left gray.
//
// Built by scripts/build-helper.sh (universal, macOS 13+, with an embedded
// Info.plist: a sandboxed executable without a bundle identifier is killed at
// launch).
import Cocoa

let hideFromCapture = CommandLine.arguments.contains("--hide-from-capture")

final class Overlay {
    private var windows: [NSWindow] = []
    var isOn: Bool { !windows.isEmpty }

    func on() {
        rebuild()
    }

    func off() {
        for w in windows { w.orderOut(nil); w.close() }
        windows.removeAll()
    }

    // Called on display changes while on, so a new or resized display is covered.
    func rebuild() {
        off()
        for screen in NSScreen.screens {
            windows.append(makeWindow(for: screen))
        }
    }

    private func makeWindow(for screen: NSScreen) -> NSWindow {
        let w = NSWindow(contentRect: screen.frame, styleMask: [.borderless],
                         backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.isOpaque = false
        w.backgroundColor = .clear
        w.hasShadow = false
        w.ignoresMouseEvents = true
        // Below the red border (Electron's 'screen-saver' level), so the border
        // stays red; above the menu bar, the Dock and full-screen apps.
        w.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue - 1)
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // Default: screenshots (Grayout's own checks, screen shares) see the
        // gray too, which is verified to show on the display. --hide-from-capture
        // leaves the overlay out of captures; that is not yet verified on a
        // physical display, so it is opt-in.
        w.sharingType = hideFromCapture ? .none : .readOnly
        w.animationBehavior = .none

        let view = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        view.wantsLayer = true
        let layer = CALayer()
        layer.frame = view.bounds
        layer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        layer.backgroundColor = NSColor(white: 0.5, alpha: 1).cgColor
        layer.compositingFilter = "saturationBlendMode"
        view.layer?.addSublayer(layer)
        w.contentView = view
        w.setFrame(screen.frame, display: false)
        w.orderFrontRegardless()
        return w
    }
}

func frontmostJSON() -> String {
    let app = NSWorkspace.shared.frontmostApplication
    let obj: [String: String] = [
        "name": app?.localizedName ?? "",
        "bundleId": app?.bundleIdentifier ?? ""
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let s = String(data: data, encoding: .utf8) else { return "{}" }
    return s
}

func reply(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

// One-shot mode: no run loop, no windows.
if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "front" {
    reply(frontmostJSON())
    exit(0)
}

let overlay = Overlay()

func handle(_ raw: String) {
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines) {
    case "on":
        overlay.on()
        reply(overlay.isOn ? "on" : "error no displays")
    case "off":
        overlay.off()
        reply("off")
    case "status":
        reply(overlay.isOn ? "on" : "off")
    case "front":
        reply(frontmostJSON())
    case "ping":
        reply("pong")
    case "":
        break
    default:
        reply("error unknown command")
    }
}

let app = NSApplication.shared
// Accessory: no Dock icon or menu bar, but allowed to own windows.
app.setActivationPolicy(.accessory)

NotificationCenter.default.addObserver(
    forName: NSApplication.didChangeScreenParametersNotification,
    object: nil, queue: .main
) { _ in
    if overlay.isOn { overlay.rebuild() }
}

func shutdown() -> Never {
    overlay.off()
    exit(0)
}

// Read stdin off the main thread; every command runs on the main thread,
// where AppKit requires window work to happen.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        DispatchQueue.main.sync { handle(line) }
    }
    // stdin closed: Grayout is gone. Leave nothing behind.
    DispatchQueue.main.async { shutdown() }
}

// Backstop: if the parent died without closing our stdin, we were reparented
// to launchd (pid 1).
Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
    if getppid() == 1 { shutdown() }
}

app.run()
