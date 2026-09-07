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

/// The Platform surface, exercised through StubPlatform so gestures and app
/// lifecycle can be tested with no simulator and no private frameworks.
final class PlatformSurfaceTests: XCTestCase {
    private func stub() throws -> StubPlatform {
        let s = StubPlatform(width: 120, height: 260)
        _ = try s.attach(udid: nil)
        return s
    }

    func testGesturesReachThePlatform() throws {
        let s = try stub()
        try s.tap(at: CGPoint(x: 10, y: 20), durationMs: 70)
        try s.longPress(at: CGPoint(x: 30, y: 40), durationMs: 600)
        try s.drag(from: CGPoint(x: 1, y: 2), to: CGPoint(x: 3, y: 4), holdMs: 500, durationMs: 400)
        try s.swipe(from: CGPoint(x: 5, y: 6), to: CGPoint(x: 7, y: 8), durationMs: 300)
        XCTAssertEqual(s.recorded, [
            "tap(10,20)",
            "longPress(30,40,600)",
            "drag(1,2->3,4,hold=500)",
            "swipe(5,6->7,8)",
        ])
    }

    func testAppLifecycleReachesThePlatform() throws {
        let s = try stub()
        _ = try s.launch(bundleId: "com.example.app", arguments: ["-a"], environment: ["K": "V"])
        try s.terminate(bundleId: "com.example.app")
        try s.openURL("myapp://x")
        try s.permission(action: "grant", service: "photos", bundleId: "com.example.app")
        XCTAssertEqual(s.recorded, [
            "launch(com.example.app)",
            "terminate(com.example.app)",
            "openURL(myapp://x)",
            "permission(grant,photos,com.example.app)",
        ])
    }

    func testTextRoutesAreDistinct() throws {
        let s = try stub()
        try s.type("abc")
        try s.paste("abc")
        // Two different mechanisms: key events are layout-dependent, paste is not.
        XCTAssertEqual(s.recorded, ["type(abc)", "paste(abc)"])
    }

    func testAsciiIsTypeableAndEmojiIsNot() {
        XCTAssertTrue(HIDKeyboard.canType("Fryer 3!"))
        XCTAssertFalse(HIDKeyboard.canType("Fryer 🍟"), "emoji has no usage code and must go via paste")
    }

    func testOnlyVerifiedButtonsHaveCodes() {
        XCTAssertEqual(HIDKeyboard.buttonCode(.home), 2)
        // Unverified codes must refuse rather than guess: a wrong Indigo button
        // can crash backboardd or lock the device.
        for button in [HardwareButton.lock, .siri, .volumeUp, .volumeDown] {
            XCTAssertNil(HIDKeyboard.buttonCode(button), "\(button.rawValue) is not verified")
        }
    }
}
