import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!); exit(1)
}
// Recognition level is a switch now, not a constant.
//
// CLAUDE.md fixes `.accurate` with language correction off, and that was chosen
// without a comparison — which is a threshold nobody had scored. `SIMFRAME_OCR`
// selects it so the two can be measured against each other on the perception
// harness: accuracy lost against milliseconds gained.
//
// The theory being tested is a human one: we read imprecisely and gain speed by
// it, tolerated by a forgiving match. simframe's matcher already forgives a
// great deal — prefixes, synonyms, typo distance, a Cyrillic-for-Latin fold —
// so a worse reading may cost nothing that matters.
let req = VNRecognizeTextRequest()
let level = ProcessInfo.processInfo.environment["SIMFRAME_OCR"]?.lowercased() ?? "accurate"
req.recognitionLevel = (level == "fast") ? .fast : .accurate
req.usesLanguageCorrection = false
try! VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
let w = Double(cg.width), h = Double(cg.height)
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox   // normalized, origin bottom-left
    out.append([
        "text": top.string,
        "confidence": top.confidence,
        "x": b.origin.x * w,
        "y": (1 - b.origin.y - b.size.height) * h,
        "width": b.size.width * w,
        "height": b.size.height * h,
    ])
}
let data = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
