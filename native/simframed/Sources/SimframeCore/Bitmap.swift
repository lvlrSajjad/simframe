import Foundation
import PrivateAPI

/// A tightly-packed RGBA bitmap, which is what every algorithm below expects.
/// The simulator hands us padded BGRA, so conversion happens exactly once.
public struct Bitmap {
    public let width: Int
    public let height: Int
    public var data: [UInt8]   // RGBA, 4 bytes per pixel, no row padding

    public init(width: Int, height: Int, data: [UInt8]) {
        self.width = width
        self.height = height
        self.data = data
    }

    /// Convert a padded BGRA surface into packed RGBA, downscaling by box
    /// average in the same pass. Box averaging is what `grayGrid` does anyway,
    /// so doing it here keeps the scaled image consistent with the hashes.
    public static func from(_ frame: RawFrame, targetLongEdge: Int) -> Bitmap {
        let (tw, th) = Self.fit(width: frame.width, height: frame.height, longEdge: targetLongEdge)
        var out = [UInt8](repeating: 0, count: tw * th * 4)
        let src = frame.pixels

        for ty in 0..<th {
            let y0 = (ty * frame.height) / th
            let y1 = max(y0 + 1, ((ty + 1) * frame.height) / th)
            for tx in 0..<tw {
                let x0 = (tx * frame.width) / tw
                let x1 = max(x0 + 1, ((tx + 1) * frame.width) / tw)
                var r = 0, g = 0, b = 0, n = 0
                for y in y0..<y1 {
                    let row = y * frame.bytesPerRow
                    for x in x0..<x1 {
                        let i = row + x * 4
                        b += Int(src[i])          // surfaces are BGRA
                        g += Int(src[i + 1])
                        r += Int(src[i + 2])
                        n += 1
                    }
                }
                let o = (ty * tw + tx) * 4
                out[o] = UInt8(r / n)
                out[o + 1] = UInt8(g / n)
                out[o + 2] = UInt8(b / n)
                out[o + 3] = 255
            }
        }
        return Bitmap(width: tw, height: th, data: out)
    }

    /// Match `sips -Z`: the longer edge becomes `longEdge`, aspect preserved.
    public static func fit(width: Int, height: Int, longEdge: Int) -> (Int, Int) {
        guard width > 0, height > 0 else { return (1, 1) }
        if max(width, height) <= longEdge { return (width, height) }
        if height >= width {
            return (max(1, Int((Double(width) * Double(longEdge) / Double(height)).rounded())), longEdge)
        }
        return (longEdge, max(1, Int((Double(height) * Double(longEdge) / Double(width)).rounded())))
    }
}
