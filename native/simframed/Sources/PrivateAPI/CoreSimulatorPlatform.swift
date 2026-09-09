import Foundation
import IOSurface

/// The real implementation, against CoreSimulator + SimulatorKit.
///
/// Everything here was established by inspecting the live runtime rather than
/// from documentation, because there is none. Two findings are worth stating
/// because they contradict what public write-ups claim:
///
///  * `registerCallbackWithUUID:ioSurfacesChangeCallback:` does NOT deliver a
///    frame per redraw. It fires when the surface is *reallocated*, which is
///    rare. Reading `framebufferSurface` on demand is the correct capture path,
///    and it costs ~0.13ms.
///  * A device exposes several display ports. Only one has a non-zero
///    `displaySize`; the others vend nothing. Selecting the first port that
///    merely conforms to the protocol yields a permanently nil surface.
public final class CoreSimulatorPlatform: SimulatorPlatform {
    private var deviceSet: NSObject?
    private var display: NSObject?
    private var attached: DeviceInfo?
    // The block must outlive registration; releasing it would leave the
    // framework calling into freed memory.
    private var changeCallback: Any?
    private var changeUUID: NSUUID?
    private var device: NSObject?
    private var hid: IndigoHID?
    // Built on first use, not at attach: reading the tree is optional, and a
    // machine where the translation framework is missing must still capture.
    private var accessibility: AccessibilityBridge?
    private var accessibilityFailure: String?
    private let bridgeLock = NSLock()
    private var simulatorKitHandle: UnsafeMutableRawPointer?
    // Read once at attach: spawning simctl per status call cost 300ms.
    private var cachedKeyboardWarning: [String]?

    private static let bootedState = 3

    public init() {}

    // MARK: - Framework loading

    private static var loaded = false
    private static var simulatorKitHandles: UnsafeMutableRawPointer?

    private static func loadFrameworks() throws {
        guard !loaded else { return }
        let developerDir = Self.developerDir()
        let candidates = [
            ("CoreSimulator", "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"),
            ("SimulatorKit", "\(developerDir)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
        ]
        for (name, path) in candidates {
            guard FileManager.default.fileExists(atPath: path) else {
                throw PrivateAPIError.frameworksUnavailable("\(name) not found at \(path)")
            }
            guard let handle = dlopen(path, RTLD_NOW) else {
                let reason = String(cString: dlerror())
                throw PrivateAPIError.frameworksUnavailable("\(name): \(reason)")
            }
            if name == "SimulatorKit" { simulatorKitHandles = handle }
        }
        loaded = true
    }

    private static func developerDir() -> String {
        if let env = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !env.isEmpty { return env }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        p.arguments = ["-p"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (out?.isEmpty == false ? out! : "/Applications/Xcode.app/Contents/Developer")
    }

    // MARK: - Device discovery

    private func loadDeviceSet() throws -> NSObject {
        if let set = deviceSet { return set }
        try Self.loadFrameworks()
        guard let ctxClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
            throw PrivateAPIError.frameworksUnavailable("SimServiceContext missing")
        }
        typealias CtxFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutableRawPointer?) -> AnyObject?
        let ctxSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard let ctxImp = ctxClass.method(for: ctxSel) else {
            throw PrivateAPIError.frameworksUnavailable("sharedServiceContextForDeveloperDir: missing")
        }
        guard let ctx = unsafeBitCast(ctxImp, to: CtxFn.self)(ctxClass, ctxSel, Self.developerDir() as NSString, nil) as? NSObject else {
            throw PrivateAPIError.frameworksUnavailable("no service context")
        }
        typealias SetFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer?) -> AnyObject?
        let setSel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard let setImp = ctx.method(for: setSel),
              let set = unsafeBitCast(setImp, to: SetFn.self)(ctx, setSel, nil) as? NSObject else {
            throw PrivateAPIError.frameworksUnavailable("no device set")
        }
        deviceSet = set
        return set
    }

    private func devices() throws -> [NSObject] {
        (try loadDeviceSet()).value(forKey: "availableDevices") as? [NSObject] ?? []
    }

    /// KVC on these objects throws for unknown keys, so every read is guarded.
    private func safeValue(_ object: NSObject, _ key: String) -> Any? {
        object.responds(to: NSSelectorFromString(key)) ? object.value(forKey: key) : nil
    }

    private func info(for device: NSObject) -> DeviceInfo {
        let udid = (safeValue(device, "UDID") as? NSUUID)?.uuidString ?? "?"
        let name = safeValue(device, "name") as? String ?? "?"
        var runtime = "?"
        if let rt = safeValue(device, "runtime") as? NSObject {
            runtime = (safeValue(rt, "versionString") as? String).map { "iOS \($0)" }
                ?? (safeValue(rt, "name") as? String ?? "?")
        }
        // deviceType carries the screen in pixels plus its scale, which is how
        // input coordinates (points) are derived without idb.
        var pixels = CGSize.zero
        var scale = 1.0
        if let type = safeValue(device, "deviceType") as? NSObject {
            if let size = safeValue(type, "mainScreenSize") as? NSValue { pixels = size.sizeValue }
            if let s = safeValue(type, "mainScreenScale") as? NSNumber { scale = s.doubleValue }
        }
        return DeviceInfo(udid: udid, name: name, runtime: runtime,
                          pixelWidth: Int(pixels.width), pixelHeight: Int(pixels.height),
                          scale: scale > 0 ? scale : 1)
    }

    public func bootedDevices() throws -> [DeviceInfo] {
        try devices()
            .filter { ($0.value(forKey: "state") as? NSNumber)?.intValue == Self.bootedState }
            .map(info(for:))
    }

    // MARK: - Display attachment

    public func attach(udid: String?) throws -> DeviceInfo {
        let booted = try devices().filter { ($0.value(forKey: "state") as? NSNumber)?.intValue == Self.bootedState }
        guard !booted.isEmpty else { throw PrivateAPIError.noBootedDevice }
        let device: NSObject
        if let wanted = udid?.uppercased(), !wanted.isEmpty {
            guard let match = booted.first(where: {
                ((($0.value(forKey: "UDID") as? NSUUID)?.uuidString) ?? "").uppercased() == wanted
            }) else { throw PrivateAPIError.deviceNotFound(wanted) }
            device = match
        } else {
            device = booted[0]
        }

        return try resolveDisplay(on: device, warmInput: true)
    }

    /// Re-resolve the display port on the device we are already bound to.
    ///
    /// Input is deliberately left alone: the HID session is independent of the
    /// display port, it survives the port being replaced, and tearing it down
    /// to fix capture would break the half that still worked.
    public func reattachDisplay() throws -> DeviceInfo {
        guard let device else { throw PrivateAPIError.noDisplayPort }
        return try resolveDisplay(on: device, warmInput: false)
    }

    private func resolveDisplay(on device: NSObject, warmInput: Bool) throws -> DeviceInfo {
        guard let io = device.value(forKey: "io") as? NSObject,
              let ports = io.value(forKey: "ioPorts") as? [NSObject] else {
            throw PrivateAPIError.noDisplayPort
        }
        guard let proto = NSProtocolFromString("SimDisplayIOSurfaceRenderable") else {
            throw PrivateAPIError.frameworksUnavailable("SimDisplayIOSurfaceRenderable missing")
        }

        let descriptorSel = NSSelectorFromString("descriptor")
        let sizeSel = NSSelectorFromString("displaySize")
        typealias SizeFn = @convention(c) (AnyObject, Selector) -> CGSize

        for port in ports {
            guard port.responds(to: descriptorSel),
                  let descriptor = port.perform(descriptorSel)?.takeUnretainedValue() as? NSObject,
                  descriptor.conforms(to: proto),
                  descriptor.responds(to: sizeSel),
                  let sizeImp = descriptor.method(for: sizeSel) else { continue }
            // Several ports conform; only the live one reports a real size.
            let size = unsafeBitCast(sizeImp, to: SizeFn.self)(descriptor, sizeSel)
            guard size.width > 0, size.height > 0 else { continue }
            display = descriptor
            // The bridge captures one device's token and installs itself on a
            // process-wide translator, so it belongs to the device it was built
            // for. Binding to a different one must not inherit it.
            if self.device !== device {
                bridgeLock.lock()
                accessibility = nil
                accessibilityFailure = nil
                bridgeLock.unlock()
            }
            self.device = device
            let resolved = info(for: device)
            attached = resolved
            if warmInput {
                // Warm the HID session once, so the first gesture is not slower
                // than the rest. Input being unavailable must not stop capture.
                hid = try? IndigoHID(device: device, simulatorKit: Self.simulatorKitHandles)
                cachedKeyboardWarning = nonEnglishKeyboards()
            }
            return resolved
        }
        throw PrivateAPIError.noDisplayPort
    }

    // MARK: - Accessibility

    public func accessibilityStatus() -> (available: Bool, detail: String) {
        guard device != nil else { return (false, "no device attached") }
        do {
            // Constructing the bridge only proves the symbols are there. The
            // failure this path took two attempts to get past was a bridge that
            // constructed perfectly and read nothing, so this reads.
            try bridge().probe()
            return (true, "AXPTranslator, host-side")
        } catch {
            return (false, "\(error)")
        }
    }

    public func accessibilityTree() throws -> AXTree {
        try bridge().tree()
    }

    /// Serialised, because building a bridge installs a delegate on a
    /// **process-global** translator that holds it weakly.
    ///
    /// Two constructions racing both install; the loser's delegate is released
    /// and the survivor is left holding a translator whose delegate has
    /// deallocated, which answers nil for everything and sets no failure — the
    /// exact silent-nil this file's header warns about. The control socket is
    /// serial, but the capture loop's rebind path clears these same two fields,
    /// so there is a genuine second writer.
    private func bridge() throws -> AccessibilityBridge {
        bridgeLock.lock()
        defer { bridgeLock.unlock() }
        if let accessibility { return accessibility }
        // A framework that is missing stays missing; re-probing it on every
        // screen read would cost a dlopen per call to learn the same thing.
        if let accessibilityFailure { throw AccessibilityError.unavailable(accessibilityFailure) }
        guard let device else { throw PrivateAPIError.noBootedDevice }
        do {
            let made = try AccessibilityBridge(device: device)
            accessibility = made
            return made
        } catch {
            accessibilityFailure = "\(error)"
            throw error
        }
    }

    public func withFrame<T>(_ body: (RawFrame) throws -> T) throws -> T {
        guard let display else { throw PrivateAPIError.noDisplayPort }
        guard let raw = display.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue(),
              let surface = raw as? IOSurface else {
            throw PrivateAPIError.surfaceUnavailable
        }
        surface.lock(options: .readOnly, seed: nil)
        defer { surface.unlock(options: .readOnly, seed: nil) }
        guard let base = surface.baseAddress.assumingMemoryBound(to: UInt8.self) as UnsafeMutablePointer<UInt8>? else {
            throw PrivateAPIError.surfaceUnavailable
        }
        let frame = RawFrame(
            width: surface.width,
            height: surface.height,
            bytesPerRow: surface.bytesPerRow,
            pixels: UnsafePointer(base)
        )
        return try body(frame)
    }

    /// `registerCallbackWithUUID:damageRectanglesCallback:` on the *live* port
    /// fires roughly per redraw (~52/s while an app is switching). Registering
    /// it on the inactive port yields nothing, which is why this path is easy
    /// to dismiss as broken.
    public func observeChanges(_ handler: @escaping () -> Void) throws {
        guard let display else { throw PrivateAPIError.noDisplayPort }
        let sel = NSSelectorFromString("registerCallbackWithUUID:damageRectanglesCallback:")
        guard display.responds(to: sel), let imp = display.method(for: sel) else {
            throw PrivateAPIError.frameworksUnavailable("damageRectanglesCallback missing")
        }
        let block: @convention(block) (AnyObject?) -> Void = { _ in handler() }
        changeCallback = block
        let uuid = NSUUID()
        changeUUID = uuid
        typealias RegFn = @convention(c) (AnyObject, Selector, NSUUID, AnyObject) -> Void
        unsafeBitCast(imp, to: RegFn.self)(display, sel, uuid, block as AnyObject)
    }

    public func detach() {
        if let display, let uuid = changeUUID {
            let sel = NSSelectorFromString("unregisterDamageRectanglesCallbackWithUUID:")
            if display.responds(to: sel), let imp = display.method(for: sel) {
                typealias UnregFn = @convention(c) (AnyObject, Selector, NSUUID) -> Void
                unsafeBitCast(imp, to: UnregFn.self)(display, sel, uuid)
            }
        }
        changeCallback = nil
        changeUUID = nil
        display = nil
        attached = nil
    }
}

// MARK: - Input

extension CoreSimulatorPlatform {
    /// Gestures are real down → move → up sequences with human timings. A
    /// teleporting tap is not what a person does, and some UI treats it
    /// differently — flings need intermediate points to carry velocity.
    public enum Timing {
        public static let tapMs: Double = 70
        public static let stepMs: Double = 12          // ~83 Hz, finer than the display
        public static let keyStrokeMs: Double = 18
    }

    public func inputStatus() -> (available: Bool, detail: String) {
        if hid != nil {
            var detail = "Indigo HID (SimDeviceLegacyHIDClient)"
            if let layouts = cachedKeyboardWarning, !layouts.isEmpty {
                // Silent wrong text is the worst failure this layer has, so say
                // so up front rather than letting it surface as odd characters.
                detail += "; WARNING: \(layouts.joined(separator: ", ")) keyboard(s) installed — "
                    + "key events follow the active layout, so use paste for exact text"
            }
            return (true, detail)
        }
        if attached == nil { return (false, "not attached to a device") }
        return (false, "the HID client could not be created")
    }

    /// Keyboards installed on the device other than English and emoji. With
    /// `hw=Automatic` the hardware layout follows whichever of these is active,
    /// so their presence makes key-event typing unpredictable.
    private func nonEnglishKeyboards() -> [String]? {
        guard let udid = attached?.udid else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        p.arguments = ["simctl", "spawn", udid, "defaults", "read", ".GlobalPreferences", "AppleKeyboards"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        return text
            .split(separator: "\n")
            .compactMap { line -> String? in
                guard let at = line.range(of: "@sw=") else { return nil }
                let code = line[line.startIndex..<at.lowerBound]
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \",\t"))
                guard !code.isEmpty, code != "emoji", !code.hasPrefix("en") else { return nil }
                return code
            }
    }

    private func requireHID() throws -> (IndigoHID, CGSize) {
        guard let hid, let info = attached else {
            throw PrivateAPIError.hidUnavailable(inputStatus().detail)
        }
        return (hid, CGSize(width: info.pointWidth, height: info.pointHeight))
    }

    public func tap(at point: CGPoint, durationMs: Double = Timing.tapMs) throws {
        let (hid, screen) = try requireHID()
        hid.mouse(at: point, event: .down, screen: screen)
        Thread.sleep(forTimeInterval: max(0.01, durationMs / 1000))
        hid.mouse(at: point, event: .up, screen: screen)
    }

    public func longPress(at point: CGPoint, durationMs: Double = 600) throws {
        try tap(at: point, durationMs: max(durationMs, 400))
    }

    public func drag(from: CGPoint, to: CGPoint, holdMs: Double = 500, durationMs: Double = 400) throws {
        let (hid, screen) = try requireHID()
        hid.mouse(at: from, event: .down, screen: screen)
        // Hold still first: without it the UI reads a swipe, and a reorderable
        // list never enters drag mode at all.
        Thread.sleep(forTimeInterval: holdMs / 1000)
        let steps = max(2, Int(durationMs / Timing.stepMs))
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            hid.mouse(at: CGPoint(x: from.x + (to.x - from.x) * eased,
                                  y: from.y + (to.y - from.y) * eased),
                      event: .dragged, screen: screen)
            Thread.sleep(forTimeInterval: Timing.stepMs / 1000)
        }
        // Settle at the destination before lifting, so the drop lands there.
        Thread.sleep(forTimeInterval: 0.08)
        hid.mouse(at: to, event: .up, screen: screen)
    }

    public func swipe(from: CGPoint, to: CGPoint, durationMs: Double = 300) throws {
        let (hid, screen) = try requireHID()
        let steps = max(2, Int(durationMs / Timing.stepMs))
        hid.mouse(at: from, event: .down, screen: screen)
        for i in 1...steps {
            // Ease in and out, so the gesture accelerates and settles the way a
            // finger does rather than moving at a constant machine speed.
            let t = Double(i) / Double(steps)
            let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            let p = CGPoint(x: from.x + (to.x - from.x) * eased,
                            y: from.y + (to.y - from.y) * eased)
            hid.mouse(at: p, event: .dragged, screen: screen)
            Thread.sleep(forTimeInterval: Timing.stepMs / 1000)
        }
        hid.mouse(at: to, event: .up, screen: screen)
    }

    public func type(_ text: String) throws {
        let (hid, _) = try requireHID()
        // Key events carry a key *position*, which iOS maps through whatever
        // keyboard layout is active. There is no way to make that
        // layout-independent from out here — see docs/PRIVATE_API.md — so
        // anything that must be exact goes through paste() instead.
        for character in text.unicodeScalars {
            guard let usage = HIDKeyboard.usage(for: character) else { continue }
            if usage.shift { hid.key(usage: HIDKeyboard.leftShift, op: .down) }
            hid.key(usage: usage.code, op: .down)
            Thread.sleep(forTimeInterval: Timing.keyStrokeMs / 1000)
            hid.key(usage: usage.code, op: .up)
            if usage.shift { hid.key(usage: HIDKeyboard.leftShift, op: .up) }
            Thread.sleep(forTimeInterval: Timing.keyStrokeMs / 1000)
        }
    }

    public func paste(_ text: String) throws {
        let (hid, _) = try requireHID()
        guard let info = attached else { throw PrivateAPIError.hidUnavailable("not attached") }

        let copy = Process()
        copy.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        copy.arguments = ["simctl", "pbcopy", info.udid]
        let pipe = Pipe()
        copy.standardInput = pipe
        copy.standardError = FileHandle.nullDevice
        try copy.run()
        pipe.fileHandleForWriting.write(Data(text.utf8))
        pipe.fileHandleForWriting.closeFile()
        copy.waitUntilExit()
        guard copy.terminationStatus == 0 else {
            throw PrivateAPIError.hidUnavailable("simctl pbcopy failed (\(copy.terminationStatus))")
        }

        // Command-V. Modifiers are ordinary key usages held around the keystroke.
        hid.key(usage: HIDKeyboard.leftGUI, op: .down)
        hid.key(usage: HIDKeyboard.vKey, op: .down)
        Thread.sleep(forTimeInterval: 0.04)
        hid.key(usage: HIDKeyboard.vKey, op: .up)
        hid.key(usage: HIDKeyboard.leftGUI, op: .up)
    }

    /// simctl, run against the attached device.
    @discardableResult
    private func simctl(_ arguments: [String]) throws -> (status: Int32, output: String) {
        guard let udid = attached?.udid else { throw PrivateAPIError.noBootedDevice }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        p.arguments = ["simctl"] + [arguments[0]] + [udid] + Array(arguments.dropFirst())
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let out = String(data: data, encoding: .utf8) ?? ""
        guard p.terminationStatus == 0 else {
            throw PrivateAPIError.simctlFailed("\(arguments.joined(separator: " ")): \(out.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        return (p.terminationStatus, out)
    }

    @discardableResult
    public func launch(bundleId: String, arguments: [String] = [], environment: [String: String] = [:]) throws -> Int32 {
        var args = ["launch"]
        for (key, value) in environment { args += ["--setenv", "\(key)=\(value)"] }
        args.append(bundleId)
        args += arguments
        let result = try simctl(args)
        // simctl prints "<bundle>: <pid>\n". Trimming with .whitespaces leaves
        // the newline, so the parse silently yielded 0 — newlines need
        // .whitespacesAndNewlines.
        let pid = result.output
            .split(separator: ":").last
            .flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return pid ?? 0
    }

    public func terminate(bundleId: String) throws {
        try simctl(["terminate", bundleId])
    }

    public func openURL(_ url: String) throws {
        try simctl(["openurl", url])
    }

    public func permission(action: String, service: String, bundleId: String?) throws {
        var args = ["privacy", action, service]
        if let bundleId { args.append(bundleId) }
        try simctl(args)
    }

    /// Reset the HID session, and rebuild the client if the reset does not take.
    ///
    /// `resetHIDSession` is the framework's own selector; recreating the client
    /// is the bigger hammer for the case where the client itself is the stale
    /// thing. Cheap either way — constructing one has no effect on the device.
    public func resetInput() throws {
        guard let device else { throw PrivateAPIError.hidUnavailable("not attached to a device") }
        hid?.resetSession()
        hid = try? IndigoHID(device: device, simulatorKit: Self.simulatorKitHandles)
        guard hid != nil else { throw PrivateAPIError.hidUnavailable("could not rebuild the HID client") }
    }

    public func press(_ button: HardwareButton) throws {
        let (hid, _) = try requireHID()
        guard let code = HIDKeyboard.buttonCode(button) else {
            throw PrivateAPIError.hidUnavailable("no key code for \(button.rawValue)")
        }
        hid.button(keyCode: code, op: .down)
        Thread.sleep(forTimeInterval: 0.06)
        hid.button(keyCode: code, op: .up)
    }
}
