import CoreGraphics
import Foundation
import PrivateAPI

/// Downscale through CoreGraphics rather than by box average.
///
/// `sips` — which the JavaScript capture loop uses — is a thin wrapper over
/// ImageIO/CoreGraphics, so resampling the same way is the closest we can get
/// to producing byte-identical hashes without reimplementing its filter.
public enum CoreGraphicsScaler {
    public static func bitmap(from frame: RawFrame, targetLongEdge: Int) -> Bitmap? {
        let (tw, th) = Bitmap.fit(width: frame.width, height: frame.height, longEdge: targetLongEdge)
        let srcBytes = frame.bytesPerRow * frame.height
        guard let provider = CGDataProvider(dataInfo: nil, data: frame.pixels, size: srcBytes, releaseData: { _, _, _ in }) else {
            return nil
        }
        // Surfaces are BGRA; this bitmapInfo is how CoreGraphics is told so.
        let srcInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue).union(.byteOrder32Little)
        guard let cgImage = CGImage(
            width: frame.width, height: frame.height,
            bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: frame.bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: srcInfo,
            provider: provider, decode: nil,
            shouldInterpolate: false, intent: .defaultIntent
        ) else { return nil }

        var out = [UInt8](repeating: 0, count: tw * th * 4)
        let ok = out.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(
                data: buf.baseAddress, width: tw, height: th,
                bitsPerComponent: 8, bytesPerRow: tw * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            ctx.interpolationQuality = .high
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: tw, height: th))
            return true
        }
        return ok ? Bitmap(width: tw, height: th, data: out) : nil
    }
}
