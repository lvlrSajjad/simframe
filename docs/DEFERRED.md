# Deferred work

Things consciously left undone, with the reason. Each was cheap to note and
would be expensive to rediscover. Nothing here is a bug; bugs get fixed or filed
as such.

Ordered by how much it would hurt to keep ignoring.

## Correctness

### Region bands are positional, and that is now three bugs

`src/regions.js` decides what is chrome by fraction of screen height. The
tab-bar band starts at 0.92 with 0.06 of slack, so anything short whose top sits
past y = 0.86 × height is a tab item. On an 874-point screen that is everything
below y = 751 — which on a list screen is the last two rows.

Because chrome labels are the only text that enters a fingerprint, every
misclassification lands directly in a screen's identity. Three phases have paid
for it:

- **6b** — a nav button read as a title, and a date banner in the tab band.
- **6d** — a screen whose identity contained `"sep 08, 2026"`. It would have
  become a different screen at midnight, breaking every stored map, node and
  route touching it overnight, and nothing would have flagged it: the
  fingerprint was perfectly stable, just stable on something that expires.
- **7** — dumping the structural tokens of all twenty learned screens found
  three still carrying content: a store address, a phone number, and a nav title
  reading `"tuesday, september 8"`.

Each was patched with another rule — a nav-slot token, a tab-label width limit,
and now a volatile-label test (a date, a time, a price or a bare count is a
value, not a name). The rules are individually defensible and collectively a
smell. One case from Phase 7 survives all three: a stable-looking store address
in a misfiled list row, wrong for a reason no text pattern can see.

The fix is to derive the bands from the elements' own geometry — a nav bar is a
short row of things at the top with a gap under it, not a fraction — per screen
rather than per HIG.

What makes it non-trivial: the bands feed the fingerprint, so changing them
invalidates every learned graph and re-opens the same-screen / different-screen
distributions 6b measured at 0/62/74/85. It needs the fingerprint eval harness
re-run either side of the change, not a hand check.


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

### The accessibility tree still comes from idb
(And until today, so did two other things. See below.)
The last idb dependency. Most of the hard part is done and recorded: a host-side
bridge that resolves the frontmost application works. See **Phase 2b** in
`docs/PHASES.md`.

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
  turn "it works on the screens I tried" into a recall number — and which
  Phase 2b's scheduling is supposed to depend on.

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

### 0.5.x is published, but only single commands have been run from it
`simframe@0.5.1` is on npm and in the MCP registry, published over GitHub OIDC
with no token anywhere. An independent session installed it and exercised
individual commands, which is how the state-version drift and the `tap <label>`
crash were found. What has *not* been done from the published package is a
multi-step verified flow on a machine that is not the author's — so the numbers
in `docs/BENCHMARKS.md` are all from this working copy.
