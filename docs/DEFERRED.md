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
2. The iOS a11y tier's hit rate is measured and shows what Android is losing.
   Phase 2a has already landed, so this is a measurement waiting to be taken
   rather than a phase waiting to happen: instrument how often the tree
   contributes an element OCR+CV missed, per screen, across the tours. If that
   number is small on iOS, Android is losing little.

**The shape, when the time comes**, is the one every serious Android driver
converged on — uiautomator2, Maestro and Appium all do the same thing: a tiny
instrumentation APK, built from source in `native/android/`, debug-signed,
installed by the daemon over `adb` on first use, holding a `UiAutomation`
connection open and serving the tree over a local socket. It is a runtime
artifact, but it is ours, it is built from source in this repo, and it is
automatic. The promise change is "simframe puts a helper on your emulator" —
an honest sentence to add to the README on the day it is true, and not before.

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
`streamScreenshot` is the streaming capture path if 21 ms per frame ever stops
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

### There is no *adb* path to the Android clipboard — but there is a gRPC one
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

Two things to settle first: whether the gRPC endpoint wants a token (there is an
`emulator_access.json` beside the protos), and whether the port is discoverable
without parsing `lsof` — 8554 is the documented default and is what this machine
uses, but a second emulator will not be on it.

### Android input is measured and unwired
The emulator console's `event mouse <x> <y> 0 1` / `... 0 0` puts a real
down-and-up on the touch screen — verified by the screen changing — in about
20 ms, host-side, with no adb and no dependency. That is the Android equivalent
of Indigo HID, including the ability to write real down→move→up sequences with
honest timing rather than teleporting taps, and `event text` types.

It is deliberately not wired yet: input belongs to the same step as the control
socket and the gesture vocabulary, and landing half of it would mean `sim_tap`
existing on Android while `swipe` and `key` did not. Phase 8's next step.

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
