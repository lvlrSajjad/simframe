---
name: simframe
description: Drive and inspect the iOS Simulator with eyes, hands and memory. Use for any task that involves running, testing, navigating or verifying an iOS app on a simulator — "does this screen look right", "tap through the signup flow", "why is this button not working", "is the list loading". Reads screens as text rather than screenshots, batches whole flows into one command, and verifies each step against what it did last time.
---

# simframe

A background daemon keeps the simulator's framebuffer warm, reads the screen
through the accessibility tree and on-device OCR, and remembers which action
leads from which screen to which. So the three things that make simulator work
expensive — waiting for screenshots, spending tokens on images, and re-deriving
the same screen every time — are already paid for.

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

The numbers are selectors. Whatever `ui` calls `#3`, you can tap as `#3`.

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
 {"tap": "#3"},
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
| `{"type": {"into": "Name", "text": "..."}}` | `is`: `visible` · `gone` · `enabled` · `disabled` · `value` (with `equals`) |
| `{"paste": {"into": "Notes", "text": "long text"}}` | `{"waitFor": {"value": "Saved", "timeoutMs": 5000}}` |
| `{"scroll": "down"}` · `{"scrollTo": "Delete account"}` | `{"settle": {"stableMs": 600}}` |
| `{"swipe": {"from": [x,y], "to": [x,y]}}` | `{"pause": 300}` |
| `{"button": "HOME"}` | |
| `{"launch": {"value": "com.example.app", "relaunch": true, "args": ["-uiTest","1"]}}` | |
| `{"openUrl": "myapp://path"}` | |
| `{"permission": {"value": "photos", "grant": "grant", "bundleId": "com.example.app"}}` | |

## Selectors

| | |
| --- | --- |
| `#3` | the number `simframe ui` gave it. Cheapest, and unambiguous. |
| `"Save"` · `the Assets tab` · `back` | resolved by intent — verbs, typos, synonyms, icon-only controls by their common name |
| `@120,400` | raw point coordinates. Last resort; it cannot tell you it missed. |

A ref is valid only while that screen is showing. Use one on a different screen
and it refuses rather than tapping whatever now sits at those coordinates.

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
simframe devices            # booted simulators
simframe recall             # what happened in the last ~60s, as text
simframe strip              # recent frames tiled into one image, for an animation
simframe find "the save button"   # resolve an intent without acting on it
simframe wait --mode=settle       # block until the screen stops reacting
```

`recall` matters more than it looks: if you look up and the screen is already
different, it tells you what happened and when, instead of you re-running the
action to find out.
