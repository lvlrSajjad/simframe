import CoreGraphics
import Foundation
import PrivateAPI
import SimframeCore

/// Resident size of this process, in bytes, or 0 if the kernel will not say.
///
/// Logged with throughput because the capture wedge has no established cause
/// and memory pressure is one of two candidates. A number in the log every
/// second is what lets the next wedge be correlated with a spike — or clear
/// memory of suspicion, which is just as useful.
func residentBytes() -> UInt64 {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(
        MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size
    )
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), rebound, &count)
        }
    }
    return result == KERN_SUCCESS ? info.resident_size : 0
}

let args = Array(CommandLine.arguments.dropFirst())
func flag(_ name: String) -> String? {
    guard let a = args.first(where: { $0.hasPrefix("--\(name)=") }) else { return nil }
    return String(a.dropFirst(name.count + 3))
}

/// How long a `ui` request may spend on its two reads before what has not
/// arrived is reported as missing.
///
/// Just inside the client's own 30 s give-up, because a read the caller has
/// already abandoned is worth nothing, and stopping any earlier than that
/// converts a slow-but-correct read into a failure. See the `ui` handler.
let readBudgetMs = 25_000

let command = args.first(where: { !$0.hasPrefix("--") }) ?? "run"
let platform: SimulatorPlatform = args.contains("--stub") ? StubPlatform() : CoreSimulatorPlatform()
let longEdge = Int(flag("max-dim") ?? "") ?? 700

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("simframed: \(message)\n".data(using: .utf8)!)
    exit(1)
}

switch command {
case "devices":
    do {
        for d in try platform.bootedDevices() { print("\(d.udid)  \(d.name)  \(d.runtime)") }
    } catch { fail("\(error)") }

case "hash":
    // One-shot: used to verify the Swift hashes match the JavaScript ones.
    do {
        let device = try platform.attach(udid: flag("udid"))
        let t0 = DispatchTime.now().uptimeNanoseconds
        let useCG = !args.contains("--box")
        let (bmp, native) = try platform.withFrame { frame -> (Bitmap, (Int, Int)) in
            let scaled = useCG
                ? (CoreGraphicsScaler.bitmap(from: frame, targetLongEdge: longEdge) ?? Bitmap.from(frame, targetLongEdge: longEdge))
                : Bitmap.from(frame, targetLongEdge: longEdge)
            return (scaled, (frame.width, frame.height))
        }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
        let json: [String: Any] = [
            "device": ["udid": device.udid, "name": device.name, "runtime": device.runtime],
            "native": ["width": native.0, "height": native.1],
            "scaled": ["width": bmp.width, "height": bmp.height],
            "hash": Hashing.frameHash(bmp),
            "layoutHash": Hashing.layoutHash(bmp),
            "regions": Hashing.signatureToHex(Hashing.regionSignature(bmp)),
            "captureMs": (ms * 100).rounded() / 100,
        ]
        let data = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
    } catch { fail("\(error)") }

case "bench":
    do {
        _ = try platform.attach(udid: flag("udid"))
        let n = Int(flag("n") ?? "") ?? 200
        var grab: [Double] = [], full: [Double] = []
        for _ in 0..<n {
            let t0 = DispatchTime.now().uptimeNanoseconds
            let bmp = try platform.withFrame { Bitmap.from($0, targetLongEdge: longEdge) }
            let t1 = DispatchTime.now().uptimeNanoseconds
            _ = Hashing.frameHash(bmp)
            _ = Hashing.layoutHash(bmp)
            let t2 = DispatchTime.now().uptimeNanoseconds
            grab.append(Double(t1 - t0) / 1e6)
            full.append(Double(t2 - t0) / 1e6)
        }
        func pct(_ xs: [Double], _ p: Double) -> Double {
            let s = xs.sorted(); return (s[min(s.count - 1, Int(Double(s.count) * p))] * 100).rounded() / 100
        }
        print("n=\(n)  grab+scale median \(pct(grab, 0.5))ms p95 \(pct(grab, 0.95))ms  |  +hash median \(pct(full, 0.5))ms p95 \(pct(full, 0.95))ms")
    } catch { fail("\(error)") }

case "snap":
    // Write one frame to disk so it can be looked at. Correct hashes prove
    // nothing about channel order or row padding; a picture does.
    do {
        _ = try platform.attach(udid: flag("udid"))
        let out = flag("out") ?? "simframed-snap.png"
        let full = args.contains("--native")
        let bmp = try platform.withFrame { frame -> Bitmap in
            let edge = full ? max(frame.width, frame.height) : longEdge
            return CoreGraphicsScaler.bitmap(from: frame, targetLongEdge: edge)
                ?? Bitmap.from(frame, targetLongEdge: edge)
        }
        try PNGWriter.write(bmp, to: URL(fileURLWithPath: out))
        print("\(out) — \(bmp.width)x\(bmp.height)")
    } catch { fail("\(error)") }

case "input":
    do {
        let device = try platform.attach(udid: flag("udid"))
        let status = platform.inputStatus()
        print("\(status.available ? "ok  " : "FAIL") \(status.detail)")
        print("     \(device.name): \(device.pixelWidth)x\(device.pixelHeight)px @\(device.scale)x = \(device.pointWidth)x\(device.pointHeight)pt")
    } catch { fail("\(error)") }

case "tap", "swipe", "type", "paste", "press", "key":
    do {
        _ = try platform.attach(udid: flag("udid"))
        let positional = args.filter { !$0.hasPrefix("--") }.dropFirst()
        let t0 = DispatchTime.now().uptimeNanoseconds
        switch command {
        case "tap":
            guard positional.count >= 2, let x = Double(positional.first!), let y = Double(positional.dropFirst().first!) else {
                fail("usage: simframed tap <x> <y> [--duration-ms=70]")
            }
            try platform.tap(at: CGPoint(x: x, y: y), durationMs: Double(flag("duration-ms") ?? "") ?? 70)
        case "swipe":
            let v = positional.compactMap(Double.init)
            guard v.count >= 4 else { fail("usage: simframed swipe <x1> <y1> <x2> <y2> [--duration-ms=300]") }
            try platform.swipe(from: CGPoint(x: v[0], y: v[1]), to: CGPoint(x: v[2], y: v[3]),
                               durationMs: Double(flag("duration-ms") ?? "") ?? 300)
        case "type":
            guard !positional.isEmpty else { fail("usage: simframed type <text>") }
            try platform.type(positional.joined(separator: " "))
        case "key":
            guard let u = positional.first, let usage = UInt32(u) else {
                fail("usage: simframed key <hid-usage-code>")
            }
            try platform.pressKey(usage: usage, modifiers: [])
        case "paste":
            guard !positional.isEmpty else { fail("usage: simframed paste <text>") }
            try platform.paste(positional.joined(separator: " "))
        default:
            guard let name = positional.first, let button = HardwareButton(rawValue: name) else {
                fail("usage: simframed press <\(HardwareButton.allCases.map(\.rawValue).joined(separator: "|"))>")
            }
            try platform.press(button)
        }
        print(String(format: "%@ in %.0fms", command, Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6))
    } catch { fail("\(error)") }

case "run":
    // The capture loop. Driven by the display's damage callback rather than a
    // timer, so an idle screen costs nothing and a moving one is picked up at
    // once. A slow floor keeps state fresh enough for liveness checks.
    do {
        let device = try platform.attach(udid: flag("udid"))
        var opts = FrameStore.Options()
        opts.maxDim = longEdge
        let store = try FrameStore(device: device, options: opts)
        try store.claim()
        defer { store.release() }

        // `defer` does not run when a signal terminates the process, so a
        // plain Ctrl-C would leave meta.json naming a dead pid. Node recovers
        // from that on its own, but a daemon should tidy up after itself.
        var stopping = false
        let signalQueue = DispatchQueue(label: "simframe.signals")
        var signalSources: [DispatchSourceSignal] = []
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)   // let the dispatch source own it
            let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
            source.setEventHandler { stopping = true }
            source.resume()
            signalSources.append(source)
        }

        let minInterval = Double(flag("min-interval-ms") ?? "") ?? 80      // coalesce bursts
        let idleInterval = Double(flag("idle-interval-ms") ?? "") ?? 2000  // keep state fresh
        let idleExitMs = Double(flag("idle-exit-ms") ?? "") ?? 15 * 60_000

        let lock = NSLock()
        var dirty = true
        var recovery = CaptureRecovery()
        var stalledSince: Double?
        var lastCapture = 0.0
        var frames = 0
        var lastReport = Date().timeIntervalSince1970
        var latencies: [Double] = []

        try platform.observeChanges {
            lock.lock(); dirty = true; lock.unlock()
        }

        // Control socket: requests are served off the capture loop, because a
        // swipe sleeps for its whole duration and must not stall frames.
        let socketPath = store.controlSocketPath
        let control = ControlSocket(path: socketPath) { request in
            let action = request["action"] as? String ?? ""
            let started = DispatchTime.now().uptimeNanoseconds
            func done(_ extra: [String: Any] = [:]) -> [String: Any] {
                var r: [String: Any] = ["ok": true]
                r["ms"] = (Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6 * 100).rounded() / 100
                for (k, v) in extra { r[k] = v }
                return r
            }
            func point(_ xKey: String, _ yKey: String) -> CGPoint? {
                guard let x = request[xKey] as? Double ?? (request[xKey] as? Int).map(Double.init),
                      let y = request[yKey] as? Double ?? (request[yKey] as? Int).map(Double.init) else { return nil }
                return CGPoint(x: x, y: y)
            }
            do {
                switch action {
                case "ping":
                    return done(["device": device.name, "udid": device.udid])
                case "status":
                    let input = platform.inputStatus()
                    let ax = platform.accessibilityStatus()
                    return done([
                        "input": ["available": input.available, "detail": input.detail],
                        "accessibility": ["available": ax.available, "detail": ax.detail],
                        "device": ["name": device.name, "udid": device.udid,
                                   "pointWidth": device.pointWidth, "pointHeight": device.pointHeight,
                                   "scale": device.scale],
                        "engine": "simframed",
                    ])
                case "ui":
                    // The accessibility tree and OCR read the same instant of
                    // the screen and neither needs the other, so they run
                    // together: in series the tree read is simply added to the
                    // OCR pass. Both run off the capture loop.
                    let wantAx = request["ax"] as? Bool ?? true
                    let wantOcr = request["ocr"] as? Bool ?? true
                    // Shared with two background blocks, and a bounded wait
                    // means they can still be running when this reads them —
                    // so every touch goes through the lock. Timing out and
                    // reading racing variables would trade a slow answer for a
                    // wrong one.
                    final class Reads {
                        let lock = NSLock()
                        var axTree = AXTree(nodes: [])
                        var axError: String?
                        var axMs = 0.0
                        var ocrElements: [Element] = []
                        var ocrError: String?
                        var ocrMs = 0.0
                        func set(_ body: (Reads) -> Void) { lock.lock(); body(self); lock.unlock() }
                        func snapshot() -> (AXTree, String?, Double, [Element], String?, Double) {
                            lock.lock(); defer { lock.unlock() }
                            return (axTree, axError, axMs, ocrElements, ocrError, ocrMs)
                        }
                    }
                    let reads = Reads()

                    let group = DispatchGroup()
                    if wantAx {
                        DispatchQueue.global(qos: .userInitiated).async(group: group) {
                            let t = DispatchTime.now().uptimeNanoseconds
                            var tree = AXTree(nodes: [])
                            var failure: String?
                            do { tree = try platform.accessibilityTree() }
                            catch { failure = "\(error)" }
                            let ms = Double(DispatchTime.now().uptimeNanoseconds - t) / 1e6
                            reads.set { $0.axTree = tree; $0.axError = failure; $0.axMs = ms }
                        }
                    }
                    if wantOcr {
                        DispatchQueue.global(qos: .userInitiated).async(group: group) {
                            let t = DispatchTime.now().uptimeNanoseconds
                            var found: [Element] = []
                            var failure: String?
                            do {
                                found = try platform.withFrame { frame in
                                    try VisionOCR.recognise(frame: frame, scale: device.scale)
                                }
                            } catch { failure = "\(error)" }
                            let ms = Double(DispatchTime.now().uptimeNanoseconds - t) / 1e6
                            reads.set { $0.ocrElements = found; $0.ocrError = failure; $0.ocrMs = ms }
                        }
                    }
                    // Bounded, because this blocks the control socket and the
                    // socket is serial: a read that runs long does not just
                    // return late, it holds up every command behind it.
                    //
                    // The bound is "as long as the caller is willing to wait",
                    // not a number picked for feel. The client gives up at 30 s
                    // (`control.js`), so anything past that is lost either way,
                    // and stopping earlier only converts a slow-but-correct
                    // read into a failure. It was 12 s, chosen against a runner
                    // that once spent 28 s inside a *tree* read — a cost the
                    // attribute batching then removed — and a hosted runner
                    // where Vision has no GPU promptly failed a screen read
                    // with "text recognition did not finish within 12s". OCR is
                    // 100–400 ms on a developer's machine and evidently much
                    // slower on a shared one; guessing its ceiling was the
                    // mistake.
                    let timedOut = group.wait(timeout: .now() + .milliseconds(readBudgetMs)) == .timedOut
                    var (axTree, axError, axMs, ocrElements, ocrError, ocrMs) = reads.snapshot()
                    if timedOut {
                        let secs = readBudgetMs / 1000
                        if wantAx, axTree.nodes.isEmpty, axError == nil {
                            axError = "the accessibility read did not finish within \(secs)s"
                        }
                        if wantOcr, ocrElements.isEmpty, ocrError == nil {
                            ocrError = "text recognition did not finish within \(secs)s"
                        }
                    }
                    // OCR failing is fatal to a screen read in a way a missing
                    // tree is not: without pixels there is nothing to report.
                    if wantOcr, let ocrError, axTree.nodes.isEmpty { return ["ok": false, "error": ocrError] }

                    var elements = axTree.nodes.enumerated().map { Element(id: $0.offset, node: $0.element) }
                    for (i, var e) in ocrElements.enumerated() {
                        e.id = elements.count + i
                        elements.append(e)
                    }
                    var sources: [String] = []
                    // A tree that stopped early is reported as nodes, not as a
                    // source. The layer above treats accessibility elements as
                    // the real hit targets and writes them into screen memory,
                    // and half a screen remembered as a whole one is worse than
                    // a screen read again from pixels.
                    if wantAx, axError == nil, axTree.truncated == nil { sources.append("ax") }
                    if wantOcr, ocrError == nil { sources.append("ocr") }
                    let latest = store.latestState()
                    let map = ScreenMap(
                        fingerprint: latest?["layoutHash"] as? String ?? "",
                        hash: latest?["hash"] as? String ?? "",
                        size: CGSize(width: device.pointWidth, height: device.pointHeight),
                        elements: elements,
                        sources: sources,
                        capturedAt: FrameStore.nowMs()
                    )
                    var payload = map.json
                    let round = { (v: Double) in (v * 100).rounded() / 100 }
                    if wantOcr { payload["ocrMs"] = round(ocrMs) }
                    if wantAx {
                        payload["axMs"] = round(axMs)
                        payload["axCount"] = axTree.nodes.count
                        if let truncated = axTree.truncated { payload["axTruncated"] = truncated }
                        // Why the tree is missing matters: a launching app and a
                        // framework that will not load look identical otherwise.
                        if let axError { payload["axError"] = axError }
                    }
                    if let ocrError { payload["ocrError"] = ocrError }
                    return done(["screen": payload])
                case "tap":
                    guard let p = point("x", "y") else { return ["ok": false, "error": "tap needs x and y"] }
                    try platform.tap(at: p, durationMs: request["durationMs"] as? Double ?? 70)
                    return done()
                case "swipe":
                    guard let from = point("x1", "y1"), let to = point("x2", "y2") else {
                        return ["ok": false, "error": "swipe needs x1, y1, x2, y2"]
                    }
                    try platform.swipe(from: from, to: to, durationMs: request["durationMs"] as? Double ?? 300)
                    return done()
                case "type":
                    guard let text = request["text"] as? String else { return ["ok": false, "error": "type needs text"] }
                    try platform.type(text)
                    return done()
                case "paste":
                    guard let text = request["text"] as? String else { return ["ok": false, "error": "paste needs text"] }
                    try platform.paste(text)
                    return done()
                case "longPress":
                    guard let p = point("x", "y") else { return ["ok": false, "error": "longPress needs x and y"] }
                    try platform.longPress(at: p, durationMs: request["durationMs"] as? Double ?? 600)
                    return done()
                case "drag":
                    guard let from = point("x1", "y1"), let to = point("x2", "y2") else {
                        return ["ok": false, "error": "drag needs x1, y1, x2, y2"]
                    }
                    try platform.drag(from: from, to: to,
                                      holdMs: request["holdMs"] as? Double ?? 500,
                                      durationMs: request["durationMs"] as? Double ?? 400)
                    return done()
                case "launch":
                    guard let bundleId = request["bundleId"] as? String else { return ["ok": false, "error": "launch needs bundleId"] }
                    let pid = try platform.launch(bundleId: bundleId,
                                                  arguments: request["arguments"] as? [String] ?? [],
                                                  environment: request["environment"] as? [String: String] ?? [:])
                    return done(["pid": Int(pid)])
                case "terminate":
                    guard let bundleId = request["bundleId"] as? String else { return ["ok": false, "error": "terminate needs bundleId"] }
                    try platform.terminate(bundleId: bundleId)
                    return done()
                case "openUrl":
                    guard let url = request["url"] as? String else { return ["ok": false, "error": "openUrl needs url"] }
                    try platform.openURL(url)
                    return done()
                case "permission":
                    guard let action = request["permissionAction"] as? String, let service = request["service"] as? String else {
                        return ["ok": false, "error": "permission needs permissionAction and service"]
                    }
                    try platform.permission(action: action, service: service, bundleId: request["bundleId"] as? String)
                    return done()
                case "press":
                    guard let name = request["button"] as? String, let button = HardwareButton(rawValue: name) else {
                        return ["ok": false, "error": "press needs a known button name"]
                    }
                    try platform.press(button)
                    return done()
                case "key":
                    guard let usage = request["usage"] as? NSNumber else {
                        return ["ok": false, "error": "key needs a HID usage code"]
                    }
                    let mods = (request["modifiers"] as? [NSNumber])?.map { $0.uint32Value } ?? []
                    try platform.pressKey(usage: usage.uint32Value, modifiers: mods)
                    return done()
                case "resetInput":
                    try platform.resetInput()
                    FileHandle.standardError.write("simframed: HID session reset on request\n".data(using: .utf8)!)
                    return done()
                default:
                    return ["ok": false, "error": "unknown action '\(action)'"]
                }
            } catch {
                return ["ok": false, "error": "\(error)"]
            }
        }
        do {
            try control.start()
            FileHandle.standardError.write("simframed: control socket at \(socketPath)\n".data(using: .utf8)!)
        } catch {
            // Capture is still useful without input; say so rather than dying.
            FileHandle.standardError.write("simframed: control socket unavailable: \(error)\n".data(using: .utf8)!)
        }
        defer { control.stop() }

        // A new capture session inherits no stall.
        //
        // capture-health.json is cleared when a stalled loop captures a frame
        // again, and a loop that dies while stalled never gets to. So a fresh
        // daemon captured happily while `doctor` reported "stalled for 221s,
        // 60 re-attaches" from its dead predecessor — and the display probe,
        // correctly on that input, called it a simframe bug. It was: this one.
        try? store.writeCaptureHealth(nil)

        FileHandle.standardError.write("simframed: capturing \(device.name) (\(device.udid))\n".data(using: .utf8)!)

        while true {
            let now = Date().timeIntervalSince1970 * 1000
            lock.lock()
            let isDirty = dirty
            lock.unlock()

            let due = (isDirty && now - lastCapture >= minInterval) || (now - lastCapture >= idleInterval)
            if due {
                lock.lock(); dirty = false; lock.unlock()
                let t0 = DispatchTime.now().uptimeNanoseconds
                // One pool per capture.
                //
                // There was none anywhere in this loop, and on Darwin that is
                // the standard way to get the working set this daemon had:
                // 732 MB resident after eleven minutes and 2831 frames, for a
                // process that holds one frame at a time. CoreGraphics scaling
                // and IOSurface access both produce autoreleased temporaries,
                // and a `while true` loop with no pool of its own drains
                // nothing. Whether that pressure is what wedges capture is
                // unproven — the RSS also *fell* 200 MB in 25 s, so nothing is
                // leaking monotonically — but a frame grabber should not hold
                // half a gigabyte either way.
                autoreleasepool {
                    do {
                        // One grab produces both sizes; the surface pointer is only
                        // valid inside this call, so nothing may be deferred out of it.
                        let wantFull = store.wantsFullFrame()
                        let (bmp, full) = try platform.withFrame { frame -> (Bitmap, Bitmap?) in
                            let scaled = CoreGraphicsScaler.bitmap(from: frame, targetLongEdge: longEdge)
                                ?? Bitmap.from(frame, targetLongEdge: longEdge)
                            let native = wantFull
                                ? CoreGraphicsScaler.bitmap(from: frame, targetLongEdge: max(frame.width, frame.height))
                                : nil
                            return (scaled, native)
                        }
                        let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
                        try store.record(bmp, fullBitmap: full, captureMs: ms)
                        latencies.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)
                        frames += 1
                        lastCapture = now
                        let wasStalled = recovery.isStalled
                        recovery.captureSucceeded()
                        if wasStalled {
                            // A frame after a stall is the only thing that clears
                            // it, and it is worth saying out loud: the device came
                            // back on its own, which nobody would otherwise know.
                            try? store.writeCaptureHealth(nil)
                            stalledSince = nil
                            FileHandle.standardError.write(
                                "simframed: capture recovered on its own\n".data(using: .utf8)!)
                        }
                    } catch {
                        let due = recovery.captureFailed()
                        FileHandle.standardError.write(
                            "simframed: capture failed: \(error) (\(recovery.consecutiveFailures) in a row)\n".data(using: .utf8)!)
                        // The display port can be torn down and rebuilt under a
                        // running daemon, and every read on the old descriptor
                        // returns nil from then on. Observed on a device that was
                        // awake and visible the whole time: six minutes of
                        // "the display surface could not be read", cured instantly
                        // by restarting the daemon. Reporting a failure loudly is
                        // right; never recovering from it is not, so re-resolve the
                        // port and re-arm the damage callback.
                        if due {
                            let onDamage = { lock.lock(); dirty = true; lock.unlock() }
                            // Escalate rather than repeat. Two successful re-resolves
                            // with no frame between them means the port was never the
                            // problem, so try the thing that until now needed a human:
                            // rebind to the device, which is what restarting the
                            // daemon did.
                            let rebinding = recovery.needsRebind
                            let outcome = rebinding
                                ? recovery.rebind(platform: platform, udid: device.udid, onDamage: onDamage)
                                : recovery.reattach(platform: platform, onDamage: onDamage)
                            let what = rebinding ? "rebound to the device" : "re-resolved the display port"
                            switch outcome {
                            case .success(let after):
                                lock.lock(); dirty = true; lock.unlock()
                                FileHandle.standardError.write(
                                    "simframed: \(what) after \(after) failed reads\n".data(using: .utf8)!)
                            case .failure(let error):
                                FileHandle.standardError.write(
                                    "simframed: could not \(rebinding ? "rebind to the device" : "re-resolve the display port"): \(error)\n".data(using: .utf8)!)
                            }
                        }
                        // Say that capture is wedged rather than merely slow.
                        //
                        // The loop now tries two things — re-resolve the port, then
                        // rebind the device — and stops there. Restarting the device
                        // remains the user's to make: a capture loop that rebooted
                        // the device it was watching would be a tool reaching for
                        // the mains because a reading looked wrong. So it is published, `doctor` grades it and
                        // `simframe state` prints it, and an agent reads "the
                        // simulator is wedged" instead of "nothing changed".
                        if recovery.isStalled {
                            if stalledSince == nil { stalledSince = FrameStore.nowMs() }
                            try? store.writeCaptureHealth([
                                "stalled": true,
                                "since": stalledSince ?? FrameStore.nowMs(),
                                "at": FrameStore.nowMs(),
                                "consecutiveFailures": recovery.consecutiveFailures,
                                "reattaches": recovery.reattaches,
                                "reason": "\(error)",
                            ])
                        }
                        Thread.sleep(forTimeInterval: 0.5)
                    }
                }
            }

            let wall = Date().timeIntervalSince1970
            if wall - lastReport >= 1 {
                let sorted = latencies.sorted()
                let median = sorted.isEmpty ? 0 : sorted[sorted.count / 2]
                FileHandle.standardError.write(
                    String(
                        format: "simframed: %.1f fps, median %.2fms, rss %.0fMB\n",
                        Double(frames) / (wall - lastReport),
                        median,
                        Double(residentBytes()) / 1_048_576
                    ).data(using: .utf8)!)
                frames = 0; latencies.removeAll(); lastReport = wall
            }

            if stopping {
                FileHandle.standardError.write("simframed: stopping\n".data(using: .utf8)!)
                break
            }
            if store.heartbeatAge() > idleExitMs {
                FileHandle.standardError.write("simframed: exiting, no client heartbeat\n".data(using: .utf8)!)
                break
            }
            if !store.stillOwner() {
                FileHandle.standardError.write("simframed: exiting, superseded by another capture loop\n".data(using: .utf8)!)
                break
            }
            // The damage callback is delivered on a framework queue, so the
            // main thread only needs to wake often enough to notice.
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
    } catch { fail("\(error)") }

default:
    fail("unknown command '\(command)' (try: devices, hash, bench, snap, run, input, tap, swipe, type, press)")
}
