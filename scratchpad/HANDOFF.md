# Handoff — 2026-09-15

**0.14.3 is published and verified.** npm `latest`, the MCP registry, and
`node scripts/check-published.mjs` → **83/83 files identical**. Nothing held
locally; `origin/main` clean. Gates: 201/201 tests, check-private (203 files),
check-package, the article projection.

**Start here: item 169 — and the answer is already in the repo.** See below.

## Today in one line

Two independent field reports on real RN apps drove nine fixes and three
releases; then one CI symptom turned out to be **seven** distinct causes, five in
the harness and two real defects (169, 170).

## The two field reports — they agreed on #1

Different testers, different apps, no contact. Both named the same top finding:

> *"name→element resolution falling back to OCR when the AX label is a testID …
> made `sel`-by-name unusable here"*

One called it "the single biggest friction", the other "the single largest time
sink". That is **152**, fixed: `matching.rank` now scores `t.identifier` and the
`Visible:` list no longer filters to `t.label`. Their sharper diagnosis is worth
keeping: `Visible:` is OCR-derived while `content:` is AX-derived, so the reply
printed the union and the resolver matched half of it.

Shipped from the two rounds: **148** (tap the activation point), **150**
(AsyncStorage at `Library/Application Support`), **151** (`storage` with no
boot), **152**, **154**, **157** (`sim_do` accepts its own tool names), **158**
(`sim_look` states its coordinate space), **159** (`scroll_to` will not call an
off-screen element in view), **160**, plus **149**'s release guard.

## NEXT: item 169 — `launch` says ok without fronting the app

The only open item costing **users** rather than me, live in every published
version, and the root of several CI failures.

Symptom: `launch com.apple.Preferences (relaunch: true)` returns ok, reports
`[no visible change]`, and the device is still on the previous app. `actions.js`
documents the ambiguity and cannot resolve it — "already in front" and "did not
come forward" look identical.

**The answer is already in the codebase, found just before compacting:**

    native/simframed/Sources/PrivateAPI/AccessibilityBridge.swift
      private func frontmostApplication() -> NSObject?
        -> translator.frontmostApplicationWithDisplayId:bridgeDelegateToken:

`tree()` already calls it and throws `noFrontmostApplication` when nil. So the
daemon can see which app is in front; nothing exposes it. Shape of the fix:
surface the frontmost app's identity, plumb it through the `ui` response the way
`activationPoint` was, and have `launch` verify it.

**A dead end already checked — do not repeat it:** "a relaunch must change the
screen, so no-visible-change means failure" is WRONG. Relaunching an app already
in front can legitimately land on the same screen. The discriminator has to be
app identity, not screen change.

Cheaper fallbacks if the identity route stalls: retry the launch when the settle
reports no visible change (the workflow's own step vehicle already does this by
hand, three times), or assert the tree belongs to the launched app.

## Then

- **170** — a CLI that dies with **empty stdout** is classified as a check
  failure, because no guard signature matches *silence*. `jsonRetry` also
  discards the stderr that would name the cause. Same shape as 166 one layer
  out: a harness watching the wrong channel.
- **153** — a tap actuating a **covered** control and returning `ok`. Needs a
  hit test: confirm the frontmost element at the aim point is the target or a
  descendant. Neither aim point could have avoided it.
- **162** — the AX list intermittently drops a visible element, undermining
  every `#ref` numbered from it.
- **163** — hash collisions on lists differing only in row text. Locally
  Settings > General gave **six identities across six visits**, each stable
  within its visit.

## CI: seven causes, one symptom

Every "reading taken on the previous screen" failure, in the order peeled:

| | |
| --- | --- |
| 143 | a stale frame scored as a reading |
| -- | a wrong turn onto a sparse screen misreported as an under-read |
| 164 | "newer than the navigation" is not "recent" — a **38,266 ms** frame passed |
| 166 | **`runScript` does not throw on a failed step** — returns `ok: !failed`, and the eval only caught throws. The real cause. |
| 167 | a launched app that never fronted, classified as a check failure |
| 168 | the tour waited for `VoiceOver`, which is below the fold |
| 169/170 | the two real defects underneath |

**The lesson to carry:** 166 was found by the diagnostic added in 165 — printing
what the tour's own steps reported — on its **first run**. Five rounds of
reasoning had not found it. When a harness keeps being wrong, print what it saw
rather than theorise once more.

**Two of those seven were bugs I introduced while fixing the previous one** (a
TDZ in actions.js, `byName` out of scope in the eval). Both correct logic that
never ran. `node --check` catches neither. `classifyStray` now lives in
`scripts/classify-stray.mjs` with a test replaying real CI data, because
`eval-fingerprint.mjs` runs the whole eval on import and nothing could reach it.

CI is **honest** now and not yet **trustworthy**. Treat a green as weaker
evidence than usual until 169 lands.

## Unfinished business

- **`bench` on the v0.14.3 tag was still running at compact.** It is the HPI
  gate, it was skipped on every push today, and 148 (tap aim) and 154 (verdicts)
  are exactly the changes that could move HPI. **Check run `34977210692` and
  report it.** A regression there is a real finding about today's releases.

## Tools built today

- `scripts/check-published.mjs <version>` — diffs the **published tarball**
  against the working tree. Exit 1 differs; **exit 2 = not published / no
  network**, which must never read as a match. Run before handing anyone a
  version to test. It reports `0.14.1` as 8 files stale — the incident it exists
  for.
- `scripts/analyse-routes.mjs`, `scripts/analyse-escalations.mjs` — the §16/§17
  measurements, kept runnable because both were negative results.

## Things I got wrong today, because they were expensive

- **Released `0.14.1` without the change it was meant to contain.** Tagged at one
  commit; item 148 landed after. An external tester diffed the package and caught
  it: *"I came within one command of filing this report against the wrong
  binary."* The tag went stale **again** before 0.14.3 — six commits behind — and
  only the pre-tag diff caught it. Always diff before tagging.
- **Blamed sharding for failures it merely exposed** (144), then `openurl` (145),
  then hunted a `waitFor` that passed wrongly — when `waitFor` had correctly
  failed and nobody was listening (166).
- **Silenced a correct message with an "improvement."** My UNDER-READ
  attribution reported a real wrong turn as the instrument's fault, and I nearly
  downgraded the whole check to a NOTE before reading the tour note saying that
  pair exists *to catch exactly that collision*.
- **Built a gate on an unpublished signal** (161): refusing to type when nothing
  reports focus produced a false refusal on the legitimate case, because iOS does
  not reliably publish `AXFocused`. Reverted. Testing the *working* case, not
  only the broken one, is what caught it.

## Standing rules

- **No client or third-party project name in this repo, ever.** Verified clean.
  Note that escalation logs and `detail` fields carry app content — a scratch
  script once printed a client's screen labels and a customer email into a
  terminal. Classify against a closed vocabulary instead.
- Do not rewrite git history without an explicit, specific instruction.
- Never `git add -A` without looking. Verify checks separately, never chained
  with `&&`.
- Release files (`server.json`, versions, the workflow) only when the task is
  explicitly a release or a fix to the release path — say what and why first.
  `npm version` is the only way to bump.
- **If CI failed, don't publish.** "Cancelled" is not "failed" — but say which.
- Docs, article and README current **before** a push and release, numbers
  included.
- `cancel-in-progress` is keyed on **event + ref**: a push to main cancels the
  in-flight main run. Never push while waiting on a run you need to read.

## State of the machine

- Bench device `326464A4` **shut down**; no daemons; nothing booted.
- `7B8F8963` belongs to another of the owner's projects — always pass `--device`.
- Port 8081 is someone else's Metro. Do not kill it.
- Both field reports live under `/private/tmp/...` paths from *other* sessions
  and will vanish. Everything actionable is in DEFERRED 148–170, with the
  reporters' wording where it was better than mine.
