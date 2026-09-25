// Composes a README GIF: simulator recording on the left, a terminal panel on
// the right whose lines appear at the moments the flow printed them.
// usage: swift gif.swift <video.mp4> <events.json> <out.gif>
// events.json: {"startMs":..,"endMs":..,"fps":..,"lines":[{"t":ms,"text":".."}]}
// Times are milliseconds from the start of the video. No dependencies.
import Foundation
import AVFoundation
import ImageIO
import CoreText
import UniformTypeIdentifiers

struct Line: Decodable { let t: Double; let text: String; let color: String? }
struct Events: Decodable { let startMs: Double; let endMs: Double; let fps: Double; let lines: [Line]; let title: String?; let videoEndEpochMs: Double }

let args = CommandLine.arguments
let video = URL(fileURLWithPath: args[1])
let raw = try! JSONDecoder().decode(Events.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
let asset0 = AVURLAsset(url: video)
let durMs = CMTimeGetSeconds(asset0.duration) * 1000
let vstart = raw.videoEndEpochMs - durMs
struct Ev { let startMs: Double; let endMs: Double; let fps: Double; let lines: [Line]; let title: String? }
let events = Ev(startMs: max(0, raw.startMs - vstart), endMs: min(durMs, raw.endMs - vstart), fps: raw.fps,
  lines: raw.lines.map { Line(t: $0.t - vstart, text: $0.text, color: $0.color) }, title: raw.title)
print("video \(durMs) ms, window \(events.startMs)...\(events.endMs)")
let out = URL(fileURLWithPath: args[3])

let asset = AVURLAsset(url: video)
let gen = AVAssetImageGenerator(asset: asset)
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 30)
gen.appliesPreferredTrackTransform = true

let W = 760, H = 560, pad = 16
let simH = H - 2 * pad
let firstFrame = try! gen.copyCGImage(at: CMTime(seconds: events.startMs / 1000, preferredTimescale: 600), actualTime: nil)
let simW = Int(Double(simH) * Double(firstFrame.width) / Double(firstFrame.height))
let termX = pad + simW + pad
let termW = W - termX - pad

func color(_ hex: String) -> CGColor {
  var v: UInt64 = 0; Scanner(string: String(hex.dropFirst())).scanHexInt64(&v)
  return CGColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}
let bg = color("#0b0f14"), termBg = color("#111820"), fg = color("#d8dee6"), dim = color("#7d8590"), ok = color("#3fb950"), accent = color("#79c0ff")
let font = CTFontCreateWithName("Menlo" as CFString, 12.5, nil)
let boldFont = CTFontCreateWithName("Menlo-Bold" as CFString, 12.5, nil)

func wrap(_ s: String, width: CGFloat, font: CTFont) -> [String] {
  // greedy word wrap measured with the real font
  var lines: [String] = []; var cur = ""
  for word in s.split(separator: " ", omittingEmptySubsequences: false) {
    let cand = cur.isEmpty ? String(word) : cur + " " + word
    let l = CTLineCreateWithAttributedString(NSAttributedString(string: cand, attributes: [kCTFontAttributeName as NSAttributedString.Key: font]))
    if CTLineGetTypographicBounds(l, nil, nil, nil) > Double(width) && !cur.isEmpty { lines.append(cur); cur = String(word) } else { cur = cand }
  }
  if !cur.isEmpty { lines.append(cur) }
  return lines
}

func draw(ctx: CGContext, text: String, x: CGFloat, y: CGFloat, color: CGColor, font: CTFont) {
  let l = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [kCTFontAttributeName as NSAttributedString.Key: font, kCTForegroundColorAttributeName as NSAttributedString.Key: color]))
  ctx.textPosition = CGPoint(x: x, y: y); CTLineDraw(l, ctx)
}

func render(at ms: Double) -> CGImage {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.setFillColor(bg); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  // simulator frame, rounded corners
  let frame = (try? gen.copyCGImage(at: CMTime(seconds: ms / 1000, preferredTimescale: 600), actualTime: nil)) ?? firstFrame
  let simRect = CGRect(x: pad, y: pad, width: simW, height: simH)
  ctx.saveGState()
  ctx.addPath(CGPath(roundedRect: simRect, cornerWidth: 22, cornerHeight: 22, transform: nil)); ctx.clip()
  ctx.draw(frame, in: simRect)
  ctx.restoreGState()
  // terminal panel
  let termRect = CGRect(x: termX, y: pad, width: termW, height: simH)
  ctx.setFillColor(termBg); ctx.addPath(CGPath(roundedRect: termRect, cornerWidth: 10, cornerHeight: 10, transform: nil)); ctx.fillPath()
  var y = CGFloat(H - pad - 28)
  let lx = CGFloat(termX + 14), lw = CGFloat(termW - 28)
  if let t = events.title { draw(ctx: ctx, text: t, x: lx, y: y, color: dim, font: font); y -= 26 }
  for line in events.lines where line.t <= ms {
    let c: CGColor = line.color == "ok" ? ok : line.color == "accent" ? accent : line.color == "dim" ? dim : fg
    let f = line.color == "accent" ? boldFont : font
    for (i, piece) in wrap(line.text, width: lw, font: f).enumerated() {
      draw(ctx: ctx, text: piece, x: lx + (i > 0 ? 28 : 0), y: y, color: c, font: f); y -= 18
    }
    y -= 6
  }
  // cursor
  let blink = Int(ms / 500) % 2 == 0
  if blink { ctx.setFillColor(fg); ctx.fill(CGRect(x: lx, y: y + 2, width: 8, height: 14)) }
  return ctx.makeImage()!
}

let n = Int((events.endMs - events.startMs) / 1000 * events.fps)
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.gif.identifier as CFString, n, nil)!
CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
for i in 0..<n {
  let ms = events.startMs + Double(i) * 1000 / events.fps
  let img = render(at: ms)
  let delay = (i == n - 1) ? 2.0 : 1 / events.fps
  CGImageDestinationAddImage(dest, img, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay, kCGImagePropertyGIFUnclampedDelayTime: delay]] as CFDictionary)
}
CGImageDestinationFinalize(dest)
print("wrote \(out.path) \(n) frames \(W)x\(H)")
