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

### Confirm vocabulary is English
`APPLY`, `OK`, `SAVE`, `DONE` and friends are hardcoded. A localised UI needs
them extended, and the same applies to the synonym table Phase 5 introduces.

## Unexplained

### Screen-memory hit rate varies more than it should
Phase 3's flow saw 1/1/2 of four controls resolved from memory where earlier runs
saw 1/3/4. The app was mid-load on the first pass and its list screens carry live
data, so it is probably that — but it was not isolated, so it is not known to be
fine. Phase 4's settle detector should improve it; if it does not, this is worth
a proper look before Phase 6 builds a transition graph on top of the same keys.

## Product

### The published npm package is behind
`simframe@0.4.2` on npm predates the entire Swift rebuild. Everything from
Phase 0 onwards is GitHub-only. Publishing should wait until the daemon has been
run by someone other than its author, but the gap should not be forgotten — the
README on npm describes a tool the package does not contain.
