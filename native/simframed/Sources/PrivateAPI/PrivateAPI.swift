import Foundation

/// A frame as the simulator hands it to us: tightly-packed BGRA is not
/// guaranteed, so `bytesPerRow` must always be honoured rather than assumed
/// to equal `width * 4`.
public struct RawFrame {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public let pixels: UnsafePointer<UInt8>

    public init(width: Int, height: Int, bytesPerRow: Int, pixels: UnsafePointer<UInt8>) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.pixels = pixels
    }
}

public struct DeviceInfo: Sendable {
    public let udid: String
    public let name: String
    public let runtime: String
    /// Native pixels, as the framebuffer reports them.
    public let pixelWidth: Int
    public let pixelHeight: Int
    /// Points per pixel. Input coordinates are in points, frames are in pixels.
    public let scale: Double

    public var pointWidth: Int { scale > 0 ? Int((Double(pixelWidth) / scale).rounded()) : pixelWidth }
    public var pointHeight: Int { scale > 0 ? Int((Double(pixelHeight) / scale).rounded()) : pixelHeight }

    public init(udid: String, name: String, runtime: String,
                pixelWidth: Int = 0, pixelHeight: Int = 0, scale: Double = 1) {
        self.udid = udid
        self.name = name
        self.runtime = runtime
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.scale = scale
    }
}

/// Hardware buttons, named rather than numbered at call sites.
public enum HardwareButton: String, Sendable, CaseIterable {
    case home, lock, siri, volumeUp, volumeDown
}

public enum PrivateAPIError: Error, CustomStringConvertible {
    case frameworksUnavailable(String)
    case noBootedDevice
    case deviceNotFound(String)
    case noDisplayPort
    case surfaceUnavailable
    case hidUnavailable(String)
    case simctlFailed(String)

    public var description: String {
        switch self {
        case .frameworksUnavailable(let d): return "simulator frameworks unavailable: \(d)"
        case .noBootedDevice: return "no booted simulator"
        case .deviceNotFound(let u): return "no simulator matching \(u)"
        case .noDisplayPort: return "the device exposes no active display port"
        case .surfaceUnavailable: return "the display surface could not be read"
        case .hidUnavailable(let d): return "input is unavailable: \(d)"
        case .simctlFailed(let d): return "simctl \(d)"
        }
    }
}

/// The whole private surface simframe depends on. Anything that talks to
/// CoreSimulator or SimulatorKit goes through this.
public protocol SimulatorPlatform: AnyObject {
    func bootedDevices() throws -> [DeviceInfo]
    /// Bind to a device's display. Must be called before `withFrame`.
    func attach(udid: String?) throws -> DeviceInfo
    /// Re-resolve the display port on the device already attached.
    ///
    /// The descriptor handed out by `attach` can die under a live daemon: the
    /// simulator tears its display port down and builds a new one, and every
    /// `framebufferSurface` read on the old object returns nil from then on.
    /// Measured on one long session — capture reported "the display surface
    /// could not be read" for six minutes on a device that was awake and
    /// perfectly visible, and a daemon restart fixed it instantly. Without a
    /// way to re-resolve, a restart is the only cure.
    func reattachDisplay() throws -> DeviceInfo
    /// Rebind from scratch: a fresh device object as well as a fresh port.
    ///
    /// The escalation for when re-resolving the port has demonstrably not
    /// helped. `reattachDisplay` re-walks the cached device's ports, which
    /// re-finds the same dead descriptors when it is the device binding that
    /// is stale.
    func reattachDevice(udid: String?) throws -> DeviceInfo
    /// Borrow the current framebuffer. The pointer is only valid inside `body`.
    func withFrame<T>(_ body: (RawFrame) throws -> T) throws -> T
    /// Called whenever the display reports damage — the per-redraw signal, so a
    /// capture loop can be driven by the screen rather than by a timer.
    func observeChanges(_ handler: @escaping () -> Void) throws
    func detach()

    // MARK: Input. Optional: a platform may observe without being able to touch.

    /// Whether input is available, and why not when it is not.
    func inputStatus() -> (available: Bool, detail: String)
    /// A press and release at one point.
    func tap(at point: CGPoint, durationMs: Double) throws
    /// A deliberate hold. Named separately from `tap` because callers mean
    /// something different by it, even though the mechanism is a longer hold.
    func longPress(at point: CGPoint, durationMs: Double) throws
    /// Press, hold in place, then move and release. The hold is what separates
    /// a drag from a swipe: reorderable lists and drag-and-drop need the UI to
    /// register a pick-up before movement starts.
    func drag(from: CGPoint, to: CGPoint, holdMs: Double, durationMs: Double) throws
    /// A real down, interpolated moves, then up — never a teleporting jump.
    func swipe(from: CGPoint, to: CGPoint, durationMs: Double) throws
    func type(_ text: String) throws
    /// Put text on the device pasteboard and paste it.
    ///
    /// Key events are mapped by whatever keyboard layout iOS has active, so
    /// typing "Fryer 3" against a Persian layout yields Persian text with no
    /// error. The pasteboard carries characters rather than key positions, so
    /// it is the only reliable route for content that must be exact.
    func paste(_ text: String) throws
    func press(_ button: HardwareButton) throws
    /// Rebuild the HID session.
    ///
    /// Input has no feedback channel: a dispatched Indigo message reports
    /// success when the send succeeds, and there is no way to ask the device
    /// whether anything happened. Measured on a long-running daemon, a HOME
    /// press returned in 66ms and the screen never moved, while the same press
    /// on a freshly started daemon worked — so the session can stop delivering
    /// while still accepting. This is the recovery for that, and the caller
    /// that notices is the one with the frames.
    func resetInput() throws

    // MARK: Accessibility. Optional in the same way input is: a platform may
    // see the screen without being able to read the app's own tree.

    /// Whether the accessibility tree can be read, and why not when it cannot.
    func accessibilityStatus() -> (available: Bool, detail: String)
    /// The frontmost application's accessibility tree, flattened depth-first,
    /// carrying whether it is all of one.
    ///
    /// An app still launching has no tree yet, and this reports that as it is —
    /// one node, no children — rather than retrying until it looks populated.
    func accessibilityTree() throws -> AXTree

    // MARK: App lifecycle. These are simctl, not private API — no HID needed.

    @discardableResult
    func launch(bundleId: String, arguments: [String], environment: [String: String]) throws -> Int32
    func terminate(bundleId: String) throws
    func openURL(_ url: String) throws
    /// `action` is grant/revoke/reset, `service` one of simctl's privacy services.
    func permission(action: String, service: String, bundleId: String?) throws
}
