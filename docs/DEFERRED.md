# Deferred work

Things consciously left undone, with the reason. Each was cheap to note and
would be expensive to rediscover. Nothing here is a bug; bugs get fixed or filed
as such.

Ordered by how much it would hurt to keep ignoring.

## Correctness

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

### No integration coverage in CI
All 22 Swift and 34 Node tests are pure functions. Nothing exercises the daemon,
the control socket, OCR or input, because hosted runners have no booted
simulator. Everything involving a device has been verified by hand, once, on one
machine. A self-hosted runner or a scripted boot would change that.

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
where they are weakest today. This is the single highest-value item in this
file.

### Phase 6 left graph-assisted navigation unbuilt
`simframe goto "<screen>"` and flow save/replay are specified in
`docs/PHASES.md` and not implemented. Phase 6b removed the blocker — the
structural fingerprint separates same from different screens with a clear gap
(`docs/BENCHMARKS.md`) — so these are now blocked on effort alone.

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

### The published npm package is behind
`simframe@0.4.2` on npm predates the entire Swift rebuild. Everything from
Phase 0 onwards is GitHub-only. Publishing should wait until the daemon has been
run by someone other than its author, but the gap should not be forgotten — the
README on npm describes a tool the package does not contain.
