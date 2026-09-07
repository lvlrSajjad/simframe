import CoreGraphics
import Foundation

/// What the screen is doing, derived from frame history alone.
///
/// Everything here works on a small grayscale grid rather than the frame, so a
/// full analysis costs well under a millisecond and can run on every capture.
public enum Motion {
    /// Grid the analysis runs on. Large enough to localise a keyboard or a
    /// spinner and to measure a scroll offset; small enough to be free.
    public static let cols = 48
    public static let rows = 96

    /// Below this mean absolute difference, two frames are the same picture.
    public static let stillThreshold = 0.004
    /// Frames that must agree before the screen counts as settled.
    ///
    /// Paired with a duration, because frame count alone is not a measure of
    /// time: the capture loop slows to one frame every two seconds when nothing
    /// is happening, so requiring three consecutive still frames would take six
    /// seconds to call a motionless screen settled.
    public static let stillFramesRequired = 2
    public static let stillDurationRequired: Double = 200

    public struct Frame: Sendable {
        public let at: Double
        public let gray: [UInt8]
        public init(at: Double, gray: [UInt8]) {
            self.at = at
            self.gray = gray
        }
    }

    public enum Kind: String, Sendable {
        case none, scroll, push, pop
        /// The screen changed substantially, but not by translating — a tab
        /// switch, a reload, a different view entirely.
        case replace
        case sheetPresent = "sheet-present", sheetDismiss = "sheet-dismiss"
        case alertPresent = "alert-present", alertDismiss = "alert-dismiss"
        case keyboardUp = "keyboard-up", keyboardDown = "keyboard-down"
        case toast, loading
    }

    /// The quantities a classification was made from. Carried on the result
    /// because a misclassification is otherwise impossible to argue with.
    public struct Evidence: Sendable {
        public var overall = 0.0
        public var shiftDy = 0
        public var shiftScore = 0.0
        public var horizontalDx = 0
        public var horizontalScore = 0.0
        public var brightnessDelta = 0.0
        public var top = 0.0
        public var middle = 0.0
        public var bottom = 0.0

        public init() {}

        public var json: [String: Any] {
            func r(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
            return [
                "overall": r(overall),
                "dy": shiftDy, "dyScore": r(shiftScore),
                "dx": horizontalDx, "dxScore": r(horizontalScore),
                "brightness": (brightnessDelta * 10).rounded() / 10,
                "bands": ["top": r(top), "middle": r(middle), "bottom": r(bottom)],
            ]
        }
    }

    public struct Transition: Sendable {
        public let kind: Kind
        /// Pixel offset in points, for scroll and push/pop.
        public let offset: CGPoint?
        public let confidence: Double
        public let evidence: Evidence

        public init(kind: Kind, offset: CGPoint?, confidence: Double, evidence: Evidence = Evidence()) {
            self.kind = kind
            self.offset = offset
            self.confidence = confidence
            self.evidence = evidence
        }

        public var json: [String: Any] {
            var out: [String: Any] = [
                "kind": kind.rawValue,
                "confidence": (confidence * 100).rounded() / 100,
                "evidence": evidence.json,
            ]
            if let offset { out["offset"] = ["x": Int(offset.x.rounded()), "y": Int(offset.y.rounded())] }
            return out
        }
    }

    public struct State: Sendable {
        public let settled: Bool
        public let stillForMs: Double
        public let stillFrames: Int
        /// Set when a small area animates while everything else holds still —
        /// a spinner or a progress indicator. The screen is NOT settled.
        public let animatingRegion: CGRect?

        public var json: [String: Any] {
            var out: [String: Any] = [
                "settled": settled,
                "stillForMs": stillForMs.rounded(),
                "stillFrames": stillFrames,
            ]
            if let r = animatingRegion {
                out["animating"] = ["x": Int(r.origin.x), "y": Int(r.origin.y),
                                    "width": Int(r.width), "height": Int(r.height)]
            }
            return out
        }
    }

    // MARK: - Frame comparison

    public static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 1 }
        var sum = 0
        for i in 0..<a.count { sum += abs(Int(a[i]) - Int(b[i])) }
        return Double(sum) / Double(a.count) / 255.0
    }

    /// Per-cell absolute difference, used to localise what moved.
    public static func differenceMap(_ a: [UInt8], _ b: [UInt8]) -> [Double] {
        guard a.count == b.count else { return [] }
        return (0..<a.count).map { abs(Double(a[$0]) - Double(b[$0])) / 255.0 }
    }

    // MARK: - Settle

    /// Is the screen holding still, and if not, is one small part of it moving?
    public static func state(history: [Frame], now: Double) -> State {
        guard history.count >= 2 else {
            return State(settled: false, stillForMs: 0, stillFrames: 0, animatingRegion: nil)
        }
        var stillFrames = 0
        var stillSince = history.last!.at
        var i = history.count - 1
        while i > 0 {
            let d = difference(history[i].gray, history[i - 1].gray)
            if d > stillThreshold { break }
            stillFrames += 1
            stillSince = history[i - 1].at
            i -= 1
        }

        // A spinner keeps a small patch moving while the rest of the screen is
        // finished. Treating that as "still moving" would wait forever; treating
        // it as settled would read a half-drawn screen. It is neither, so it is
        // reported as its own thing.
        //
        // This must run even when the frames look still globally — that is the
        // whole point. A spinner covering half a percent of the screen moves the
        // mean difference by about 0.001, well under the still threshold, so
        // checking only when the global test already says "moving" never fires.
        var animating: CGRect?
        if history.count >= 3 {
            let recent = Array(history.suffix(4))
            var union: [Double] = Array(repeating: 0, count: cols * rows)
            for k in 1..<recent.count {
                let map = differenceMap(recent[k].gray, recent[k - 1].gray)
                for j in 0..<min(union.count, map.count) { union[j] = max(union[j], map[j]) }
            }
            // Per-cell, not global: a cell either changed or it did not.
            let cellThreshold = 0.06
            let moving = union.filter { $0 > cellThreshold }.count
            let fraction = Double(moving) / Double(union.count)
            // Small and persistent, rather than a screen changing.
            if fraction > 0 && fraction < 0.06 {
                animating = boundingBox(of: union, threshold: cellThreshold)
            }
        }

        return State(
            settled: stillFrames >= stillFramesRequired
                && (now - stillSince) >= stillDurationRequired
                && animating == nil,
            stillForMs: now - stillSince,
            stillFrames: stillFrames,
            animatingRegion: animating
        )
    }

    private static func boundingBox(of map: [Double], threshold: Double) -> CGRect? {
        var minX = cols, minY = rows, maxX = -1, maxY = -1
        for r in 0..<rows {
            for c in 0..<cols where map[r * cols + c] > threshold {
                minX = min(minX, c); maxX = max(maxX, c)
                minY = min(minY, r); maxY = max(maxY, r)
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }

    // MARK: - Shift estimation

    /// Rows that actually changed between two frames.
    ///
    /// A scrolling screen almost never scrolls all of itself: a navigation bar,
    /// a search field, a filter row and a tab bar stay put while the content
    /// between them moves. Searching the whole frame for a translation lets
    /// that fixed chrome — often a quarter of the screen, and pixel-identical —
    /// pin the answer at "no shift". Restricting the search to the rows that
    /// moved is what makes a real scroll measurable.
    public static func movingRows(_ a: [UInt8], _ b: [UInt8], threshold: Double = 0.02) -> ClosedRange<Int>? {
        var first = -1, last = -1
        for r in 0..<rows {
            var sum = 0
            for c in 0..<cols { sum += abs(Int(a[r * cols + c]) - Int(b[r * cols + c])) }
            let rowChange = Double(sum) / Double(cols) / 255.0
            if rowChange > threshold {
                if first < 0 { first = r }
                last = r
            }
        }
        guard first >= 0, last > first else { return nil }
        return first...last
    }

    /// Best whole-cell shift of `b` relative to `a` within `region`, by
    /// minimising absolute difference over candidate offsets.
    ///
    /// Phase correlation via FFT is the textbook approach, but at 48x96 a direct
    /// search over the plausible range is a fraction of a millisecond and has no
    /// windowing artefacts to reason about.
    public static func shift(
        _ a: [UInt8], _ b: [UInt8], maxShift: Int = 40, region: ClosedRange<Int>? = nil
    ) -> (dx: Int, dy: Int, score: Double) {
        let rowRange = region ?? 0...(rows - 1)
        var best = (dx: 0, dy: 0, score: Double.infinity)
        for dy in -maxShift...maxShift {
            for dx in -2...2 {          // horizontal drift during a vertical scroll
                var sum = 0, n = 0
                for r in rowRange {
                    let sr = r + dy
                    guard sr >= 0, sr < rows else { continue }
                    for c in 0..<cols {
                        let sc = c + dx
                        guard sc >= 0, sc < cols else { continue }
                        sum += abs(Int(a[r * cols + c]) - Int(b[sr * cols + sc]))
                        n += 1
                    }
                }
                guard n > rowRange.count * cols / 3 else { continue }
                let score = Double(sum) / Double(n) / 255.0
                if score < best.score { best = (dx, dy, score) }
            }
        }
        return best
    }

    /// Mean absolute difference restricted to the same rows, so a shift score
    /// and the baseline it is compared against are measured over one sample.
    public static func difference(_ a: [UInt8], _ b: [UInt8], region: ClosedRange<Int>) -> Double {
        var sum = 0, n = 0
        for r in region {
            for c in 0..<cols { sum += abs(Int(a[r * cols + c]) - Int(b[r * cols + c])); n += 1 }
        }
        return n == 0 ? 1 : Double(sum) / Double(n) / 255.0
    }

    /// Same, for a horizontal push or pop.
    public static func horizontalShift(_ a: [UInt8], _ b: [UInt8], maxShift: Int = 40) -> (dx: Int, score: Double) {
        var best = (dx: 0, score: Double.infinity)
        for dx in -maxShift...maxShift {
            var sum = 0, n = 0
            for r in stride(from: 0, to: rows, by: 2) {
                for c in 0..<cols {
                    let sc = c + dx
                    guard sc >= 0, sc < cols else { continue }
                    sum += abs(Int(a[r * cols + c]) - Int(b[r * cols + sc]))
                    n += 1
                }
            }
            guard n > cols * rows / 8 else { continue }
            let score = Double(sum) / Double(n) / 255.0
            if score < best.score { best = (dx, score) }
        }
        return best
    }
}

// MARK: - Transition classification

extension Motion {
    private static func meanBrightness(_ g: [UInt8]) -> Double {
        g.isEmpty ? 0 : Double(g.reduce(0) { $0 + Int($1) }) / Double(g.count)
    }

    /// Mean change within a horizontal band, given as fractions of height.
    private static func bandChange(_ map: [Double], from: Double, to: Double) -> Double {
        let r0 = Int(Double(rows) * from), r1 = max(r0 + 1, Int(Double(rows) * to))
        var sum = 0.0
        var n = 0
        for r in r0..<min(r1, rows) {
            for c in 0..<cols { sum += map[r * cols + c]; n += 1 }
        }
        return n == 0 ? 0 : sum / Double(n)
    }

    /// What happened between two settled screens.
    ///
    /// The order matters: a shift that explains the whole frame is a navigation
    /// or a scroll, and only when nothing explains the frame as a shift is it
    /// worth asking which band changed.
    public static func classify(before: [UInt8], after: [UInt8], pointHeight: Double, pointWidth: Double) -> Transition {
        let overall = difference(before, after)
        guard overall > stillThreshold else { return Transition(kind: .none, offset: nil, confidence: 1) }

        let map = differenceMap(before, after)
        let top = bandChange(map, from: 0, to: 0.12)         // status + nav
        let middle = bandChange(map, from: 0.12, to: 0.60)
        let bottom = bandChange(map, from: 0.60, to: 1.0)
        let brightnessDelta = meanBrightness(after) - meanBrightness(before)
        var evidence = Evidence()
        evidence.overall = overall
        evidence.brightnessDelta = brightnessDelta
        evidence.top = top; evidence.middle = middle; evidence.bottom = bottom

        // A shift that explains the frame better than the raw difference is
        // motion rather than a repaint.
        // Compare like with like: the shift score and the baseline it is judged
        // against must be measured over the same rows, or the ratio is
        // meaningless.
        let region = movingRows(before, after)
        let baseline = region.map { difference(before, after, region: $0) } ?? overall
        let h = horizontalShift(before, after)
        let v = shift(before, after, region: region)
        evidence.horizontalDx = h.dx; evidence.horizontalScore = h.score
        evidence.shiftDy = v.dy; evidence.shiftScore = v.score

        // Whichever direction explains the frame better wins. Requiring a
        // stable top band to call something a scroll was wrong: a scroll view
        // filling the screen moves the top too, and such a scroll fell through
        // to "no change".
        let horizontalWins = abs(h.dx) >= 4 && h.score < v.score
        let verticalWins = abs(v.dy) >= 2 && !horizontalWins
        let bestScore = horizontalWins ? h.score : v.score

        if (horizontalWins || verticalWins), bestScore < baseline * 0.7 {
            let confidence = min(1, (baseline - bestScore) / max(baseline, 0.0001))
            if horizontalWins {
                // Content moving left is a push; moving right is going back.
                return Transition(kind: h.dx < 0 ? .push : .pop,
                                  offset: CGPoint(x: Double(h.dx) / Double(cols) * pointWidth, y: 0),
                                  confidence: confidence, evidence: evidence)
            }
            return Transition(kind: .scroll,
                              offset: CGPoint(x: 0, y: Double(v.dy) / Double(rows) * pointHeight),
                              confidence: confidence, evidence: evidence)
        }

        // Bottom-only change is the keyboard. Which way is told by whether the
        // bottom gained detail or lost it.
        if bottom > overall * 1.6, top < overall * 0.35, middle < overall * 0.8 {
            let kind: Kind = brightnessDelta < 0 ? .keyboardUp : .keyboardDown
            return Transition(kind: kind, offset: nil, confidence: min(1, bottom / max(overall, 0.0001) / 2), evidence: evidence)
        }

        // Something laid over the screen dims everything behind it. An alert
        // changes the middle; a sheet takes the lower half.
        if abs(brightnessDelta) > 6 {
            let presenting = brightnessDelta < 0
            let sheetish = bottom > middle
            let kind: Kind = sheetish
                ? (presenting ? .sheetPresent : .sheetDismiss)
                : (presenting ? .alertPresent : .alertDismiss)
            return Transition(kind: kind, offset: nil, confidence: min(1, abs(brightnessDelta) / 40), evidence: evidence)
        }

        // A small banner at one edge, with the rest of the screen untouched.
        if top > overall * 2.2, middle < overall * 0.4, bottom < overall * 0.4 {
            return Transition(kind: .toast, offset: nil, confidence: min(1, top / max(overall, 0.0001) / 3), evidence: evidence)
        }

        // Plenty changed and nothing explains it as motion: the screen was
        // replaced. Saying so is more use to a caller than "none", which reads
        // as "nothing happened".
        if overall > stillThreshold * 4 {
            return Transition(kind: .replace, offset: nil,
                              confidence: min(1, overall * 12), evidence: evidence)
        }
        return Transition(kind: .none, offset: nil, confidence: 1 - min(1, overall * 4), evidence: evidence)
    }
}


extension Motion {
    /// The analysis grid, built with integer arithmetic and subsampling.
    ///
    /// `Hashing.grayGrid` averages every pixel in double precision, which is
    /// right for a hash that has to match the JavaScript byte for byte. Motion
    /// analysis has no such constraint and runs on every frame, so it samples
    /// every other pixel and stays in integers — about fifteen milliseconds a
    /// frame cheaper.
    public static func grid(from bmp: Bitmap) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: cols * rows)
        bmp.data.withUnsafeBufferPointer { src in
            for r in 0..<rows {
                let y0 = (r * bmp.height) / rows
                let y1 = max(y0 + 1, ((r + 1) * bmp.height) / rows)
                for c in 0..<cols {
                    let x0 = (c * bmp.width) / cols
                    let x1 = max(x0 + 1, ((c + 1) * bmp.width) / cols)
                    var sum = 0, n = 0
                    var y = y0
                    while y < y1 {
                        let row = y * bmp.width
                        var x = x0
                        while x < x1 {
                            let i = (row + x) * 4
                            // Integer luminance: 77/150/29 over 256.
                            sum += (Int(src[i]) * 77 + Int(src[i + 1]) * 150 + Int(src[i + 2]) * 29) >> 8
                            n += 1
                            x += 2
                        }
                        y += 2
                    }
                    out[r * cols + c] = n > 0 ? UInt8(min(255, sum / n)) : 0
                }
            }
        }
        return out
    }
}
