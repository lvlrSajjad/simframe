import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum PNGWriter {
    /// Write a packed RGBA bitmap as a PNG. Used for the frame files the Node
    /// readers consume, so it must produce an ordinary 8-bit RGBA PNG.
    public static func write(_ bmp: Bitmap, to url: URL) throws {
        try encode(bmp).write(to: url)
    }

    /// Encode once, write anywhere. The ring frame and `latest.png` are the
    /// same picture; encoding it twice doubled the cost of every capture.
    public static func encode(_ bmp: Bitmap) throws -> Data {
        var data = bmp.data
        guard let provider = CGDataProvider(data: Data(data) as CFData),
              let image = CGImage(
                width: bmp.width, height: bmp.height,
                bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: bmp.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider, decode: nil,
                shouldInterpolate: false, intent: .defaultIntent
              ) else {
            throw NSError(domain: "PNGWriter", code: 1, userInfo: [NSLocalizedDescriptionKey: "could not build image"])
        }
        data.removeAll()
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else {
            throw NSError(domain: "PNGWriter", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not create PNG destination"])
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw NSError(domain: "PNGWriter", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not encode PNG"])
        }
        return out as Data
    }
}
