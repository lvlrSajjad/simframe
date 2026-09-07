import Foundation
import PrivateAPI
import SimframeCore

let args = Array(CommandLine.arguments.dropFirst())
func flag(_ name: String) -> String? {
    guard let a = args.first(where: { $0.hasPrefix("--\(name)=") }) else { return nil }
    return String(a.dropFirst(name.count + 3))
}

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

        let minInterval = Double(flag("min-interval-ms") ?? "") ?? 80      // coalesce bursts
        let idleInterval = Double(flag("idle-interval-ms") ?? "") ?? 2000  // keep state fresh
        let idleExitMs = Double(flag("idle-exit-ms") ?? "") ?? 15 * 60_000

        let lock = NSLock()
        var dirty = true
        var lastCapture = 0.0
        var frames = 0
        var lastReport = Date().timeIntervalSince1970
        var latencies: [Double] = []

        try platform.observeChanges {
            lock.lock(); dirty = true; lock.unlock()
        }

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
                } catch {
                    FileHandle.standardError.write("simframed: capture failed: \(error)\n".data(using: .utf8)!)
                    Thread.sleep(forTimeInterval: 0.5)
                }
            }

            let wall = Date().timeIntervalSince1970
            if wall - lastReport >= 1 {
                let sorted = latencies.sorted()
                let median = sorted.isEmpty ? 0 : sorted[sorted.count / 2]
                FileHandle.standardError.write(
                    String(format: "simframed: %.1f fps, median %.2fms\n", Double(frames) / (wall - lastReport), median)
                        .data(using: .utf8)!)
                frames = 0; latencies.removeAll(); lastReport = wall
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
    fail("unknown command '\(command)' (try: devices, hash, bench, snap, run)")
}
