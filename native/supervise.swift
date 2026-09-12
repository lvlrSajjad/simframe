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
//   out  {"decision":"wait","ms":410}
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
}

/**
 * The same question with a fourth answer: "I cannot tell".
 *
 * A second type rather than a fourth case on `Decision`, because the two have
 * to be *comparable*. `@Generable` fixes the answer space at compile time, so a
 * binary that can only be asked one way cannot measure whether the token helps
 * or merely moves the errors around — and "does the model abstain on the ones
 * it gets wrong, or at random" is the whole question. One binary, both
 * vocabularies, chosen per request.
 *
 * `abstain` is not a new capability and cannot become one. It means "behave as
 * if there is no supervisor", which is exactly the `null` the caller already
 * handles on every failure path. The answer space stays the safety property:
 * this strictly shrinks what the model can cause to happen.
 */
@available(macOS 26.0, *)
@Generable
enum CautiousDecision: String {
    case wait
    case retry
    case stop
    case abstain
}

@available(macOS 26.0, *)
@Generable
struct CautiousJudgement {
    @Guide(description: "wait if the screen is still arriving, retry if the same step should be attempted again, stop if nothing further can work, abstain if you cannot tell from what you were given")
    var decision: CautiousDecision
}

struct Situation: Decodable {
    /// Ask with the fourth word available. Absent means the shipped three.
    let mayAbstain: Bool?
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
    // Instructions, reused; the *session* is not.
    //
    // One session reused across requests is what made the supervisor go silent
    // in the field: `LanguageModelSession` accumulates its transcript, so after
    // seven real failures it hit `exceededContextWindowSize` — 4,441 tokens
    // against a 4,096 maximum — and every request after that errored. The tester
    // saw three rulings and then nothing for twenty supervised calls, while
    // `doctor` in a separate process kept reporting the model available. It
     // degraded before it broke, too: latency climbed 987ms to 1,890ms as the
    // transcript grew, and the reasons collapsed into boilerplate repeated
    // verbatim across unrelated failures.
    //
    // Each judgement is independent by nature — a failed step, what was
    // expected, what is on screen — so there is nothing for a transcript to
    // carry, and carrying it was pure cost even before it was fatal. The process
    // stays warm, which is where the model load is paid; only the conversation
    // is fresh.
    let instructions = """
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

    The plan's own guidance about this app comes FIRST and outranks everything \
    below. It is the only knowledge of this app you have, and it was written by \
    someone who has seen it. If it says lists arrive late, then a row that is \
    not there yet means wait — even on a screen that has gone completely still, \
    because a screen waiting on a network call is perfectly still and perfectly \
    empty.

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
    are not being asked what to do, only whether this can proceed. Answer with \
    the decision alone.
    """

    // The same brief with the fourth word, built from the first so the two
    // cannot drift. Everything above applies; this adds one rule and changes
    // nothing else, which is what makes the comparison mean something.
    let abstainInstructions = instructions + "\n\n" + """
    There is a fourth answer: abstain. Use it when the evidence you were \
    given does not distinguish these cases — when you would be guessing. \
    Abstaining is not a failure and it is not penalised: it hands the decision \
    to someone with more context, which costs one step. A wrong stop abandons a \
    plan that would have worked, and a wrong wait spends a timeout on a screen \
    that will never change. Prefer abstain to either. Do not abstain merely \
    because the situation is unusual; abstain because the evidence is absent.
    """
    // Warm up front so the first real judgement does not pay model load —
    // measured at ~880ms against ~600ms warm.
    //
    // `prewarm()` is the supported way and this used to be a throwaway
    // `respond`, which loaded the same weights the hard way and paid a whole
    // generation to do it. Warming a session we then discard works because
    // residency is process- and system-managed: the expensive part outlives the
    // session, which is also why fresh-session-per-judgement is affordable.
    LanguageModelSession(instructions: instructions).prewarm()
    // The window, reported rather than assumed. 4,096 has been a documented
    // constant we repeated; since 26.4 it is queryable, so it is now read from
    // the model and handed to the caller, who prints it in `doctor`.
    // Guarded at 26.4, which is where `contextSize` became queryable — the
    // enclosing block only promises 26.0, so an SDK between the two would fail
    // to *compile* and the supervisor would simply not exist on that machine,
    // reported as "could not build the local supervisor". A peer round is
    // exactly where that costs somebody an afternoon, and the window is a
    // nicety: it is printed in `doctor` and nothing depends on it.
    var hello: [String: Any] = ["ready": true]
    if #available(macOS 26.4, *) {
        hello["contextSize"] = SystemLanguageModel.default.contextSize
    }
    emit(hello)
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let s = try? JSONDecoder().decode(Situation.self, from: data) else {
            emit(["error": "could not parse that line"])
            continue
        }
        // Capped here as well as in the caller. A single realistic failure
        // message carries the whole "Visible: …" list, and one request built
        // from raw input measured 4,266 tokens against a 4,096 window — so a
        // request can exceed the context on its own, with no transcript
        // involved at all. Truncation belongs where the limit is.
        let clip = { (t: String, n: Int) in t.count > n ? String(t.prefix(n)) + "…" : t }
        var prompt = "Step: \(clip(s.step, 120))\nIt failed with: \(clip(s.failure, 220))"
        if let goal = s.goal, !goal.isEmpty { prompt += "\nThe plan's guidance about this app: \(clip(goal, 300))" }
        if let expected = s.expected, !expected.isEmpty { prompt += "\nExpected: \(clip(expected, 200))" }
        if let ms = s.stillMs { prompt += "\nThe screen has been still for \(ms)ms" }
        if let note = s.note, !note.isEmpty { prompt += "\nPerception note: \(clip(note, 160))" }
        if let screen = s.screen, !screen.isEmpty {
            prompt += "\nOn screen now: \(screen.prefix(14).map { clip($0, 28) }.joined(separator: ", "))"
        }
        let started = Date()
        do {
            let mayAbstain = s.mayAbstain ?? false
            let session = LanguageModelSession(instructions: mayAbstain ? abstainInstructions : instructions)
            let decision: String = mayAbstain
                ? try await session.respond(to: prompt, generating: CautiousJudgement.self).content.decision.rawValue
                : try await session.respond(to: prompt, generating: Judgement.self).content.decision.rawValue
            // No reason field, deliberately. Asked for one it confabulated in
            // every observed run: a correct `stop` justified as "screen is
            // elsewhere" when the screen was exactly where the plan expected,
            // and reasons repeated verbatim across unrelated failures. The
            // reporter's judgement, and it is right — *"a right answer with a
            // fabricated justification teaches me to distrust the
            // justification, which is most of the value of it explaining
            // itself. No reason at all would be better than a confident wrong
            // one."* What the caller gets instead is which rule or which model
            // answered, which is true by construction.
            emit([
                "decision": decision,
                "ms": Int(Date().timeIntervalSince(started) * 1000),
            ])
        } catch let err as LanguageModelSession.GenerationError {
            // Named, not merely stringified, because the cases mean different
            // things to whoever reads the log — and because a string match on
            // an error message is a classification that silently becomes
            // "unknown" the day Apple rewords it.
            //
            // Deliberately NOT a retry policy. The research that asked for this
            // warned that a blanket retry burns battery on the permanent cases,
            // and checking found we never retry at all: `ask` resolves null on
            // any error and `judge` refuses anything outside the three words. So
            // what these buy is a diagnosis, which is what was actually missing
            // — every failure reached the log as "the supervisor did not answer".
            let kind: String
            switch err {
            // Our own bug if it appears: the caller clips every field and the
            // worst case those caps allow measures 1,918 tokens of 4,096.
            case .exceededContextWindowSize: kind = "context-window"
            // Permanent for this input. Retrying cannot help and it says so.
            case .guardrailViolation: kind = "guardrail"
            case .unsupportedLanguageOrLocale: kind = "locale"
            // A session takes one request at a time. The line protocol here
            // serialises them and each gets a fresh session, so this should be
            // unreachable — worth knowing loudly if it ever is not.
            case .rateLimited: kind = "rate-limited"
            default: kind = "generation"
            }
            emit(["error": "\(err)", "kind": kind])
        } catch {
            emit(["error": "\(error)", "kind": "unknown"])
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
