---
name: simframe
description: Drive and inspect the iOS Simulator or an Android emulator with eyes, hands and memory. Use for any task that involves running, testing, navigating or verifying an app on a simulator or emulator — "does this screen look right", "tap through the signup flow", "why is this button not working", "is the list loading". Reads screens as text rather than screenshots, batches whole flows into one command, and verifies each step against what it did last time.
---

# simframe

A background daemon keeps the device's framebuffer warm, reads the screen
through the accessibility tree and on-device OCR, and remembers which action
leads from which screen to which. So the three things that make simulator work
expensive — waiting for screenshots, spending tokens on images, and re-deriving
the same screen every time — are already paid for.

Both an iOS simulator and an Android emulator are driven the same way, by the
same commands, and `simframe devices` lists both. The one difference worth
knowing: **Android has no accessibility tree**, so its screens are read by OCR
and CV alone. Tapping by label works; screen recognition is thinner, so prefer
naming a device explicitly and re-reading the screen after a step you are unsure
about.

## The protocol: plan once, execute once, think only when told to

The expensive thing in a simulator session is not the tapping. It is you —
observe, think, tap, observe, think. Measured over a real session: 62 tool
calls for 179 steps, and 48 of those calls were three steps or fewer. A
twelve-step flow arrived as five calls, and every boundary between them was a
think that nothing had asked for.

So the protocol is four steps, and step 4 is the one that saves the time.

1. **State the goal, then read the screen once.** `simframe ui`, or `sim_find`
   if you doubt a selector will resolve. Once — not per step.
2. **Write the entire flow as one `sim_do`**, with an assert after each step
   whose success you would otherwise have checked by looking.
3. **Run it. Read only the verdict line per step.**
4. **Think again only when the result tells you to.** Every action result ends
   with a `next:` line the daemon computed locally, and it says which case you
   are in:

   - `next: settled; screen known (…); N elements; nothing ambiguous — chain the
     next steps in one sim_do without looking again` → **do not look. Act.**
   - `next: new screen, nothing predicted here yet` → read it before acting on a
     label you have not seen on it.
   - `next: N labels repeat on this screen` → address those by `#ref`.
   - `next: the flow stopped here` → this is the moment to think.
   - `worked here before: tap "…" (7x)` → the graph's own vocabulary for this
     screen, most-used first. It is evidence for writing a chain, not an
     instruction: the most-tapped control on a screen is often what earlier runs
     used to *back out*.
   - `memory disagrees with this screen: N remembered controls not present` →
     two screens share one fingerprint. Trust the element list, not the graph,
     and re-read before anything irreversible.

**Do not** narrate each step, re-read the screen after every action, or use
extended thinking inside a flow. The flow is already planned; executing it is
not a decision.

### Recovering without a round trip

Three things let a batch survive a problem instead of handing it back. Every one
of them exists because a real run lost a call to the thing it prevents.

**Fallback selectors.** `{"tap": "Save", "or": ["Done", "Confirm"]}` — tried
locally, in order, and only an exhausted list reaches you. Eligible after a
selector that did not *resolve*, and nothing else: retrying from a screen you did
not expect to be on is a second guess, not a retry. simframe refuses to
substitute a label that looks destructive even when you list it.

They are a cure for *"I named it wrong"*, and most real failures are *"it is not
there yet"* — so when everything in an `or` chain misses and the screen has only
just stopped moving, the failure says so. Reach for `waitFor` there, not for more
labels.

**`{"seek": "change username", "budget": 6}`** looks for something that is not on
this screen: it opens containers, checks, and comes back, depth first.

It **acts** — opening a door changes state — and it refuses to open anything that
commits, abandons or answers. It once opened `CANCEL` and pressed *"YES, THIS
FIXED MY PROBLEM"*, which is why that sentence is here. It does not tap the
target: it leaves you on the screen where the target resolves, and returns to
where it started if it fails. **Do not point it into a flow whose progress you
cannot afford to lose.**

**`sweep` — read and fill a long screen.** A viewport is the only honest unit:
the tree publishes what is rendered, so a form taller than the screen is knowable
only in pieces.

```json
{"sweep": "all", "fill": {"Last Name": "Asadi", "Email": "a@b.c", "Comment": "…"}}
```

It goes to the top, then reads section by section to the bottom, filling each
field **while it is on screen** — which beats finding a field and then trying to
scroll back to it, because one gesture travels a non-deterministic distance.
`{"from": "here"}` sweeps down from where you are. `{"sweep": "<text>"}` stops as
soon as it finds that text. It reports which section each element was in, what it
filled, and what it never found at any scroll position.

Prefer it to `scrollTo` on any form or long list. `scrollTo` hunts one label and
cannot work when the label is not yet rendered; a sweep covers the screen.

**The local supervisor**, when one is enabled, decides whether a failed step
should `wait`, `retry` or `stop` — before the failure reaches you. It knows
nothing about the app and you do, so brief it from the plan:

```json
{"supervisor": "apple",
 "supervise": "Lists here render a count header before their rows, so a missing row usually means waiting.",
 "steps": [{"tap": "Ceiling", "expect": "the asset list arrives after a count header"}]}
```

A `stop` names the steps it did not attempt. If the ruling was wrong, re-issue
them with a corrected `supervise` note. It is off unless asked for, and **not yet
proven in the field** — measured on a bench, not on a real run.

### Two things that answer a question a screenshot would

**Waiting for either of two outcomes.** A login screen *or* a dashboard is a
disjunction, and asking for it as one intent asks the matcher for something no
single element answers — one agent spent 120 seconds that way while the login
screen was already there.

```json
{"waitFor": {"any": ["Email", "Dashboard"]}}
```

**A region of the screen, enlarged.** `sim_look` caps at 1024px on the long edge,
which cannot tell a selected chip from an unselected one. `region` is in points —
the same coordinates the map prints — and the crop gets the whole budget, so the
detail per point is the reason to ask:

```json
{"device": "…", "detail": "high", "region": {"x": 18, "y": 260, "width": 366, "height": 80}}
```

Reach for it when the question is *selected or not*, *is there a chevron*, *is
that a validation mark* — the cases text genuinely cannot answer. Not for what a
field contains or whether a button is enabled; `sim_ui` reports both.

### Anything network-backed: `waitFor`, never `settle`

`settle` asks whether the screen has stopped moving. A screen waiting on a
network call has stopped moving — it is perfectly still and completely empty —
so `settle` reports success and you act on a list that has not arrived. This
happened in a real session and cost several calls before the cause was found:
the settle said settled, the map showed an empty content region, and nothing
distinguished *empty* from *still loading*.

So for anything that has to come over the network — a list, a search result, a
login, a screen after a submit — assert on the **content you expect**, not on
stillness:

```json
{"waitFor": {"value": "Kate Bell", "timeoutMs": 8000}}
```

`settle` is right for a local transition: a push, a modal, a tab switch. Two
signals now help you tell the difference without guessing. The map header says
`STILL LOADING` when the transition classifier can see a load in progress, and
the `next:` line says the same in words — *an empty-looking region may be a list
that has not arrived*. Neither is a substitute for asserting on the string you
are waiting for, which is the only check that knows what "arrived" means.

### A six-step flow in two model turns

```bash
simframe ui                                     # turn 1: look once
```
```bash
simframe do '[                                  # turn 2: everything else
  {"launch": {"value": "com.example.app"}},
  {"tap": "Sign in"},
  {"type": {"into": "Email", "text": "a@b.com"}},
  {"type": {"into": "Password", "text": "hunter2"}},
  {"assert": {"value": "Sign in", "is": "enabled"}},
  {"tap": "Sign in"},
  {"waitFor": {"value": "Inbox", "timeoutMs": 8000}}
]'
```

Seven steps, one call. The asserts are what make it safe to not look between
them: if the email did not land, the `assert` halts the flow at that step rather
than letting the next four run against a screen you were wrong about.

### Recovering from `unexpected-screen`, without starting over

```
FLOW FAILED — 2/5 steps in 3184ms
  ok   [0] tap: tapped "Assets" at 62,835 · settled in 412ms
  FAIL [1] tap: unexpected-screen: expected the screen this action reached 3x
       before, and landed somewhere else
next: the flow stopped here — this is the moment to think. sim_recall shows how
you got here; sim_ui re-reads the screen.
```

That verdict is the tool doing its job: it stopped instead of running three more
taps on a screen you did not plan for. Recover in two calls, not ten:

```bash
simframe recall            # what happened, as text — not a screenshot
simframe ui                # where you actually are
```

Then write the *remaining* steps as one new `sim_do`. Do not re-run the steps
that already succeeded, and do not switch to single taps "to be careful" —
single taps are the expensive mode, and the asserts are what make batching safe.

## Read the screen as text, not as an image

```bash
simframe ui
```

```
iPhone 17 Pro · 402x874pt · screen a1b2c3d4 "Inbox" (known, 3 known exits)
nav-bar:
  #1 button    24,64      Back
  #2 text      201,64     Inbox
content:
  #3 cell      201,140    Weekly digest
  #4 cell      201,196    Payment received
tab-bar:
  #5 text      62,835     Inbox
  #6 text      201,835    Settings
```

That is the whole screen: region, a number, type, tap point in points, label.
Measured against the same screen as an image: **~460 tokens of text versus
~1,600 for a correctly-handled image**, and 10–40× worse than that if the MCP
image path degrades to base64-as-text. The text also says what is *tappable*
and where, which an image does not.

The numbers are selectors, and so are the labels beside them. Act by **name** —
whatever `ui` calls `Weekly digest`, you can tap as `"Weekly digest"`. A `#3`
is exact but only until the screen moves; see Selectors below for why that
order is a correction rather than a preference.

**Reach for an image only when the text genuinely cannot answer the question:**
visual layout, colour, spacing, an animation, or something neither the
accessibility tree nor OCR can see. Then `simframe frame --out=/tmp/s.png`, or
`sim_look` over MCP.

## Run the whole flow in one command

One command, not one per tap. Each step waits for the screen to settle against
a baseline captured *before* it, so steps cannot race the UI.

```bash
cat > /tmp/flow.json <<'JSON'
[{"tap": "Inbox tab"},
 {"assert": {"value": "Weekly digest", "is": "visible"}},
 {"tap": "Weekly digest"},
 {"type": {"into": "Reply", "text": "on it"}},
 {"scrollTo": "Send"},
 {"tap": "Send"},
 {"waitFor": {"value": "Sent", "timeoutMs": 5000}}]
JSON
simframe do /tmp/flow.json
```

Steps stop at the first failure and say which step and why. Measured: **a
10-step flow is one command, ~5 seconds, ~460 tokens, zero images.**

Steps — every place a control is named accepts a selector:

| Act | Check |
| --- | --- |
| `{"tap": "Save"}` · add `"index"` if a label is ambiguous | `{"assert": {"value": "Saved", "is": "visible"}}` |
| `{"type": {"into": "Name", "text": "..."}}` — drop `into` to type into whatever already has focus | `is`: `visible` · `gone` · `enabled` · `disabled` · `value` (with `equals`) |
| `{"paste": {"into": "Notes", "text": "long text"}}` | `{"waitFor": {"value": "Saved", "timeoutMs": 5000}}` |
| `{"scroll": "down"}` · `{"scrollTo": "Delete account"}` | `{"settle": {"stableMs": 600}}` |
| `{"swipe": {"from": [x,y], "to": [x,y]}}` | `{"pause": 300}` |
| `{"button": "HOME"}` — hardware buttons | |
| `{"key": "return"}` — the **keyboard** return key, which is how a mobile search field submits. Also `escape`, `tab`, `space`, `backspace`, arrows | |
| `{"clear": "Notes"}` — empty a field. Add `"clear": true` to a `type`/`paste` to **replace** rather than append | |
| `{"launch": {"value": "com.example.app", "relaunch": true, "args": ["-uiTest","1"]}}` | |
| `{"openUrl": "myapp://path"}` | |
| `{"permission": {"value": "photos", "grant": "grant", "bundleId": "com.example.app"}}` | |

## Selectors

| | |
| --- | --- |
| `"Save"` · `the Assets tab` · `back` | **start here.** Resolved by intent — verbs, typos, synonyms, icon-only controls by their common name |
| `#3` | the number `simframe ui` gave it. Cheap and exact, but only within the round trip that numbered it |
| `@120,400` | raw point coordinates. Last resort; it cannot tell you it missed. |

**Prefer a label to a number**, and this order is a correction. Four peer rounds
in a row reported the same thing: intent resolution worked every time, including
on labels a string matcher should not have managed, while refs renumbered
constantly and were safe only inside a single round trip. The table used to lead
with `#3` and call it "cheapest and unambiguous", which sent every one of them
down the more brittle path first.

A ref is valid only while that screen is showing. Use one on a different screen
and it refuses rather than tapping whatever now sits at those coordinates — and
the refusal names the label the number was given to, so re-issuing it by label
costs nothing. A refusal that says the screen *moved* rather than *changed* is
reporting pixel drift, not a different screen; it says which.

## Lines that mean the tool is unsure, and what to do about each

These exist because three peer rounds in one day all reported the same class of
bug: a component answering confidently when it could not know. Each line below is
a place that now says so instead. None of them is decoration — if you see one,
the next call should change.

| line | what it means |
| --- | --- |
| `[unconfirmed — nothing on this screen reads back the field's contents]` | the text was sent and **nothing verified it landed**. Common on web views, where the accessibility tree carries no field contents. Re-read, or `assert` the value |
| `a value simframe wrote here is gone: …` | a field simframe filled is on screen and its contents are not. Something cleared it — a reload, a pull-to-refresh, a navigation. Re-fill before continuing |
| `N element(s) on this screen overlap and disagree about what is there` | a sheet or overlay is probably covering the screen behind it, and some elements belong to the layer underneath |
| `WARNING: this image is Ns older than the screen state` | the picture is very likely not what is on the device. Use `sim_ui`, which is read live |
| `#N cannot be trusted here — … layout distance D, tolerance T` | pixel drift, **not** a different screen. The identity may be unchanged; re-issue by label |
| `#N cannot be trusted here — … this is a different screen` | the screen really did change. Read it again |
| `autoSettle was off, so the map below was read without waiting` | the map may describe the screen *before* the last action landed |
| `"iPhone 17 Pro" names more than one booted device` | a name cannot identify which device answered. Pass `device` with a UDID |

## Every step is verified, and the verdict means something

simframe records which action led from which screen to which, so it can check
each step against what that action did here last time.

| Verdict | What it means | What to do |
| --- | --- | --- |
| `ok` | landed where this action has landed before | nothing |
| `unverified` | this action has not been taken on this screen before | nothing — it is learning. Run the flow again and it becomes `ok`. |
| `no-visible-change` | the screen is stable and nothing moved | the tap may have missed, or its effect may be invisible (a checkbox, a button state). Check with `simframe ui`, not by waiting longer. |
| `unexpected-screen` | it went somewhere it has not gone before from here | the flow **stops here**. Read the map it returns: either the app changed, or the tap hit the wrong thing. |

A first run through a new part of an app is mostly `unverified`, and a
transition-kind mismatch is reported inside `ok` rather than failing — that
classifier is noisy and a verdict that cries wolf teaches you to ignore
verdicts.

## Navigate by memory

Once simframe has been somewhere, getting back is a search over remembered
transitions — no reasoning, no images.

```bash
simframe screens                 # what it knows, and how many exits each has
simframe goto "Settings"         # plan a route and walk it, verifying each step
simframe do /tmp/flow.json --save=checkout   # save it if every step verified
simframe flow run checkout       # replay it
```

`goto` refuses rather than guesses. Unknown screen, a name that fits two
screens equally, no remembered path — each is reported, with what it does know.
A wrong route is worse than no route, because it taps things.

## It refuses rather than guesses

When two controls answer a query equally well, simframe lists them and asks
instead of picking. That is deliberate: a wrong tap can *do something* and
leave you believing it did the right thing. Pass `index`, or use a `#ref`.

## Everything speaks JSON

`--json` is on every command, so nothing has to be parsed out of prose:

```bash
simframe ui --json | jq '.elements[] | select(.type=="button") | .label'
simframe do /tmp/flow.json --json | jq '.results[] | select(.ok==false)'
```

## The cheap-to-expensive order

1. `simframe state` — has anything changed at all? Cheapest thing there is.
2. `simframe ui` — what is on screen and what can I tap? Text.
3. `simframe do` — act, in a batch, with asserts inside the batch.
4. `simframe frame` / `sim_look` — pixels. Only for a question about pixels.

A screenshot is about 1600 tokens and it is the most expensive call here. Before
reaching for one, check it is not a question the text already answers: a map row
carries the element's **contents** (`= Fryer 3`) and its **state** (`disabled`),
and the flow's own verdict already said whether the action worked. Those three
account for nearly every screenshot taken in the session that was measured —
28 of 62 calls returned an image, about a third of that session's entire token
cost.

## One goal per session

A session gets slower with every turn: more context to carry, and later turns
run measurably longer than early ones. Where you can, give one test goal its own
session and finish it. `sim_do` is what keeps a session short — a flow that runs
as one call adds one exchange to the context instead of twelve.

## When something is wrong with simframe itself

```bash
simframe doctor           # capture engine, input driver, a11y, OCR — each honestly
simframe doctor --strict  # any degraded layer is a non-zero exit
```

simframe falls back when it must — the simctl capture loop instead of the
daemon, idb instead of the in-process input and accessibility paths — but it
never falls back quietly. If
`doctor` says a layer is degraded, believe it: the numbers above assume the
daemon.

## Other commands

```bash
simframe start [device]     # capture starts on first use anyway
simframe devices            # booted simulators and emulators
simframe recall             # what happened in the last ~60s, as text
simframe strip              # recent frames tiled into one image, for an animation
simframe find "the save button"   # resolve an intent without acting on it
simframe wait --mode=settle       # block until the screen stops reacting
```

`recall` matters more than it looks: if you look up and the screen is already
different, it tells you what happened and when, instead of you re-running the
action to find out.
