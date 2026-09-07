import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!); exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
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
