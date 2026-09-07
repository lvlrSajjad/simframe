import CoreGraphics
import Foundation
import ImageIO
import PrivateAPI

/// Writes the on-disk layout the Node readers already expect.
///
/// This is a compatibility surface, not a design: every field, filename and
/// retention rule here exists because `src/daemon.js` produced it and
/// `simframe state/look/wait/recall` reads it. Changing anything means changing
/// both sides together.
public final class FrameStore {
    public struct Options {
        public var ringSize = 400
        public var historySize = 400
        public var historyMs: Double = 90_000
        public var retainMs: Double = 60_000
        public var fineMs: Double = 6_000
        public var keyframeMs: Double = 450
        public var fullKeep = 8
        public var recallScale = 0.5
        public var maxRingBytes = 12 << 20
        public var changeThreshold = 0.004
        public var fullFrameIntervalMs: Double = 1000
        public var housekeepEvery = 20
        public var maxDim = 700
        public init() {}
    }

    /// State version of the on-disk format. Must match STATE_VERSION in
    /// src/daemon.js, or Node will treat this daemon as stale and replace it.
    public static let stateVersion = 5

    private let device: DeviceInfo
    private let options: Options
    private let root: URL
    private let fm = FileManager.default

    private var seq = 0
    private var prevSignature: [UInt8]?
    private var lastChangeAt = FrameStore.nowMs()
    private var history: [[String: Any]] = []
    private var ringIndex: [(seq: Int, at: Double, small: Bool)] = []

    public init(device: DeviceInfo, options: Options = Options()) throws {
        self.device = device
        self.options = options
        let home = fm.homeDirectoryForCurrentUser
        let base = ProcessInfo.processInfo.environment["SIMFRAME_HOME"]
            .map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent(".simframe")
        self.root = base.appendingPathComponent(device.udid)
        for sub in ["ring", "full"] {
            try fm.createDirectory(at: root.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
    }

    private var deviceJSON: [String: Any] {
        ["udid": device.udid, "name": device.name, "runtime": device.runtime, "state": "Booted"]
    }

    public static func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    private func writeAtomic(_ data: Data, to url: URL) throws {
        let tmp = url.appendingPathExtension("tmp-\(getpid())")
        try data.write(to: tmp)
        _ = try fm.replaceItemAt(url, withItemAt: tmp)
    }

    /// Claim the device. Node checks meta.json to decide whether a capture loop
    /// is already running, so writing it is what makes the Node CLI defer to us.
    public func claim() throws {
        let meta: [String: Any] = [
            "pid": Int(getpid()),
            "device": deviceJSON,
            "options": ["engine": "simframed", "maxDim": options.maxDim],
            "startedAt": Self.nowMs(),
            "version": Self.stateVersion,
        ]
        try writeAtomic(try JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted]),
                        to: root.appendingPathComponent("meta.json"))
    }

    public func release() {
        let url = root.appendingPathComponent("meta.json")
        guard var meta = (try? Data(contentsOf: url)).flatMap({ try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any],
              (meta["pid"] as? Int) == Int(getpid()) else { return }
        meta["pid"] = NSNull()
        meta["stoppedAt"] = Self.nowMs()
        try? writeAtomic(try JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted]), to: url)
    }

    /// Milliseconds since a client last asked for anything, so an unattended
    /// daemon can retire itself the way the Node one does.
    public func heartbeatAge() -> Double {
        let url = root.appendingPathComponent("heartbeat")
        if let text = try? String(contentsOf: url, encoding: .utf8), let at = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
            return Self.nowMs() - at
        }
        return .infinity
    }

    /// Whether meta.json still names this process. A replacement daemon taking
    /// over is how the single-writer rule is enforced.
    public func stillOwner() -> Bool {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("meta.json")),
              let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return (meta["pid"] as? Int) == Int(getpid())
    }

    private let fullWriteQueue = DispatchQueue(label: "simframe.fullframe", qos: .utility)
    private var lastFullAt: Double = 0

    /// Whether a native-resolution frame is worth taking on this tick. These
    /// exist only as an OCR source for the current screen, so one every so
    /// often is plenty — and encoding one costs ~115ms, far more than the
    /// entire rest of the loop.
    public func wantsFullFrame(now: Double = FrameStore.nowMs()) -> Bool {
        now - lastFullAt >= options.fullFrameIntervalMs
    }

    @discardableResult
    public func record(_ bmp: Bitmap, fullBitmap: Bitmap?, captureMs: Double) throws -> [String: Any] {
        let now = Self.nowMs()
        let nextSeq = seq + 1

        let signature = Hashing.regionSignature(bmp)
        let firstFrame = prevSignature == nil
        let diff = Hashing.signatureDiff(signature, prevSignature)
        let deltas = Hashing.regionDeltas(signature, prevSignature)
        let changed = !firstFrame && diff > options.changeThreshold
        if changed || firstFrame { lastChangeAt = now }

        let ringURL = root.appendingPathComponent("ring/\(nextSeq).png")
        let png = try PNGWriter.encode(bmp)
        try png.write(to: ringURL)
        try writeAtomic(png, to: root.appendingPathComponent("latest.png"))

        // Encoded off the capture path: a native-resolution PNG costs more
        // than everything else here combined.
        let fullURL = root.appendingPathComponent("full/\(nextSeq).png")
        if let fullBitmap {
            lastFullAt = now
            fullWriteQueue.async { try? PNGWriter.write(fullBitmap, to: fullURL) }
        }

        seq = nextSeq
        prevSignature = signature

        let hash = Hashing.frameHash(bmp)
        history.append([
            "seq": nextSeq, "at": now, "hash": hash,
            "sig": Hashing.signatureToHex(signature),
            "diff": firstFrame ? 0 : round(diff * 100_000) / 100_000,
        ])
        let cutoff = now - options.historyMs
        history = history.filter { ($0["at"] as? Double ?? 0) >= cutoff }.suffix(options.historySize).map { $0 }

        ringIndex.append((nextSeq, now, false))
        thinRing(now: now)
        // Housekeeping stats every retained frame, so it runs periodically
        // rather than on the capture path of every single tick.
        if nextSeq % options.housekeepEvery == 0 {
            shrinkAgedFrames(now: now)
            enforceByteBudget()
            pruneFull()
        }

        let state: [String: Any] = [
            "seq": nextSeq,
            "capturedAt": now,
            "captureMs": round(captureMs),
            "width": bmp.width,
            "height": bmp.height,
            "hash": hash,
            "layoutHash": Hashing.layoutHash(bmp),
            "diff": firstFrame ? NSNull() : round(diff * 100_000) / 100_000,
            "changed": changed,
            "firstFrame": firstFrame,
            "stableForMs": now - lastChangeAt,
            "regions": firstFrame ? deltas.map { _ in 0.0 } : deltas.map { round($0 * 10_000) / 10_000 },
            "lastChangeAt": lastChangeAt,
            "history": history,
            "ring": ringIndex.map { r -> [String: Any] in
                r.small ? ["seq": r.seq, "at": r.at, "small": true] : ["seq": r.seq, "at": r.at]
            },
            "fullFile": fullURL.path,
            "ringFile": ringURL.path,
            "device": deviceJSON,
        ]
        try writeAtomic(try JSONSerialization.data(withJSONObject: state), to: root.appendingPathComponent("state.json"))
        return state
    }

    /// Keep every frame inside `fineMs`, then roughly one per `keyframeMs` out
    /// to `retainMs`. Fine detail where transitions live, cheap recall beyond.
    private func thinRing(now: Double) {
        var kept: [(seq: Int, at: Double, small: Bool)] = []
        var lastKeptAt: Double?
        for frame in ringIndex.reversed() {
            let age = now - frame.at
            if age > options.retainMs { drop(frame.seq); continue }
            if age <= options.fineMs || lastKeptAt == nil || (lastKeptAt! - frame.at) >= options.keyframeMs {
                kept.append(frame)
                lastKeptAt = frame.at
            } else {
                drop(frame.seq)
            }
        }
        ringIndex = kept.reversed().suffix(options.ringSize).map { $0 }
    }

    private func drop(_ seq: Int) {
        try? fm.removeItem(at: root.appendingPathComponent("ring/\(seq).png"))
    }

    private func shrinkAgedFrames(now: Double) {
        for i in ringIndex.indices where !ringIndex[i].small && (now - ringIndex[i].at) > options.fineMs {
            let url = root.appendingPathComponent("ring/\(ringIndex[i].seq).png")
            if let small = CoreGraphicsScaler.downscalePNG(at: url, factor: options.recallScale) {
                try? PNGWriter.write(small, to: url)
            }
            // Marked regardless: a frame we cannot shrink is still a frame we
            // can serve, and retrying it every tick would be pure waste.
            ringIndex[i].small = true
        }
    }

    private func enforceByteBudget() {
        var total = 0
        var sizes: [Int] = []
        for f in ringIndex {
            let path = root.appendingPathComponent("ring/\(f.seq).png").path
            let size = ((try? fm.attributesOfItem(atPath: path))?[.size] as? Int) ?? 0
            sizes.append(size)
            total += size
        }
        var i = 0
        while i < ringIndex.count && total > options.maxRingBytes {
            drop(ringIndex[i].seq)
            total -= sizes[i]
            ringIndex.remove(at: i)
            sizes.remove(at: i)
        }
    }

    private func pruneFull() {
        let dir = root.appendingPathComponent("full")
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        let pngs = names.filter { $0.hasSuffix(".png") }
            .compactMap { name -> (Int, String)? in
                Int(name.replacingOccurrences(of: ".png", with: "")).map { ($0, name) }
            }
            .sorted { $0.0 < $1.0 }
        for (_, name) in pngs.dropLast(options.fullKeep) {
            try? fm.removeItem(at: dir.appendingPathComponent(name))
        }
    }
}
