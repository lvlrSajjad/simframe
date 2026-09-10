# Deferred work

Things consciously left undone, with the reason. Each was cheap to note and
would be expensive to rediscover. Nothing here is a bug; bugs get fixed or filed
as such.

Ordered by how much it would hurt to keep ignoring.

## Priority right now — 2026-09-09, end of the Phase 11 session

Rewritten, because the previous version had grown three separate "P0" headings
and a numbering of 1, 1b, 1c, 1d, 1e, 1f. Ordered by what it costs to keep
ignoring, and everything with a threshold in it sits behind the thing that
would say whether the threshold is right.

Done this session and struck rather than deleted, so the order is traceable:
**Phase 11 step 4** (the focus window and the identity settle) and **the
orphaned HID session** (the staleness gate was keyed on the process, so it
could not fire in the MCP server; `simframe input reset` now exists and is what
`doctor` prints).

> **Status, end of 2026-09-11 — read this first after a compact.** Supersedes
> the 2026-09-10 block below, which is kept for its reasoning.
>
> **Three peer rounds and an external research brief landed in one day**, and
> the shape of the day is worth stating before the list: every serious bug found
> was a component reporting more certainty than it had, and not one of them
> would have failed a test. Items 82-88 are the third round; **89-97 are the
> research answers** (`docs/research/05-private-api-and-uncertainty.md`).
>
> **Done today**, all verified on a device rather than on a bench: the field
> readback works on web content at all (it never had), a value simframe wrote
> and can no longer see is announced, `detail:"high"` serves a real
> full-resolution frame, `sweep` no longer pull-to-refreshes at the top, a look
> cannot claim an image is fresher than its bytes, the stale-ref message no
> longer prints 8 characters of a 72-character hash, an alias cannot pair two
> z-layers, the keyboard boundary reaches its own top row (`TOKEN_RULES_VERSION`
> 6), **a keyboard key can be pressed on iOS at all** for the first time, **a
> field can be cleared** (90), and text insertion waits for focus (91).
>
> **CI went from 28 minutes to about 10** by taking `bench` off the push path —
> it cost 28 of a 28-minute run and could only ever emit a warning — plus a
> daemon-build cache and `cancel-in-progress`. `bootstatus -b` now waits for the
> boot to finish, which is the best available explanation for three different
> integration failures in four runs (95).
>
> **The red CI was hiding a worse bug than itself (2026-09-11, late).** The
> `integration` job failed one check: the stale-ref guard, which asserts that a
> `#n` numbered on one screen refuses rather than tapping those coordinates on
> another. It failed on **prose** — it matched three phrasings and simframe had
> answered with a fourth. That looked like a test-only fault. It was not.
>
> Re-running the scenario on a device rather than reasoning about it: `find #1`,
> numbered "Reminders" in Reminders and asked for in Contacts, **returned
> `ok: true`** — it re-resolved the label onto the status-bar back-to-app
> breadcrumb "• Reminders", scored 0.64, and handed back a tap point at (47,40)
> in the status bar, a region the screen map explicitly refuses to offer. The
> harness had caught a confident wrong answer and reported it as a wording
> mismatch, and in CI the same bug happened to fail loudly only because the
> label was absent there.
>
> The cause was mine, from earlier the same day. `refs.js` distinguishes three
> refusals — a **different screen**, an **unrecognised** screen, and **layout
> drift on the same screen** — and the relabel recovery was built for the third
> (the reported case: dashboard cards finished loading, same screen, new hash).
> Identity and drift wore one flag, so it fired on the first as well. Fixed by
> discriminating them (`staleKind`), and the recovery now runs on drift only.
>
> Two things came out of it worth keeping. `find --json` now carries `reason`,
> `staleRef` and `staleKind` as **fields**, in one shared `failureJson` — a
> refusal recognisable only by reading its prose is one nobody can depend on,
> and this check had now gone red twice for exactly that. And two tests were
> asserting the **shape of the source** rather than the behaviour: one grepped
> `cli.js` for the literal `ok: false`, and the stale-ref test constructed an
> identity mismatch while its own comment described drift — which is what let
> the recovery be wired to the wrong branch in the first place. Both now run
> the thing.
>
> **Next, in order.**
>
> 1. **The release.** 0.11.0 is authorised and gated on a green `integration`.
> 2. **89 and 92** — `custom_actions` and `AXTraits`. Both are already in the
>    tree, we have never asked for either, and between them they answer the
>    modality bug (85) and offer a way to act on an element that is not a
>    keystroke and so cannot be corrupted by a keyboard layout.
> 3. **93 + 94 together** — the sweep. Sections do not overlap because the
>    gesture flings; the answer is a dwell before lift plus computing the next
>    step from a measured content-anchor delta. One closed-loop piece, and built
>    **offline against the perception harness** rather than by swiping at a live
>    page — that mistake cost two wrong fixes today, one of which made it worse.
> 4. **86** — `memory disagrees` fires on nearly every call because screens
>    carrying live numbers and dates do not hash stably. Wants numeric and
>    date-shaped text out of the fingerprint, so another `TOKEN_RULES_VERSION`.
> 5. **78, 87** — promote "1 of 4 steps unverified" to the first line of a
>    result, and flag low-confidence taps on partially occluded elements.
> 6. **88** — lead with intent resolution rather than refs. **Done for the
>    README and the SKILL**; the MCP tool descriptions still lead with `#3`.
> 7. **96 before any further supervisor claim.** The A/B is inside the noise
>    band and needs the full 2x2 with repeated cells.
> 8. **97** — conformal abstention and Dempster-Shafer. Least urgent, most
>    likely to matter in a year, and the weight-free subset is adoptable under
>    the no-shipped-weights non-goal.
>
> Older queue, unchanged: item 11 (the structural window), 71 (`choose`), 72
> (`sweep` measured with `ax-first`), 61's remaining half, and 62-70.

> **Status, end of 2026-09-10 — superseded by the block above.**
>
> Gate A (1, 14, 22) and Gate B (3, 4, 6, 8, 21) are complete. Gate C is
> complete except **item 11**, with item 10 half done on purpose — its
> measurement is in and nothing acts on it. **Phase 11.5 is done**: the
> diagnosis overturned its own premise (batches are short, not absent), and the
> fixes are tool descriptions under 60 words, a locally computed `next:` line
> telling the model when it need not think, a trailing map that is re-read
> rather than recalled, and a rewritten SKILL. The map-shrinking half was
> **reverted the same day** — see `docs/BENCHMARKS.md`.
>
> **Phase 17 is a NO-GO, decided 2026-09-10 by running its own go/no-go.** Of
> 40 real element decisions, the local matcher already resolves 37. The
> deliberation the phase set out to remove happens *upstream* of the tool call
> — a verified edge's goal already names the option Claude picked — so a model
> inside the daemon would only re-derive a decision already made.
> `scripts/phase17-corpus.mjs` reproduces it; the reasoning is in
> `docs/PHASES-HUMAN-PARITY.md` and the numbers in `docs/BENCHMARKS.md`. **The
> CLAUDE.md amendment it wanted is no longer needed.**
>
> **Phase 11.5 and everything after it is on `main` and NOT yet released.**
> 0.10.0 is what is on npm.
>
> Struck items keep their original diagnosis where the diagnosis was wrong,
> because that is the instructive half. Decisions that changed the plan — the
> no-go, the two reverts, the false premises — are indexed in
> `docs/DECISIONS.md`.
>
> **Built and awaiting its first field round (2026-09-11 state).** The cheap
> retry exists (`or`), bounded exploration exists (`seek`, and it is the thing
> that pressed an affirmative button in a live app before its permissions were
> split), the destructive vocabulary exists at last, and there are three local
> tiers behind flags: `--sensor=ax-first`, `--planner=apple`,
> `--supervisor=apple`. All three are per-call arguments on every MCP tool too,
> because an MCP server's environment is fixed at spawn and that cost a round.
>
> **The supervisor is measured on a bench and not in the field**, which is the
> distinction to keep: every previous local-tier idea here survived a bench and
> died on a real app. The number that settles it is not accuracy, it is whether
> batches that used to be abandoned now finish. Round 7's prompt asks for
> exactly that, plus the operator's live commentary mapped to causes — round 6's
> version of that section was the most useful thing in the report.
>
> Deterministic fixes landed alongside it and each should be re-checked in round
> 7: `assert` reads fresh and looks twice (item 49), a stuck `continueOnError`
> run stops (52), an `or` chain that misses while the screen just moved says
> timing not naming (53), and a settle reports an unpopulated list (51). Still
> open from round 6: **50** (`find`'s stale Visible list), **54** (`or` cannot
> express "the enabled one"), **56** (ref lifetime undocumented), **57**
> (`all` without `refresh`), **58** (`seek` asks the wrong question for a
> wizard), **59** (`sim_state` never suggested).
>
> **The unifying finding of 2026-09-10 is item 46, above: there is no cheap
> retry.** Four separate examples from the owner turned out to be one problem —
> an attempt fails benignly, you vary it and retry, without deliberation — and
> simframe answers all four by throwing and abandoning the batch. That is the
> next thing to build, and it needs no model.
>
> **Items 41, 42 and 43 are done — one root cause, three findings, 2026-09-10.**
> A phantom keyboard was deleting screens' content from their own identity: a
> dozen short text rows of uniform height stacked low on a read-only summary
> satisfied every size-and-uniformity test for a keyboard, and
> `fingerprint.tokens` discards everything below `keyboardTop`. So two screens
> of one wizard, sharing a nav title and a step indicator, collapsed onto one
> hash — which is what offered one screen's remembered controls on the other,
> and what made `locate` resolve against the wrong screen's stored elements so
> `assert` denied a string the map printed four lines below. `detectKeyboardTop`
> now requires the small uniform boxes to be **keys**, and `TOKEN_RULES_VERSION`
> is 5 so the stored graph and maps are discarded.
>
> Item 43 separately: `nearestScreen` has always had a token-similarity
> tolerance for content variation, and the verification path threw it away by
> passing bare hash strings. It passes the whole reading now. **Next: item 44**
> (open a batch against a remembered screen with no read), then the local-triage
> question, then Phase 12's cheap half.
>
> **Round 5 fixed the safety hole its own new feature opened** — remembered
> vocabulary is now checked against the screen, and a disagreement outranks
> "carry on" — plus `unexpected-screen` while loading, the false focus warning,
> and the keyboard band with no keys in it. **Next: items 41 + 42 together**
> (screen identity is too coarse, and it is the root of both), then **43** (the
> negative verdict on data variation — leave the positive one alone), then
> **44** (open a `sim_do` against a remembered screen with no read at all).
>
> **Round 4 (cold start) fixed T1, T2, T5 and T7, and produced the plan-first
> change: the graph now names what worked on a screen instead of counting it.**
> Open next: **item 36** (`unexpected-screen` on legitimate variants — it costs
> the rest of the batch), **item 38** (phantom rows after a scroll), **item 40 /
> 32** (cosmetic content moving screen identity), **item 37** (`assert` races),
> then item 35, item 33, item 26.
>
> **Next, in order — reset by the third peer round.** Round 3 fixed N1, N2, N3,
> N5, half of N6 and N7, which covers round 2's items 23 and 24. It also
> **disconfirmed item 25**: every screen in the surprise flow reported `known`
> and calls-per-step was still 7× worse, so unfamiliarity is not the cost and
> the hint is not what to fix next. Open, in order: **item 32** (refs churn — but
> measure again first, since N5 is fixed), **item 35** (value and state on
> selects and inputs), **item 33** (`settle` should degrade), **item 34**
> (`no-visible-change` on tap is intermittent), **item 26** (the form read),
> then item 11, then Phase 12.
>
> **How we work now (2026-09-10):** a phase ends with tests green and the work
> pushed, then a **proposed peer test** — not a release. A CI cycle plus a
> release costs ~30 minutes of waiting, and every finding that changed the plan
> so far came from a peer driving a real third-party app rather than from the
> bench suite. Wait for an explicit instruction before `npm version`.
>
> After that, the CI speed work, which the user asked to confirm before it
> lands: `concurrency: cancel-in-progress`; move the fingerprint distribution
> check into the offline harness (−4.8 min and it stops flaking); take `bench`
> off the push trigger (−15.2 min, it never gated); make the memory-layer
> assertion tolerate a device that legitimately learned nothing. ~32 minutes of
> simulator time per push down to ~11.

### P0 — the engine is learning wrong things, and everything else measures on top

1. ~~**A settle can be satisfied by stillness older than the action it waits
   on.**~~ **Done, 2026-09-10.** `waitFor` re-baselines when the screen already
   differs *and* has already been at rest for the whole stillness window, and
   the graph records no edge for an action with no observed effect. Six runs,
   two rounds, clean graph each: **zero self-edges**, against `count: 11` and
   `changedOutcomes: 5` before. Pass rate unchanged at 5/6; the failure mode is
   now a caught `unexpected-screen` at the step that made the wrong turn rather
   than a silent walk-on. `docs/BENCHMARKS.md`, "Gate A, item 1".

   The original diagnosis, kept because it is the instructive half:
   `tap Accessibility` reports `settled 124ms` against a 500 ms stillness
   window and the screen never left the Settings root. The baseline hash is
   taken at the top of the step; if it lands mid-animation it already differs
   from the live hash when the wait begins, so `sawChange` is true before the
   action did anything.

   The cost is not the failed step — `screenIdentity` then reads the screen we
   never left and the graph records **root → root** as verified. The stored
   edge had `count: 11`, `changedOutcomes: 5`. This is the corruption the
   learned-stillness revert cleaned up, and it came back *without* learned
   stillness, so that was never its only cause and deleting the graph is a
   remedy for the symptom. Measured 2/6 suite passes before step 4 and 5/6
   after, which nudges it and does not touch it.

   **No harness needed.** This is a logic fix, not a threshold: `sawChange`
   must mean "changed after the dispatch returned", so the baseline has to be a
   frame captured after the action, not before the step. First thing to do.

2. ~~**The Phase 5 perception eval harness** — fifteen screens, three apps.~~
   **Done — `scripts/eval-perception.mjs`, 16 screens across 5 apps, 73
   expectations, and it gates in CI.** Struck here rather than deleted because
   the shape changed: the harness this entry described cannot exist. It wanted
   to replay stored frames through perception and diff the element lists, and a
   frame on disk is half the input — the tree is not in the frame and OCR runs
   in the daemon against a live framebuffer. So the machine records the *input*
   (the fused element list, as perception produced it) and a person authors the
   *expected output*; everything downstream is a pure function, so resolution,
   identity and change all check offline in a second with no simulator. What it
   deliberately does **not** measure is whether perception found the elements at
   all, which stays live in `eval-fingerprint.mjs` and the integration job.

3. ~~**Small-delta taps are invisible to the change detector.**~~ **Done,
   2026-09-10 — and my own framing of it was wrong in a way worth keeping.**

   True: the daemon's `changed` is `signatureDiff > 0.004`, a mean over a 4x8
   grid, and a measured switch flip moves the mean by **0.001348** — a third of
   the threshold. So `stableForMs` genuinely cannot see a switch.

   Not true: the consequence I asserted. `waitFor` does not use `changed` for
   `sawChange` — it compares **frame hashes**, which are far more sensitive, and
   measured on the same flip the hash *did* change (`…dbdf` → `…dbdb`). So this
   switch was never actually costing a settle budget, and the reported ~2.5 s
   per radio/segment tap **does not reproduce here**. The 124 ms
   `no-visible-change` I attributed to it was a tap on the row *centre* that
   flipped nothing at all — which is its own bug, filed below.

   What shipped is the backstop for changes below the *hash's* resolution,
   calibrated to a measured gap rather than chosen: `analyze.CELL_CHANGE =
   0.012`, sitting between the flip's largest single-region delta of **0.0431**
   and the loudest thing on eighty seconds of a static screen — the status-bar
   clock ticking, at **0.0039**. Eleven times' separation, so no row needs
   excluding; the clock simply does not reach it, which is a better reason to
   ignore it than a structural exclusion that would also blind the nav bar.

   It feeds `sawChange` and deliberately **not** stillness. A blinking text
   caret is a small localised change, and a screen with a cursor in it would
   otherwise never settle. The two signals answer different questions: "did the
   action do anything" and "has the screen finished moving".

   **Not demonstrated firing on a real control**, because the one I could flip
   is already caught by the frame hash. Both measured signature pairs are in
   the harness as `frame_pairs`, so the calibration is regression-tested even
   though the path is not yet exercised in anger.

### Answers from outside — the research brief, 2026-09-11

`docs/research/05-private-api-and-uncertainty.md` answers the seven questions we
could not answer ourselves. Its confidence tiers are (a) verified with a source,
(b) inferred, (c) nobody has solved this — and several items below are marked
**verify-against-binary**, which is this project's standing discipline: a
signature is not confirmed until the binary states its own prototype.

**Immediately actionable, cheap, and none of it needs a decision.**

89. **`custom_actions` is already in the tree and we have never asked for it.**
   idb's `describe-all` emits a `custom_actions` array per element — e.g.
   `["Edit mode","Today"]` on a calendar icon — and `AXPTranslatorRequest`
   carries an `action` field. We request eight attributes and none of them is
   this. Called "the single most under-used lever" in our request, and it is the
   candidate answer to item 61: an action performed on an element is not a
   keystroke and cannot be corrupted by a keyboard layout.

90. ~~**Clearing a field: ⌘A then Delete over HID.**~~ **DONE, same day.** Left-GUI usage `0xE3` plus
   `a` usage `0x04`, release, then Delete usage `0x2A`. Layout-independent,
   because the modifier and Delete are key *positions*, and `a` in ⌘A is a
   position too. We already have the key path — it shipped today for Return
   (usage `0x28`, which the research confirms) — so `clear`/`replace` is now a
   small step rather than an open question. **No tool has a clear primitive**;
   XCUITest, Appium and idb all lack one, so this is the standard workaround
   rather than a hack of ours.

91. ~~**Gate every text insertion on a confirmed focus read**~~ **DONE, same day** — and stop
   investigating paste-versus-type. Two verified causes, and neither is a
   primitive defect. iOS 16's **paste-consent prompt** can swallow a first
   programmatic paste (Apple confirmed the early-iOS-16 over-firing was
   unintended; there is now a per-app "Paste from Other Apps" setting). And a
   keystroke delivered before a web view commits focus is **dropped** — WDA
   copes by checking `hasKeyboardFocus` before typing. That is the whole
   explanation of "one primitive reports success into an empty field and the
   other then works", it is a focus race, it will never reproduce
   deterministically, and **chasing a paste-vs-type bug is the wrong
   investigation**. We already fetch `AXFocused`; we just do not wait on it.

92. **`AXTraits` exist and we read none of them.** From `AXRuntime`:
   `AXTraitScrollable` (bit 33), `AXTraitCausesPageTurn` (14),
   `AXTraitAdjustable` (12), `AXTraitAlert` (56), `AXTraitTouchContainer` (45),
   `AXTraitSupportsZoom` (46), `AXTraitContainedByTable`/`List` (43/44). Two
   uses land immediately: `AXTraitScrollable` tells us *which* element is the
   scroller instead of inferring it, and `AXTraitAlert` is the **modality hint
   we lack for item 85** — when a smaller frame sits inside a larger element
   carrying `AXTraitAlert`, prefer that subtree and suppress the rest, rather
   than only reporting that two layers disagree.

**Answers that close questions rather than opening work.**

93. **There is no scroll offset, and we were asking the wrong question.** No
   AXP or CoreSimulator attribute exposes `contentOffset` or `contentSize`;
   XCUITest cannot read them either; and *no public tool* answers "am I at the
   top" from a read — WDA, Appium, idb and XCUITest all answer it behaviourally,
   with the same heuristic family we already tried. Since only rendered content
   is published, absolute position is **not observable — only change is.** So
   our current best (content-only frame deltas, two consecutive stalls) is the
   state of the art, with one upgrade worth taking: measure a **stable content
   anchor's** frame delta rather than a label-set novelty, and compute the *next*
   step size from measured travel. That closes the loop on item 87's sibling
   defect — sections that do not overlap.

94. **The unpredictable swipe is UIScrollView inertia, and the cure is a
   drag.** Pan velocity comes from the final touch samples before lift, so our
   612pt/260ms gesture measuring 28/40/482/529/0pt is a fling on some runs and a
   near-static lift on others. Recipe: dwell ~50-80ms at the start, many small
   equal steps (idb uses 10pt) with monotonic realistically-spaced timestamps,
   and — the highest-value part — **dwell 80-120ms at the end before lift** so
   the last velocity samples are zero. Total ~600-800ms for ~600pt. Apple's own
   `thenHoldForDuration` has a documented no-effect bug on a perfectly still
   finger, and Apple DTS concedes coordinate drags carry "a consistent error of
   several pixels". **Nobody gets deterministic travel**; the answer is
   closed-loop measurement, not open-loop tuning.

95. **Hosted-runner simulator flakiness is universal and documented**, with a
   list of `actions/runner-images` issues to match: #7971 (simulators failing to
   boot or use openurl), #11874, #9511, #8434 (a new image ~2x slower), #11845,
   #12948. Teams running XCUITest at scale **self-host or use a device cloud**.
   So the bench job stays non-blocking on hosted runners, which is where it
   already is. **The one change worth making landed immediately**: `simctl boot`
   returns before the device is usable and nothing waited on it, so
   `bootstatus -b` now blocks until the boot completes — named in #11874 as the
   fix for exactly this, and the best available explanation for three different
   failures in four runs of our own integration job.

   **The `bootstatus -b` half is done, same day.** The rest of Q5's mitigations
   are not, and are worth reaching for when this job next misbehaves: keep the
   simulator warm across the whole job rather than re-booting, disable
   animations and pre-dismiss SpringBoard's first run, quiet the app under test
   with `SIMCTL_CHILD_*`, consider GitHub's larger macOS runners (the slowdown
   reports correlate with the smallest images), and pre-launch the Simulator GUI
   with `xcrun instruments -w <udid>` — openradar 27524047 documents that
   `simctl` alone is unreliable under load.

96. **Our supervisor A/B is inside the noise band until replicated**, and this
   is the correction worth taking on the chin. Single-run agent measurements
   vary by 2.2-6.0 percentage points depending on which run you pick, standard
   deviations exceed 1.5pp even at temperature 0, one study found up to 15%
   accuracy variation across identical reruns at temperature 0, and 15-22% of
   tasks are flaky across reruns. **So "25 calls versus 45" is one run of a
   two-armed test of a two-factor system and cannot carry the weight anyone has
   put on it, including me.** The design: a full 2x2 factorial
   {neither, briefing-only, model-only, both} run **within-subject** with a
   **Williams design** to balance order and first-order carryover, the
   transition graph **reset between conditions** (or cold/warm treated as an
   explicit blocking factor), each cell **repeated** with mean ± SD reported,
   primary response **model calls** analysed as a paired within-flow difference,
   completion as a gate rather than a metric, and recovery-call fraction as the
   diagnostic that actually separates "the briefing prevented a failure" from
   "the model recovered one".

97. **The literature for our recurring failure exists and is mature**, and the
   weight-free subset is adoptable under the no-shipped-weights non-goal.
   **Selective prediction / classification with a reject option** is the formal
   name for "a sensor should refuse rather than answer". **Conformal
   abstention** gives distribution-free guarantees where the error budget α
   *reads directly as our allowed false-warning rate* — which operationalises
   the rule we keep rediscovering, that a warning which is usually wrong is
   worse than no warning: set α to the false-warning budget and the threshold
   follows with a coverage guarantee, calibrated by a stored quantile rather
   than a learned model. **Dempster-Shafer** represents *conflict* and
   *ignorance* as distinct from *low probability*, which is exactly our
   sheet-versus-background disagreement, and lets "I could not tell" be carried
   as first-class mass instead of collapsing into a confident wrong answer.
   **Cascades** (FrugalGPT, RouteLLM, early-abstention) are the literature for
   deciding locally when to escalate — with the caveat that most of it assumes a
   learned router, which would be shipped weights. And from the **UTG**
   literature (DroidBot, Stoat, Humanoid, AppAgent): the recurring hard problem
   is **state-abstraction quality**, and the transferable idea is to abstract a
   screen by its **element-identity set rather than a pixel hash** — which is
   precisely what would stop a footer with live content thrashing our
   fingerprint.

98. **The relabel recovery still trusts a weak match, even on drift.** Fixed
   today so it only runs when the screen is the same one and the layout has
   moved (`staleKind: 'drift'`), which removes the case that hurt. What remains
   is that the re-resolution is an ordinary label lookup: it accepted **0.64**
   and a target in the **status bar** — a region `sim_ui` refuses to offer as
   something to tap, because taps there open the clock or scroll to top. Two
   guards it should have and does not: a floor on the score, since a recovery is
   a *guess* and should be held to a higher bar than a lookup the caller
   actually asked for; and a refusal to land in a region the map itself will not
   publish. Cheap, and the second one is a rule we already state elsewhere and
   do not enforce on this path. Worth doing before the next peer round.

**Ordering.** 89-92 are cheap and independent; 91 changes what we investigate
rather than adding work. 93 and 94 together are the sweep fix and should be done
as one piece, closed-loop. 98 is small and sits next to them. 96 gates any
further claim about the supervisor. 97 is a reading list that could reshape the verdict layer and is the least urgent and
most likely to matter in a year.

### From a second peer on the same RN app — three confidently-wrong headers, 2026-09-11

Their own framing is the useful part: *"the three bugs above are all in the
'confidently wrong' family rather than the 'obviously broken' family, which is
the dangerous kind for an agent-facing tool."* All three are fixed.

82. **A look could serve an hours-old image under a fresh header.** Reported as
   `sim_look` returning another device's screen: the header read `frame #714 ·
   84ms old · still for 17173ms` above an image whose status-bar clock said 6:11
   when the real time was 11:10. **Device resolution was not the fault** —
   measured both booted devices, each returns its own frame and hash. The fault
   is that `state.json` and the image are **two separate writes**: state is
   written when a frame is recorded, the PNG separately, so a freshly started
   daemon publishes fresh state while `latest.png` is still the previous
   session's — which is exactly when a session's first look lands. Their own
   evidence gives it away: `sim_ui` was right in the same session because the
   accessibility tree is read **live and in-process**, so only the image comes
   from a file and only the image can be hours stale under a confident header.
   The reported age is now the larger of the state's age and the file's mtime
   age, which cannot overstate freshness — it can overstate staleness by however
   far apart the two writes land, measured at **6ms** on a healthy daemon.

83. **Two booted devices can share a name**, and do on this machine — two called
   "iPhone 17 Pro". A header naming only the model cannot say which answered.
   `sim_devices` now warns on the collision and headers carry a UDID prefix
   while it holds. Their suggestion, and `xcrun simctl list devices booted`
   makes it trivial, as they said.

84. **The stale-ref message printed 8 characters of a 72-character hash.**
   Reported three times as `#4 was numbered on a different screen (03003714 →
   03003714)` — asserting the screen changed while showing that it had not, so
   they could not tell a real move from a false positive. Verified on the device:
   `layoutHash` is **72 chars**, and the refs table's own prefix at the time of
   the fix was `c3cc409c`, one of the three pairs they quoted. A perceptual
   hash's leading characters encode coarse structure, which is *precisely why*
   this comparison is a distance against a tolerance rather than an equality, so
   prefixes coincide routinely. The two refusals had been wearing one sentence
   and now have their own: identity names the hashes it compared, drift reports
   the layout distance and tolerance and states outright that the identity may be
   unchanged. Both say how long ago the refs were issued, asked for by name.

85. **An alias was pairing two z-layers.** With a sheet open over a dimmed page,
   `#15 text 167,316 Area (Optional) ~ Exterior Building` reads as though the
   field contains that value; they are unrelated things at one coordinate on
   different layers, and the reporter fell back to a screenshot to count five
   radio options — the case the text map exists to remove. A labelled ax element
   now only takes an alias related to its own label; an unlabelled one still
   takes the text outright, because that is how an icon-only control gets a name
   and it cannot contradict a label it does not have. A rejected pairing becomes
   its own element and the disagreement is reported as a probable overlay.

**Open from this round.**

86. **`memory disagrees with this screen` fired on almost every call and became
   noise** — roughly ten consecutive appearances on screens that were fine.
   Their diagnosis is almost certainly right: this app's screens do not hash
   stably because the maps carry live values (`45 Records`, `1634 Records`,
   `Sep 10, 2026`) and async rows. Two fixes, and the first is the real one:
   exclude numeric and date-shaped text from the fingerprint (a
   `TOKEN_RULES_VERSION` bump, so stored graphs and maps are discarded), and
   suppress the warning after it has been overridden N times in a session.
   *"A warning that's usually wrong trains the reader to skip the line it's
   printed on"* — which is the same lesson as item 75, from a different reporter
   on the same day.

87. **A tap that scrolls instead of activating is reported as success.** Their
   first tap hit a list card at `y=38`, partly under the nav bar; the list
   scrolled and nothing was selected, reported as `ok … [a small change, in one
   region only]`. The ingredients to be suspicious were all present — an element
   at the top edge under a known nav bar, and "a small change in one region" is
   what a scroll looks like rather than a navigation. Flag low-confidence taps on
   partially-occluded elements.

88. **`#N` refs are less useful than the docs claim.** The description calls
   `#3` "cheapest and unambiguous"; in practice refs renumbered constantly and
   were only safe within one round trip, while intent resolution worked every
   time — `"the Assets tab"`, `"Area (All)"`, `"CREATE A SERVICE REQUEST"`,
   including a `d=0` memory hit. **This is the fourth round running where labels
   beat refs.** A documentation change, not a code one: lead with intent
   resolution.

**Praised, and worth protecting.** *"Errors that diagnose instead of just
failing"* — they singled out `waited 10000ms for Gaslamp: "Gaslamp" is in the
tree but not in view — it is at y=2975 on a 874pt screen. Scroll to it
(sim_scroll_to) rather than waiting; waiting cannot bring it into view.* as
**the best error message they have seen from a tool of this kind**, because it
gives the state, why the approach cannot work, and the right tool. Outcome
memory (`ok: matches the outcome seen 3x before`) was called the real
differentiator over screenshot-driving. The half-loaded-list warning, the
false-negative guard on filters, and cost framing in the descriptions were all
named as behaviour-changing. Every one of those is an instance of the same
principle and it is worth stating once: **this tool's value is in what it says
about its own certainty, not in what it can do.**

### From a peer driving a React Native app — 2026-09-11

A single app, a single session, heavy async list loading — which is the profile
that stresses the settle heuristics hardest, and the reporter said so themselves
rather than leaving it to be discovered.

**Fixed in this round.**

74. **There was no way to press a keyboard key on iOS.** The reporter was
   blocked outright: half of mobile search fields submit on the return key,
   `button` covers only HOME/LOCK/SIRI, and `key` fell through to idb, which is
   absent on a machine using the daemon. Typing `"\n"` as text is not a
   substitute — text goes through the active keyboard layout, and it turned
   `Coke Display` into `Coke In Display`. The primitive existed the whole time:
   `IndigoHID.key(usage:op:)` had been implemented and never exposed as a verb.
   Now `{"key":"return"}`, by name, on a usage-code path that no layout
   translates — which is the point on a device whose own `doctor` warns that two
   extra layouts are installed. **Not yet pressed on a device**: the benchmark
   simulator had the owner's app in the foreground with a half-built service
   request on screen, and a stray Return there could submit it.

75. **The count-header heuristic cried wolf, and got itself ignored.** `a header
   promises 1232 records and only 43 row(s) are here yet` fired on nearly every
   step of a list whose correct final state was 43 rendered rows. The reporter's
   verdict is the reason this was capped rather than tuned: *"by the fourth
   occurrence I was ignoring it, which is the failure mode you least want from a
   warning."* The flaw was deeper than the threshold — on a paginated or
   virtualised list the header is a **total**, and a total says nothing about how
   many rows belong on screen. It now only speaks when the promised count could
   plausibly be a count of rendered rows (≤30, about a viewport).

76. **A stale ref aborted three remaining steps for want of a label it already
   had.** `#19 was numbered on a different screen (61b835b7 → 6f34c006)` because
   dashboard cards finished loading and shifted the layout — the same screen, a
   new hash. The ref table stores the label behind each number, so the refusal
   now carries it and the caller is re-resolved **by label**, never by the old
   coordinates, and told so in the step detail. Their suggestion, and a good one.

77. **The multi-device error pointed at a shell that does not exist over MCP.**
   *"set SIMFRAME_DEVICE to pick a default for this shell"* — so they passed a
   36-character UDID on all ~20 calls. The sticky device landed the same day
   from another report and the message never learned about it; it now says to
   pass `device` once.

**Open, and the reporter's own ordering is kept.**

78. **A `type` that lands nowhere still returns `ok`** — their most important
   finding, and the third independent report of it. Two of their three incidents
   are now covered by the readback (item 1 of this round): an unread field says
   `unconfirmed`, and the OCR fallback means a web field can be read back at all.
   The third is not: an iOS Paste/AutoFill bubble intercepted the tap and the
   field kept its placeholder. Their proposed remedy is worth weighing on its
   own — *promote "1 of 4 steps unverified" to the first line of the result*
   rather than leaving it as a per-step trailer.

79. **OCR is winning over the tree on React Native text.** `Q bearch`,
   `Possible Warrantv`, `Location (AII)`, `MoreR` — cosmetic. `O Records` for
   `0 Records` is not: a digit read as a letter silently breaks an assertion.
   Their proposal is that AX should win outright for text content and OCR supply
   only geometry — and the fusion rule already does exactly that when an ax
   element covers the text. So the premise needs checking before the fix: if
   these arrived OCR-only, the tree had no string to prefer, and the answer is
   **item 21 (OCR confusables)**, a comparison change, not a fusion change.
   Do not build either until it is known which.

80. **Network visibility — the feature they would add, "by a distance."** They
   hand-rolled a CDP bridge to Metro's inspector and patched `XMLHttpRequest` to
   see what the app sent, and *that* is what made the bug diagnosable: the screen
   looked identical whether the API returned `403`, returned `200 []`, or was
   never called. Most "is this broken?" questions are answered by the network
   rather than the pixels. The pairing they describe is the interesting part and
   it is ours to make: simframe already knows when a screen settled, so
   "settled, and these three requests fired with these statuses" is a sentence
   nothing else can say. `http://localhost:8081/json/list` is the plumbing.
   **A product decision, not a fix** — it is a new capability and a new
   dependency surface, so it needs an explicit call.

81. **Detect screen changes the agent did not cause.** Their runner-up, and it
   bit *me* the same afternoon: the owner's app appeared in the foreground of the
   benchmark device mid-field-test, and I ran 28 swipe gestures before noticing.
   Their own version was a search field containing `2609251` that they had never
   typed. Frame hashes and stillness are already tracked, so an unattributed
   change signal is nearly free — and a human and an agent on one simulator is
   precisely the QA scenario, not an edge case.

**Praised, recorded because knowing what to keep is as useful as knowing what to
fix.** Pricing the tools in their own descriptions changed behaviour
immediately — *"very few tools bother to price themselves, and it works"*: three
`sim_look` calls all session against constant `sim_ui`. The `next:` trailer was
called the standout feature, specifically for correcting a wasteful re-plan
in-band. Cross-session `worked here before:` was called a real differentiator.
And intent resolution beat numeric refs consistently — `sim_tap "the More tab"`
first time — which is the fourth round in a row where labels beat refs.

### From a bug-fixing agent, not a peer round — 2026-09-11

A different agent used simframe to fix a ticket and reported back. Five findings,
ordered by what each cost them. Four are fixed; the fifth is not ours.

**Fixed: the viewport had one edge.** Every off-viewport filter in this project
checked `y` and ignored `x` — invisible until a horizontal row. A filter chip
came back at **x=422 on a 402pt-wide screen** and counted as visible, so
`scroll_to` answered *"'Assigned to Me' is in view at 422,277 already"*, which is
confidently wrong about the one thing it exists to decide. Off-screen chips read
as **x=-247** the same way. Their note on the cost is the part worth keeping:
*"the cost was not the wrong answer — it was that the wrong answer was confident,
so the recovery was hand-tuned swipes and two overshoots."* One predicate,
`regions.offViewport`, now used by the row filter, by `locate`'s visible list and
by the off-screen match.

**Fixed: `sim_look` takes a `region`.** A whole screen at 1024px cannot tell a
selected chip from an unselected one, and selection state was the entire question
their ticket turned on — so they shelled out to `simctl io` and PIL to crop and
upscale, **for every single check**, at an estimated six round trips. `region` is
in points, the same coordinates the map prints, and the crop is enlarged to the
same budget the whole screen gets. Verified live: a 402x120pt slice came back as
a legible 966x288 image.

Building it found a second bug of the same family as the first: `state.width` and
`state.height` are the **captured frame's** pixels (322x700), not the screen's
points (402x874). Scaling by them made a crop at y=760 clamp to a single pixel
row and return a 119-byte image — which looked like it had worked.
`screenIdentity` supplies the point size in ~17ms warm.

**Fixed: the device is sticky.** `sim_launch` accepted `device`, and the very
next `sim_ui` refused with *"2 simulators are booted and none was named"* — so a
UDID had to ride on all ~15 subsequent calls. Refusing to *choose* between two
booted devices is right; forgetting which one the caller already named is not.
Only an explicitly passed device is remembered, so nothing is ever inferred from
a boot list. They also said the error message itself was excellent, naming both
UDIDs and mentioning `SIMFRAME_DEVICE` — that stays.

**Fixed: a wait can be a disjunction.** `waitFor "any login or dashboard
content"` spent **120 seconds** while the login screen was already there, and the
failure message itself listed `Email`, `Password`, `Remember me`. A phrase like
that is a disjunction, and resolving it as one intent asks the matcher for
something no single element answers. `{"waitFor": {"any": ["Email",
"Dashboard"]}}` says it directly and the first to appear wins.

73. **Not ours, and worth saying so: selection state is already plumbed.** They
    asked for `selected` in the text map. It is there — the daemon reads
    `AXSelected` (`AccessibilityBridge.swift:283`), `input.js` carries it, the
    screen map stores it, and `view.renderRow` prints it. So the chips in that
    app do not publish the trait, which is an accessibility gap in the app as
    much as a testing one. What we could add is a way to tell *"the app did not
    say"* from *"the app said no"* — the map currently prints nothing in both
    cases, and that ambiguity is ours.

**Named as working, unprompted, and none of it should be optimised away:**
`sim_ui` at a tenth of a screenshot's cost as the right default, used far more
than `sim_look`; `sim_do` batching as where the speed comes from; `sim_launch`'s
`args` passthrough, which *unblocked the entire run* — the app could not find
Metro on a fresh device and `["-RCT_jsLocation", "localhost:8082"]` fixed it with
no rebuild. And the failure output: *"no-visible-change: the screen did not
change, and nothing predicted it would"* and *"memory disagrees with this screen
— trust the element list, not the graph"* both stopped them drawing a wrong
conclusion. Their words: *"that last one is a rare quality in a tool."*

### `sweep` lands, and `scrollTo` is no longer the answer for a form — 2026-09-11

Built on the owner's algorithm, verified on a real HTML form in Safari, and it
retires several of the findings above rather than filing new ones. Every field on
that form filled **in one call**. Numbers, and the three wrong "where am I"
signals it took to get there, are in `docs/BENCHMARKS.md`.

Two open items are answered by it and should be read together with it: **item 60**
(an off-screen match only helps when the element is in the tree — a sweep does
not need it to be) and **F2/item 69** (a scroll's distance is
non-deterministic — a sweep acts on whatever the viewport holds, so it does not
care).

71. **A sweep cannot choose from a picker.** `fill` types or pastes, so a select
    needs a `tap` on the control and a `tap` on the option, in a following call
    once the list has rendered — which is what the verification run did. A
    `choose: {"Subject": "Support Inquiry"}` companion to `fill` would make a
    form with dropdowns a single call instead of three. This is the obvious next
    piece and it is small.

72. **A sweep pays a full perception read per section**, which is most of its
    ~27 s on a six-section page. `ax-first` should help here more than anywhere
    else — it is exactly the case the cheaper sensor was built for — and the two
    have never been measured together.

### From round 7 — the supervisor's first field round, and it went silent

Five runs across two flows, with the order deliberately reversed between them so
supervision and prior knowledge could be separated. The reporter designed that
themselves and it is why this round is worth anything.

| run | flow | mode | knowledge | calls | wall | rulings |
|---|---|---|---|---|---|---|
| 1A | CSR | unsupervised | blind | 21 | 391 s | — |
| 1B | CSR | supervised | informed | **4** | 172 s | 3 |
| 2B | Add Asset | supervised | **blind** | 14 | 430 s | **0** |
| 2A | Add Asset | unsupervised | informed | 9 | 286 s | — |
| 2C | Add Asset | supervised | informed | 6 | 220 s | **0** |

**21 → 4 is not the supervisor.** In flow 1 the supervised run was also the
second run, so the two variables are perfectly confounded. Flow 2 was run
B-first to break that and broke it the other way: **supervised+blind cost 14
calls; unsupervised+informed cost 9.** Knowledge without a supervisor beat a
supervisor without knowledge. And in the isolating cell — 2C replaying 2A's
exact step sequence, mistakes included, with only the flag changed — 6 against
an adjusted 9-minus-3 = **6. A dead heat, with zero rulings.**

The reporter also volunteered the caveat that cuts our way: some of every
second-run gain is *the graph learning the app*, not them learning it, and this
design cannot separate those. Their fair headline: **the screen graph and plan
quality carried the later runs; the supervisor contributed one round trip.**

**F1, and it is the round: the supervisor answered three times and then never
again.** Twenty supervised calls and six failures produced nothing — including
failure classes it had already ruled on, and one case the briefing described
explicitly. `doctor` kept reporting it healthy throughout. Their diagnosis from
outside was *"a model session established once and then lost, with the loss never
surfaced"*, and their warning is the part to keep: *"had I run flow 2 alone I
would have reported the supervisor makes no difference without realising it had
never run."*

**Root cause, found on the bench and fixed.** `LanguageModelSession` accumulates
its transcript, and one session was reused for every request — so after seven
real failures it hit `exceededContextWindowSize`, **4,441 tokens against a 4,096
window**, and every later request errored. It degraded before it broke: latency
climbed 987 ms → 1,890 ms, and the reasons collapsed into boilerplate repeated
verbatim across unrelated failures. Both were visible in the report; neither was
recognised as one cause. A session per judgement: **15 of 15 answered at
488–533 ms with no growth**, where it used to die at 7.

**Also fixed, and all three came from the report's own reasoning:**

- **A silent consultation is now visible.** `supervisor: unavailable` on the
  call, and `doctor` **proves a round trip** rather than a presence — it answers
  a probe or reports "present and not working". Both were the reporter's asks.
- **Code answers what code knows.** An ambiguous selector cannot be waited into
  uniqueness and an element out of view cannot be waited into view — the
  executor's own error says so in English, and the model answered `wait` anyway.
  Those are ruled deterministically now, narrowing the model to the one class it
  has been reliably right about: *has this arrived yet?*
- **It is no longer asked to explain itself.** It confabulated in every observed
  run — a correct `stop` justified as "screen is elsewhere" on a screen exactly
  where the plan expected. The reporter's judgement: *"no reason at all would be
  better than a confident wrong one."* The caller is told which rule or which
  model answered, which is true by construction.
- **`wait` and `retry` now differ only in duration.** That was the one
  distinction it still fumbled, so a wrong choice between them costs
  milliseconds instead of the recovery.

**F2 — `scrollTo` scrolled away from its target. Fixed three times over, and it
was the most expensive defect of the round**, more than the supervisor could have saved
working perfectly. The target sat at **y = −693**, above the viewport, and it
scrolled *down* six times with the offset printed in its own error each time,
then advised the tool it already is. Reproduced three times. The operator called
it *"scrolled too much and trying to scroll more like a loop"*. It reads the sign
now; an explicit `direction` still wins.

Two further faults surfaced while verifying that on a live web page, both
watched in real time by the operator. It **never noticed an end**: six gestures
against the bottom of a page, each paying a 2,500 ms transition budget for a
gesture that moves at once or not at all — *"it looks like a loop"*, and it was.
And the blind reversal I added to fix that **triggered pull-to-refresh**:
scrolling up at the top of a web page reloads it, which changes the screen hash
and defeats the very end-detection it was meant to feed — *"now you're scrolling
to the top which triggers pull-to-refresh too"*.

So a reversal now requires *evidence*: the tree saying where the target is. No
evidence is not a direction. With that, a target which is not in the tree at all
— a form field inside an iframe, in the observed case — fails in **one attempt
and 3.7 seconds** with an honest message, against six attempts and 38 seconds.

**F12 — `type` sent a field's own label into the field. Fixed.** Reported as
`typed into "Asset*" … = "Asset*"`, which looks like a display quirk and is not:
`value` is the selector when `into` is present, and `step.text ?? step.value`
fell through to it. It refuses now rather than guessing, because typing a
selector into a form is a wrong write.

70. **Browser chrome outranks page content on a prefix match.** Found verifying
    the supervisor fix on a live web page: `tap "More information"` resolved to
    Safari's toolbar **`More`** at 344,816 and opened a share sheet, while the
    page's own "More information..." link went untouched. A four-character
    chrome label beat a seventeen-character content label that the query names
    almost exactly. `nav-bar`/`tab-bar` region weighting exists; a browser's
    bottom toolbar is neither, and the content region should win when the query
    is longer than the chrome label it matched.

**Still open, worst first:**

61. **F3 — text entry has no correct answer.** `paste` is exact but fires no
    change handler, so an autocomplete never queries; `type` fires events but
    corrupts under the installed keyboard layouts (`type "er"` after `Fry` gave
    `Fry er`); and **nothing can clear a field** — `paste ""` is a silent no-op
    and paste appends. The reporter left `Fry er a` in a field because there was
    no way to fix it. Their conclusion, which is the one to act on: *"any app
    with an autocomplete, a debounced search box or a validated numeric input is
    not automatable end to end today."* Wants `clear: true` or `replace: true`,
    and a `key` step with `repeat` for Backspace.

62. **F4 — `unexpected-screen` now fires on successful scrolls too.** Twice,
    including on a `scroll` that had put the target in view. The
    `memory disagrees with this screen` warning fired on roughly **11 of 25**
    maps in one flow and never once changed what the reporter did — at that
    frequency it is noise. Note the tension with round 5, where the same
    subsystem correctly caught a confusion on a submit screen: it is more
    willing to abort a correct flow than to admit a variant.

63. **F5 — a `#ref` was rejected as stale against an identical, freshly-printed
    element list.** Twice. The same response that refused `#8` then printed
    `#8 element 346,258 Select`, same label, same coordinates. It also
    contradicts the map's own closing advice to chain by ref. Validate a ref
    against the element it named, not only against the screen hash.

64. **F6 — the tree retains phantom controls from closed sheets.** `APPLY` and
    `Confirm` both resolved at `y=1845` on an 874 pt screen with no sheet
    present, so `or` chains matched them and then failed on visibility, blaming
    scrolling for a stale node. This is what made two rounds of `or` fallbacks
    useless.

65. **F7 — the count-header check is inconsistent.** It fired truthfully on
    `1630 records / 42 rows` and did **not** fire on `21 Records` with one row
    present — the same shape. The row count is measured against everything in
    the content region rather than against the rows below the header. Nor did
    anything fire on a list that settled **fully empty** in 1,356 ms and then
    killed a batch, which is the case that costs the most.

66. **F8 — `sim_ui refresh:true all:true` returned nothing** on a static screen
    mapped one second earlier: *"no elements read on this screen"*. Total
    perception dropout, seen once, forced a screenshot.

67. **F9 — `autoSettle:true` hid a bottom sheet that `autoSettle:false` saw.**
    The same tap reported `no-visible-change` twice with no sheet in the map;
    with auto-settle off and a 700 ms pause the sheet was fully there.
    Intermittent, and it cost one run about six calls, because
    `no-visible-change` on a control that *is* a dropdown is indistinguishable
    from a dead control.

68. **F10 — an `or` chain's failure message miscounts and drops entries.** Seven
    selectors passed, "none of 5" reported, six named, two never mentioned — so
    the reporter could not tell whether they had been tried. The loop breaks
    early on a non-retryable failure and the message does not say which were
    skipped.

69. **F11 — `{"scroll":"down"}` travels a non-deterministic distance.** Four
    rows in one run, one row in another. `scrollTo` should absorb it, and now
    that it reads the offset sign it mostly will — but `scroll` still cannot be
    planned against.

**What the report says is genuinely working**, unprompted: `assert` reads fresh
and was correct on every call in all five runs (round 6's item 49); the
`loading`-control settle warning fired every time and never falsely; the
count-header warning works where it fires; and **3 standalone reads and 2 images
across 54 device calls** — the batching primitive and its post-step map are the
part of this tool that is carrying it.

The operator's own vocabulary is the clearest instrument we have: *"fast"/"fair"
= steps inside a batch, "taking too much time" = a round trip, "failure" = a
defect in the report.* Thirteen complaints across 21 calls in the blind run;
three across four in the batched one.

### Bench notes on the supervisor, before its first field round — 2026-09-11

What is actually verified, so the field round is read against the right claim.

**Verified.** The decision quality on the four real batch-killers from round 6,
once the plan briefs it: a list still arriving → `wait`, a control disabled for a
reason → `stop`, a flow that has landed in a support chat → `stop`, a screen
still for 300 ms → `wait`. 689–751 ms warm, ~1.5 s for the first call in a
process. Asked *cold*, without the briefing, it got the first one wrong — which
is the whole case for `supervise` being part of the plan.

The `stop` path is verified end to end on a device: the ruling is printed, its
stated reason is quoted as a claim, the unattempted steps are named, and the
message says how to overrule it. And a unit test asserts the safety-critical
half — a `wait` or `retry` may only re-run **the same step**, never a re-aimed
or skipped one.

**Not verified, and this is the gap the field round exists to close.** The
`wait` path end to end. It needs an app whose content genuinely arrives late, and
iOS Settings does not have one — every screen renders instantly. So the branch is
wired, unit-covered and unexercised against a real load.

60. **An off-screen match only helps when the element is in the tree, and a
    virtualised list does not put it there.** Found trying to build a `wait`
    case: "Software Update" is two screens down in General and appears **nowhere**
    in the accessibility tree — iOS publishes the rendered window plus a little,
    so of 15 targets exactly one was off-screen. Item N7's *"in the tree but not
    in view"* message is therefore correct but rarer than it sounds, and the
    honest answer for a virtualised list is `scrollTo` and nothing else. Worth
    saying in the tool description, because "not on this screen" and "not
    rendered yet" read identically and only one of them is about naming.

### From round 6 — the round that measured everything and indicted `seek`

2026-09-10. Three runs on a real form-heavy app: **A** baseline (MCP), **B**
`ax-first`, **C** `ax-first` + `planner: apple` (both CLI, because the running
MCP server predated the per-call arguments — see item 55).

| | A | B | C |
|---|---|---|---|
| calls per completed task | 31 | 9 | **3** |
| steps per call | 1.5 | 7.4 | **11.0** |
| images | 2 | 0 | 0 |
| wall | 514 s | 431 s | **136 s** |
| largest successful batch | 5 | 12 | **18** |

**Read that table only with its caveat, which the reporter supplied unprompted:
the dominant variable is not the sensor or the planner, it is that they learned
the app.** By C they had the selectors, the coordinates, the `index` for the
ambiguous radio and the right `waitFor` sentinel for every async list. The graph
was also *not* cleared as I had predicted, so B started warm off A and C warmer
still, and the harness differed (A over MCP, B and C over the CLI). The one
attributable number is **steps per call: 1.5 → 7.4 → 11.0**, which is batching.

**The sensor made no behavioural difference, stated plainly.** One small
regression and one small win, both real: stripping OCR removed the extra text
that distinguished two stacked controls sharing an AX label, so a `waitFor`
became ambiguous and needed `index: 0` (the refusal was correct — it did not
guess); and on the review page `ax-first` reported a row honestly as `loading`
where full mode fused stale OCR over it and **invented the word "hanuynan"**. My
own prediction that `ax-first` would fix the modal-fusion problem was **wrong** —
the reporter checked, the fusion is identical, so it is a layering problem and
not an OCR one.

**Fixed from this round:**

- **`seek` opened CANCEL, then pressed "YES, THIS FIXED MY PROBLEM"** — see
  `docs/DECISIONS.md`. Three faults: one permission list answering two
  questions, a comment claiming it "does not act" when opening a door plainly
  is acting, and no return to origin on failure. All three fixed, and candidacy
  is now permissive about shape and strict about vocabulary because requiring
  `actsInteractive` had found *zero* doors on a screen holding two real pickers.
- **G1, `unexpected-screen` discarding a flow whose action worked.** Twice, and
  the direct cause of B and C needing 9 and 3 calls instead of 5 and 1. A
  variant that satisfies the next step's selector is now a note, not a halt.
  The verdict is still reported and logged; only the batch survives.

**Still open, worst first:**

49. **`assert` reads a stale snapshot and killed a six-step batch — the single
    most expensive finding in run A (~120 s, 3 calls).** `assert REVIEW is
    enabled` failed, and the map printed by that same call, three lines below,
    shows `#24 button REVIEW` with **no `disabled` marker**. The assert was
    measured against a state that no longer existed. `tap` already re-takes a
    stale baseline and says so — *"[baseline had already settled; re-taken from
    the live screen]"* — and `assert` needs the same. The reporter's framing is
    the reason this is top of the list: *"I put an assert in to be careful, and
    being careful is what broke the flow. The lesson an agent learns is 'do not
    assert inside batches', which is the opposite of what you want learned."*

50. **`find`'s "Visible:" list is a stale cache and does not say so.** It
    omitted the very control asked about, which `ui` listed seconds either side
    — and it carried a status-bar clock reading `3:21` when the wall clock was
    `3:23`. `ui` warns when it serves recalled elements; `find` must warn or
    refresh. A false "not on this screen" from the tool whose whole job is
    resolving intent is indistinguishable from the app being broken.

51. **A settle that has seen an unpopulated list should say so.** Three
    separate times, every list in the app arrived *after* the settle declared
    the screen stable. `waitFor` on a row label fixes it, but that requires
    already knowing a string that only exists once loaded — solvable only by
    having failed once. The raw material is there: the tree exposed
    `#13 element 201,263 loading`. Sharpest version, from run B: a `waitFor` on
    `Records` was satisfied by the header **"21 Records"** while zero of the 21
    rows existed. Even a correctly written wait can be satisfied by a promise of
    content.

52. **`continueOnError` pays out every timeout on an unchanged screen.** After
    one step failed, ten more failed against the same unchanged hash, two
    `waitFor`s serving their full 9,000 ms — 79 seconds of certain failure, and
    what the operator saw as *"you look stuck"*. After N consecutive failures on
    an unchanged screen hash, stop.

53. **Fallback selectors solve the wrong failure.** `{"tap":"Ceiling","or":[…]}`
    failed all three, for one reason that had nothing to do with labels: the
    list had not loaded. The three-label failure message reads like a naming
    problem and pointed away from the cause. When every selector in an `or`
    chain misses *and the screen changed within the last second*, say the screen
    was still loading rather than naming the last label tried. The reporter's
    summary: *"fallbacks are a cure for 'I named it wrong'. Almost everything
    that actually failed failed because 'it is not there yet'."*

54. **`or` cannot express a disambiguator.** Two `SELECT` buttons, same label,
    different jobs — one inline, one the bottom CTA. What was wanted is not an
    alternative label but `{"tap":"SELECT","prefer":"enabled"}`. `index` is
    positional and fragile across a reload, and this is the one place in the run
    where they fell back to raw `#ref`s knowing they might shift.

55. **An MCP server must be restarted to pick up a change to its own tool
    schema, and I said "nothing needs restarting".** True of the design, false
    of a long-lived session: the running server predated the per-call arguments,
    so `sensor`/`planner` were not in its advertised schema and passing them
    would either be rejected by client validation or *sail through into an old
    build that ignores them* — a run in the wrong mode reporting itself as
    correct. The reporter caught it by comparing file mtime against process
    start time and ran B and C over the CLI instead. Document it next to the
    override.

56. **`ref`s are only safe inside a single batch.** Correct refusals, twice —
    `#2 was numbered on a different screen` — triggered by nothing but a row
    finishing its load. Right trade, but their cheapness invites reuse across
    calls, so the tool description should say the lifetime out loud.

57. **`all: true` without `refresh` silently serves stale data.** `all` reads as
    "give me everything"; it does not mean "as of now". Fold `refresh` into
    `all`, or make the staleness warning impossible to skim past — it is
    currently one clause at the end of a line the reporter had stopped reading.

58. **`seek` asks the wrong question for a wizard.** It answers "the thing I
    want is behind a container on this screen", and the two places the reporter
    was genuinely stuck were neither: a dropdown that was visible and inert, and
    a REVIEW button that was visible and disabled. What was wanted:
    `{"seek": "what is blocking REVIEW"}` — walk the form and report *"Service
    Provider has no value and is required"*. Their estimate: 90 seconds and four
    calls. That is the expensive question in every wizard.

59. **`sim_state` is never suggested.** The reporter never called it once across
    three runs, and wanted exactly its niche — cheap polling while a list loads —
    four separate times, reaching for a full `ui` each time. The `next:` hints
    suggest plenty of other things.

**The number to keep from this round**, because it decides what to work on next:
of run A's 514 seconds, **~128 s was measured tool and device time and ~386 s
(75%) was the agent thinking and the MCP round trip.** Every pause the operator
flagged in real time was a call boundary, and every call boundary they flagged
was forced by one of the items above. The reporter's conclusion, which is also
the answer to "why does it feel slow": *"the only lever simframe has on
perceived speed is steps-per-call."* Where one call carried the work, the
operator wrote *"third page looked awesome"*.

### The "read approximately, like a human" theory — right layer, wrong sensor

The owner's theory, 2026-09-10: *"about your OCR — what you probably do is 100%
matching, which is probably a bit slower than making it, idk, 70% accurate.
Because we humans don't accurately read stuff, which makes us prone to mistakes,
but it also makes us faster."*

The principle is right and it is already applied — just not where the theory
aimed, and the measurement says the aim matters.

**What OCR actually costs, warm, on this machine:** an accessibility-only read
is **85 ms**, a full read with OCR is **142 ms**. So all of Vision costs about
**57 ms**. The waits it sits next to were costing **1,900–2,000 ms each**. Making
OCR twice as fast would save ~28 ms of a step that was taking seconds; making
one unnecessary wait go away saved two full seconds. That is the whole reason
the field time went where it went.

**Where the principle is already in force**, in two places:

- **Skipping the expensive sensor rather than degrading it.** The accessibility
  tree is authoritative when present, so the field readback and the focus check
  ask for `useOcr: false` and pay 85 ms instead of 142. "Approximate is enough"
  becomes "do not run it at all", which is strictly better than running a worse
  version.
- **Approximate *matching*, not approximate reading.** `src/matching.js` already
  does prefixes, synonyms, verb forms, typo distance and a confusable fold for
  Cyrillic С versus Latin C. That is the human property the theory describes —
  imprecise recognition tolerated by a forgiving match — and matching is the
  right layer for it, because a wrong *character* is recoverable while a wrong
  *tap* is not.

47. ~~**Still worth measuring: `VNRequestTextRecognitionLevel.fast`.**~~
    **Measured, and the answer is to skip the sensor rather than degrade it.**
    `.fast` against `.accurate`: **162 ms against 164 ms — no difference**,
    because the daemon reads text in-process and owns its own recognition level,
    so `SIMFRAME_OCR` reaches only the no-daemon fallback. The flag exists,
    `doctor` says exactly what it can reach, and plumbing the level through the
    control socket is a daemon change filed as item 48 rather than smuggled in
    before a field test.

    What did work is `SIMFRAME_SENSOR=ax-first`: the tree alone is **50 ms
    against 164 ms**, and `locate` pays for a full read only when a resolve
    fails. Six real labels on a live screen resolved **6/6 in both modes**, at
    **83 ms against 207 ms** per resolve. The escalation is what makes it safe
    rather than a repeat of the map cut — a cheaper reading may drop data
    nothing misses until it does, and the safe form of "approximate" is one that
    notices it was not enough. `.fast` would not have had that property, which
    is the second reason it is the wrong knob.

48. **Plumb the recognition level through the control socket**, so the daemon's
    OCR can be scored the way the fallback's now can. Small, Swift, and a
    rebuild — worth doing next time the daemon is being touched anyway rather
    than on its own.

### The unifying finding: there is no cheap retry — 2026-09-10

Four examples from the owner, given one after another, and they are one problem:

| the situation | what a person does |
|---|---|
| picked a location with no assets | pick a different location |
| misclicked a like on Instagram | notice, un-like or go back |
| hunting "change username" in a new app's settings | next menu, then the next |
| a YouTube search returns nothing useful | another keyword |

*"All done in maybe less than a second or a few seconds."* *"When I don't find
what I need somewhere I don't fall into an existential crisis — I look for it
somewhere else."*

Every one of them is **an attempt that failed benignly, varied, and retried,
with no deliberation.** And in every one of them simframe's current behaviour is
the same: the step throws, the batch is abandoned, and the reasoner is asked.

So the gap is not three features. **A step can only succeed or throw, and
throwing is expensive** — `continueOnError` is all-or-nothing for a whole run,
which is why nobody uses it, and there is no way to say "if this does not work,
try that, and only ask me if none of them do".

46. **Per-step alternatives.** A step should be able to carry its own fallbacks,
    tried locally in order:

    ```json
    {"tap": "Save", "or": ["Done", "Confirm"]}
    {"type": "compressor", "into": "Search", "expect": "results", "or": ["air compressor", "compressor repair"]}
    ```

    No model, no new state, and it makes the *batch* longer instead of making the
    round trips more numerous — which is the whole objective. It partially covers
    all four examples above, and it composes with what already exists: `find`
    already returns ranked alternatives, the graph already names the way back on
    a wrong turn, and the verify barrier still applies to every attempt.

    The design question worth settling first is which failures are eligible. A
    label that did not resolve, yes. An `unexpected-screen`, only together with
    the way back. A destructive label, never. Getting that list wrong turns a
    retry primitive into a way to hammer an app until something gives.

Ordering against the phases: item 46 is the cheap general case; **Phase 15**'s
mechanical half is the same idea specialised to menu trees (try an unexplored
container, come back), and only its *ordering* half wants a model; **Phase 18**
is the tail where neither convention nor a fallback list applies.

### From the fifth peer round — the labels worked, and then pointed at a submit button

2026-09-10. Cold repeat of round 4's task: fresh session, same app, same goal,
one variable changed (the `worked here before:` line plus the T1 fix). Task
completed.

| | round 4 | round 5 |
|---|---|---|
| invocations | 25 | **19** |
| reads | 11 | **4** |
| images | 2 | **1** |
| wall | 6m 16s | **5m 10s** |
| calls per step | 0.81 | 0.86 |
| `unexpected-screen` | 2 | **3, wrong all 3** |

**Calls down 24%, reads down 64%, and my predicted metric did not move.** I
predicted 0.4–0.5 calls-per-step and got 0.86. The prediction was against the
wrong yardstick: calls-per-step divides by how many steps you chose to batch, so
batching harder makes it *worse*. Round 5 executed 22 steps against round 4's 31
for the same completed task, which is the improvement, and the ratio hid it.
**Calls per completed task is the metric.** Recorded rather than quietly
replaced, because picking a metric that moves the way you hoped is the easiest
mistake here.

**The feature earned its place.** The reporter's accounting: right or useful 5
times, wrong once. Best single case — on a screen whose list had not loaded, the
remembered `tap "Anaheim" (10x)` let them write `waitFor "Anaheim"` → `tap
"Anaheim"` in one call *for a control they could not yet see*, replacing a
read-wait-read-tap cycle. **The line's value is that it lets an agent write
chains past screens it has not seen**, which is a stronger claim than "it saved a
read". Two reads saved there, six or seven across the run.

Also learned: the line is **frequency-ranked, not goal-ranked**, and the
most-tapped control on a screen is often what previous runs used to *back out*.
The reporter ignored it correctly twice for that reason. That is the right way to
read it and it is why it stays framed as evidence.

**And then it pointed at a submit button. Fixed.** The wizard's read-only review
screen had been given the **same identity as its step 1**, so it inherited step
1's entire vocabulary. The map offered `tap "APPLY"`, `tap "No Power"`,
`tap "PLACE A SERVICE REQUEST"` — **not one of which exists on it** — and the
hint said *"nothing ambiguous, chain the next steps without looking again"*. The
only control on that screen files a real work order.

The line was right and the identity was wrong, so **the line now checks**:
remembered actions are offered only when their label is on the screen in front
of us. When memory and screen disagree, that disagreement is reported and
outranks "carry on" — *"this screen is recognised but 3 remembered controls are
not on it, so the identity is probably wrong … act only on the element list, and
re-read before anything irreversible."* Memory that contradicts the screen is
the most useful thing to say, not something to swallow.

**Also fixed this round:**

- **`unexpected-screen` while a region is still loading** (cause (a) of the three
  false alarms). A tap applied a selection correctly and enabled the submit
  button, but an async panel had not returned, so the structure differed from the
  settled screen the edge remembered. A settle can be satisfied while content is
  still arriving — that is Phase 11.5's own finding — so the two are now read
  together, and an incomplete screen reports `unverified` rather than a wrong
  turn.
- **The false "did not visibly take focus"**, which is what started the run's
  most expensive cascade. It fires whenever the screen does not visibly react to
  the tap, and the simulator has a **hardware keyboard attached**, so none ever
  does. The note is now suppressed once the readback has confirmed the text
  landed: where there is direct evidence, a proxy for it is noise.
- **A band called `keyboard` with no keyboard in it.** Review-summary rows were
  filed under it, followed by `keyboard: 1 keys (tap by label or type directly)`
  — wrong advice about page content. The band is relabelled from its contents
  rather than its position. Fifth bug from positional region bands.

**Still open, worst first:**

41. **Screen identity is too coarse, and it is now the root of three findings.**
    Two screens in one wizard — a form step and a read-only review — collapsed
    into one hash, sharing a header and a step indicator. Whatever the
    fingerprint weights, it is weighting chrome over content. This causes: the
    wrong-vocabulary case above (now *detected*, not cured); item 42 below; and
    every `unexpected-screen` argument about "which screen did we reach". The
    cross-check makes it safe and visible. It does not make it right.

42. **`assert` and `find` read a staler, truncated view than `sim_ui` does, in
    the same response.** `assert` said a string was absent while the map printed
    it at `#21` four lines below, and the `Visible:` list was a 15-item prefix
    identical to one `find` had returned four calls earlier. The reporter's
    conclusion: *"`assert` is unusable on anything in the lower ~60% of a
    scrolling screen, which is where form fields and submit buttons live."* Cost
    3 calls — the most expensive finding of the run. Very likely the same root as
    41: `locate` resolves against the *stored* map for the screen's identity, and
    a wrong identity loads another screen's elements. **Do this one with 41.**

43. **`unexpected-screen` on data variation** — cause (b), unfixed. Picking a
    different test asset changes the content, and the check reads it as a wrong
    turn. *"This will fire on every run that varies its test data — i.e. every
    useful run."* Needs structural comparison rather than content comparison. Two
    of the three false alarms were this. Note the reporter's own assessment moved
    between rounds: round 4 called the verdict the most valuable thing in the
    tool, round 5 calls it a net negative in its current form (3 false, 0 true).
    Both readings are right about different halves — **positive confirmation was
    accurate every time** (`matches the outcome seen 7x before`), and it is the
    negative verdict that is broken. Fix the negative case; do not touch the
    positive one.

44. **`sim_do` cannot open with a step against a remembered screen without a
    preceding read.** The reporter's one "habit" read: they pulled a 26-element
    map of the home screen and used exactly one line of it — the remembered
    `tap "CREATE A SERVICE REQUEST" (7x)` printed in the same breath. If a first
    step could be written against a recognised screen, that call disappears.
    This is the smallest remaining piece of "plan first, then act".

45. **A sticky footer sorts by y into the middle of the form.** `SUBMIT SERVICE
    REQUEST` at y=815 lands between two form rows. Technically honest, reads as
    though the button is inside the form. Same family as items 29 and 38.

**Named as working, again:** every `sim_do` returning its resulting map — *"the
single highest-value thing in the tool. Do not make maps opt-in."* — `waitFor`
chained ahead of a control not yet on screen, positive verification, the
`disabled` marker, and the step annotations. On the annotations the reporter was
precise and it is worth keeping: one of them misled them, and the answer is to
make them **more accurate rather than to remove them**, because telling you an
action landed but looked odd beats a bare `ok`.

### From the fourth peer round — cold start, and the map lied by omission

2026-09-10. A **fresh** session, no prior knowledge of the app, no source read,
told only that the app was open on its home screen. The task was completed.

| | |
|---|---|
| invocations | **25** |
| steps | **31** |
| calls per step | **0.81** |
| images | **2** |
| wall | 6m 16s |

The reporter's own accounting is the finding: **~10 of 25 invocations, 40% of
the run, were spent recovering from the map omitting things it demonstrably knew
about.** Four reads were genuinely unavoidable; seven existed only because the
tool would not say what it already knew.

**T1 — `sim_ui` omitted primary pinned controls the resolver could hit.
Critical, fixed.** On a wizard step, four reads — `all` and `refresh` included —
never listed the only forward control, while the hint said *"nothing ambiguous —
chain the next steps without looking again"*. The proof it was emission and not
perception was the next call: `tap "NEXT"` hit it instantly at 201,800
`via ax|ocr, memory d=0` — a coordinate the map had never printed.

The cause is **region bands, positionally assigned, for the fourth time.** With
the keyboard up, the bottom band is called `keyboard` and collapsed to one line —
thirty keys nobody names. A primary action pinned above the keyboard lands in
that band and was collapsed with them. It also explains the inconsistency the
reporter spotted: the same control at the identical coordinate *was* listed on a
screen where the keyboard was down. And it is the same root as round 2's "a
control behind the keyboard is invisible". Fixed by asking whether a target in
that band is actually a key — width settles it before any label does, which also
keeps an icon-only pinned control in the map. `README.md`'s roadmap entry on
clustering the bands instead of positioning them is now overdue by four bugs.

**T2 — the readback failed a step whose text had landed. My regression, from
hours earlier, fixed.** `type` reported *"the field reads empty — the text did
not land"* while the text was visible in the very map the failure returned, and
the tool's own remediation advice would have double-entered it. The cause: the
text arrives as a sibling text node's **label**, not as the control's `value`,
and treating a missing `value` attribute as an empty field is not evidence of
absence. The readback now looks for what was sent across both `value` and
labels, compares by alphanumerics so the OCR'd caret does not break it (a typed
name reads back with a trailing `l`), and fails only on a valued control that
genuinely reads empty. **No evidence is not counter-evidence** — that was the
whole bug, and it made the verdict it replaced look good.

**T5 — contradictory verdicts on a tap, fixed.** `[a small change, in one region
only]` and `no-visible-change: the screen did not change`, four lines apart. Both
true of different questions: the wait watches regions, the verdict compares
screen identity. The verdict stands — a change too small to move the identity is
the finding — but it now says what was observed rather than denying it happened.

**T7 — `SIMFRAME_SESSION` cannot be honoured by an MCP client, and the
instruction to export it was mine and wrong.** It is read into a module-level
constant at process start; the server was spawned before the agent's first
message, so nothing said in-session changes it, and the run was logged under the
server's own id. It is also unnecessary there: an MCP server is one long-lived
process, so its per-process id already identifies exactly one agent. What was
missing was discovery, not tagging — `escalations` already lists every session
id with its client and count. Documented, and the CLI help now says when the
variable can and cannot work.

**The user's own observation, and the change it produced.** *"Still slow and
thinking too much between each step — how about orchestrating a plan using the
code and then just doing its job?"* The data says exactly that: the familiar
flow ran 16 steps in **one** call because a plan existed before execution
started; the cold run spent 25 calls on 31 steps building one step at a time.
The reporter's version: *"on the familiar flow I knew every label in advance, so
I never needed a read."*

The graph already held those labels and only ever reported a **count** —
`(known, 3 known exits)`. It now names them, in the map and in the hint:
`worked here before: tap "CREATE A SERVICE REQUEST" (7x)`. Zero perception cost,
no new state, and it is the smallest version of the plan-first idea. Explicitly
evidence and not a promise — the destructive-label rules are untouched.

**Still open from this round:**

36. **`unexpected-screen` false negatives on correct transitions.** *"expected
    the screen this action reached 2x before, and landed somewhere else"* on a
    tap that correctly applied a selection, populated content and enabled the
    submit button — i.e. the screen legitimately became a variant of itself.
    Because `continueOnError` defaults false, every false negative costs the rest
    of the batch, which undercuts the batching that makes calls-per-step good.
    **Do not soften the verdict itself** — the same reporter calls it the most
    valuable thing in the tool, and one of its stops exposed a real bug in the
    app under test. This is variant handling, not verdict policy.

37. **`assert` races the state it asserts.** A tap reported settled after 2.4 s;
    the assert in the same batch read pre-update state, and the map returned by
    that same call showed the asserted control already enabled. One response,
    two answers.

38. **Occluded and stale content emitted as real elements.** After a scroll, rows
    blended a sticky header with the content beneath it *and* with pre-scroll
    leftovers, at overlapping coordinates. `settle` returned an identical map, so
    it was not motion. An image proved several rows were not on screen at all. A
    map with phantom rows is worse than a short map, because it looks actionable.
    Same family as round 2's sticky-header interleaving (item 29).

39. **The caret is OCR'd into field values**, so `assert {is: "value"}` fails on
    a correct field. The readback now compares by alphanumerics and is immune;
    `assert` is not.

40. **A ref survived the element but not the screen hash.** `#16 was numbered on
    a different screen` for a control that had not moved a pixel — the hash moved
    because a validation message appeared and cleared. Item 32 with a concrete
    cause: cosmetic, transient content is changing screen identity.

**Working, and named as such by the reporter:** `sim_do` batching; label
resolution against elements the map never printed (the best thing in the tool,
and what proved T1 was emission); ambiguity refusal naming both candidates with
coordinates, which fixed a mistake with no read; `STILL MOVING` with "do not act
on this reading yet"; the `disabled` marker; and stating *how* a tap resolved
(`via ax|ocr`, `memory d=0`) — keep that, it is what makes these reports
diagnosable.

**Two app bugs found, and they are the user's, not simframe's:** a work-order
card rendering `Age of Work Order: days` with no number, and a location whose
service-request flow dead-ends on a raw backend error string. Passed on rather
than filed here.

### From the third peer round — the batching hypothesis dies, 2026-09-10

Run cold-ish on a real form-heavy app, one session (`SIMFRAME_SESSION` set), on
the working tree at `e85a517`. **Zero images across both tasks** — text answered
everything, and twice the reporter read the app's own source rather than take a
screenshot.

| | familiar flow | surprise flow |
|---|---|---|
| invocations | **1** | **23** (14 `do`, 8 `ui`, 1 `find`) |
| steps | 16 (3 asserts) | 52 |
| **calls per step** | **0.06** | **0.44** |
| images | 0 | 0 |
| wall | 24.2 s | ~130 s of `do` plus reads |

**My prediction was wrong, and the way it was wrong is the finding.** I predicted
the agent would collapse to 1–3 steps per call on *unseen* screens, because
`next:` tells it to read first — item 25. The split could not be computed:
**every screen in the surprise flow reported `known`**, the graph having learned
them in earlier rounds. Unseen screens ≈ 0, and calls-per-step was still **7×
worse**. So unfamiliarity is not the cost, and **item 25 drops** from "cheapest
thinking-time win" to a wording nit. It stays filed because the hint is still
using familiarity as a proxy for risk, but it is not what is costing the calls.

What is costing them, in the reporter's order: neither selector is dependable so
every action needs a fresh read (N4 + N5); type verdicts cannot be trusted in
either direction (N1); `waitFor` burns its timeout on content that exists but is
off-screen (N7); `settle` hard-fails a usable screen (N8).

The observation worth keeping above all of them: *"on the familiar flow I knew
every label in advance, so I never needed a read. The graph knowing the screen
did not substitute for **me** knowing the labels."* The graph's knowledge is
currently spent on verdicts and routing. It is not spent on telling the caller
what it already knows is tappable there — which is the same conclusion Phase
17's no-go reached from the other end: the tool holds knowledge it does not hand
over, and the model pays for that in reads.

**Fixed this round** (all with tests, and a fixture for the matcher one):

- **N1 — the `type` verdict was wrong in *both* directions.** Round 2 reported
  false negatives; this round produced a false *positive* in the same batch — a
  clean `ok` that had silently done nothing, beside a `no-visible-change`
  warning on the step that had actually landed. Anti-correlated with reality on
  the one path where acting on the warning is destructive.
  **Fixed at the root:** a change verdict was the wrong instrument, because
  typing does not change the screen. `type` and `paste` now read the field back
  from the tree and report its contents (`= "…"`), and **fail** when the field
  reads empty after text was sent. The tree has carried `value` since
  MAP_VERSION 9; it was simply never consulted. This removes the mandatory
  verifying read *and* makes the destructive re-type structurally impossible.
- **N2 — `flow completed — 16/16 steps` printed directly above `next: the flow
  stopped here`.** A regression I shipped in Phase 11.5, and not cosmetic:
  `no-visible-change` is an escalating verdict and it fires falsely, so **one**
  wrong verdict anywhere in a clean flow told the agent to abandon batching and
  re-read — the exact failure the hint exists to prevent, caused by the hint. A
  stopped flow and a completed flow carrying an unconfirmed step are now
  different hints, and the second keeps the horizon open.
- **N3 — a verdict contradicting itself inside one line**
  (`[a small change, in one region only] … [no-visible-change]`). Both halves
  were true, of different questions: the wait watches regions, the verdict
  compares screen identity. `type`, `paste` and `key` no longer receive a
  screen-movement verdict at all (`graph.STAYS_ON_SCREEN`), since staying put is
  their correct outcome.
- **N5 — label resolution preferred the caption over the control it names.**
  `tap "Problem"` hit the text at (49,486) and did nothing while the select sat
  at (201,496). `collapseSamePlace` already prefers a hit target over the text
  printed on it, but only after `sameControl` agrees they are the same place —
  and these were 152 points apart with a generic role, so nothing merged them.
  A caption overlapping a control with the same label now merges into it, and a
  caption loses to what it names before source or role is considered. Two
  genuinely distinct controls sharing a label still refuse, and a caption with
  nothing to name is still reachable. Fixture:
  `test/perception/screens/reported__caption-vs-control.json`.
- **N6, half — `--interactive` under-reported the controls**, and the *hint*
  was the harmful half. It reported the filtered count as the screen: "1
  element; nothing ambiguous — chain the next steps" on a form with two
  required inputs. Interactivity is now decided by evidence as well as role — a
  `value`, `focused`, or a declared `enabled` state, since the roles are exactly
  what the tree got wrong — and a filtered view says it is filtered.
  **Still open:** an empty, unfocused input whose placeholder is its only text
  is genuinely indistinguishable from a caption in the tree. That is why the
  hint now warns instead of pretending.
- **N7 — `waitFor` could not tell absent from off-screen**, and spent 15 s
  proving it before stopping the flow. `locate` now says *"in the tree but not
  in view — it is at y=1140 on an 874pt screen. Scroll to it rather than
  waiting; waiting cannot bring it into view."*

**Still open from this round:**

32. **N4 — refs expire between consecutive invocations, with no visible change.**
    `#16 was numbered on a different screen (01f66613 → 73ddfcb0)` on calls
    seconds apart with nothing visibly different; a blinking caret is the
    reporter's guess at the hash churn. **Refusing is correct** and must not be
    softened — the complaint is the churn that triggers it, not the refusal.
    Together with N5 it meant no selector could be trusted, which is the single
    largest cost in the run. Ask: key refs to a screen *identity* rather than a
    frame hash, or tolerate cosmetic deltas (caret, clock, spinner) when
    validating one. N5 is fixed, so measure again before designing this.

33. **N8 — `settle` hard-fails on an animated but usable screen.** Third round
    running. A screen with a permanent animation returns *"did not settle within
    8053ms"* and stops the flow; the screen was perfectly readable. `waitFor` is
    the documented answer and works, but a `settle` that fails on a healthy
    screen still costs a call and a re-plan. Ask: degrade — *"did not settle;
    changes confined to region X"* — and continue.

34. **N9 — `no-visible-change` on `tap` is intermittent, not fixed.** The
    identical step in the identical flow reported it this round and not last.
    Round 2's "fixed for modal-opening taps" is downgraded to **intermittent**.
    Note this is now less damaging than it was: it no longer poisons the hint
    (N2) and no longer fires on the type path at all (N3).

35. **N6, the other half — expose current value and enabled state on `Select`
    and `TextInput`.** The vocabulary exists and is applied to a `Button` on the
    same screen but not to the select beside it, so text could not distinguish
    "no options available for this asset" from "my tap missed" — two calls and a
    wrong hypothesis. Same root as round 2's item 24.

**Working, and worth protecting** — the reporter was explicit about this:
`unexpected-screen` is the most valuable verdict in the tool ("expected the
screen this action reached 6x before, and landed somewhere else"), it stopped a
compounding error, and that stop exposed a real bug in the app under test. Do
not soften it. Refusing a stale ref and refusing an unknown label are both
correct. Round 2's three fixes all held, including **zero** follow-up
`ui --refresh` calls across the 16-step flow.

### From the second peer round — forms and text entry, 2026-09-10

The first four findings of the previous round all landed and were verified the
same way they were reported: the map cut is reverted (9 elements → 13, all four
list rows present and truncated rather than dropped), `next:` is reachable from
both front ends and is *contextually* right, and the trailing map is fresh —
proved behaviourally rather than by a flag, because round one ran `ui --refresh`
after nearly every action and round two ran **zero** follow-up reads across a
16-step flow.

The headline from that round is the product working as designed: **a flow the
graph knew ran as 16 steps, one call, 20.2 s, zero images, including 3 asserts.**
The same app's unseen flow took ~19 calls for ~14 steps and ended with a
corrupted field. Everything below is from that second half — one theme, forms
and text entry, which is simply the next surface a real app presents after
lists and navigation.

23. **`no-visible-change` on the type path caused a wrong write.** HIGH, and a
    different bug from the modal-open false negative filed below. `type`
    reported *"the field did not visibly take focus (settled 123ms)
    [no-visible-change]"* — and the text **had** landed. On the strength of
    those two warnings the reporter re-typed, and the field became the value
    twice over. `keys` does the same thing.

    This is no longer a verdict that cries wolf; it is a verdict that **caused a
    wrong write to the app under test**, which in a form-submission flow is the
    difference between a valid test and a corrupted record. The detector is
    sampling after the keystroke burst rather than after the text commits.

    Two fixes and they are not equivalent. Sampling after commit is the right
    one. The fallback is to **stop asserting absence of change at all** on the
    type path, because "no change" is the one verdict an agent acts on
    destructively — a missing verdict costs a read, a wrong one costs the run.

24. **Text inputs are absent from `--interactive`, and their contents are not
    exposed.** HIGH. On a form with two visible, bordered, *required* text
    inputs, `ui --interactive --refresh` returned **one element** — a button —
    and `next:` cheerfully said "1 element; nothing ambiguous — chain the next
    steps". The placeholders appear in the default map only as `StaticText`, and
    `find "<field> field"` returns `StaticText/ax|ocr`, not an input.

    So an agent asking "what can I interact with here" is told "one button" on a
    form it cannot submit, and discovers the block only by tapping the button
    and watching nothing happen. Type-classify editable fields from the a11y
    trait and include them; expose the current contents so `assert {is: value}`
    works. The map already collects `value` — Phase 11.5 added it — so half of
    this is wiring. `next:` could then say "2 required fields are empty", which
    the reporter estimates would have replaced about eight calls.

25. **`next:` uses familiarity as a proxy for risk, and shrinks the batch where
    short batches cost most.** The design finding, and the cheapest
    thinking-time win left now that Phase 17 is a no-go. On an unseen screen the
    hint says *"new screen, nothing predicted here yet — read it before acting
    on a label you have not seen on it."*

    That is correct about **label resolution** and is the right warning against
    tapping a guessed name. But an agent reads it as *reduce your batch size*,
    and unseen screens are exactly where short batches hurt — 48 of 62 calls in
    our own measured session were three steps or fewer. The reporter's planning
    horizon went from 16 steps to 1 the moment a screen was new, in a wizard
    where every action was reversible.

    What should govern batch size is **reversibility**; what the hint measures is
    familiarity. Separate them: on a new screen with no destructive-looking
    labels, *"new screen — resolve labels from this map rather than from memory,
    but the next few steps can still be chained."* As written, the hint and the
    phase goal pull in opposite directions on precisely the screens the phase
    was about.

26. **A form-shaped read.** Between 23 and 24, the single highest-value addition
    for driving real apps: labelled inputs, their current contents, which are
    required, and where the primary action is — including "it is under the
    keyboard". On the screen in question that is one call replacing roughly
    eight: a `find` triple, an `--interactive`, a screenshot, a no-op tap, and
    two type-verify round trips.

27. **No way to clear a field.** MEDIUM, and it ends runs. `keys "BACKSPACE
    BACKSPACE BACKSPACE"` typed the **literal string**. There are no named keys
    and no select-all, so once a field holds a wrong value there is no
    tool-level way to correct it — which is how finding 23's corrupted field
    ended that run rather than merely annoying it. Named keys (`BACKSPACE`,
    `ENTER`, `TAB`, `CMD+A`), or a `clear` step, or `type` gaining
    `replace: true`.

28. **A control behind the keyboard is invisible, with no hint that it might
    be.** MEDIUM. On two steps the screen's *primary action* sat below the
    keyboard and was absent from the map. The map does say `keyboard up` and
    `keyboard: 7 keys`, which is good, but nothing suggests content may be
    occluded — so three `find` calls guessed at label names and all three
    returned "not on this screen" before a scroll revealed the button. A false
    "not on this screen" is the same confidently-wrong class as the map cut.
    When the keyboard is up, let `next:` say so.

29. **Sticky headers interleave with scrolled content.** MEDIUM. Pinned header
    text is ordered by y-position among the scrolled rows, so one record's
    fields appear split around header lines, and an OCR alternate from a header
    bled into a row below it. Same family as the modal interleaving from round
    one. Give pinned elements their own region, as `nav-bar` and `tab-bar`
    already get.

30. **`settle` hard-fails a flow on a screen that is perfectly usable.**
    LOW/MEDIUM. A screen carrying a persistent animation produced *"screen did
    not settle within 8028ms"* and failed the run. `waitFor` is the documented
    answer now, but a `settle` that stops a flow on a readable screen still
    costs a call and a re-plan. Let it degrade: report "did not settle; changes
    confined to region X" and continue.

31. **OCR confusables.** LOW, cosmetic, and every label still resolved. Across
    both rounds: a Cyrillic С for a Latin C, `O` for `0`, `Al` for `AI`, `(2R)`
    for `(⌘R)`, plus text bleeding in from an image inside a row. A digit/letter
    confusable pass would clear most of it — note `confusableFold()` already
    exists in `matching.js` as a last, discounted tier, so this is a question of
    whether OCR output should be folded at read time too.

Also from that round, and already filed below rather than repeated here:
`strip --device` returning another device's frames (reproduced twice in round
one with two simulators booted, unreproducible in round two with one — worth a
targeted check), and `paste` raising the iOS paste-consent dialog and losing the
text on the first attempt.

### P1 — wrong actions and wrong state, all from real-app use

4. **Label resolution silently picks the wrong element.** Three sightings, one
   bug: a bottom tab resolved at `memory d=6` into a list row containing the
   query as a substring and opened an unrelated record; `type into "Search"`
   typed into a section-index letter; and `nameScore`'s `q.startsWith(n)`
   branch returns a flat 0.86 however little of the query the name covers, so
   `"S"` beats `"Q Search"` at 0.585 while the sibling `n.includes(q)` branch
   already scales by coverage. Looks like one line; it is a ranking change, so
   it needs 2. Worst outcome on this list — it acts, and reports success.

5. ~~**A field's contents have no authoritative source.**~~ **Done,
   2026-09-10** — and the diagnosis was wrong twice before it was right. Not
   "the renderer drops `value`" (it did, and that was not the cause) and not
   "the contents are merely stale" (they were, and that was not the cause
   either). Measured: **zero** of the elements across fourteen recorded screens
   carried a value at all, including eight switches and a text field. The
   daemon has asked the tree for `AXValue`, `AXSelected` and `AXFocused` since
   0.6.0 — three of the eight attributes in its batched round trip — and *two*
   boundaries each dropped a different subset. `elementToNode` took `value` and
   dropped the other two; `screenmap` took `enabled` and dropped `value`. So
   `view.renderRow` has printed `selected` for as long as it has existed,
   against a field nobody set. All three now survive, and a row prints
   `Bold Text = 0` beside the OCR alias rather than instead of it, because when
   the two disagree that is the signal. `MAP_VERSION` 8 → 9.

6. ~~**Ambiguity is reported only after the full timeout.**~~ **Done,
   2026-09-10.** Measured live: 30 s+ before, **5 s** after, with the
   disambiguation delivered at once and a sentence saying why waiting would not
   have helped — `(not waiting: it is already on screen, and waiting cannot
   make it unique)`.

   The distinction had to be carried from the throw site, not read off a
   message: two very different failures both tag `ambiguous_intent` — the
   target is on screen several times over, and the target is absent from a
   screen we thought we knew — and only the first means more time changes
   nothing. `metrics.tag` takes an `ambiguous` flag now, and both wait loops
   act on it. The harness encodes the contract as `expect.ambiguous`, which is
   the other half of what `sim_find`'s description promises.

7. **The nav-bar back chevron is undetectable** — absent from the map, from
   `all: true`, and from `sim_find` asked in plain language, while coordinates
   work every time. This is the SF Symbol template bank, filed since Phase 5.

8. **`sim_launch` reports success without fronting an already-running app** —
   **does not reproduce, and here is the measurement.** Both apps running,
   Contacts fronted, then `simctl launch` on the other: the screen changed and
   Settings came forward. So `simctl launch` *does* front a running app on
   Xcode 26.0 / iOS 26.5.

   The likelier explanation for what was seen is item 1, now fixed: the
   settle's baseline was captured before the launch, the app fronts a few
   hundred milliseconds later, and a settle satisfied by stillness that
   predated the launch reported `settled` for a screen that had not arrived.
   That would read exactly as "launched · settled" with the wrong app in front.

   What is fixed regardless is the reporting, because `[no visible change]`
   after a launch is ambiguous between two different things and a real session
   read it the wrong way twice. The step now says which: *the screen did not
   change, so this app was already in front — or it did not come forward.*
   Likely is not the same as said.

### P1 — HPI_time, where the gap to the human median actually is

9. **Perception cost per step**: 36% of a clean flow is two `screenIdentity`
   passes plus locate. Phase 13, and the larger half of the gap.
10. **Unbiased stillness estimator.** *Half done, 2026-09-10 — the measurement
   is in, the decision is not.* `index.longestQuietGap` reads the pause profile
   off the frame history one step later, over a window whose end nothing about
   the wait decided, and returns `null` rather than a number when the ring no
   longer reaches back to the action. `graph.noteTrueGap` stores it beside the
   biased figure so the difference is visible.

   Measured over two runs, and it corrects the Phase 11 write-up: **the bias
   goes both ways.** `launch` recorded a gap of 0 against a true 1641 ms, as
   predicted; but `tap larger text` recorded 1398 ms against a true 88 ms,
   because the biased figure tracks `stableForMs`, which accumulates quiet from
   *before* the wait. So it was never an underestimate — it was noise whose sign
   depends on the previous step, which is a better reason not to build a wait on
   it than the one written down at the time.

   It also explains the corruption: `tap accessibility` genuinely pauses ~2 s
   mid-transition against a 500 ms stillness window. See `docs/BENCHMARKS.md`,
   "Gate C item 10".

   **Nothing reads it**, and the unit test asserts that `stillnessFor` does not.
   Phase 11 built a wait on the biased version and corrupted the graph in an
   afternoon; a number earns the right to act by being watched first. Four edges
   over two runs is the start of that. What remains is the decision to use it,
   and it should not be taken on this much data.
11. **The structural window itself** (300 ms), per-screen learnable. **The one
   thing on this list still undone before Phase 12**, and deliberately last: its
   estimator is self-correcting rather than self-reinforcing — a window too
   short produces disagreeing samples, which lengthens it — which is a reason to
   expect it to work and not evidence that it does. Item 1 already removed the
   part of it that was pure waste, by crediting the time a sample had already
   spent instead of sleeping a fresh 300 ms. What is left is learning the window
   per screen, and item 10's data is the argument for taking that slowly: the
   pause statistic it would be built on was noise in *both* directions, not the
   one direction the design assumed.

### P2 — Phase 12, which real-app use has now specified

12. **`simframe prep` and the reflex table.** A fresh install adds two dialogs
   the suite's device has never had: the pasteboard consent alert **swallowed
   the first paste entirely** (and `type` pastes, so it hits the commonest step
   there is), and the notifications prompt blocked a `waitFor` on content
   behind it. The ref invalidation reported as a fault is the ref guard working
   correctly — its cost belongs here. Argues for `prep` running by default on a
   device simframe has not seen before.
13. **`settle` under-detects slow progress.** It reported "nothing moved" at
   94% of a visible progress counter, after which `mode: change` returned
   instantly every time with "the change had already happened before this
   call". Same family as 1 and 3: the settle detector's evidence is wrong.

### P2 — the instruments

14. ~~**The escalation log pools sessions and cannot say so.**~~ **Done,
   2026-09-10.** Records carry `session_id` and `client`; flow escalations and
   `goto` refusals carry `flow_name`. `simframe escalations` narrows with
   `--session`, `--session=<id>` and `--flow=<name>`, and warns *before* the
   counts whenever it might be pooling. The 92 records already in the bench log
   stay unattributable and it says so every time. `docs/ESCALATIONS.md`.

   One thing fell out of it: `BUILT_FACULTIES` was empty "until Phase 11 lands
   the first one", and Phase 11 landed. So the 34 `verification_failed` records
   are not a queue waiting on a phase — they are evidence the phase that
   shipped is not sufficient, and the breakdown now says `not removed by`.
15. The `bench` gate cannot gate — a hosted runner cannot `simctl launch`
   Settings (47–55 s per failed attempt), so it only warns.
16. The fingerprint gate is intermittent: failed on the 0.8.0 push, passed on
   the next with nothing changed.

### The route — where each item sits against the phases

The list above is an ordering by cost of neglect. This is the same items placed
against the phase plan, because several of them are not "before the next phase"
in general — they are *before a specific phase*, for a specific reason, and two
of them are cheap enough that doing them late is just paying twice.

The rule used throughout: **a phase may not be built on top of a measurement or
a threshold that is known to be wrong.** Every gate below is an instance of it.

**Gate A — before any phase at all.** These make every subsequent phase's
number mean something.

- **1. The stale settle baseline.** Not a Phase 12 prerequisite in particular:
  a graph that records `root → root` makes *every* later phase's HPI a
  measurement of a corrupt graph. It is also a logic fix with no threshold in
  it, so nothing gates it. First.
- **14. A session id on each escalation record.** An hour's work, and CLAUDE.md
  makes the escalation breakdown the thing that chooses which faculty comes
  next. Choosing Phase 12's contents from a log that silently pools two agents'
  sessions is choosing from the wrong data. Do it before the choice, not after.
- **22. Detect an all-black frame early.** Filed under P4 as the wedge's
  consolation prize, and it belongs here for a duller reason: it pays for
  itself in every benchmarking session from now on. The wedge cost three
  restarts and two confounded A/B rounds in this session alone.

**Gate B — before Phase 12 (reflexes).** A reflex acts locally, with no model
call, and is guarded by matching a label against a destructive vocabulary. So
Phase 12 builds a *safety* mechanism on top of label matching and verdicts.

- **4. Label resolution.** Not a hole today — `confirm` matches with regex
  tiers and the destructive vocabulary from CLAUDE.md is **not implemented at
  all yet** (`grep -rn destructive src/` finds nothing; Phase 12 step 5 builds
  it). It becomes one the moment that guard exists, because `nameScore` gives
  a flat 0.86 to a one-character prefix and the guard would inherit that
  looseness in both directions. Needs 2 (it is a ranking change), so: 2 then 4
  then 12.
- **3. Small-delta change detection.** A reflex whose trigger is a transient
  `no-visible-change` will fire on every switch, radio and segment tap, because
  those are eight times below the change threshold. Building a retry reflex on
  a fabricated verdict is building a retry that fires on working actions.
  Needs 2.
- **8. `sim_launch` fronting.** `prep` launches apps; a launch that reports
  success without fronting makes every prep step a lie. Cheap and independent.
- **6. Ambiguity at the first frame.** A reflex fires "only when the trigger
  matches with confidence above the intent-resolution threshold" — an answer
  that costs 30 s cannot be on the hot path of a reflex.

**Gate C — before Phase 13 (ROI perception).**

- **2. The eval harness.** Phase 13's own prompt says to build it *inside*
  Phase 13, step 5. That is now wrong, and this is the deviation from the
  written plan: four items ahead of Phase 13 need it, so it comes out of 13 and
  becomes its own piece of work before Gate B. It is the single most-blocking
  item in this file.
- **5. A field's contents need an authoritative source.** Phase 13's whole
  method is carrying elements over from the previous list for anything outside
  the ROI set. That is right for structure and wrong for content — it would
  *institutionalise* the staleness that cost a real session two wrong
  conclusions. So either 5 lands first, or Phase 13's ROI set must
  unconditionally include every content-bearing element, which is a constraint
  worth writing into the phase rather than discovering during it.
- **10, 11. The unbiased stillness estimator and the structural window.** Both
  are Phase 11's unfinished half, both need 2, and both are on the perception
  path Phase 13 rewrites. Doing them after 13 means doing them twice.

**Gate D — before Phase 15 (goal-directed exploration).**

- **7. The nav-bar back chevron.** Exploration is bounded at six actions and
  then has to *get back*. A control that is invisible to the map, to
  `all: true`, and to `sim_find` asked in plain language is a control
  exploration cannot rely on, and coordinates are not a plan. Full icon
  semantics is Phase 16; what Gate D needs is narrower and cheaper — the
  nav-bar left slot with a small glyph in it is a back button by position, and
  position is already computed.

**Gate E — before trusting a phase's number in CI, not before the phase.**

- **15, 16.** The `bench` gate cannot gate on a hosted runner, and the
  fingerprint gate is intermittent. Neither blocks work; both mean a green CI
  says less than it appears to. Worth fixing before anyone else relies on it.

**Ungated — no phase depends on these.**

- **17–21** (default-device preference helper, `android.internals.js`,
  `getPasteboard` dispatch, non-English vocabulary, OCR confusables). **21**
  should ride with **4**, since both are changes to comparison.
- **23** the Apple feedback report, which is correspondence rather than work.
- **Phase 9** (Tier-2 local model) and **8b** (the Android accessibility APK)
  stay deferred, unchanged.

**So the order is:** 1, 14, 22 → 2 → 5, 10, 11 → 3, 4 (+21), 6, 8 →
**Phase 12** → **Phase 13** → 7 → **Phase 15** → **Phase 14**, **Phase 16**.

Two notes on that order. Phase 14 (anticipation) moves behind 15 because
speculative resolution on top of a resolver that silently picks the wrong
element is the least safe thing in the whole plan — it would act on a guess
before anyone asked for it. And Phase 12 sits ahead of Phase 13 even though 13
is where HPI_time moves, because every failure a real user hit this week was a
Phase 12 failure, and a tool that is fast on the suite and helpless on a fresh
install has optimised the wrong number.

### Phases still unbuilt

**12** reflexes (specified by 12–13 above), **13** ROI perception (gated by 2),
**14** anticipation, **15** goal-directed exploration, **16** icon semantics —
and **9**, the Tier-2 local model, still deferred. Phase 13 is where HPI_time
moves; Phase 12 is where the real-app failures are.

### Found while fixing item 5: a switch is tapped where it cannot be flipped

Filed rather than fixed, because it is a tap-geometry change and this run was
scoped to the route above.

A `Switch` element's frame is the whole row — measured on
`settings/display-text`, `Bold Text` is `x: 36, width: 330` — so its centre is
`x: 201`, which is the *label*. The control itself sits at the right end of the
row. Three taps at the centre left the switch off, the screenshot confirms it,
and the newly-carried AX value agrees at `= 0`.

What made this findable is item 5. Before it, a toggle tap that did nothing
reported `no visible change` and there was no second opinion: the change
detector cannot see a switch flip (item 3, eight times below threshold) and the
map had no state to contradict it. Now the value is a witness, and the two
agree that nothing happened.

The fix is not "tap the frame's centre" for this role: for a `Switch` in a
left-to-right layout the actionable point is the trailing end of the frame.
That is a role-specific tap point, which means it belongs with a review of
`centerOf` rather than a patch at one call site — and it wants a case in the
perception harness, which currently checks *which element* a query resolves to
and not *where* the element is tapped. Extending it to tap points is the same
day's work.

### P3 — known product gaps, all filed below

17. The default-device *preference* helper above the platform boundary.
18. `android.internals.js`, so ~970 lines with two assertions become testable.
19. `getPasteboard` has no dispatch wrapper.
20. English-only confirm vocabulary; the iOS/Android permission-name mismatch;
    pinch and the unverified iOS hardware buttons.
21. ~~OCR confusables.~~ **Done, 2026-09-10.** `matching.confusableFold` folds
    `i l 1 | !` to one shape, and `o 0`, `s 5`, `b 8`, so `(AII)` matches
    `(All)`. Deliberately the **last** tier in `nameScore` and discounted to
    0.62, not part of `norm`: folding in `norm` would change what an *exact*
    match means — "Log in" and "1og in" would become the same string
    everywhere — and identity is not something to be fuzzy about. Here it only
    ever rescues a comparison that had already scored zero, and it fires only
    when the folded strings are equal, which is why "Delete" still scores 0
    against "Remove".

### P4 — the wedge, which is the simulator's bug and not ours

22. ~~Spot an all-black frame early.~~ **Done, 2026-09-10.**
    `analyze.isBlackFrame` costs 32 integer comparisons on a signature already
    computed. A wait now rides *through* black frames instead of reading them
    first as a change (the hash differs from anything) and then as stillness
    (nothing moves), which is how it used to return `ok` for an action whose
    result nobody could see. `doctor` warns, `getState` reports `black`, and a
    step says how many black frames it waited through.

    The threshold is on the **maximum** cell, not the mean: one cell with
    anything in it means the display is rendering, so a dark-mode screen, a
    video and a splash on black are not faults. And it reports "the frames are
    black", never "the simulator is wedged" — a screen can be black because the
    app drew black, and what makes it the wedge is staying black while input is
    delivered, which only the caller knows.

    **Verified on a live wedge**, hours after being written and after being
    filed as unverifiable. The device blacked out mid-benchmark and `doctor`
    said so from the new check:

    ```
    WARN capture  frame #5718 322x700 in 167ms (age 15ms) — and every pixel of
                  it is black. If the device is not showing a black screen on
                  purpose, this is the display pipeline having stopped
                  rendering…
    ```

    Worth the comparison: the existing `display` probe reports the same fact by
    reading 3,162,132 pixels through Apple's screenshot path and took
    **6174 ms** to do it. This one is 32 integer comparisons on a signature the
    frame already carried.
23. Worth an Apple feedback report: rapid app relaunch cycling kills the
    simulator's display pipeline in about six cycles, reproducibly, and
    `simctl io screenshot` confirms it from outside simframe.

### Waiting on the user, not on work

- ~~The bundle id in public commit diffs.~~ **Settled, 2026-09-10, and the
  framing was wrong all along.** The inherited rule read "one of my clients must
  never appear in this repo". The actual rule is simpler and stronger: simframe
  is a general-purpose tool — you install it and Claude Code drives *your* app —
  so **no** particular app's bundle id belongs in it, from anyone, ever. Not in
  the source, not in the docs, and not in a secret either.

  That reshaped the guard. `scripts/check-private.mjs` is a **pattern**, not a
  denylist: anything shaped like a reverse-DNS bundle id fails unless it is a
  platform's own (`com.apple.*`, `com.android.*`, `com.google.*`), a
  documentation placeholder (`com.example.*`), or ours. It needs no
  configuration, so it works on a fresh clone, on a fork, and on a pull request
  from a stranger — none of which a secret does. `SIMFRAME_PRIVATE_STRINGS` and
  `.private-strings` still add extra patterns for anyone who wants them, and
  nothing depends on either existing.

  The first version of it did depend on that, and the cost was immediate: a
  282-line field-notes file about a real third-party app was committed by
  `git add -A` and pushed to `main` an hour after the guard was written, while
  the guard sat passing because nobody had supplied a denylist. **A guard with a
  precondition is a guard that is off.** Removed from `main` in `217454e`; the
  findings worth keeping were extracted scrubbed first.

  Two occurrences remain in git history and neither is in the working tree:

  | | where | tags containing it |
  |---|---|---|
  | a bundle id in a since-deleted script, 2026-09-07 | history only | **all 10** |
  | the field-notes file, 2026-09-10 | history only, after `v0.9.0` | **none** |

  So a rewrite of post-`v0.9.0` history removes the larger of the two and moves
  **no tag SHA** — much cheaper than the rewrite declined this morning, which
  would have broken npm provenance for one placeholder-shaped identifier.
  **Not started, and not to be started without an explicit, specific
  instruction.**

- The human baseline JSONs are committed and therefore public: medians, IQRs
  and inter-transition intervals for one person, no name attached. Flagged so
  it is a choice rather than an accident.
- The article (`docs/agents-shouldnt-blink.html`) is **checked for falsified
  claims, not updated per phase**, and that is the standing rule. Reviewed
  2026-09-10 against everything built since Phase 10:

  - **One claim was falsified and is now amended.** It said a radio button that
    moves 0.1% of the screen "returns in a second marked `no-visible-change`,
    and the agent knows to check rather than wait". Measured on a real form,
    every radio and segment tap cost **~2.5 s** of dead wait and each one *had
    worked* — being told nothing happened when something did is a wrong answer,
    not a hint. The amendment carries the mechanism (`changed` is a mean over a
    4×8 grid against 0.004; a switch flip moves it 0.001348) and says plainly
    that it is not fixed.
  - **The token table still holds.** It quotes 1159 characters / ~330 tokens for
    one screen's map. Re-measured across the 15 harness screens: median **740**,
    range 372–1169. So the figure is a fair busy screen and the 5×-cheaper-than-
    an-image conclusion is if anything conservative — even with rows now
    carrying element state and results carrying a `next:` line.
  - **The section that was waiting is written**: "Sixteen of nineteen were one
    bug". The escalation contract was designed, then instrumented, and the
    first breakdown disagreed with the plan — 16 of 19 escalations were one
    de-duplication bug, an IoU test scoring two boxes at 0.053 where containment
    scores 1.000. The refusal was correct; the fault was upstream of the
    decision. It also names the two later measurements that overturned things in
    the piece: a pause statistic that was noise in both directions, and a map
    optimisation reverted the day it shipped.

  Everything else in it — the capture numbers, the classifier, the accessibility
  tier's worth, the borrowed work — is unchanged and still measured. HTML
  validated and rendered after editing.

## Correctness

### Region bands are positional, and that is now three bugs — fixed

`src/regions.js` decided what was chrome by fraction of screen height, and
because chrome labels are the only text entering a fingerprint, every
misclassification landed in a screen's identity. Three phases paid for it: a nav
button read as a title (6b), a screen whose identity contained `"sep 08, 2026"`
and would have become a different screen at midnight (6d), and three of twenty
learned screens still carrying a store address, a phone number and a nav title
reading `"tuesday, september 8"` (7). Each was patched with another rule; the
rules were individually defensible and collectively a smell.

The bands are now derived from where the elements actually sit — a nav bar is a
short row of things at the top with a gap under it, not a fraction — with the
HIG fractions kept as the fallback for a screen too sparse to cluster. Measured
either side with the fingerprint eval harness, as this entry required: chrome
labels entering identity fell from **14 to 6**, same-screen similarity held at
1.00, different-screen similarity stayed at 0.04–0.05, and the adversarial pair
(`settings-general` against `settings-accessibility`) separated at 0.05 with
`general`, `accessibility` and `settings` correctly retained. Numbers in
`docs/BENCHMARKS.md`.

### Verify-after-tap
A tap can move the screen without doing what was meant — a swipe that animates
but does not navigate still reports `changed`. Phase 6 covers this properly with
the transition graph, and Phase 4 supplied the missing half (a transition kind to
compare against). Until then `sim_do` can report a step succeeded when it did
not.

### Classifier accuracy is anecdotal
Phase 4 asked for twenty repetitions of each known action with the classifier's
label asserted. It was verified against a handful of real actions instead, so
there is no accuracy figure. The known weak case: a scroll that rubber-bands off
the end of a list reads as `replace`, because after the bounce the frames
genuinely are not a translation. A harness would say whether that is rare enough
to leave alone. `docs/BENCHMARKS.md` "Phase 4" has the shape of the test.

### Integration coverage exists now, and the assumption behind this entry was wrong
This used to say hosted runners have no booted simulator, so nothing could
exercise the daemon. That was never tested. A `macos-15` runner boots
simulators fine, and the daemon works there in full: `simframed` capture,
`simframed` input over Indigo HID, in-process OCR, frames at 177 ms.

The `integration` job now installs the packed tarball, boots a simulator, and
asserts every layer is the good one under `--strict`. What is still uncovered:
the graph, screen memory, intent matching and the fingerprint are exercised only
by unit tests and by hand on one machine. A flow that taps real controls in a
real app cannot run on a hosted runner, because there is no app to tap.

## Completeness

### A long-running simulator stops accepting hardware button presses
Measured: on a device under heavy automation for hours, `press home` reports
success and the screen never moves. A daemon restart does not help; a device
restart does. Not reproducible on a fresh device of either iOS 18.0 or iOS 26.5
(8/8 presses), so it is device state rather than anything simframe holds, and
the mechanism is unknown.

simframe now reports it rather than claiming success, and rebuilds the HID
session and retries once inside a flow. Neither recovers the device-state case.
What would settle it is a way to ask the device whether a button is currently
held — nothing in the private surface studied so far offers one, and without it
input remains the only path with no feedback channel.

Worth revisiting if it starts happening inside a single test session rather than
after hours, because then it stops being an operational annoyance and starts
being a correctness problem for long flows.

**2026-09-09: it does happen inside a single session, and it takes capture with
it.** Same class, different casualty. On a freshly booted iPhone 17 (iOS 26.5),
the memory harness passed clean, and by the third run the daemon was logging
`the display surface could not be read` continuously — 475 failures, the frame
hash frozen for 46 s, swipes reporting no visible change. `CaptureRecovery`
re-resolved the display port every six failures, as designed, and it made no
difference: the surface stays unreadable. Only a device restart cures it, after
which a full harness run passes with 6 surface failures, one recovery cycle,
which is what that code is for.

Two things it is *not*. It is not simframe holding something: the failure is
inside the daemon, reading IOSurface, and the daemon binary was not rebuilt or
touched across the runs that went from clean to wedged. And it is not the
window: a device booted headlessly with `simctl boot` while Simulator.app is
running and showing a different device captures fine on its first run, and
fronting a wedged device's own window revives nothing (+16 failures in the 8 s
after fronting it). CI boots headlessly with no Simulator.app at all and
captures fine, which rules the window out as the rule.

So the honest shape is: **display-surface capture degrades under sustained
automation on a timescale of minutes, not hours, and a device restart is the
only known cure.** That is now two independent subsystems — HID button presses
and the display surface — degrading the same way on a device that has been
driven hard, which makes a shared cause in CoreSimulator more likely than two
coincidences. The next step is not more recovery code; recovery already runs and
already fails. It is finding out what a restart resets.

**Detected and reported since 2026-09-09, and deliberately not cured.**
`simframe state` leads with `capture: stalled — the display surface has been
unreadable for 62s; 3 re-attaches did not help; only restarting the device is
known to cure it`, `doctor` grades it `fail`, and `--strict` exits non-zero. An
agent that reads "nothing changed" keeps tapping; one that reads "the simulator
is wedged" stops. simframe does not restart the device: a capture loop that
rebooted the device it was watching would be a tool reaching for the mains
because a reading looked wrong.

Two things about the signal were not obvious. **Frame age is not it** — a screen
that is genuinely still produces no frames at all under a damage-driven engine,
which is the state `settle` exists to detect, so "no frames" cannot distinguish
a wedge from a quiet screen. The signal is the daemon's own failed reads, which
only the daemon knows about, published to `capture-health.json` because
`state.json` is written when a frame is recorded and a stall is the absence of
frames. **And the count to watch is re-resolves, not failures**: a successful
re-resolve resets the failure count, so the pathology loops — six failures,
re-resolve, six failures — and no count of consecutive failures ever grows
large enough to notice. Two re-resolves without a frame in between means the
port was never the problem. The Node capture loop, which has no port to
re-resolve, counts consecutive errors instead, so a wedged Android emulator is
not silent either.

### Three small things from the 0.7.0 session, written down so they survive it
None of these is hard. They are here because they existed only in a
conversation, and this file is where a status is supposed to live.

- ~~**`server.json`'s description still says iOS only.**~~ **Fixed, 0.7.1**, as
  predicted, by riding along with the next release — together with
  `package.json`'s description and its keywords, which had no `android` in them
  either. `README.md`'s headline and `CLAUDE.md`'s opening line said the same
  thing and are fixed too. The pattern is worth naming: the version string was
  kept in step by a hook, and every *prose* claim about what the tool is drifted
  independently, in five files, for a whole release.
- ~~**`doctor` with no `--device` fans out across every booted device.**~~
  **Fixed, 0.7.1**, with the first of the listed options and a little of the
  third. *Listing* every booted device is free and stays. *Probing* — the part
  that starts a capture loop and reads frames — now goes to a device already
  running its own capture loop, or to the only booted device, and otherwise to
  none, with a `warn` naming the flag that would pick one. Two related fixes
  fell out of writing it: `--device X` with a space now parses (it set the flag
  to `true` and resolved a device named "true", and the space form is exactly
  how `doctor`'s own advice reads), and a cleanup that cannot stop a loop it
  started now says so instead of `catch { /* best effort */ }` — a refused stop
  used to leave a capture loop running on somebody else's machine while doctor
  reported a clean bill of health.
- **The release workflow creates no GitHub Release.** It publishes to npm and
  the MCP Registry off a `v*` tag and stops. Nothing is missing, but the commit
  messages in this project are detailed enough to be release notes, and nobody
  reading the repository can see them as such.

### Phase 9 is optional, and today's numbers moved its gate — but not enough
`docs/PHASES.md` gates Phase 9, the tier-2 local model, on the Phase 5 eval
showing vision-only recall on accessibility-poor screens is below what you can
live with, and says not to start before those numbers exist. The a11y-tier
measurement is the first evidence that bears on it, and it points somewhere
narrow: what vision-only cannot do is **icon-only controls**. 83% of interactive
elements carry no text, and every OCR-only failure was that shape — two
refusals, and `Back` resolving to `"B"`.

Three reasons not to start it anyway, recorded so the next person does not have
to re-derive them:

1. **The cheaper tool for that exact gap is already on the list, unbuilt.**
   Phase 5's remaining pieces lead with the SF Symbol template bank, whose own
   entry says these are exactly the controls with no text for OCR to find.
   Template matching needs no weights, no license review and no download.
2. **The gate is not actually met**, because the thing that would meet it does
   not exist: the eval harness over fifteen screens from three apps. This
   session measured six screens from four Apple apps, which are unusually
   well-labelled — suggestive, not a recall number. Phase 2a was supposed to
   wait on that harness and did not; doing it again would be the same mistake
   twice.
3. **It contradicts a stated non-goal.** CLAUDE.md lists shipping ML model
   weights as a non-goal for now, so Phase 9 is a promise change rather than
   just work — the same class of decision as the APK above. Both are "put a
   runtime artifact on the user's machine", and they should be decided together
   rather than one at a time.

The order that respects all three: template bank and contours first, then the
eval harness for a real recall number on a11y-poor screens, and only then is
Phase 9 a decision with evidence behind it. That sequence is also the best
available answer for Android without an APK.

### Phase 8b — the instrumentation APK, and when to build it
**Decided 2026-09-09: Android ships OCR + CV only.** Not because the tree is
worthless but because of where the pain is. Android is the second proof of the
platform boundary; the perception ladder was built so that a missing tier
degrades rather than fails, and this is precisely that case; and an npm package
that does what it says is worth more than one that quietly installs an APK.
`simframe doctor` reports the tier as `optional` with the 2,012 ms number, so
the absence is visible rather than silent.

**Do it when one of these is true, and not before:**

1. A real Android user hits a screen class OCR and CV cannot serve — a custom
   canvas surface, an icon-only control with no text anywhere near it, a
   WebView whose text OCR reads but whose roles it cannot infer.
2. ~~The iOS a11y tier's hit rate is measured and shows what Android is
   losing.~~ **Measured 2026-09-09 — see `docs/BENCHMARKS.md`.** It is not
   small. On six iOS screens, **every** interactive element came from the tree
   (72 of 72) and **83%** of them have no text at all, so OCR cannot see them
   even in principle. Intent resolution went 26/28 with the tree to 22/28
   without, and one of those failures was a *wrong* answer rather than a
   refusal: `Back` resolved to `"B"`, the section-index letter next to it.

   What it does not cost is recognition: every revisit was recognised either
   way. So the tier earns its place in acting, not in looking, and Android's
   missing tree makes it less certain about controls rather than blind.

   That is the number for this decision, and it does not settle it on its own:
   79% with one mis-resolution in fourteen is a working tool, and these are
   Apple's own unusually well-labelled apps. Criterion 1 is still the trigger —
   a real Android screen class that OCR cannot serve.

**The shape, when the time comes**, is the one every serious Android driver
converged on — uiautomator2, Maestro and Appium all do the same thing: a tiny
instrumentation APK, built from source in `native/android/`, debug-signed,
installed by the daemon over `adb` on first use, holding a `UiAutomation`
connection open and serving the tree over a local socket. It is a runtime
artifact, but it is ours, it is built from source in this repo, and it is
automatic. The promise change is "simframe puts a helper on your emulator" —
an honest sentence to add to the README on the day it is true, and not before.

### Android input reported success while the device did not move — once
Observed 2026-09-09 on an emulator that had been running about two hours under
capture and OCR load. A `home` key and a `launch --relaunch` both reported
success, three consecutive readings of what should have been three different
screens returned one identical fingerprint, and `dumpsys window` confirmed the
device had never left Chrome. Both commands worked immediately afterwards, from
the same code, against the same device.

That is the same shape as the long-running-simulator entry above — input
reporting success with nothing moving — on the other platform and through a
completely different mechanism, which makes a shared cause unlikely and a shared
*class* worth naming: **an input path with no feedback channel cannot tell you
it did nothing.** simframe's answer is the verdict layer, which compares the
screen before and after; the reason this was caught at all is that the
fingerprints came back identical.

One observation, so no diagnosis. What would settle it is `dumpsys window`'s
focused activity recorded alongside a verdict, which is 27 ms and would say
"the app never came to the front" instead of "the screen did not change".

### A contact row is ambiguous with its own name — fixed
Found while measuring the a11y tier: `"Kate Bell"` on the Contacts list resolves
as *ambiguous* with the tree present, because the row arrives as a row and as
its own text element and the two score within `AMBIGUITY_MARGIN`. Two of 28
intents, and only with the tree — OCR-only has one element there and resolves
it.

The safe failure, since the caller is asked for an index rather than given a
guess, but still a failure: a list of contacts is exactly the screen where
tapping a name should be the easy case. The fix is probably in
`collapseSamePlace` — a text element wholly inside a row *is* that row, which is
the same judgement the screen map already makes when it files OCR text as an
alias — but the two paths reach it differently and that is worth understanding
before changing either.

**Phase 10 update (2026-09-09): this is now the most expensive open item here,
and it has a number.** It is the only escalation the instrumented flow suite
produces — three of three runs of `contacts-kate-bell`, all `ambiguous_intent`,
all on one screen fingerprint — and it is the whole reason `HPI_accuracy` is
0.5 rather than 1.0. The log's candidate list closes the diagnosis left open
above: the AX row is `x=2 w=384`, the OCR text is `x=67 w=71` wholly inside it,
and both score exactly 1.00. One more fact worth having: `simframe ui` renders
**one** "Kate Bell" for that screen, so the display path already collapses the
pair and the matcher that acts on it does not — two representations of one
element list, disagreeing, with the acting one wrong. Do it before Phase 11;
`docs/ESCALATIONS.md` argues that ordering from the data rather than from the
default phase order.

**Fixed the same day.** An OCR reading whose frame is ≥90% inside a labelled ax
element, and whose text matches that element's label or value, is that element:
merged at fusion, keeping the tree's role and frame, marked `source: ax|ocr`.
Neither existing rule could have caught it and the numbers say why — the row is
18.8× the area of its own text, so the 8× size cap could not fire; the centres
are 91 pt apart, so the 12 pt rule could not; and the row is `StaticText`, so
the interactive-role containment rule could not. IoU, the first thing tried,
would have been 0.053. `contacts-kate-bell`: 0 of 5 runs completing to 5 of 5,
`HPI_accuracy` 0.5 to 1.0, zero escalations added by a fresh measurement.

### The emulator's gRPC surface has nothing tree-shaped — confirmed
Asked and answered so nobody asks again. The emulator ships its own service
definitions in `$ANDROID_HOME/emulator/lib/*.proto`, which is the authoritative
list, and `emulator_controller.proto` has 43 RPCs: sensors, physical model,
battery, GPS, fingerprint, key/touch/mouse/wheel input, phone and SMS, status,
`getScreenshot`/`streamScreenshot`, logcat, VM state, display configuration,
notifications, virtual scene camera, posture, brightness, display mode, XR
options. `ui_controller_service.proto` adds four, all about the emulator's own
window chrome. Grepping every proto in that directory for `accessib`,
`hierarch`, `uiautomat`, `viewnode`, `nodeinfo`, `widget` or `element` returns
nothing but a comment in `adb_service.proto` about making adb *accessible*.

The emulator can hand over pixels and take input. It has no idea what a view is,
and it is not going to.

Two things in that list are worth remembering rather than rediscovering:
`streamScreenshot` is the streaming capture path if 41 ms per frame ever stops
being enough, and `setClipboard` is the answer to the entry below.

### Android's accessibility tree costs 2 seconds a read
`uiautomator dump` is 2,012 ms on this machine (`docs/BENCHMARKS.md`), against
45 ms for the iOS tree after Phase 2a. It is not the same kind of cost and it
does not have the same kind of fix: iOS was slow because each attribute was a
separate hop to the guest, and batching removed that. Here the cost is a fresh
instrumentation process per dump, so there is nothing to batch.

The known way to make it fast is a resident server — an APK on the device that
holds the `UiAutomation` connection open and answers over a socket, which is
what Appium's UiAutomator2 server is. That would be the first runtime
dependency this project has ever shipped, and shipping an APK is a different
promise from shipping a Node package. Not decided.

Two cheaper things exist and neither is a tree: `dumpsys window displays` names
the focused activity in 27 ms, and `dumpsys activity` can name the current
fragment. Both are useful for "which app am I in" and neither gives an element
list, so neither substitutes for perception — OCR does, and does it today.

Until this is settled, Android reports its accessibility layer as `optional`
with the reason, which is the state doctor exists to make visible.

### There is no *adb* path to the Android clipboard — the gRPC one is shipped, 0.7.0
`cmd clipboard` does not exist on API 36 — the shell answers "No shell command
implementation" — and `service call clipboard` depends on transaction numbers
that move between platform versions. So `setPasteboard` throws on Android with
the reason, rather than appearing to work.

This matters more than it sounds: on iOS the pasteboard is how simframe types a
long string exactly, because key events follow the active keyboard layout and a
device with a non-Latin layout installed types the wrong characters. Android's
`input text` has the same class of problem.

**Correction, same day: the emulator gRPC surface has it.**
`emulator_controller.proto` declares `setClipboard(ClipData)`,
`getClipboard(Empty)` and `streamClipboard(Empty)`, and `ClipData` is the
simplest message protobuf can express:

```
message ClipData { string text = 1; }   // → 0x0A <varint len> <utf-8 bytes>
```

A unary gRPC call is an HTTP/2 POST to
`/android.emulation.control.EmulatorController/setClipboard` with
`content-type: application/grpc` and a five-byte length prefix. Node has `http2`
built in, so this is reachable in about forty lines with **no npm dependency**
and no APK — which makes it the cheapest real capability left on the Android
side, and it should not stay filed under "not possible".

Both open questions turned out to have the same answer, and it is a file. A
running emulator writes its own `grpc.port` and `grpc.token` into a per-process
record beside the AVD, so nothing is hardcoded to 8554 and a second emulator on
another port works. The token is required — the `unprotected` list in
`emulator_access.json` is empty — and it is read at call time, never logged.

Measured: 48 ms cold, 10 ms warm. Verified where it counts, which is not the
`getClipboard` round trip — that only proves the emulator accepted the text.
`CLIPTEST-7391` set through the seam and then pasted into Chrome's address bar
proves the guest has it.

### Android input is measured and unwired — wired, 0.7.0
The emulator console's `event mouse <x> <y> 0 1` / `... 0 0` puts a real
down-and-up on the touch screen, host-side, with no adb and no dependency. That
is the Android equivalent of Indigo HID, including real down→move→up sequences
with honest timing rather than teleporting taps, and `event text` types.

Shipped as one gesture vocabulary — tap, swipe, type, keys — so `sim_tap` never
existed on a platform where `swipe` did not. The coordinate space is device
pixels, settled by watching the touch driver report `0x3fff` for a point at half
the screen rather than by reading the help text.

**The `paste` *step* was broken, and not only on Android — fixed, 0.7.1.** This
entry used to say "open on Android". That was wrong in a way worth keeping on
the page: the step set the pasteboard, long-pressed the field and returned
*"placed text on the pasteboard"*, and **nothing ever issued the paste on either
platform**. iOS had the mechanism and did not use it — the daemon's `paste` is
pbcopy *plus* Cmd-V, which is why `type` worked — and Android had `KEYCODE_PASTE`
sitting unused in its own `KEYS` map. Filing it as a platform gap is what hid
it: an entry that names one platform stops anyone checking the other.

The fix is `input.pasteText`, which sets the pasteboard **and** delivers the
keystroke (the platform's own key where there is one, the daemon's Cmd-V
otherwise) and **throws** where it can neither — a step that cannot do what it
says has to say so. The step now focuses the field through the same `focusField`
helper `type` uses, so it reports when the field never visibly took focus.

Reached through `sim_type_into` with `paste: true`, this was the worst shape a
bug can take here: `paste` is in `ACTION_STEPS`, so the edit menu appearing
satisfied `settle`, `sawChange` came back true, and the graph could record an
edge for a field that stayed empty.

### The capture loop's recovery path has no test — fixed
A display port torn down under a live daemon left capture dead for six minutes
until the process was restarted (see `docs/BENCHMARKS.md`). The fix re-resolves
the port after six consecutive failed reads, and it is unverified: a teardown
cannot be induced on demand, and the loop is inline in `main.swift` rather than
factored into a function a stub platform can drive.

Extracted to `CaptureRecovery` in SimframeCore and tested three ways: a
momentary hiccup does not reattach, a sustained run reattaches *and re-arms the
damage callback*, and a reattach that fails stays due rather than waiting for
another six. The callback half is the one worth a test of its own — a fresh
descriptor with nothing registered on it gives a daemon that has recovered and
will never notice another change, which looks exactly like the failure it just
recovered from.

The teardown itself still cannot be induced on demand, so what is covered is the
decision and the act, not the event.

### Fixed sleeps in `actions.js` — the action path is done, the step types are not
`sim_wait` and the settle gate defer to the daemon's real settle detector, and
since Phase 11 step 4 so do the two waits that sat on the action path: the focus
window after tapping a field is learned per edge (lengthen-only — the failure of
a short focus wait is a *silent wrong type*, so the saving is declined), and the
structural identity settle credits the time the previous sample already spent
instead of sleeping a fresh 300 ms. `docs/BENCHMARKS.md` has the measurements
and the asymmetry argument.

What is left is the individual step types. `scrollTo` settles for 250 ms and
gives up at 2500 ms per scroll; `waitText` and the explicit `settle` step
default to 8000 ms; `press` in the CLI waits 400 ms before asking the frames
whether anything moved. None of these has a graph edge in hand at the point it
waits, which is why they were not folded in — giving them one means either
threading the step loop's timing into the inner calls or letting them read the
graph themselves, and that is a shape decision, not a constant swap.

The keyboard-focus one was the first to go, because Android forced it: 150 ms is
enough for a keyboard rising over the screen you are already on and nowhere near
enough for a tap that starts a whole activity, and the text went before the
field existed while the step reported success. That is still the argument for
the rest of the pass — every one of these numbers is calibrated against one
platform's animation timings, and the second platform is slower in places the
first never was.

### Screen memory still lives in Node
Phase 2 called for porting the layout-hash cache into the daemon. It was left
where it is: it works, it is byte-compatible with the daemon's hashes, and moving
it only pays off once the daemon serves `locate` — which is Phase 7's reshaping
of the agent-facing surface. Doing it earlier is churn.

### Pinch, and every hardware button except `home`
Pinch needs multi-touch, a different Indigo message shape that is unverified.
The remaining button codes need sweeping on a simulator someone is willing to
have crash or lock — a wrong Indigo button code can take `backboardd` down. Both
return errors rather than guesses today. See `docs/PRIVATE_API.md`.

### The accessibility tree still comes from idb — fixed

It comes from the daemon now, read host-side through `AXPTranslator` with
nothing injected into the guest: 45 ms against idb's 203 ms on the same screen,
and nothing beyond Xcode to install. idb remains a fallback, and
`SIMFRAME_AX_DRIVER=idb` forces it, because every private-framework path here is
version-coupled. What the two blocking mistakes were is in `docs/PRIVATE_API.md`
under "Accessibility: the sequence that works".

### Phase 5 left four things unbuilt
`sim_find` covers the part agents use every call. Not built, in the order they
would be worth adding:

- **SF Symbol template bank.** Icon-only controls are reachable by synonym
  ("back", "close", "more") but not identified. Template matching against
  rendered symbols would name them, which matters because these are exactly the
  controls with no text for OCR to find.
- **Contour / rectangle candidates** for regions the accessibility tree leaves
  empty. Lower value while OCR plus the tree already cover most screens; it
  matters on canvas and WebView surfaces.
- **NLEmbedding similarity.** Fuzzy matching and synonyms handle typos and
  common names; embeddings would handle paraphrase ("go back" vs "return").
  Needs the NaturalLanguage framework, so it belongs in the daemon.
- **The eval harness** over fifteen screens from three apps, which is what would
  turn "it works on the screens I tried" into a recall number. Phase 2a was
  supposed to wait on it and did not; the harness is still the thing that would
  say what OCR-only misses on accessibility-poor screens.

### Confirm vocabulary is English
`APPLY`, `OK`, `SAVE`, `DONE` and friends are hardcoded. A localised UI needs
them extended, and the same applies to the synonym table Phase 5 introduces.

## What an independent review of 0.6.0 found

A reviewer was asked whether the two known-open defects could produce a *wrong
action* — tapping the wrong thing, `goto` walking somewhere wrong, a verdict
reporting success on the wrong screen — or only wasted work. The entries below
said wasted work. **It reproduced two wrong-action paths**, and both are now
fixed.

### Fixed: "nothing claims this reading" was treated as proof of a variant

`graph.record` merged an arrival into a learned edge's destination whenever no
*other* stored screen claimed it. Unknown is not the same as "the target grew a
second face" — it is equally consistent with the action being state-dependent
and having gone somewhere new. Fed a screen sharing **zero** tokens with the
target (Jaccard 0.0 against a 0.36 threshold), the reviewer got it merged, after
which arriving there returned `ok` — *"matches the outcome seen 3x before"* — so
`stopOnUnexpected` never fired and a flow kept walking, tapping real controls on
a screen its plan never contained.

A reading must now positively resemble the target before it is called a face of
it. Unclaimed is a necessary condition, not a sufficient one.

That change surfaced something the old code was quietly relying on: an edge
stores its destination's **hash and nothing else**, so a target that has never
been stood on has no structure to compare against. In that case simframe now
declines to call the reading a variant and records a changed outcome instead —
the conservative reading, and the honest one.

### Fixed: every unreadable screen shared one identity

`hashTokens([])` was sha256 of the empty string — a constant — so a zero-target
read of *any* screen produced the same structural hash. And `similarity([], [])`
returned 1, so two consecutive unreadable reads "agreed", which promoted the
non-identity to a confirmed screen and let it be learned as an edge.

The reviewer showed this defeats all three of `resolveRef`'s guards at once: the
structural check passes because both hashes are the constant, `screenKnown` is
truthy because a stored dark entry matched, and the pixel backstop is skipped
because `informative()` correctly reports a near-zero layout hash as no
evidence. `#3` then resolves to coordinates numbered on a different screen and
taps them. The pixel hash got an `informative()` guard for exactly this
degeneracy; the structural hash had the same one and no guard — and a guard
could not have helped, because a constant looks perfectly informative.

No tokens is now `null` rather than a hash, and two empty sets are similar by
0, not 1.

### Fixed: one observation was enough to halt a run

Separately, and the reason a first install behaved worse on its *second* run
than its first: `verdict` returned `unexpected-screen` whether an edge had been
seen once or fifty times, and any `unexpected-screen` halts. Run one learns
every edge at count 1 and cannot contradict itself; run two has an expectation
for every step and stops dead on the first screen whose identity wobbled.

A single-observation miss now reports `unverified`, and so does a miss on an
edge that has already reached more than one destination — the graph had been
counting that as `changedOutcomes` and nothing ever read it. `unexpected-screen`
is reserved for an edge seen at least twice that had always gone to one place
and then did not, which is a real wrong turn worth stopping for.

Measured from a cleared graph, six consecutive runs of a ten-step flow with
halting enabled:

| | before | after |
| --- | --- | --- |
| run 1 | **halted 3/10** | 10/10 |
| runs 2–6 | 10/10 | 10/10 |
| converged to all-`ok` by | run 2, then oscillated | **run 3, and stayed** |

### Fixed since, from the same review

Everything the reviewer raised is now closed except where noted:

- **The unguarded KVC call.** Both `setValue(_:forKey:)` on
  `bridgeTokenDelegate` and the `pid` read are guarded by `responds(to:)`. An
  Xcode that renames either degrades the accessibility layer instead of raising
  `NSUnknownKeyException`, which is an Objective-C exception and therefore
  uncatchable from Swift — a crash taking capture, input and OCR with it.
- **The unsynchronised `bridge()` accessor.** Behind a lock, and the capture
  loop's rebind path takes the same lock. Two constructions can no longer race
  and leave the survivor holding a translator whose weakly-held delegate has
  deallocated.
- **The 12-second bound abandoning work rather than the wait.** Timeouts are
  counted per read against a ticket rather than in one shared counter, so an
  abandoned read cannot clear or inherit a live one's count. A tree that lost
  subtrees can no longer come back claiming to be whole.
- **`recallNearest` without an `informative()` guard.** Guarded. A near-uniform
  screen no longer hands back a different screen's element map, and it no longer
  feeds a guarded function unguarded inputs.
- **`route()` blind to variants.** The search now resolves variants the way
  `nearestScreen` does, and a goal may be named by any of a screen's faces. An
  edge whose destination was a variant hash used to be a dead end, so the graph
  had routes it could not find and `goto` answered `no-route` for somewhere it
  had been.
- **`npm@latest` in the release pipeline.** Pinned to `>=11.5.1 <13`. Pinning
  Node alone fixed one instance and left the mechanism intact.
- **`workflow_dispatch` publishing with the version check skipped.** The check
  now runs on manual runs too, comparing `package.json` and `server.json` with
  each other — which is the half that protects a publish — and against the tag
  only when there is one.
- **`mcp-publisher` floating on `releases/latest`** in a job holding
  `id-token: write`. Pinned to `v1.8.1`, with a failure message that says to
  bump it deliberately.
- **`ci.yml` never running on tags.** `check:package` and the tarball build now
  run in the release job, so the commit that actually ships is checked by the
  two things written to catch a broken package.
- **The already-published test.** `npm view <pkg>@<version>` 404s during npm's
  review window, so a re-run inside it took the publish branch and hard-failed
  on `EPUBLISHCONFLICT` — the promise that an existing version is a skip held
  only after review completed, which is the opposite of when a re-run happens.
  It reads the versions list now and tolerates losing a race to itself.
- **Documentation.** `accessibilityMultipleAttributes:` is documented with its
  measurements. Two of my own claims were overstated and are corrected: "one
  bridge call per node" is really three (batch, label, children), and 2.7 s
  measured against 2.2 s predicted is the same order, not agreement.

**Not fixed:** no `autoreleasepool` in the tree walk — up to 4000 nodes of
autoreleased objects accumulate until the read returns. Memory pressure only,
and free to fix whenever that file is next open.

## What an independent review of 0.7.0 found

Two peers were pointed at the release: one reviewing the source read-only, one
installing the published tarball on a clean prefix. Seven findings, every one
verified against the source before it was believed. Six are fixed in 0.7.1 and
are recorded above or below; what follows is the residue — the things the review
raised that are *decisions* rather than bugs, so they belong here rather than in
a commit.

The review's own lesson is the cheapest thing in it: **the highest-value
question to ask a reviewer is "what reports success without doing the work",**
and asking it found a bug that had been filed for a whole release under the
wrong platform. Three of the seven were of that shape.

### `xcrun simctl openurl` times out on a loaded runner — retried in CI, not in simframe
Three consecutive integration runs failed at `openUrl` with
`NSPOSIXErrorDomain code 60, Operation timed out`, and the same commit passed on
a quieter runner, so it is load and not code. The evidence that it is load: the
flow immediately before the failure took **33 s** on the failing runs against
**21 s** on the passing one, and one run logged `capture failed: the display
surface could not be read (6 in a row)`. The timeout is simctl's own; simframe
never gets a chance to see it.

The CI step retries three times with a 5 s gap. **simframe deliberately does
not.** A timeout is not evidence the URL failed to open — it is evidence simctl
stopped waiting — so a product-level retry can open the URL twice, and an action
that fires twice is precisely what the verify barrier in `CLAUDE.md` exists to
prevent. For a real user, who can see their own screen, a hard failure is the
honest answer. The retry buys the runner patience without buying simframe a lie.

Worth revisiting if a user ever reports this off a hosted runner. Then the
question becomes whether `openUrl` can be made *checkable* — open, then confirm
the frontmost app changed — which is a retry with evidence rather than a retry
with hope, and is the only version of it that belongs in the product.

### `doctor` was fixed and the default device was not — fixed, 0.8.0
The 0.7.2 guard stopped `doctor` fanning out across every booted device. It did
not touch the thing that chose the device in the first place, and a clean-room
review of the published 0.7.2 found the rest of it in minutes.

Both backends answered a bare query with `booted[0]`. On a host with more than
one booted simulator that meant `simframe ui` read whichever simctl happened to
list first — reproduced deterministically against a colleague's simulator,
starting a daemon on it and writing a frame store — and the same unguarded path
is reached by `tap`, `type`, `swipe`, `keys`, `press`, `do`, `goto`, `find`,
`start` and the MCP server's default. So a bare `simframe tap "Save"` would have
**injected input into somebody else's device**.

The sharpest piece of evidence is the inconsistency: at one moment, in one
state, bare `doctor` correctly picked the reviewer's own device while bare `ui`
picked the colleague's. That is the signature of a fix applied to a command
instead of to a default.

Both backends now refuse, marked `ambiguous` so a clean match on the other
platform cannot override it, and name the devices plus `SIMFRAME_DEVICE`. This
is why 0.8.0 is a minor and not a patch: a bare command on a multi-device host
used to act and now errors, and that is user-visible behaviour even though the
old behaviour was the bug. The MCP server's default is the same path, so an
agent that never named a device now gets an error telling it to — verified
against the running server.
Refusing rather than preferring, for a reason that is a boundary constraint and
not timidity: the seam cannot see which device simframe is already driving,
because that is store state above the boundary, and a backend must not guess
when guessing wrong is a tap on another person's screen.

**What is still open is the convenience `doctor` has and nothing else does:**
preferring the device that is already capturing. Doing it generally means the
default-device decision moving above the boundary — a small helper in `src/` that
every call site uses instead of importing `resolveDevice` from the seam directly,
which is seven call sites across `cli.js` and `index.js`. Worth doing; not worth
folding into a fix for a wrong-device hazard.

### `stop` exited 0 after refusing to stop anything — fixed, 0.8.0
`stop --device=X` against a daemon another client holds printed "stopped 0
daemons; left 1 in use by another client" and exited **0**. The text was honest
and the exit code was not, so a script could not tell the difference. An
explicit device that was refused now exits non-zero; `--all` still exits 0 when
it skips a device somebody else holds, because there it is informational.

### Three README claims that were not true — fixed, 0.8.0
Found by the same review, and all three are the kind of small dishonesty this
project says it cares about:

- *"The first `simframe start` builds a small Swift daemon"* — `doctor` builds
  it too, and `doctor` is the first command the quickstart tells you to run. A
  cold `doctor` measured **16.7 s** against 2.2 s for the `start` after it, and
  the README explained none of it.
- **`~20 ms` was quoted as though it were the cost of a shell command.** It is
  the read inside a live process. A one-shot CLI invocation pays ~200 ms of Node
  startup on top, and frame age on an *idle* screen measured min 17 / median 75
  / p90 462 ms because the loop throttles when nothing moves.
- **The sample `doctor` output is a single-simulator host.** With several booted
  it prints `WARN device probes` and none of the per-device layer lines.

### The Android backend has ~970 lines and two assertions
Fixed in 0.7.1 only where a fix was one line. The coverage gap is real and
mostly *pure* functions, which is the annoying part — none of this needs a
device:

- `toPixels` — points→pixels and its off-screen throw. This is the arithmetic
  whose absence produced the `393x700pt` wrong-tap bug, and it has no test.
- `geometry`'s parse of `wm size; wm density`, and `fetchDevices`' parse of
  `adb devices -l` plus the batched `getprop` block.
- `setPermission`'s read-back — the declared/actionable/undeclared/disagreed
  split is the most intricate reasoning in the file and the thing that makes
  Android permissions honest.
- `completePng`'s IEND check, `protoString`/`firstString`, `consolePort`, the
  `KEYS` normalisation, and `ConsoleSession`'s OK/KO framing.

**Why they are still untested, which is the part worth writing down.** Testing
them means exporting them, and a backend exporting anything but its one
`platform` object is the rule `CLAUDE.md` sets and a test enforces. So this is a
choice between two rules, and the options are: a `__test` property on the
platform object (ugly, honest, and the fake-backend surface test would need to
know about it); a sibling `android.internals.js` the backend imports and the
test may too; or leaving the arithmetic that once mis-aimed every tap untested.
The second is probably right. It was not done in 0.7.1 because a release fixing
seven confident-wrong-answer bugs is not the place to also restructure a module.

One item on that list is a possible bug rather than a gap: `ConsoleSession`'s
response matcher is unanchored, so an `OK` or `KO` *substring* inside a response
line would terminate the read — an AVD or device model containing those letters
would do it. Too speculative to fix blind; five lines of test would settle it.

### `getPasteboard` exists on the Android backend and cannot be reached
It is on the platform object and has no dispatch wrapper in `platform/index.js`,
so nothing above the boundary can call it, and iOS has no counterpart. It got
there because the surface test checks that every `PLATFORM_SURFACE` member is
*present* on a real backend, and only checks "nothing more than the surface"
against the *fake* one. Harmless today — it exists to make the setter checkable
in development — but it is an asymmetry the tests were meant to catch and
didn't. Either wrap it on both platforms or take it off the object.

### Physical Android devices are filtered out of the listing — decided
`adb devices` lists phones as readily as emulators, and `fetchDevices` listed
whatever it was handed while `ownsUdid` claimed emulator serials only. 0.7.1
filters the listing to emulator serials, so listing and routing agree.

The decision inside that fix: a plugged-in phone is now **invisible** rather
than listed-and-broken. Physical devices are a stated non-goal, and this list
means "devices simframe can drive". The alternative — list it and refuse it with
a clear reason — is friendlier to someone wondering why their phone is missing,
and is the better answer the day physical devices stop being a non-goal. Worth
revisiting then, not before.

A quieter finding rode along with it: the unit test asserting that listing and
routing agree **would have failed** on any machine with an Android phone
attached. It passed everywhere because nobody testing this project had one
plugged in. A test whose result depends on what is plugged into the host is not
a test, and this one had been green for a phase.

## Known and unresolved

### A screen has two identities: one with the tree, one without — decided

Decided while graphs were still cache rather than data, on the principle that
**identity is what the screen is, not which sensor happened to see it** — and
that where the hash cannot deliver that, the graph should.

**The number that decided it.** Measured on four device-native screens, the same
screen read with the accessibility tree and without it:

| | similarity | same hash |
| --- | --- | --- |
| before | 0.300–0.600, median 0.438 | 0/4 |
| after coarsening | 0.333–0.467, median 0.467 | 0/4 |

Coarsening the representation was expected to collapse most of the gap. **It
collapsed almost none of it**, and the reason is worth keeping: the divergence
was predicted to be containers and non-visual nodes, and only 4 of 23 divergent
tokens were. The rest is the two sensors *disagreeing about role for the same
visible element* — the tree says `button` and `heading` where OCR says `text`,
and a search field reads as `slider` to one and `text` to the other. `roleOf`
already mapped every source into one small vocabulary and `source` never entered
the hash, so the cheap half was already done.

That inverts the design: aliasing is not the safety net for a residual, it is
the mechanism. Three parts, all in:

1. **Only what any sensor could see enters identity.** An element with no
   visible footprint, and a container holding two or more others, are both
   things only the tree can report. Worth doing on its own terms; worth almost
   nothing for this problem, as above.
2. **A screen node carries a set of fingerprints.** A reading that matches no
   node is attached to the node an edge predicted, given positive evidence:
   either the tokens overlap by the usual threshold, or the pixels are within
   the same-screen band of what was seen there before. What no longer counts is
   "nothing else claims it" — an absence of evidence, and previously the whole
   test. The transition is evidence the fingerprint cannot supply, which is the
   point: identity belongs to the graph as much as to the hash.
3. **The fingerprint is versioned and stored graphs are discarded, never
   migrated.** `FINGERPRINT_VERSION` travels with every node file and is
   separate from `GRAPH_VERSION` on purpose: not "is this file shaped right" but
   "were these hashes computed by the rules I am about to compare them with". An
   old hash is a well-formed hash that never matches anything — the graph looks
   populated, every prediction misses, and nothing says why. A rebuild costs a
   few hundred milliseconds per screen, once. A mis-merged graph costs a wrong
   tap for as long as the file lives.

**Separation held**, which was the thing that could have made this worse rather
than better. Six-screen tour including the adversarial `settings-general` /
`settings-accessibility` pair:

| | before | after |
| --- | --- | --- |
| same screen, revisited | min 1.00 | min 0.69, median 1.00 |
| different screens | max 0.05 | max 0.05 |
| gap | 0.62 | **0.64** |

The same-screen floor tightened from 1.00 to 0.69 — the price of dropping
tokens — and the gap still widened, with the 0.36 threshold inside it.

### Screens without a nav title are named by their tab bar
`simframe screens` lists one screen as `assets / home / more / •.. / $ /
invoices / work orders` — the whole tab bar, including two OCR misreads, because
that screen has no nav title to name it by. It is addressable and unambiguous,
so `goto` works, but it is not a name anybody would type. A better fallback
would be the label of the *selected* tab, which needs a selected-state signal
the fused element list does not currently carry.

### A screen can legitimately have more than one structure
This is the real cause of the narrow same-screen margin, and Phase 6c's settle
gate does not fix it. One screen reads 8, 17 and 6 tokens on three cold visits
with no transient to wait out: sections arrive from different sources at
different times, and more than one of the results is a genuine settled state of
that screen. Every other screen scores 1.00 against itself.

A threshold cannot express this, because the two structures are as far apart as
two different screens are. What can is letting a node hold **several** accepted
fingerprints — match if the reading agrees with any variant, add a variant when
a confirmed reading arrives at a node reached by a known edge. That keeps
identity exact rather than loosening it, and it is bounded: a screen with three
async sections has a few variants, not unlimited ones.

The alternative — excluding a region that changes between visits — was
considered and is worse: it needs to know which region is async, which is the
same problem again.

Phase 7's CI work added a measurement of how bad this gets on the worst
available case. The iOS springboard carries a live weather widget and a clock,
and over four identical passes the same `home` action read `[ok, unverified]`,
`[ok, ok]`, `[ok, unexpected-screen]`, `[ok, unexpected-screen]` — it never
settles into one shape, and four variants are not enough to hold it. Twelve
graph nodes existed for what is really about three screens.

This is why the CI check asserts that verdicts are *reported honestly* rather
than that they converge: convergence is not something simframe can currently
promise on a screen with live content in it.

### A screen fingerprinted while still loading becomes its own screen
The four-tab tour stores five graph nodes, not four. All five are genuinely
distinct (max pairwise similarity 0.31, well under the 0.45 threshold), so
nothing was wrongly merged; one tab was captured twice in states different
enough to be different screens, almost certainly once before its content
arrived.

This is the safe direction to fail in. A spurious extra screen costs one
re-derivation; a wrong merge costs a tap on the wrong element. But the cause is
structural and worth fixing: `settled` is a *pixel* criterion, and a screen
whose spinner has gone but whose rows have not yet landed is pixel-stable and
structurally sparse. The fix is a structural settle gate — sample the token set
twice a short interval apart and only key on it once it stops growing — which
costs a second perception pass and so needs measuring before it is adopted.
Which of the four tabs produced the extra node has not been isolated.

### The HPI gate's 10% threshold is tighter than the measurement's own noise
`CLAUDE.md` fixes the `bench` gate at ">10% HPI_time regression or any
HPI_accuracy drop". It is implemented exactly that way and it works — verified
by an exit code, not through a pipe. What it did not have when it was decided
is a variance number, and now it does: three runs of identical code on one
device in one afternoon produced `HPI_time` 0.475 (warm), 0.413 (after a
wedge), and 0.406 (freshly restarted). **A 17% spread against a 10%
threshold.** The accuracy half is not affected — it is a ratio of whole runs
and held at 0.5 across both healthy runs.

Two things reduce it without touching the decision, and both are done: the
committed baseline is the *cold* run, since CI boots a fresh simulator every
job, and the gate compares p50s over N=5 rather than single runs. What remains
is the random half, concentrated almost entirely in `settings-larger-text`
(IQR 4591–5803 ms against a 13977–19199 ms median; `contacts-kate-bell` is
stable to ±110 ms in the best run).

Three options if it proves flaky in practice, none of them taken here because
the threshold is not mine to move: widen the time threshold to ~25% and keep
accuracy strict; gate on the flow with the tighter distribution and report the
other; or require the regression to repeat before failing. The first is
probably right — HPI is described in the research as a trend metric, and a
trend does not need a 10% trigger to be visible.

### Two faults found while measuring Phase 10, both fixed or filed
**The escalation recorder shadowed a local `note` string and failed real
flows** — fixed. The recorder was named `note`; the step loop already had a
`note` string for the no-visible-change suffix, so an escalating verdict
called a string and threw `note is not a function` from inside the step's try
block, which the catch turned into a failed step. Every guard against this was
inside the recorder, one scope too deep to help. Three escalation records in
this device's log carry that message and are artifacts; `docs/ESCALATIONS.md`
names them so they cannot steer a phase.

**A device restart leaves a live daemon's HID session dead for taps** — fixed.
After the simulator was restarted mid-session, every tap dispatched
successfully and moved nothing: `tapped "Accessibility" at 201,380 (memory
d=0, via ax) [no visible change]`, correct coordinates, correct element, five
runs in a row. `simframe stop && simframe start` cured it entirely. simframe's
existing input recovery covers hardware buttons only, deliberately, because
retrying a tap can act twice — so a tap has no such path and a whole flow can
fail for a reason that has nothing to do with the flow. The verdict layer
caught it honestly every time, which is the difference between a wrong answer
and a slow one. What would fix it without retrying anything: notice that the
device's boot session changed and rebuild the HID session before the next
action, which is a cheap check against `simctl`'s boot time rather than a
guess about a tap.

**Implemented exactly that, and it needed no `simctl` call at all.** The boot
marker is a `stat`: CoreSimulator writes `data/var/run/syslog.pid` when the
device's syslogd starts and touches `device.plist` on every state change, and
both read the boot second. Android answers the same question from
`/proc/uptime`, so it is a `bootedAt` member on the platform protocol rather
than an iOS special case — and a backend that cannot tell returns null, which
makes the layer above decline to claim staleness at all instead of borrowing
the other platform's vocabulary.

Stale means the device booted after the session was created, where "created" is
the newer of the daemon's `startedAt` and the last recorded rebuild. That
second clock is not decoration: comparing against the daemon's start alone left
`doctor` reporting `stale` about a session it had just rebuilt and that was
demonstrably working, so `resetSession` now writes `input-session.json`.

The session is rebuilt *before* the action and nothing is retried, which is the
whole point: the action is delivered on a session known to be current, where a
retry afterwards is how an action fires twice. Verified by restarting the device
under a running daemon — same pid — then running the four-step Settings flow
that had failed five times in a row: 4/4 steps. `doctor` reports `input session:
stale` with the cause and the manual cure, and `sim_state`/`simframe state`
print `input: stale — …` so an agent sees a cause instead of five silent
no-ops.

One flaw worth knowing: a command that never dispatches input never rebuilds.
`simframe tap "General"` on a screen without a General row throws in `locate`,
before any input, so the session stays stale and the next real action fixes it.
That is the correct order — perception before input — and it means `doctor` can
report stale immediately after a failed command.

Also observed twice in one afternoon: the capture wedge already filed as "only
restarting the device is known to cure it". Both occurrences followed heavy
relaunch cycling, and one followed Simulator.app being quit and reopened. That
is frequency data on an entry that had none.

### The escalation log has two fields that cannot be filled honestly
`tokens_spent` is always null: simframe is on the far side of the model from
whatever counts tokens, and a number derived from output length would be a
guess presented as a measurement. `model_turns_spent` is real — one per
escalation the agent must answer — and `docs/ESCALATIONS.md` states the
definition rather than leaving it to be inferred.

`avoidable_escalation_rate` is 1.0 by construction until a faculty exists: §8
defines avoidable as mapping to a not-yet-built *or under-performing* faculty,
and everything in Phases 11–15 is unbuilt. The only term that moves it is
`outcome: resolved_locally`, which nothing produces before Phase 12. Shipped as
defined, with the degeneracy stated in the doc, rather than redefined to look
meaningful — but it means the per-reason breakdown is the number that decides
phase order, and the rate is decoration until Phase 12 lands.

### The capture wedge: it is the simulator's display, and it often heals
Capture stops with `the display surface could not be read`, the daemon
re-resolves the display port, and every read after that fails identically until
the **device** is restarted. Four occurrences in one session, all during flow
runs that relaunch an app repeatedly. It cost seven flow runs across two
measurements before `scripts/bench-hpi.mjs` learned to abort on it (exit 2, a
different code from a regression, so a CI job can tell them apart).

Two candidate mechanisms, and the honest state of each:

**Answered, and it was neither candidate.** Both were built and measured; the
numbers are in `docs/BENCHMARKS.md` under "The capture wedge, diagnosed".

The display pipeline stops rendering. `simctl io screenshot` on a wedged device
*succeeds* and returns a valid PNG whose 3,162,132 pixels are all black, in
16.2 s — so Apple's own path agrees the screen is black, and simframe's failed
read is an accurate report of it rather than a bug in it. One session's log
holds 223 port re-resolves and 6 device rebinds, none of which cured anything,
and 9 `capture recovered on its own` lines, which is what usually does.

Memory is exonerated. RSS is logged every second now and the shape is a
sawtooth, not a leak: 202 MB to 306 MB under load, 313 MB back down to 265 MB
idle. A few hundred megabytes cannot exhaust a machine with tens of gigabytes.
The `autoreleasepool` the capture loop was missing is in place and did not
change the profile materially; it stays as hygiene.

The third option, degrading to the screenshot engine, is **not worth building
for this**: the screenshot engine reads the same black display. Measuring
before building is what saved that work.

What remains open is smaller and better shaped: a wedged simulator is a
simulator bug, and simframe's job is to name it fast. `doctor` now runs a
screenshot probe on a published stall and says whether the display is black
(the simulator) or readable by simctl while the daemon cannot read the surface
(a simframe bug, worth reporting). What would improve further: notice the black
screen *before* the stall — every frame is already decoded, so an all-black
frame is nearly free to spot — and tell `sim_do` to wait for a likely
self-recovery instead of failing the flow.

### HPI is not gated on hosted CI, and the reason is simctl
The `bench` job runs on every push and cannot yet fail a build for a
regression. Its first run spent nine minutes failing `simctl launch
com.apple.Preferences` — 47 to 55 s per attempt, three attempts, then the same
for Contacts — on a `macos-15` runner with iOS 26.2. That is the fault this
repo already records for `simctl openurl`: simctl operations time out on a
loaded hosted runner, internally, so simframe never sees a failure it could
report.

So `bench-hpi` now exits 2 for "could not measure" and 1 for "got worse", and
the workflow turns 2 into a `::warning` rather than a red build. That is a
weakness stated out loud, not a fix: a gate that only ever warns is not
protecting anything.

Three ways out, in increasing order of cost. Retry the launch inside the bench
script only (never inside simframe — a retried launch is an action that fires
twice, which the verify barrier exists to prevent). Or build the suite out of
actions the integration job has already proven survive a runner: `openUrl`
launches Safari, which every simulator has, and `home` always leaves an app —
but a new flow needs a new human baseline, and the human is the denominator, so
that is a person's afternoon and not a refactor. Or run `bench` on a
self-hosted macOS box, where the device is not shared with a build farm and the
wedge is diagnosable.

Until one of those, HPI is a number this project measures deliberately, on a
known device, and reads as a trend — which is what research §1 said it was for.

### Learned stillness needs an unbiased estimator
Phase 11's adaptive timeout is in and is safe: it can only ever shorten a wait,
and a cold edge keeps the previous fixed default. Learned *stillness* — the
window a screen must hold still before it counts as settled — is the half with
the actual time in it, and the first implementation was reverted for cause.

It made the Settings flow 8.0 s instead of 11.5 s and wrong with it: eight runs
failed at step 2 with the screen still on Settings root, because step 1's
settle returned mid-push, the identity read described the screen we had not
left, and the graph learned `root -> root` as a verified edge and started
predicting it. The bias is structural: the gap statistic comes from what a wait
observed, and a wait that ends early cannot observe the pauses that come after
it, so the window ratchets itself down.

The fix is to estimate from the frame history instead, which holds every
frame's timestamp and diff and therefore the whole transition — including the
part that happened after the settle returned. `baseline.transitionsIn` already
groups a history into transitions with exactly the right rule. Gaps are being
recorded meanwhile and act on nothing.

One consequence worth stating: a wrong stillness window corrupts the graph
rather than merely slowing a flow, so this needs the perception eval harness
before it is trusted with a wait — which is the third phase in a row to want
that harness.

### The eval harness this project keeps needing does not exist — it does now

**Fixed. `scripts/eval-perception.mjs`, 73 expectations, green in CI** (see item
2 in the priority list for why its shape is not the one this entry assumed). The
original text is kept below because it is the record of what four separate fixes
had to settle for in the meantime.

Phase 5's perception eval harness — fifteen screens, three apps — was
unbuilt, and the de-duplication fix wanted it. What that fix got instead: unit
tests carrying the exact frames measured on the Contacts list, the tab-bar
negative case that the old size cap existed to protect, and a re-run of
`scripts/eval-fingerprint.mjs`, which is the nearest thing that exists.
`scripts/eval-ax-tier.mjs` already measures intent resolution over the same
tour and already reported this exact ambiguity as one of its two failures, so
the case is in the data — it is the harness that is missing, not the case.

## Product

### 0.5.1 was tagged and never published, and nothing said so
`v0.5.1` exists as a git tag and a GitHub release. npm's latest is **0.5.0**.
The publish job failed at `npm install -g npm@latest`: Trusted Publishing needs
npm 11.5.1+, the runner was pinned to Node 20, and npm 12 — which shipped some
time after v0.5.0 went out — requires Node 22. `EBADENGINE`, before the publish
step ran. v0.5.0 succeeded only because `npm@latest` was still 11.x that
afternoon.

Two things worth taking from it. A release pipeline that installs `@latest`
anything has a clock in it, and this one went off between two releases a day
apart. And the failure was completely silent from the outside: the tag existed,
the GitHub release existed, and this file asserted for a week that 0.5.1 was on
npm. Nobody checked `npm view`.

Fixed by pinning the publish runner to Node 22. Still open: nothing verifies
after a release that the version actually landed. `npm view simframe version`
against the tag would have caught this the day it happened.

**Resolved.** OIDC Trusted Publishing had never published anything — 0.5.0 went
out on a token, the switch to OIDC landed after it, and v0.5.1 died before
reaching the publish step, so `v0.6.0-rc.1` was the first attempt that actually
reached the registry under OIDC. It was refused because the Trusted Publisher
entry on npmjs.com was not in place; once it was added, the same workflow
published on the next run. The npm-major hypothesis below was wrong.

One more gap closed with it: the workflow now polls until the published version
is resolvable on npm before it registers with the MCP Registry, and fails if it
never becomes resolvable. npm runs an automated review after `npm publish`
exits — the UI says "Validating: the version will remain unavailable until
review completes" — so the registry's own existence check 400'd on a version
that had genuinely just published. The same step is what would have caught
v0.5.1 the day it happened.

### The original diagnosis, kept because it was wrong

**`v0.6.0-rc.1` got further than anything since 0.5.0 and then stopped:**

```
npm notice Publishing to https://registry.npmjs.org/ with tag next and public access
npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm notice publish Provenance statement published to transparency log
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/simframe
npm error 404  The requested resource 'simframe@0.6.0-rc.1' could not be found
               or you do not have permission to access it.
```

Everything up to the registry write worked: the OIDC identity, the provenance
signature, the transparency log entry, the `next` dist-tag. The write itself was
refused. npm answers an unauthenticated write to an existing package with 404
rather than 401, so "not found" here means "no credential npm accepted", not
"no such package".

What that is *not*: a missing Trusted Publisher. `npm view simframe@0.5.0` shows
a SLSA provenance attestation, so 0.5.0 published through this same OIDC path
and the publisher entry works.

What changed between them is the npm major. 0.5.0 went out on npm 11.x; this ran
on npm 12, because the upgrade step installs `@latest` and npm 12 shipped in
between — the same moving dependency that broke v0.5.1, one layer along. The
cheap experiment is to pin `npm@11` on Node 22 and cut another candidate: that
reproduces 0.5.0's conditions with one variable changed. Untested, and named
here as a hypothesis rather than a diagnosis.

**It was the wrong hypothesis, and it was falsifiable in thirty seconds.** The
successful v0.5.0 run has no npm-upgrade step in it at all, and `git show
v0.5.0:.github/workflows/release.yml` shows `NODE_AUTH_TOKEN: secrets.NPM_TOKEN`.
0.5.0 never used OIDC. "What changed between them" was not the npm major — it
was the entire authentication mechanism, and the answer was in the workflow's
own git history rather than in the npm release notes I was reasoning about.
Checking the last success before theorising about the failure would have cost
one command.

Two tags were spent finding this and both are harmless — `v0.6.0-rc.0` was
deleted, `v0.6.0-rc.1` published nothing. npm remains at 0.5.0.

### 0.5.x is published, but only single commands have been run from it
`simframe@0.5.0` is on npm and in the MCP registry, published over GitHub OIDC
with no token anywhere. An independent session installed it and exercised
individual commands, which is how the state-version drift and the `tap <label>`
crash were found. What has *not* been done from the published package is a
multi-step verified flow on a machine that is not the author's — so the numbers
in `docs/BENCHMARKS.md` are all from this working copy.

### The memory-layer harness could not tell a dead device from a broken guard

`scripts/ci-memory.mjs` failed twice on the stale-ref check for reasons that had
nothing to do with refs, and both times it reported the failure as if the guard
were broken.

The check needs to leave a screen before asserting that a ref numbered on it
refuses to resolve. It had two ways to leave — press home, then navigate to
`example.com` — and the second one's destination is where the first one leaves
the device on a run that already happened. Start a run there with `home` not
being delivered (the long-running-simulator device state above) and neither
leaver moves anything. The precondition then failed, and the harness asserted
the guard anyway, producing a false accusation against the one layer the file
exists to defend.

Fixed: four genuinely different destinations, and the guard is only asserted
when the screen actually moved. Also fixed alongside it, from the same run: a
flow that fails outright has no `results` — `--json` reports `{ok:false, error}`
— and reaching into it crashed the harness with a `TypeError`. A check script
whose own failure mode is a stack trace is one more thing to debug at the moment
you can least afford it.

Then four more versions of the same check, each defeated by a different
assumption about where the device was standing:

- A Settings leaver walked *back* to the screen the refs were numbered on, and
  the guard then correctly resolved the ref — which read as the guard failing.
- The precondition passed on `0000000000 -> 10ffffffff`: black, then uniform.
  Two degenerate hashes accepted as proof that the screen changed, in the
  harness whose whole job is testing the guard that exists because pixel hashes
  cannot identify a screen. This project has now learned that lesson three
  times.
- A launch placed immediately before the map read let `settle` return before the
  animation began, so the refs were numbered on a screen still arriving and the
  next command did not recognise where it was. The guard was right; the harness
  had numbered a ghost.
- Folding the positioning launch into the novel-action flow made that check pass
  whenever *the launch* was unverified, whether or not the novel action was. A
  check that passes for the wrong reason is worse than one that fails, because
  nothing ever tells you. It was found by reading, not by a run.

It now pins both ends by name — refs read in one app, then a different app, so
they cannot be the same screen — treats a degenerate hash as evidence of
nothing, and separates "could this be tested" from "was the claim broken".

**Green.** `33/33, exit 0` on a healthy device, which is the first time every
check has passed in one run. Getting there took the harness fixes above *and*
the graph fixes that came out of the 0.6.0 review — a single-observation miss no
longer halts, so the transition-graph section stopped being a coin flip.

The runs before it were all cut short by the device rather than by a check
failing on its merits — two blackouts, a SpringBoard crash, and capture stopping
altogether. Best of those: 32/33 on iOS 18.0 and 32/33 on iOS 26.5, the single
failure each time a device fault the harness correctly reported as one.

That last part is the one thing here that is verified: on the final run the new
precondition check said `FAIL the novel action ran at all — [did not run:
simframe daemon did not produce a frame]` instead of accusing the transition
graph. That is what all of this was for.

Worth stating plainly, because it is a claim about this file's own value: the
stale-ref check has caught **zero** defects in the ref guard and **five** in
itself. Every failure it has produced has been its own assumption or the
device's health. It is not yet earning its place, and the next person to touch
it should weigh deleting it against fixing it a sixth time.

## What a fresh-install session on a real app found

Twenty findings reported across two rounds by a separate 0.9.0 session driving
a third-party app installed from scratch on a clean simulator. The second round
**corrects** the first in one important place and supersedes it in several, so
what follows is the consolidated list — eleven distinct faults, each with what I
could verify of it from here and what was done about it. Where my first
write-up got a diagnosis wrong, the correction is in the entry rather than
quietly replacing it, because the wrong diagnosis is the more instructive half.

The app is not named anywhere in this repo and neither is its bundle id; nothing
below needs either. Every observation is reproducible per the reporter.

The session's own summary of the human comparison is worth keeping at the top:
**much slower than the person doing it by hand.** That is HPI_time on an app
nobody has a baseline for, and it agrees with the suite.

### Status at a glance

| | finding | status |
|---|---|---|
| 0 | Reboot orphans the HID session, silently | **fixed**, both halves |
| 1 | Action-returned maps describe remembered state | age now shown; contents still unauthoritative |
| 2 | `enabled` stale the same way | same cause as 1 |
| 3 | Fuzzy matching guesses instead of asking | mechanism found, filed |
| 4 | Small-delta taps are invisible to the change detector | **measured**, filed |
| 5 | Back chevron undetectable | filed |
| 6 | Ambiguity reported only after the full timeout | filed |
| 7 | OS dialogs invalidate refs mid-batch | working as designed; cost belongs to 8 |
| 8 | `type` pastes, consent dialog eats the first paste | Phase 12 `prep` |
| 9 | `sim_launch` reports success without fronting | filed |
| 10 | `settle` misses slow progress | filed, related to the P0 above |
| 11 | OCR confusables | filed |

### 0. Reboot orphans the HID session, silently — **fixed**

Ranked worst by the reporter and it deserves it: capture kept working, input
died, every tap returned `ok`. About ten calls and two wrong conclusions about
the app went into it.

Two independent faults, both now fixed.

**The gate was keyed on the process.** `ensureFreshSession` held a
`Set` of udids — "once per process, per device" — so the staleness check ran at
the first action and never again. In the CLI that is invisible, because every
command is a new process and per-process is per-call. In the **MCP server** it
is fatal, because that is one process for a whole session, and a device
rebooting *between two actions* is the only situation this feature exists for.
The key is now the boot the rebuild was for (`shouldRebuildSession`), so the
check runs on every dispatch and rebuilds once per device boot — enough that a
failed rebuild does not retry on every tap, not so much that the next boot is
invisible. The check costs two small `readJson`s; `bootedAtCached` already
capped the part that was expensive, which is what made the old gate unnecessary
as well as wrong.

**The printed remedy was wrong twice.** It read "The next action rebuilds it
automatically; simframe stop && simframe start does it now". The first clause
was false exactly where it mattered, per above. The second names a command that
fails twice — `stop` needs `--device` when two simulators are booted, then
refuses because a client holds the daemon — so the sequence that actually works
is `stop --device <udid> --force && start --device <udid>`, as the reporter
found. That is a daemon restart, discarding the frame ring and every warm cache,
to cure a session the daemon can rebuild on request. It simply had no way in
from outside. It does now: **`simframe input reset [--device <udid>]`**, which
is what `doctor` prints.

*What is verified and what is not.* The gate bug is a code-level certainty and
the fix is unit-tested and driven end to end: one process, a tap, a device
reboot mid-process, another tap. After the reboot the old code reports the
session `stale` and the new code reports it `current`. What did **not**
reproduce is input actually dying — the tap worked on both sides, which means
the HID session sometimes survives a reboot here (the capture recovery path
rebinds the device and warms input, which may cure it as a side effect). So
this removes one certain cause of the reported symptom; it is not proof that
the symptom is gone.

### The map answers "which screen", and was asked "what state"

**1. Text-field values are never reported.** *Verified in the code.*
`input.elementToNode` sets `value: e.value ?? null` on every node, and
`src/view.js` contains the string `value` exactly zero times. The data is
collected and then dropped by the renderer. A field holding a long string and a
field holding nothing render identically, so an `assert` on the contents of a
field cannot pass no matter what the field contains — and the observed
consequence was worse than a failed assert: the assert failed, the text was
retyped, and the field ended up with a doubled value and a validation error.
A character counter reading `0/1000` in the map read `56/1000` in the
screenshot, from the same frame.

**2. `enabled` goes stale right after typing.** Reported: the map said a
primary button was disabled while the screenshot showed it enabled. `enabled`
comes from the accessibility tree the same way `value` does, so this may be the
tree lagging a keystroke rather than a simframe cache — unverified from here,
and the reason it is worth its own line is that
`{"assert": {"value": "…", "is": "enabled"}}` reads as a state check and cannot
currently be trusted as one.

**3. Twice the map came back showing the previous screen.** A tap on a login
control reported `no-visible-change` *and* returned a map of the screen it had
left, while the flow's own error text listed strings from the screen it had
arrived at. Two sensors in one response disagreeing about which screen this is,
with the error message right and the map wrong.

Those three are one shape: identity is deliberately memory-first, because a
list with new rows is the same screen and re-perceiving it per step is the cost
Phase 13 exists to remove. State is the exact opposite — a field's contents and
a button's enabled flag are what change *without* the screen changing. The map
does not distinguish the two, and does not say which of what it printed was
observed just now and which was remembered.

### Waiting

**4. `no-visible-change` fires on actions that did work.** Nearly every tap
that started a network call, and taps that opened screens.

**5. `settle` under-detects slow progress.** `mode: settle` timed out as
"nothing moved" while a splash screen sat at 94% of a visible progress
readout — a counter incrementing is motion by any definition a person would
use. Afterwards `mode: change` returned instantly *every* time, usually with
"the change had already happened before this call", which says the transition
completed inside a wait that had reported nothing happening. Phase 11 gave
edges a distribution and a `slower_than_usual`; this is the classifier under
it, and it is the same family as the P0 above — a wait whose evidence is not
tied to the action it is waiting on.

**6. Ambiguity costs the entire timeout.** `waitFor` on an ambiguous string
waited the full 30 s and then reported four matches, all four of which were on
screen in the first frame. The disambiguation message is good — labels,
coordinates, confidence — and arrives twenty-nine seconds after everything it
needed. Ambiguity is knowable on the first frame and should be answered there.

### 4. Small-delta taps are invisible to the change detector — measured

Reported as "radio/segment taps cost ~2.5 s each — invisible to the settle
detector, so it waits out the full timeout every time". Measured here on a
switch in Settings, which is the same class of control:

```
frame diffs across the flip   0.00049  0.00037  0.00025  0.00025  0.00037
changeThreshold                0.004
```

**Eight times below the threshold at its peak.** `changed = diff > 0.004` where
`diff` is the mean absolute difference over a 4×8 grid of gray means, so a
control that repaints a switch, a radio dot, a checkbox or a segment highlight
does not change the screen as far as the daemon is concerned. `analyze.js`
already says so in a comment two lines from the constant: "a moving caret is
~0.3%".

Two consequences and they look nothing like each other, which is why this took
a report plus a measurement to see:

- `mode: settle` never observes `sawChange`, so the wait runs to its budget —
  the reporter's ~2.5 s per tap, on a cold-ish edge.
- Or the P0 above fires first, the settle is satisfied by stillness older than
  the tap, and the step returns in **124 ms** with `[no visible change]`. That
  is what happened here. The same bug, seen through a second bug, reads as its
  opposite.

Either way the verdict is wrong: a toggle that flipped is reported as an action
that did nothing, and `no-visible-change` is one of the verdicts that escalates.

The machinery to see it already exists and is not consulted. `Motion.swift`
builds a per-cell difference map — "Per-cell, not global: a cell either changed
or it did not" — with `cellThreshold = 0.06`, for deciding whether something is
*animating*. Redistribute this switch's 0.00049 mean onto one cell of the 4×8
grid and it is about 0.016, still under 0.06, so this is a calibration question
rather than a wiring one, and calibration on the settle path is what the eval
harness at 1 exists to make safe. Filed, with the number, rather than tuned by
hand.

### 7. OS dialogs invalidate refs mid-batch — working as designed

Reported as a fault and it is the ref guard doing its job. A dialog is a
different screen, `resolveRef` compares the structural hash the numbers were
assigned under against the one on screen, and refuses: "#4 was numbered on a
different screen (a1b2c3d4 → e5f6a7b8) — read the screen again before using
refs". Guessing would tap whatever now sits at those coordinates, on a dialog,
which is the worst place to do it.

So nothing to fix here, and the cost is real and belongs to 8 below: the batch
dies partway because a dialog appeared that should never have been there. Two
things would remove it — `prep` granting the consent up front, and a reflex
dismissing what still arrives. Both are Phase 12. Recorded here so it does not
get "fixed" by loosening the one guard that stops a ref tapping a dialog.

### Label resolution, which is the one that can do damage

**7. A bottom tab was tapped into the wrong screen.** The tab's label was
missing from the map, the resolver reached `memory d=6` into a *list row* whose
text contained the query as a substring, tapped it, and opened an unrelated
record. It did not report ambiguity. The only thing that caught it was the
operator's own `assert` on the next line.

**8. The nav-bar back chevron is invisible.** Absent from the map, absent with
`all: true`, and `sim_find` on a plain-language description of it returned "not
on this screen". `@29,91` worked first try, every time. Detection is
inconsistent rather than absent: a send-arrow glyph was picked up as OCR text
`>`, and one later map did list a bare `<`.

**9. And `type into "Search"` typed into a section-index letter** — found here,
same session as Phase 11 step 4, mechanism in 7 above.

`sim_find`'s own description promises, in one sentence: `"the Assets tab"`,
`"back"`, "icon-only controls by their common name", and "when two things
answer equally well it says so and lists them rather than guessing — a wrong
tap is worse than a question". Findings 7, 8 and 9 are counterexamples to all
four, and two of them are the description's own examples. Either the resolver
grows into the promise or the description stops making it; a tool description
is the only contract an agent reads before acting.

The practical rule the session arrived at — *for bottom-tab navigation use
coordinates or `#N`, never the label* — is itself the bug report. A tool whose
users learn to avoid its main interface has a working alternative and a broken
primary.

### The clean-device dialogs, which Phase 12 anticipated

**10.** A fresh install adds two OS dialogs a pre-warmed device does not have.
The pasteboard consent alert **swallowed the first paste entirely** — `type`
pastes, so this hits the most common step there is — and the notifications
prompt sat over the home screen and blocked a `waitFor` on content behind it.
Neither appears on the device the suite runs on, which is why the suite has
never seen them. This is exactly `simframe prep` plus the reflex table from
Phase 12, now measured rather than anticipated, and it argues for `prep`
running by default on a device simframe has not seen before.

**11. `sim_launch` on an already-running app reports success without fronting
it.** Twice returned "launched · settled" with a different app in the
foreground. One of the two was before any other session touched the device, so
contention does not explain it.

### OCR, minor but worth the note

`(All)` reads back as `(AII)` and a section heading came through as `=x`.
Capital-I against lowercase-l with language correction deliberately off, which
is the right setting for labels and the wrong one for exactly this. A
confusable-character pass on comparison — not on display — would cost nothing.

### And the wedge, on a second device

The reporter saw the screen black out after some steps on their own simulator.
The capture wedge is therefore not specific to the bench device, which is
consistent with it being the simulator's display pipeline rather than
simframe's use of it. See P4 below.

### Four fixes the reporter proposed that are better than mine

Read out of their full session notes, which I had filed only the *findings*
from. Each is a mechanism rather than a complaint, and three of them are now
cheaper than when they were written.

- **The matcher does not use regions, and the map already knows them.** An
  intent naming a *tab* resolved into a content-region list row. Region is
  already computed for every element and printed in every map; the ranker
  ignores it. "A tab intent should not resolve to a content row" is a rule with
  no new data behind it, and it is a second, independent guard on the failure
  that item 4 fixed by score alone.
- **A distance ceiling on screen-memory matches.** The wrong tap came from
  `memory d=6` — a recalled map six bits of layout hash away, which then
  answered a query the live screen would not have. There is no ceiling past
  which a memory match declines to act; there should be.
- **Re-read once when a selector misses.** A miss is the single moment the cache
  is most likely to be wrong, and it is when we currently trust it hardest: a
  tap failed in **23 ms** against a remembered screen while a screenshot from
  one call earlier showed the target plainly. One re-read on miss converts the
  worst failure mode into a cost of one perception pass.
- **Verify small-delta taps against the accessibility state, not the
  framebuffer.** Their number for this: every radio and segment tap cost
  ~2.5 s of dead wait, and *pickers are radio lists, forms are pickers*. This
  was not actionable when written, because the tree's state never reached the
  map — item 5 fixed that today, so a tap on a control whose `value` or
  `selected` can be re-read no longer needs the framebuffer to move at all.
  Probably the single largest HPI_time item now on this list.

### What it cost, measured by the reporter

Setting one dropdown value: **13.8 s over five steps** — 2.5 s of dead wait on
the small-delta tap, 3.3 s of the agent's own defensive padding, 1 s on an image
taken only because the map could not be trusted, and 2.8 s of genuine app work.
The form has three such dropdowns. Two other measured sequences show the same
shape: 18.5 s and 16.4 s, each containing a 2.55 s radio tap that did nothing.

Their fourth point is about themselves and worth keeping: the padding is a
*reflex* an agent develops after being burned by stale reads. Fix the staleness
and the padding goes away on its own — which makes item 5 worth more than its
own line suggests.

### What worked

Recorded because a findings list with nothing in this section is not a report,
it is a complaint: index disambiguation once passed explicitly, `waitFor` on a
real string, coordinate selectors, `sim_look` at high detail (readable every
time), and the flow-level abort — a failed assert on an empty field is the only
reason the session did not tap a disabled control and then chase a phantom bug
in the app.
