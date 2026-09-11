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

/// Motion analysis, on synthetic frames so the expected answer is known.
final class MotionTests: XCTestCase {
    private func grid(_ fill: (Int, Int) -> UInt8) -> [UInt8] {
        var g = [UInt8](repeating: 0, count: Motion.cols * Motion.rows)
        for r in 0..<Motion.rows { for c in 0..<Motion.cols { g[r * Motion.cols + c] = fill(c, r) } }
        return g
    }

    /// Content that varies in both directions, so a shift has a unique best
    /// match. Horizontally uniform content makes every horizontal offset score
    /// identically, and the search then reports an arbitrary one.
    private func striped(offsetRows: Int = 0) -> [UInt8] {
        grid { c, r in UInt8((((r + offsetRows) * 13) + c * 7) % 256) }
    }

    func testIdenticalFramesAreStill() {
        XCTAssertEqual(Motion.difference(striped(), striped()), 0)
    }

    func testSettleNeedsConsecutiveStillFrames() {
        let still = striped()
        var history: [Motion.Frame] = []
        for i in 0..<5 { history.append(Motion.Frame(at: Double(i) * 100, gray: still)) }
        let state = Motion.state(history: history, now: 500)
        XCTAssertTrue(state.settled)
        XCTAssertGreaterThanOrEqual(state.stillFrames, Motion.stillFramesRequired)
    }

    func testAChangingScreenIsNotSettled() {
        var history: [Motion.Frame] = []
        for i in 0..<5 { history.append(Motion.Frame(at: Double(i) * 100, gray: striped(offsetRows: i * 6))) }
        XCTAssertFalse(Motion.state(history: history, now: 500).settled)
    }

    func testSpinnerIsNeitherStillNorASceneChange() {
        // Everything holds still except a small patch that keeps changing.
        var history: [Motion.Frame] = []
        for i in 0..<5 {
            var g = striped()
            for r in 40..<45 { for c in 20..<25 { g[r * Motion.cols + c] = UInt8((i * 90) % 256) } }
            history.append(Motion.Frame(at: Double(i) * 100, gray: g))
        }
        let state = Motion.state(history: history, now: 500)
        XCTAssertFalse(state.settled, "a spinner must not read as settled")
        XCTAssertNotNil(state.animatingRegion, "the moving patch should be localised")
    }

    func testVerticalShiftIsMeasured() {
        let (dx, dy, score) = Motion.shift(striped(), striped(offsetRows: 8))
        XCTAssertEqual(dy, -8, "content moved up by eight rows")
        XCTAssertEqual(dx, 0)
        XCTAssertLessThan(score, 0.02)
    }

    func testScrollIsClassifiedWithAnOffset() throws {
        let t = Motion.classify(before: striped(), after: striped(offsetRows: 8),
                                pointHeight: 874, pointWidth: 402)
        XCTAssertEqual(t.kind, .scroll)
        // XCTUnwrap rather than `!`: a force unwrap here kills the whole test
        // process with signal 5 and hides every other result.
        let offset = try XCTUnwrap(t.offset)
        // Eight of ninety-six rows of an 874pt screen.
        XCTAssertEqual(offset.y, -874 * 8 / 96, accuracy: 1)
    }

    func testIdenticalScreensClassifyAsNoChange() {
        let t = Motion.classify(before: striped(), after: striped(), pointHeight: 874, pointWidth: 402)
        XCTAssertEqual(t.kind, .none)
    }

    func testDimmingTheWholeScreenReadsAsSomethingPresenting() {
        let base = striped()
        let dimmed = base.map { UInt8(max(0, Int($0) - 60)) }
        let t = Motion.classify(before: base, after: dimmed, pointHeight: 874, pointWidth: 402)
        XCTAssertTrue([.sheetPresent, .alertPresent].contains(t.kind), "got \(t.kind)")
    }
}

/// An accessibility node becoming an element. The subrole matters: a search
/// field is a TextField to the tree and a SearchField to anyone reading the
/// map, and losing that costs the reader the only word that identifies it.
final class AccessibilityElementTests: XCTestCase {
    func testSubroleWinsWhenThereIsOne() {
        let node = AXNode(role: "TextField", subrole: "SearchField", label: nil, value: "Search",
                          identifier: "search", enabled: true, selected: false, focused: nil,
                          frame: CGRect(x: 32, y: 803, width: 336, height: 38), depth: 2)
        let element = Element(id: 0, node: node)
        XCTAssertEqual(element.role, "SearchField")
        XCTAssertEqual(element.value, "Search")
        XCTAssertEqual(element.identifier, "search")
        XCTAssertEqual(element.state.enabled, true)
        XCTAssertEqual(element.state.selected, false)
        XCTAssertNil(element.state.focused, "unknown stays unknown rather than becoming false")
        XCTAssertEqual(element.source.names, ["ax"])
        XCTAssertEqual(element.center, CGPoint(x: 200, y: 822))
    }

    func testPlainRoleSurvivesWithNoSubrole() {
        let node = AXNode(role: "Button", label: "Continue",
                          frame: CGRect(x: 38, y: 784, width: 326, height: 52), depth: 1)
        let element = Element(id: 3, node: node)
        XCTAssertEqual(element.role, "Button")
        XCTAssertEqual(element.label, "Continue")
        XCTAssertNil(element.identifier)
        XCTAssertNil(element.json["identifier"], "an absent identifier is absent, not null")
    }
}

/// The recovery path that only ever runs when nobody is watching.
///
/// A display teardown cannot be induced on demand, which is why this went
/// untested through two releases. The decision and the act can both be driven
/// with a stub, and that covers everything except the teardown itself.
final class CaptureRecoveryTests: XCTestCase {
    func testAMomentaryHiccupDoesNotReattach() {
        var recovery = CaptureRecovery(threshold: 6)
        for _ in 0..<5 { XCTAssertFalse(recovery.captureFailed(), "five failures is a hiccup") }
        XCTAssertEqual(recovery.consecutiveFailures, 5)
        recovery.captureSucceeded()
        XCTAssertEqual(recovery.consecutiveFailures, 0, "one good frame clears the run")
        for _ in 0..<5 { XCTAssertFalse(recovery.captureFailed()) }
    }

    func testASustainedRunReattachesAndRearmsTheCallback() {
        let platform = StubPlatform()
        _ = try? platform.attach(udid: "STUB-1")
        var recovery = CaptureRecovery(threshold: 3)
        XCTAssertFalse(recovery.captureFailed())
        XCTAssertFalse(recovery.captureFailed())
        XCTAssertTrue(recovery.captureFailed(), "the third failure is due a re-resolve")

        var damaged = false
        let outcome = recovery.reattach(platform: platform) { damaged = true }
        guard case .success(let after) = outcome else { return XCTFail("reattach should succeed on a live stub") }
        XCTAssertEqual(after, 3, "it reports how many reads it lost")
        XCTAssertEqual(platform.reattachCount, 1)
        XCTAssertEqual(recovery.consecutiveFailures, 0)

        // The callback half is the one that is easy to forget: a fresh
        // descriptor with nothing registered on it gives a daemon that has
        // recovered and will never notice another change.
        platform.simulateChange()
        XCTAssertTrue(damaged, "the damage callback was re-armed on the new descriptor")
    }

    func testReResolvingTwiceWithoutAFrameIsAStall() {
        // The pathology this is for: re-resolving *works* and reads keep
        // failing. Because a successful re-resolve clears the failure count,
        // the loop is six-failures-then-re-resolve for as long as you let it,
        // and no count of consecutive failures ever notices. Observed three
        // times in one afternoon; only a device restart cured it.
        let platform = StubPlatform()
        _ = try? platform.attach(udid: "STUB-1")
        var recovery = CaptureRecovery(threshold: 2)

        _ = recovery.captureFailed()
        XCTAssertTrue(recovery.captureFailed())
        _ = recovery.reattach(platform: platform, onDamage: {})
        XCTAssertFalse(recovery.isStalled, "one re-resolve is a recovery, not a stall")

        _ = recovery.captureFailed()
        XCTAssertTrue(recovery.captureFailed())
        _ = recovery.reattach(platform: platform, onDamage: {})
        XCTAssertTrue(recovery.isStalled, "the second says the port was never the problem")

        // And only a real frame clears it. Nothing else is evidence.
        recovery.captureSucceeded()
        XCTAssertFalse(recovery.isStalled)
        XCTAssertEqual(recovery.reattaches, 0)
    }

    func testTwoDeadReResolvesEscalateToRebindingTheDevice() {
        // The cure that used to require a human. Two successful re-resolves
        // with no frame between them says the port was never the problem, so
        // the next attempt rebinds the device itself — which is what
        // restarting the daemon did, and it was the only known cure for four
        // wedges in one afternoon.
        let platform = StubPlatform()
        _ = try? platform.attach(udid: "STUB-1")
        var recovery = CaptureRecovery(threshold: 1)

        XCTAssertFalse(recovery.needsRebind, "a healthy loop rebinds nothing")
        _ = recovery.captureFailed()
        _ = recovery.reattach(platform: platform, onDamage: {})
        XCTAssertFalse(recovery.needsRebind, "one re-resolve deserves the benefit of the doubt")
        _ = recovery.captureFailed()
        _ = recovery.reattach(platform: platform, onDamage: {})
        XCTAssertTrue(recovery.needsRebind, "two is enough")

        var damaged = false
        let outcome = recovery.rebind(platform: platform, udid: "STUB-1") { damaged = true }
        guard case .success = outcome else { return XCTFail("rebind should succeed on a live stub") }
        XCTAssertEqual(platform.rebindCount, 1, "it rebound the device, not the port")
        XCTAssertEqual(platform.reattachCount, 2, "and did not re-resolve a third time")
        XCTAssertEqual(recovery.consecutiveFailures, 0)

        // Still stalled: a rebind is an attempt, not evidence. Only a frame is.
        XCTAssertTrue(recovery.isStalled, "the reattach count is untouched by an attempt")
        platform.simulateChange()
        XCTAssertTrue(damaged, "the damage callback was re-armed on the new port")

        // Bounded, so a wedged device is not rebound every half second forever.
        _ = recovery.rebind(platform: platform, udid: "STUB-1", onDamage: {})
        XCTAssertFalse(recovery.needsRebind, "two attempts per stall episode is the cap")

        // And a real frame resets everything, including the rebind budget.
        recovery.captureSucceeded()
        XCTAssertFalse(recovery.isStalled)
        XCTAssertEqual(recovery.rebinds, 0)
    }

    func testAReattachThatKeepsFailingIsAlsoAStall() {
        // The other direction: when the re-resolve itself fails the count does
        // keep growing, because nothing resets it.
        let platform = StubPlatform()
        platform.failReattach = true
        var recovery = CaptureRecovery(threshold: 6)
        for _ in 0..<(CaptureRecovery.stalledAfterFailures - 1) { _ = recovery.captureFailed() }
        XCTAssertFalse(recovery.isStalled)
        _ = recovery.captureFailed()
        XCTAssertTrue(recovery.isStalled)
        XCTAssertEqual(recovery.reattaches, 0, "nothing was ever re-resolved")
    }

    func testAFailedReattachStaysDueRatherThanWaitingForAnotherSix() {
        let platform = StubPlatform()
        platform.failReattach = true
        var recovery = CaptureRecovery(threshold: 2)
        _ = recovery.captureFailed()
        XCTAssertTrue(recovery.captureFailed())
        guard case .failure = recovery.reattach(platform: platform, onDamage: {}) else {
            return XCTFail("a stub told to fail should fail")
        }
        XCTAssertEqual(recovery.consecutiveFailures, 2, "the run is not cleared by an attempt that did not work")
        XCTAssertTrue(recovery.captureFailed(), "so the next failure tries again immediately")
    }

    /// What happens when the ladder runs out, which was previously implicit —
    /// and the implicit answer was "start again at the bottom, forever".
    func testAnExhaustedLadderStopsPretendingItHasSomethingLeft() {
        let platform = StubPlatform()
        var recovery = CaptureRecovery(threshold: 1)
        XCTAssertFalse(recovery.recoveryExhausted, "nothing has been tried yet")

        // Two re-resolves that each succeed and change nothing: this is the
        // pathology, not a hypothetical. The port hands back a fresh descriptor
        // and every read still fails.
        for _ in 0..<CaptureRecovery.stalledAfterReattaches {
            _ = recovery.captureFailed()
            guard case .success = recovery.reattach(platform: platform, onDamage: {}) else {
                return XCTFail("the stub re-resolves")
            }
        }
        XCTAssertTrue(recovery.needsRebind, "so the escalation is due")
        XCTAssertFalse(recovery.recoveryExhausted, "but the ladder has a second rung")

        for _ in 0..<CaptureRecovery.maxRebinds {
            _ = recovery.captureFailed()
            guard case .success = recovery.rebind(platform: platform, udid: "UDID", onDamage: {}) else {
                return XCTFail("the stub rebinds")
            }
        }
        XCTAssertFalse(recovery.needsRebind, "the rebinds are spent")
        XCTAssertTrue(recovery.recoveryExhausted, "and so is the ladder")

        // Measured from a real wedge: 670 port re-resolves against 42 rebinds in
        // one log, because this state fell back to the bottom rung every sixth
        // failure at 600ms a go, each time logging "usually transient".
        _ = recovery.captureFailed()
        XCTAssertTrue(recovery.recoveryExhausted, "more failures do not restore an option")

        // A real frame is the only thing that resets it, exactly as for the rest
        // of this machine — a re-resolve must never look like recovery.
        recovery.captureSucceeded()
        XCTAssertFalse(recovery.recoveryExhausted, "a frame is the only evidence health is back")
        XCTAssertFalse(recovery.isStalled)
    }
}
