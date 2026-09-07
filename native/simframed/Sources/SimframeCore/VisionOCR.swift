import CoreGraphics
import Foundation
import PrivateAPI
import Vision

/// Text recognition straight off the framebuffer.
///
/// The Node path wrote a PNG and shelled out to a helper; this reads the
/// IOSurface that is already mapped, so a recognition pass costs one CGImage
/// wrap rather than an encode, a write, a process spawn and a decode.
public enum VisionOCR {
    /// Recognised text as elements, in points.
    ///
    /// - Parameter scale: points per pixel, so boxes come back in the space
    ///   input speaks rather than in framebuffer pixels.
    public static func recognise(
        frame: RawFrame,
        scale: Double,
        startingId: Int = 1,
        minimumConfidence: Float = 0.3
    ) throws -> [Element] {
        guard let image = cgImage(from: frame) else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        // Correction rewrites UI strings into dictionary words — "Fryer 3"
        // becomes something else entirely — and a label must be what is on
        // screen, not what the language model thinks was meant.
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])

        let width = Double(frame.width), height = Double(frame.height)
        var elements: [Element] = []
        var id = startingId
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first,
                  candidate.confidence >= minimumConfidence else { continue }
            let box = observation.boundingBox   // normalised, origin bottom-left
            let rect = CGRect(
                x: box.origin.x * width / scale,
                // Vision's origin is bottom-left; screens are top-left.
                y: (1 - box.origin.y - box.size.height) * height / scale,
                width: box.size.width * width / scale,
                height: box.size.height * height / scale
            )
            elements.append(Element(
                id: id,
                frame: rect,
                role: "text",
                label: candidate.string,
                source: .ocr,
                confidence: Double(candidate.confidence)
            ))
            id += 1
        }
        return elements
    }

    /// Wrap the surface as a CGImage without copying its pixels.
    private static func cgImage(from frame: RawFrame) -> CGImage? {
        let bytes = frame.bytesPerRow * frame.height
        guard let provider = CGDataProvider(dataInfo: nil, data: frame.pixels, size: bytes, releaseData: { _, _, _ in }) else {
            return nil
        }
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue).union(.byteOrder32Little)
        return CGImage(
            width: frame.width, height: frame.height,
            bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: frame.bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: info,
            provider: provider, decode: nil,
            shouldInterpolate: false, intent: .defaultIntent
        )
    }
}
