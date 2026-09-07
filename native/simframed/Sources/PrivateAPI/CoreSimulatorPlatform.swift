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

    private static let bootedState = 3

    public init() {}

    // MARK: - Framework loading

    private static var loaded = false

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
            if dlopen(path, RTLD_NOW) == nil {
                let reason = String(cString: dlerror())
                throw PrivateAPIError.frameworksUnavailable("\(name): \(reason)")
            }
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

    private func info(for device: NSObject) -> DeviceInfo {
        let udid = (device.value(forKey: "UDID") as? NSUUID)?.uuidString ?? "?"
        let name = device.value(forKey: "name") as? String ?? "?"
        var runtime = "?"
        if let rt = device.value(forKey: "runtime") as? NSObject {
            runtime = (rt.value(forKey: "versionString") as? String).map { "iOS \($0)" }
                ?? (rt.value(forKey: "name") as? String ?? "?")
        }
        return DeviceInfo(udid: udid, name: name, runtime: runtime)
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
            let resolved = info(for: device)
            attached = resolved
            return resolved
        }
        throw PrivateAPIError.noDisplayPort
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

    public func detach() {
        display = nil
        attached = nil
    }
}
