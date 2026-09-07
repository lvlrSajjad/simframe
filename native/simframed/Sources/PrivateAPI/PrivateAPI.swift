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
    public init(udid: String, name: String, runtime: String) {
        self.udid = udid
        self.name = name
        self.runtime = runtime
    }
}

public enum PrivateAPIError: Error, CustomStringConvertible {
    case frameworksUnavailable(String)
    case noBootedDevice
    case deviceNotFound(String)
    case noDisplayPort
    case surfaceUnavailable

    public var description: String {
        switch self {
        case .frameworksUnavailable(let d): return "simulator frameworks unavailable: \(d)"
        case .noBootedDevice: return "no booted simulator"
        case .deviceNotFound(let u): return "no simulator matching \(u)"
        case .noDisplayPort: return "the device exposes no active display port"
        case .surfaceUnavailable: return "the display surface could not be read"
        }
    }
}

/// The whole private surface simframe depends on. Anything that talks to
/// CoreSimulator or SimulatorKit goes through this.
public protocol SimulatorPlatform: AnyObject {
    func bootedDevices() throws -> [DeviceInfo]
    /// Bind to a device's display. Must be called before `withFrame`.
    func attach(udid: String?) throws -> DeviceInfo
    /// Borrow the current framebuffer. The pointer is only valid inside `body`.
    func withFrame<T>(_ body: (RawFrame) throws -> T) throws -> T
    /// Called whenever the display reports damage — the per-redraw signal, so a
    /// capture loop can be driven by the screen rather than by a timer.
    func observeChanges(_ handler: @escaping () -> Void) throws
    func detach()
}
