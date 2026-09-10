// A local ranker, and nothing more than a ranker.
//
// Reads one JSON object per line on stdin and writes one per line on stdout, so
// the caller pays model load once instead of once per question: measured, the
// first answer in a process costs ~880ms and every later one ~564ms.
//
//   in   {"goal":"change my username","options":["General","Account"]}
//   out  {"order":["Account","General"],"ms":564}
//
// It may only reorder the labels it was given. It never invents one, never says
// what to do, and never sees pixels — the caller has already decided that every
// option is permitted (see src/vocabulary.js) and will try them in some order
// regardless. This only decides which order.
//
// Unavailable is a normal answer, not an error: no Apple Intelligence, no Apple
// Silicon, an older macOS, or a user who has turned it off. It says so on the
// first line and exits, and `doctor` reports `planner: none` while the existing
// matcher-then-Claude ladder carries on unchanged.
import Foundation
#if canImport(FoundationModels)
import FoundationModels

@available(macOS 26.0, *)
@Generable
struct Ranking {
    @Guide(description: "The given labels, most likely to lead to the goal first")
    var order: [String]
}

struct Question: Decodable { let goal: String; let options: [String] }

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

@available(macOS 26.0, *)
func serve() async {
    switch SystemLanguageModel.default.availability {
    case .available: break
    case .unavailable(let reason):
        emit(["unavailable": "\(reason)"])
        return
    @unknown default:
        emit(["unavailable": "unknown availability"])
        return
    }
    let session = LanguageModelSession(instructions: """
    You rank user-interface controls. You are given something the user is looking \
    for and a list of labels visible on one screen. Order the labels from most to \
    least likely to lead to what they want. Use only the labels you were given, \
    copied verbatim. Do not invent labels and do not explain.
    """)
    emit(["ready": true])
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let q = try? JSONDecoder().decode(Question.self, from: data) else {
            emit(["error": "could not parse that line"])
            continue
        }
        let started = Date()
        do {
            let answer = try await session.respond(
                to: "Looking for: \(q.goal)\nLabels: \(q.options.joined(separator: ", "))",
                generating: Ranking.self)
            // Only labels we handed it, and never the same one twice: a model
            // that paraphrases must not be able to smuggle in a new target.
            var seen = Set<String>()
            let kept = answer.content.order.filter { q.options.contains($0) && seen.insert($0).inserted }
            emit(["order": kept, "ms": Int(Date().timeIntervalSince(started) * 1000)])
        } catch {
            emit(["error": "\(error)"])
        }
    }
}

if #available(macOS 26.0, *) {
    await serve()
} else {
    emit(["unavailable": "the on-device model needs macOS 26 or newer"])
}
#else
print("{\"unavailable\":\"this toolchain cannot import FoundationModels\"}")
#endif
