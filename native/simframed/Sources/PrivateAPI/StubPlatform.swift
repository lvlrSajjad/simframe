import CoreGraphics
import Foundation

/// A deterministic platform for tests and for machines without Xcode.
/// Renders a synthetic screen so hashing and frame-store logic can be tested
/// with no simulator present.
public final class StubPlatform: SimulatorPlatform {
    public var width: Int
    public var height: Int
    public var tint: UInt8
    private var buffer: [UInt8] = []
    /// What was asked of it, so tests can assert on gestures without a device.
    public var recorded: [String] = []

    public init(width: Int = 1206, height: Int = 2622, tint: UInt8 = 0) {
        self.width = width
        self.height = height
        self.tint = tint
    }

    public func bootedDevices() throws -> [DeviceInfo] {
        [DeviceInfo(udid: "STUB-0000", name: "Stub Device", runtime: "iOS 26.0")]
    }

    public func attach(udid: String?) throws -> DeviceInfo {
        DeviceInfo(udid: udid ?? "STUB-0000", name: "Stub Device", runtime: "iOS 26.0")
    }

    public func withFrame<T>(_ body: (RawFrame) throws -> T) throws -> T {
        let bytesPerRow = width * 4 + 40   // deliberate padding: mirrors real surfaces
        if buffer.count != bytesPerRow * height {
            buffer = [UInt8](repeating: 0, count: bytesPerRow * height)
        }
        for y in 0..<height {
            for x in 0..<width {
                let i = y * bytesPerRow + x * 4
                let band: UInt8 = x < width / 2 ? 40 : 200
                buffer[i] = band &+ tint          // B
                buffer[i + 1] = band              // G
                buffer[i + 2] = band              // R
                buffer[i + 3] = 255               // A
            }
        }
        return try buffer.withUnsafeBufferPointer { ptr in
            try body(RawFrame(width: width, height: height, bytesPerRow: bytesPerRow, pixels: ptr.baseAddress!))
        }
    }

    public func observeChanges(_ handler: @escaping () -> Void) throws {
        // The stub never changes on its own; tests drive `tint` and call this.
        stubHandler = handler
    }

    /// Test hook: mutate the synthetic screen and announce it.
    public func simulateChange() {
        tint = tint &+ 40
        stubHandler?()
    }

    private var stubHandler: (() -> Void)?

    public func detach() { stubHandler = nil }
}

extension StubPlatform {
    public func inputStatus() -> (available: Bool, detail: String) { (true, "stub") }
    public func tap(at point: CGPoint, durationMs: Double) throws { recorded.append("tap(\(Int(point.x)),\(Int(point.y)))") }
    public func swipe(from: CGPoint, to: CGPoint, durationMs: Double) throws {
        recorded.append("swipe(\(Int(from.x)),\(Int(from.y))->\(Int(to.x)),\(Int(to.y)))")
    }
    public func type(_ text: String) throws { recorded.append("type(\(text))") }
    public func press(_ button: HardwareButton) throws { recorded.append("press(\(button.rawValue))") }
}
