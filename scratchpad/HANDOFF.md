# Handoff — 2026-10-03

The previous handoff (2026-09-25) is in git history. This one covers the
goal-mode / cartographer work from 2026-10-01 to 2026-10-03.

## Read this first

- **Released:** 0.21.0 (cartographer, credential redaction, memory carry) and
  **0.22.0** (goal mode, peer-test fixes, launch wait, head-to-head benchmark).
  0.22.0 was tagged and pushed at the end of the session. Confirm it reached npm
  with `npm view simframe dist-tags`. The release workflow was still running.
- **Phase rule:** the end of a phase is a peer test, not a release. The owner
  asked for both releases explicitly. **Next is a peer test of goal mode
  (0.22.0).** Write the prompt (pattern: `peer-reports/` and the 0.21.0 prompt
  in the conversation), wait for the report, triage, fix.
- **The last peer test found a read-only crawl writing real data** (DEFERRED
  197): MARK ALL READ was tapped 3× on the field app and four notifications were
  marked read. Fixed: notification and selection verbs are refused, any
  label that changed something without navigating is tapped once per crawl, and
  in-place changes are reported first. **Treat every crawl or goal run on the
  field app as able to write.** Watch it and verify afterwards.

## What exists now (all on main)

| piece | where | what it does |
| --- | --- | --- |
| Cartographer | `src/cartographer.js` (logic), `src/map.js` (device driver), `simframe map` / `sim_map` | Read-only crawl in attempts of ≤6 actions. It refuses the barrier (`data/vocabulary/en.json`: destructive, leavesTheApp, exploration.neverOpen, cartographer.actsImmediately/opensWrite/formCommit/devOverlay/contactLinkPatterns/dismiss/homeTabs), backs out via the app's own back, dialog dismiss or home tab, and relaunches only when `platform.relaunchNeeds` says it is safe. It is resumable (`~/.simframe/<udid>/maps/<bundle>.json`), `--trace` logs every decision, and Ctrl-C saves and reports. |
| Goal mode | `src/goal.js`, `simframe goal "<goal>"` / `sim_goal` | Targets are split on `>`/`then`. Per target: on screen now (fresh read), then a remembered route (named screen, a door with that label, or a label chain that survives split/merged identities), then backing out ≤3 toward a target the graph knows, then one `seek` of ≤6. It returns at done (with evidence) / blocked / ambiguous / not-found / failed / budget, each with an escalation reason. The barrier holds even for named controls. |
| Memory carry | `src/carry.js` | Re-fingerprints old screen maps after a TOKEN_RULES_VERSION bump and retires what it cannot rebuild. The memory line in `doctor` and `screens` counts the retired folders. |
| Credentials | `src/typed.js` | No username, password or email reaches disk: graph edges keep the field and drop the text, saved flows hold credentials as `needsText`, stored readings replace text-field values with `<typed>` everywhere, and email addresses are written as `<email>`. Frames (PNG) are NOT scrubbed; that is the owner's decision, still open. |
| Icon names | `src/glyphs.js` + `platform.appIconFonts/bundleForPid` | An icon-font glyph is looked up in the front app's bundled fonts (`cmap` + `post`) and shown as `bell (icon)`. Derived names never enter fingerprints. Identifiers (`testID`) name unlabeled controls in the cartographer. Research: `docs/research/07-icon-naming.md`. |
| Launch wait | `actions.js` `untilOperable` | A `launch` step waits until the app shows a control, up to 30 s (the owner's exception to the 10 s cap, written into CLAUDE.md). |
| Benchmark | `scripts/bench-headtohead.mjs` | Tokens and model calls per verified flow in four arms (batch / goal / step / screenshot). Results are in BENCHMARKS and GUIDE. |
| Testbed Icons tab | `examples/rn-testbed/src/screens/Icons.tsx`, `Feather.ttf` (MIT) | Seven glyph-only buttons for verifying icon naming. It needs its packager: `cd examples/rn-testbed && npm start` (port 8083). |

## Numbers to carry

- **Field (Phase 0):** about 1.1 actions per model call over 24 real sessions
  and 876 calls. In a hand-labelled sample, up to 46/59 (78%) of hand-backs
  were absorbable locally.
- **Head to head, 4-step Settings flow:** 1 `sim_do` = 1 call, 382 tokens.
  Goal = 2 calls, 436. Text map per step = 7 calls, 1,506. Screenshot per step
  = 8 calls, 6,461. 24/24 runs verified. The screenshot arm has the least tool
  time, because it verifies nothing.
- **Goal mode, live:** 5/5 goals done in their final versions (3 on Settings,
  2 on the field app), 1–3 actions each.
- **Cartographer, field app:** best run 34 screens / 42 transitions. Settings:
  27 screens / 32 transitions in 6 min, with Accessibility, Preferences,
  ColorPicker, appearance, text size and languages identical before and after.
- **Warm relaunch** of the field app's debug build: 9–16 s to an operable home
  screen.

## Environment facts that will bite

- **Devices:** `326464A4` is the benchmark device and ours. `7B8F8963`
  ("ecotrak-simframe") holds the owner's signed-in field app, which has real
  data. The owner said to use it, but **ask before any crawl there**.
  `B55AB0AE` and `CDB00FD6` are colleagues': do not drive or modify them. A
  read-only look at `B55AB0AE` was allowed once. Whether to scrub and carry its
  store is still unanswered. Other sessions use other simulators (an iPhone 16
  Pro, `F795DD6E`, was another session's).
- **The field app is an RN debug build with no embedded bundle.** A relaunch
  needs its packager on :8081 (`yarn start:ecotrak` in
  `~/Coding/ET/ecotrak-mobile`, started by the owner). Its sign-in lapses after
  about a day ("Refresh Token has expired"). Never type credentials; ask the
  owner to sign in.
- **No third-party identifiers in the repo** (`scripts/check-private.mjs`, CI).
  Shipped `src/` says "a React Native field app", never the company. Do not
  name a variable `app` in tests: `app.foo.bar` reads as a bundle id.
- **CI:** about 10 min. A Safari first-run tip on a fresh runner device turned
  the fingerprint shard red twice. It is fixed in `test/tours/device-native.json`
  with an optional tap on the page heading. Release only on green.
- **Release:** `npm version minor|patch` (the hook syncs server.json and the
  plugin manifest), push main, push the tag `vX.Y.Z`, watch `release.yml`, then
  `npm view simframe@X.Y.Z`. `gh` needs `GH_CONFIG_DIR=~/.config/gh-personal`.
- **The global `simframe`** was updated to 0.21.0 by the owner. The plugin's
  `npx simframe mcp` resolves to the global install, so update it to 0.22.0
  (`npm i -g simframe@latest`) and restart MCP sessions.
- **The benchmark device's Accessibility** (`PrefersHorizontalText`, Hover Text
  colour) was changed by an earlier crawl and **reset by the owner**. When a crawl
  runs on Settings, compare `com.apple.Accessibility`, `com.apple.Preferences`
  and `com.apple.UIKit.ColorPickerUIService` before and after, not only
  Preferences.

## Open items (DEFERRED 197 lists them in full)

- The screen header still says `NOT MOVED … did not land` after a small text
  change, because it judges by pixels. Step verdicts are fixed.
- Typing into a label that is both a field and its caption is ambiguous. The
  keyboard coming up invalidates refs, so a form cannot be filled by ref in one
  script.
- Screens are named after tab-bar chrome. A list row under the tab bar is
  offered as tappable.
- Crawl maps keep customer names and notification text in `refused` keys and
  `samples`.
- Frames on disk show typed text (owner's decision).
- The SF Symbols pixel route was approved but deferred by measurement: only 9 of
  4,266 bench controls and 3 of 2,306 field-app controls lack both a label and
  an identifier.
- Identity splits and merges (DEFERRED 174) remain the root of most crawler and
  goal-mode workarounds: label chains, door-set aliases, fresh reads.

## Next

1. Confirm 0.22.0 on npm. Tell the owner to `npm i -g simframe@latest` and
   restart MCP sessions.
2. Write the goal-mode peer-test prompt. Cover goals on Settings, Contacts and
   the testbed, read-only goals on the field app with before/after state checks,
   barrier refusals, ambiguity, not-found, and the 1-call / milestone report
   quality.
3. Phase 3, scoring. Build a small fixed task set (field app + system apps) and
   measure actions per model call (1.1 in the field, target 8–10), model turns
   per flow, HPI_accuracy, step_ratio and wrong taps, before and after each
   change. Re-record `docs/research/hpi-baseline.json` first: one of its two
   flows never completed.
