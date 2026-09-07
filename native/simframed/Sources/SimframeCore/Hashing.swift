import Foundation

/// Ports of the algorithms in src/analyze.js.
///
/// These must stay bit-identical to the JavaScript, because screen-memory keys
/// and change baselines already on disk were computed by it. Any change here is
/// a change there, and vice versa.
public enum Hashing {
    public static let hashCols = 8
    public static let hashRows = 16
    public static let regionCols = 4
    public static let regionRows = 8
    public static let layoutCols = 12
    public static let layoutRows = 24
    public static let layoutTopSkip = 0.07

    /// Box-average into a small grayscale grid, matching grayGrid() exactly,
    /// including its integer truncation and its round-half-away-from-zero.
    public static func grayGrid(_ bmp: Bitmap, cols: Int, rows: Int) -> [UInt8] {
        var gray = [UInt8](repeating: 0, count: cols * rows)
        for ry in 0..<rows {
            let y0 = (ry * bmp.height) / rows
            let y1 = max(y0 + 1, ((ry + 1) * bmp.height) / rows)
            for rx in 0..<cols {
                let x0 = (rx * bmp.width) / cols
                let x1 = max(x0 + 1, ((rx + 1) * bmp.width) / cols)
                var sum = 0.0
                var n = 0
                for y in y0..<y1 {
                    for x in x0..<x1 {
                        let i = (y * bmp.width + x) * 4
                        sum += (Double(bmp.data[i]) * 299 + Double(bmp.data[i + 1]) * 587 + Double(bmp.data[i + 2]) * 114) / 1000
                        n += 1
                    }
                }
                gray[ry * cols + rx] = UInt8(clamping: Int((sum / Double(n)).rounded()))
            }
        }
        return gray
    }

    /// 128-bit mean-threshold hash of the whole frame: identical screens hash
    /// identically even though the encoded bytes never do.
    public static func frameHash(_ bmp: Bitmap) -> String {
        let gray = grayGrid(bmp, cols: hashCols, rows: hashRows)
        let mean = gray.reduce(0.0) { $0 + Double($1) } / Double(gray.count)
        var hex = ""
        var i = 0
        while i < gray.count {
            var nibble = 0
            for b in 0..<4 where Double(gray[i + b]) > mean { nibble |= 1 << b }
            hex += String(nibble, radix: 16)
            i += 4
        }
        return hex
    }

    /// A hash of layout rather than content: the status bar is cropped and each
    /// bit compares a cell with its right-hand neighbour, so new list rows and a
    /// ticking clock do not move it.
    public static func layoutHash(_ bmp: Bitmap) -> String {
        let top = Int(Double(bmp.height) * layoutTopSkip)
        let cropped = Bitmap(
            width: bmp.width,
            height: bmp.height - top,
            data: Array(bmp.data[(top * bmp.width * 4)...])
        )
        let gray = grayGrid(cropped, cols: layoutCols + 1, rows: layoutRows)
        var bits: [Int] = []
        bits.reserveCapacity(layoutCols * layoutRows)
        for r in 0..<layoutRows {
            for c in 0..<layoutCols {
                let i = r * (layoutCols + 1) + c
                bits.append(gray[i] > gray[i + 1] ? 1 : 0)
            }
        }
        var hex = ""
        var i = 0
        while i < bits.count {
            let nibble = bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3)
            hex += String(nibble, radix: 16)
            i += 4
        }
        return hex
    }

    public static func regionSignature(_ bmp: Bitmap) -> [UInt8] {
        grayGrid(bmp, cols: regionCols, rows: regionRows)
    }

    public static func signatureToHex(_ sig: [UInt8]) -> String {
        sig.map { String(format: "%02x", $0) }.joined()
    }

    public static func signatureDiff(_ a: [UInt8], _ b: [UInt8]?) -> Double {
        guard let b, a.count == b.count, !a.isEmpty else { return 1 }
        var sum = 0.0
        for i in 0..<a.count { sum += abs(Double(a[i]) - Double(b[i])) }
        return sum / Double(a.count) / 255.0
    }

    public static func regionDeltas(_ a: [UInt8], _ b: [UInt8]?) -> [Double] {
        guard let b, a.count == b.count else { return a.map { _ in 1 } }
        return (0..<a.count).map { abs(Double(a[$0]) - Double(b[$0])) / 255.0 }
    }

    private static let bitCount: [Int] = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4]

    public static func hashDistance(_ a: String, _ b: String) -> Int {
        guard a.count == b.count else { return Int.max }
        var d = 0
        for (x, y) in zip(a, b) {
            let xv = Int(String(x), radix: 16) ?? 0
            let yv = Int(String(y), radix: 16) ?? 0
            d += bitCount[(xv ^ yv) & 0xf]
        }
        return d
    }
}
