// The local supervisor, and it may say exactly three things.
//
// Claude plans. The deterministic executor in src/actions.js runs the plan and
// verifies each step — round 6's best result was 18 steps in one call, and code
// is a better executor than a model: faster, exact, auditable, and it cannot
// hallucinate a step. What the executor has never had is judgement at the
// moment a step fails, so a batch died and a round trip was spent on a decision
// that was usually obvious.
//
// This answers that moment and nothing else:
//
//   in   {"goal":"...","step":"tap REVIEW","expected":"...","failure":"...","screen":["…labels…"],"stillMs":120}
//   out  {"decision":"wait","reason":"the list is still arriving","ms":410}
//
// `wait`, `retry`, `stop`. It cannot invent a step, skip one, substitute a
// target, or continue past an unexpected screen — not because a threshold
// forbids it but because those are not words it can say. That constraint is the
// safety property. `seek` was given latitude over *what* to open and pressed
// "YES, THIS FIXED MY PROBLEM" in a live app; a component whose whole answer
// space is three words cannot do that whatever it believes.
//
// Unavailable is a normal answer. It says so and exits, `doctor` reports
// `supervisor: none`, and the executor behaves exactly as it does today.
import Foundation
#if canImport(FoundationModels)
import FoundationModels

@available(macOS 26.0, *)
@Generable
enum Decision: String {
    case wait
    case retry
    case stop
}

@available(macOS 26.0, *)
@Generable
struct Judgement {
    @Guide(description: "wait if the screen is still arriving, retry if the same step should be attempted again, stop if nothing further can work")
    var decision: Decision
    @Guide(description: "One short clause naming the evidence, under 15 words")
    var reason: String
}

struct Situation: Decodable {
    let goal: String?
    let step: String
    let expected: String?
    let failure: String
    let screen: [String]?
    let stillMs: Int?
    let note: String?
}

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
    You supervise a UI test that is running a plan someone else wrote. A step \
    has just failed. Decide one of three things and nothing else.

    wait  — the screen is still arriving: a spinner, a list that has not \
    rendered, a count header with no rows, a transition in progress. Waiting \
    would let the same step succeed.
    retry — the step is sound and the moment was wrong: something moved under \
    it, focus was lost, a stale reading. Repeating it would work.
    stop  — nothing further in the plan can work: the app is somewhere else, a \
    required control is absent or disabled for a reason, or the screen has not \
    responded at all.

    Weigh the evidence you are given, in this order.

    If a note says the screen is still filling in — a spinner, a count header \
    with too few rows, a transition — that is decisive: answer wait.
    If the screen has been still for under about 1500ms, content may still be \
    arriving: prefer wait.
    If the visible labels belong to a different part of the app than the step \
    implies, answer stop.
    If a control the step names is present but refused, answer stop.
    Otherwise, if the step looks like it simply caught a bad moment, answer \
    retry.

    Never suggest a different step, a different target, or skipping ahead. You \
    are not being asked what to do, only whether this can proceed. Your reason \
    must name the evidence you used, not restate the failure.
    """)
    emit(["ready": true])
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let s = try? JSONDecoder().decode(Situation.self, from: data) else {
            emit(["error": "could not parse that line"])
            continue
        }
        var prompt = "Step: \(s.step)\nIt failed with: \(s.failure)"
        if let goal = s.goal, !goal.isEmpty { prompt += "\nThe plan's goal: \(goal)" }
        if let expected = s.expected, !expected.isEmpty { prompt += "\nExpected: \(expected)" }
        if let ms = s.stillMs { prompt += "\nThe screen has been still for \(ms)ms" }
        if let note = s.note, !note.isEmpty { prompt += "\nPerception note: \(note)" }
        if let screen = s.screen, !screen.isEmpty {
            prompt += "\nOn screen now: \(screen.prefix(25).joined(separator: ", "))"
        }
        let started = Date()
        do {
            let out = try await session.respond(to: prompt, generating: Judgement.self)
            emit([
                "decision": out.content.decision.rawValue,
                "reason": String(out.content.reason.prefix(120)),
                "ms": Int(Date().timeIntervalSince(started) * 1000),
            ])
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
