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

default:
    fail("unknown command '\(command)' (try: devices, hash, bench, snap)")
}
