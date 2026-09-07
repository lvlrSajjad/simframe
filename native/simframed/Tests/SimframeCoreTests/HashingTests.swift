import XCTest
import PrivateAPI
@testable import SimframeCore

/// These run without a simulator, against StubPlatform, so the pure logic is
/// testable on any machine — including CI, which has no booted device.
final class HashingTests: XCTestCase {

    private func solid(_ w: Int, _ h: Int, _ v: UInt8) -> Bitmap {
        var data = [UInt8](repeating: 0, count: w * h * 4)
        for i in stride(from: 0, to: data.count, by: 4) {
            data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
        }
        return Bitmap(width: w, height: h, data: data)
    }

    private func split(_ w: Int, _ h: Int, left: UInt8, right: UInt8) -> Bitmap {
        var data = [UInt8](repeating: 0, count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let v = x < w / 2 ? left : right
                let i = (y * w + x) * 4
                data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
            }
        }
        return Bitmap(width: w, height: h, data: data)
    }

    func testFitMatchesSipsLongEdgeBehaviour() {
        // The real device shapes this has to reproduce.
        XCTAssertEqual(Bitmap.fit(width: 1206, height: 2622, longEdge: 700).0, 322)
        XCTAssertEqual(Bitmap.fit(width: 1206, height: 2622, longEdge: 700).1, 700)
        XCTAssertEqual(Bitmap.fit(width: 2064, height: 2752, longEdge: 700).0, 525)
        XCTAssertEqual(Bitmap.fit(width: 2064, height: 2752, longEdge: 700).1, 700)
        // Smaller than the target is left alone rather than upscaled.
        XCTAssertEqual(Bitmap.fit(width: 100, height: 200, longEdge: 700).1, 200)
    }

    func testGrayGridAveragesToLuminance() {
        XCTAssertEqual(Hashing.grayGrid(solid(20, 20, 255), cols: 2, rows: 2), [255, 255, 255, 255])
        XCTAssertEqual(Hashing.grayGrid(solid(20, 20, 0), cols: 2, rows: 2), [0, 0, 0, 0])
    }

    func testIdenticalScreensHashIdentically() {
        let a = split(64, 128, left: 20, right: 220)
        let b = split(64, 128, left: 20, right: 220)
        XCTAssertEqual(Hashing.frameHash(a), Hashing.frameHash(b))
        XCTAssertEqual(Hashing.layoutHash(a), Hashing.layoutHash(b))
        XCTAssertEqual(Hashing.signatureDiff(Hashing.regionSignature(a), Hashing.regionSignature(b)), 0)
    }

    func testMirroredLayoutIsFarAway() {
        let a = split(64, 128, left: 20, right: 220)
        let b = split(64, 128, left: 220, right: 20)
        // Well beyond the tolerance of 12 the screen memory uses.
        XCTAssertGreaterThan(Hashing.hashDistance(Hashing.layoutHash(a), Hashing.layoutHash(b)), 20)
    }

    func testHashesAreTheExpectedWidth() {
        let bmp = split(64, 128, left: 20, right: 220)
        XCTAssertEqual(Hashing.frameHash(bmp).count, 32, "128 bits as 32 hex characters")
        XCTAssertEqual(Hashing.layoutHash(bmp).count, 72, "288 bits as 72 hex characters")
        XCTAssertEqual(Hashing.signatureToHex(Hashing.regionSignature(bmp)).count, 64)
    }

    func testSignatureDiffTreatsMissingBaselineAsFullChange() {
        XCTAssertEqual(Hashing.signatureDiff(Hashing.regionSignature(solid(8, 8, 100)), nil), 1)
    }

    func testHashDistanceCountsBits() {
        XCTAssertEqual(Hashing.hashDistance("abcd", "abcd"), 0)
        XCTAssertEqual(Hashing.hashDistance("0", "f"), 4)
        XCTAssertEqual(Hashing.hashDistance("abc", "abcd"), Int.max, "different widths are incomparable")
    }

    func testStubPlatformProducesReadablePaddedFrames() throws {
        let stub = StubPlatform(width: 120, height: 260)
        _ = try stub.attach(udid: nil)
        let bmp = try stub.withFrame { frame -> Bitmap in
            // The stub pads its rows on purpose: honouring bytesPerRow is the
            // single easiest thing to get wrong against a real surface.
            XCTAssertEqual(frame.bytesPerRow, frame.width * 4 + 40)
            return Bitmap.from(frame, targetLongEdge: 130)
        }
        XCTAssertEqual(bmp.height, 130)
        XCTAssertEqual(bmp.width, 60)
        // Left half dark, right half light — a shear from bad padding would blur this.
        let leftPixel = Int(bmp.data[(65 * bmp.width + 5) * 4])
        let rightPixel = Int(bmp.data[(65 * bmp.width + bmp.width - 5) * 4])
        XCTAssertLessThan(leftPixel, 100)
        XCTAssertGreaterThan(rightPixel, 150)
    }

    func testChangeIsDetectedAcrossStubFrames() throws {
        let stub = StubPlatform(width: 80, height: 160)
        _ = try stub.attach(udid: nil)
        let before = try stub.withFrame { Hashing.regionSignature(Bitmap.from($0, targetLongEdge: 80)) }
        stub.simulateChange()
        let after = try stub.withFrame { Hashing.regionSignature(Bitmap.from($0, targetLongEdge: 80)) }
        XCTAssertGreaterThan(Hashing.signatureDiff(after, before), 0.004)
    }
}
