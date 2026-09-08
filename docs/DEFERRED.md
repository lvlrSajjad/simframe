# Deferred work

Things consciously left undone, with the reason. Each was cheap to note and
would be expensive to rediscover. Nothing here is a bug; bugs get fixed or filed
as such.

Ordered by how much it would hurt to keep ignoring.

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

### The capture loop's recovery path has no test
A display port torn down under a live daemon left capture dead for six minutes
until the process was restarted (see `docs/BENCHMARKS.md`). The fix re-resolves
the port after six consecutive failed reads, and it is unverified: a teardown
cannot be induced on demand, and the loop is inline in `main.swift` rather than
factored into a function a stub platform can drive.

`StubPlatform` already counts `reattachDisplay()` calls, so the missing piece is
extracting the loop body — a `captureOnce(platform:store:) -> Result` — and
driving it with a stub whose `withFrame` throws on demand. Worth doing the next
time that file is opened, because the recovery path only ever runs in the
situation nobody is watching.

### Fixed sleeps in `actions.js`
`sim_wait` and the settle gate defer to the daemon's real settle detector, but
individual step types in `src/actions.js` still carry fixed sleeps. Removing them
touches every step and deserves its own pass rather than being folded into a
phase about something else.

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

## Known and unresolved

### The layout hash fingerprints pixels, and content is pixels
**This was the "unexplained variance", and it is now measured.** Across four
visits to each of five screens: a revisit is usually identical (median 0 bits)
but the tail reaches **62** when list content has changed, while different
screens sit at **74** and above.

The first calibration saw 0-3 against 77-96 and chose a tolerance of 12. That
was measured on screens whose content happened to be stable, and it is not
representative. The real margin is 62 against 74, which is narrow enough that no
threshold separates the two cleanly.

The tolerance is 20: it covers ordinary drift and leaves the tail to rebuild,
because a rebuild costs about 300ms and a false match taps the wrong control.

The fix is not a better threshold. It is to fingerprint **structure** rather
than pixels — the research calls for "dHash of structure + role histogram", and
the element map that would come from is already built. A fingerprint over
element roles and positions is content-independent by construction, and would
make both screen memory and the transition graph stable on exactly the screens
where they are weakest today. **Done** — Phase 6b replaced pixel identity with a
structural fingerprint, and Phase 6d added variants for screens with more than
one settled structure. Kept here because the reasoning is the record of why
pixel identity failed.

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

**Still open: a green end-to-end run.** Every attempt since the fixes has been
cut short by the device rather than by a check failing on its merits — two
blackouts, a SpringBoard crash, and finally capture stopping altogether
("the display surface could not be read", the re-resolve firing and the port
dying again immediately). Best runs so far: **32/33 on iOS 18.0** and **32/33 on
iOS 26.5**, with the single failure in each case a device fault the harness
correctly reported as a device fault.

That last part is the one thing here that is verified: on the final run the new
precondition check said `FAIL the novel action ran at all — [did not run:
simframe daemon did not produce a frame]` instead of accusing the transition
graph. That is what all of this was for.

Worth stating plainly, because it is a claim about this file's own value: the
stale-ref check has caught **zero** defects in the ref guard and **five** in
itself. Every failure it has produced has been its own assumption or the
device's health. It is not yet earning its place, and the next person to touch
it should weigh deleting it against fixing it a sixth time.
