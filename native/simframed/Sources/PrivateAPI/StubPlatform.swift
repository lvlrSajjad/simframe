import Foundation

/// A deterministic platform for tests and for machines without Xcode.
/// Renders a synthetic screen so hashing and frame-store logic can be tested
/// with no simulator present.
public final class StubPlatform: SimulatorPlatform {
    public var width: Int
    public var height: Int
    public var tint: UInt8
    private var buffer: [UInt8] = []

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

    public func detach() {}
}
