// MCP server. The point of every tool here is that the expensive part
// (capturing) already happened in the background, so a call is a file read.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION_COLS, REGION_ROWS, regionMap } from './analyze.js';
import * as actions from './actions.js';
import * as api from './index.js';
import * as input from './input.js';
import * as metrics from './metrics.js';
import * as navigate from './navigate.js';
import { bootedDevices, permissionServices } from './platform/index.js';
import * as store from './store.js';
import * as view from './view.js';

/**
 * Per-call overrides for the two experiment knobs.
 *
 * Both are read from the call first and the environment second, so an A/B is an
 * argument rather than a server restart — and a run in the wrong mode stops
 * being a thing that can silently happen.
 */
export function modesFor(base = {}, args = {}) {
  const out = { ...base };
  if (args.sensor) out.sensor = String(args.sensor);
  if (args.planner) out.planner = String(args.planner);
  if (args.supervisor) out.supervisor = String(args.supervisor);
  return out;
}

/** Offered on every tool that reads or acts, because either can be compared. */
/**
 * Which declared-required argument is absent, phrased as advice.
 *
 * Reads the tool's own `required` array, so a tool that gains a required
 * argument gains this for free and cannot drift out of step with it.
 */
function missingRequired(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  const need = tool?.inputSchema?.required ?? [];
  const absent = need.filter((k) => args?.[k] === undefined || args?.[k] === null || args?.[k] === '');
  if (!absent.length) return null;
  const known = Object.keys(args ?? {}).filter((k) => k !== 'device');
  return `${name}: missing required ${absent.map((k) => `"${k}"`).join(', ')}.`
    + (known.length ? ` You passed: ${known.map((k) => `"${k}"`).join(', ')}.` : '')
    + ` ${absent.length === 1 ? 'That argument is' : 'Those arguments are'} the one${absent.length === 1 ? '' : 's'} this tool acts on — pass ${absent.map((k) => `"${k}"`).join(' and ')} and retry.`;
}

const modeProps = {
  sensor: {
    type: 'string',
    enum: ['full', 'ax-first'],
    description: 'Perception for this call. "full" fuses accessibility and OCR (~164ms). "ax-first" reads the tree alone (~50ms) and pays for OCR only when something fails to resolve. Omit to keep the server default.',
  },
  planner: {
    type: 'string',
    enum: ['none', 'apple'],
    description: 'Local model for this call. Orders the containers seek opens; it cannot choose an action. Omit to keep the server default.',
  },
  supervisor: {
    type: 'string',
    enum: ['none', 'apple'],
    description: 'Local supervisor for this call. When a step fails it answers wait, retry or stop — nothing else — before the batch is abandoned. Omit to keep the server default.',
  },
};

const deviceProp = {
  device: {
    type: 'string',
    description: 'Device UDID or name substring — a simulator udid or an emulator serial. Defaults to the booted device.',
  },
};

/**
 * One selector grammar everywhere, and the order is the recommendation.
 *
 * It used to lead with `#3` and call it "cheapest and unambiguous". Four peer
 * rounds running reported the opposite: intent resolution worked every time,
 * while refs renumbered underneath them and were only safe inside the round
 * trip that issued them. The README was corrected and these descriptions were
 * not, which is the half a caller actually reads.
 *
 * "Unambiguous" was also the wrong word for it. A ref is exact about which
 * element simframe meant and says nothing about whether that element is still
 * there — the failure mode that needed `staleKind` to tell a moved layout from
 * a different screen, and then a score floor and a region check on top of that
 * before a relabelled ref could be trusted. A label carries its own evidence;
 * a number carries none.
 */
const SELECTOR = 'Selector: a label or phrase like "Save" or "the Assets tab" or "back" (resolved by intent — verbs, typos, synonyms, icon-only controls: START HERE), "#3" (a number from the last screen map — exact, but only inside the round trip that numbered it), or "@120,400" for raw point coordinates (last resort: it cannot tell you it missed).';

const selectorProp = (what = 'What to act on') => ({
  sel: { type: 'string', description: `${what}. ${SELECTOR}` },
});

const TOOLS = [
  {
    name: 'sim_ui',
    description:
      'READ THE SCREEN as text: every element numbered, with region, type, label, state, contents and tap point, plus which screen this is and what simframe knows about it. A tenth the cost of a screenshot and more useful, because it says what is tappable and where. Act on what it shows by NAME — whatever it calls "General", you can tap as "General"; the #3 numbers are exact but only until the screen moves. Start here, never with sim_look.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        filter: { type: 'string', description: 'Only elements whose label or read text contains this.' },
        interactive: { type: 'boolean', description: 'Only elements that look tappable.' },
        all: { type: 'boolean', description: 'Include the status bar and every collapsed region (default false).' },
        refresh: { type: 'boolean', description: 'Re-read the screen instead of using remembered layout. Use when you believe memory is stale.' },
      },
    },
  },
  {
    name: 'sim_do',
    description:
      'THE MAIN TOOL, and the cheapest path. Plan the WHOLE flow and run it in one call — tap, type, scroll, wait, assert — asserting after each step that matters. Every step settles and is checked against what that action did here before, so a wrong turn halts the flow instead of tapping on. Single-action tools are for recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        supervise: {
          type: 'string',
          description: 'What the local supervisor should know about this app while the batch runs — how lists load, what makes a control stay disabled, what a benign failure looks like here. It has no knowledge of the app; you do. Ignored when no supervisor is enabled.',
        },
        steps: {
          type: 'array',
          description:
            'Ordered steps. Every selector below accepts "Save" | "#3" | "@120,400", in that order of preference. Act: {"tap":"Save"} (add "index" if a label is ambiguous), {"type":{"into":"Name","text":"Fryer 3"}}, {"paste":{"into":"Notes","text":"long text"}}, {"clear":"Notes"} to empty a field and "clear":true on a type/paste to replace rather than append (drop "into" to type into whatever already has focus, which is how you follow a browser next-field chevron — nothing can be read back then, and the step says so), {"scroll":"down"}, {"scrollTo":"Delete account"}, {"swipe":{"from":[x,y],"to":[x,y]}}, {"button":"HOME"}, {"key":"return"} (the keyboard return/enter key, which is how a mobile search field submits — also escape, tab, space, backspace, and the arrows), {"launch":{"value":"com.example.app","relaunch":true,"args":["-uiTest","1"]}}, {"openUrl":"myapp://x"}, {"permission":{"value":"photos","grant":"grant","bundleId":"com.example.app"}}. Check: {"assert":{"value":"Saved","is":"visible"}} (also gone | enabled | disabled | value with "equals"), {"waitFor":{"value":"Saved","timeoutMs":5000}}, {"settle":{"stableMs":600}}, {"pause":300}. Recover without a round trip: add "or" to any step for fallback selectors tried locally — {"tap":"Save","or":["Done","Confirm"]} — and {"seek":"change username","budget":6} explores for something not on this screen: it OPENS containers (a real action — state changes), checks, and returns to where it started, refusing to open anything that commits, abandons or answers. It does not tap the target; it leaves you on the screen where the target resolves so you tap it next. Do not point it into a flow whose progress you cannot afford to lose. A long screen is only knowable a viewport at a time, so {"sweep":"all","fill":{"Last Name":"Asadi","Email":"a@b.c"}} goes to the top, then reads and fills section by section to the bottom — filling each field while it is on screen, which beats finding one and scrolling back. Add "from":"here" to sweep down from where you are. It reports which section each element was in, what it filled, and what it never found at any scroll position. Prefer it to scrollTo on forms and long lists. Brief the supervisor from the plan: top-level "supervise" is standing guidance for the whole batch ("lists here render a count header before rows; REVIEW stays disabled until a provider is chosen") and per-step "expect" adds to it. When it stops a run the result names the steps it did not attempt — re-issue them with a corrected "supervise" note if the judgement was wrong.',
          items: { type: 'object' },
        },
        autoSettle: {
          type: 'boolean',
          description: 'Wait for the screen to settle after each action (default true). Turn off only for deliberate rapid input — with it off the trailing map is read before the last gesture has finished, so it can describe the screen you were on rather than the one you are on.',
        },
        stableMs: { type: 'number', description: 'How still the screen must be to count as settled (default 500).' },
        timeoutMs: { type: 'number', description: 'Per-step settle timeout (default 8000).' },
        continueOnError: { type: 'boolean', description: 'Keep going after a failed step (default false).' },
        saveAs: {
          type: 'string',
          description: 'If every step verifies, save the flow under this name so it can be replayed with sim_flow_run.',
        },
        images: {
          type: 'boolean',
          description: 'Attach a frame for every {"look"} step (default false — the text map is normally what you want).',
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'sim_tap',
    description: 'Tap one thing. For more than one step, use sim_do — it batches the verification and costs one round trip. Returns the screen map afterwards.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...modeProps, ...selectorProp('What to tap'), index: { type: 'number', description: 'Which match, when the selector fits several.' } },
      required: ['sel'],
    },
  },
  {
    name: 'sim_type_into',
    description: 'Focus a field and type into it. Prefer a sim_do step when this is part of a sequence.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...modeProps, ...selectorProp('The field'), text: { type: 'string' }, paste: { type: 'boolean', description: 'Use the pasteboard instead of the keyboard — much faster for long strings.' } },
      required: ['sel', 'text'],
    },
  },
  {
    name: 'sim_scroll_to',
    description: 'Scroll until something is in view. A control that scrolled off the bottom of a list is not missing, and this is the difference.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        ...selectorProp('What to bring into view'),
        direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] },
        maxScrolls: { type: 'number', description: 'Give up after this many screens (default 6).' },
      },
      required: ['sel'],
    },
  },
  {
    name: 'sim_wait_for',
    description: 'Block until something appears on screen, then return the screen map. Use this instead of pausing and re-reading.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...modeProps, ...selectorProp('What to wait for'), timeoutMs: { type: 'number', description: 'Default 8000.' } },
      required: ['sel'],
    },
  },
  {
    name: 'sim_assert',
    description: 'Check one thing about the screen and fail loudly if it is not so. Cheaper inside a sim_do flow, where a failed assert stops the remaining steps.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        ...selectorProp('What to check'),
        is: {
          type: 'string',
          enum: ['visible', 'gone', 'enabled', 'disabled', 'value'],
          description: 'Default visible. "value" compares against `equals`.',
        },
        equals: { type: 'string', description: 'For is="value": the text the element should read.' },
      },
      required: ['sel'],
    },
  },
  {
    name: 'sim_goto',
    description:
      'Walk to a screen simframe already knows, over edges it has already verified, with no model call per step. Names come from sim_recall or a previous map. Refuses rather than guesses when the route is unknown or the name is ambiguous — a refusal is cheap and a wrong walk is not.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...modeProps, screen: { type: 'string', description: 'What the screen is called, e.g. "Settings" or an 8-character screen hash. Omit to list what is known.' } },
    },
  },
  {
    name: 'sim_flow_run',
    description: 'Replay a saved flow by name, verifying each step. Omit `name` to list the saved flows. Save one with sim_do\'s `saveAs`.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...modeProps, name: { type: 'string', description: 'Flow to run. Omit to list.' } },
    },
  },
  {
    name: 'sim_launch',
    description: 'Launch or relaunch an app, optionally with launch arguments and environment variables — the way to put an app into a test mode without touching its UI.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        bundleId: { type: 'string' },
        relaunch: { type: 'boolean', description: 'Terminate first. Without this, launching an already-running app silently does nothing and you test the screen you were already on.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Launch arguments passed to the app.' },
        env: { type: 'object', description: 'Environment variables for the app process.' },
      },
      required: ['bundleId'],
    },
  },
  {
    name: 'sim_open_url',
    description: 'Open a URL or deep link on the device — the fastest way to reach a screen when the app has a link for it.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...modeProps, url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'sim_permission',
    description: `Grant, revoke or reset a privacy permission for an app. Do this instead of tapping the system alert: the alert is not part of the app under test, and its buttons move between OS versions. Not every service exists on every platform — the device's own backend refuses one it does not have. Services: ${permissionServices().join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        action: { type: 'string', enum: ['grant', 'revoke', 'reset'] },
        service: { type: 'string' },
        bundleId: { type: 'string' },
      },
      required: ['action', 'service'],
    },
  },
  {
    name: 'sim_find',
    description:
      'Resolve one intent to one control: "tap Save", "the Assets tab", "back". Understands verbs, typos, and where on screen you meant. When two things answer equally well it says so and lists them rather than guessing. Use it when you doubt a selector will resolve; otherwise just tap. Prefer a label or a #ref over coordinates.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...modeProps, intent: { type: 'string', description: 'What you want to act on, in your own words.' } },
      required: ['intent'],
    },
  },
  {
    name: 'sim_state',
    description:
      'Cheapest possible check: a stable screen hash, whether anything changed SINCE YOUR LAST LOOK in this session, how long the screen has been still, and an ASCII map of which regions moved. A fraction of the cost of even the text screen map. Use it to poll ("has it finished loading?"). To find out WHAT is on screen, use sim_ui.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        since: { type: 'string', description: 'Compare against this frame hash instead of your last look.' },
      },
    },
  },
  {
    name: 'sim_wait',
    description:
      'Wait for the screen to change, settle, or both. sim_do already settles after every step, so you rarely need this inside a flow — reach for it when something moves without you acting, like a push or a background load. Pass `since` from a hash captured before the thing you are waiting on.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        mode: {
          type: 'string',
          enum: ['settle', 'change', 'stable'],
          description: 'settle (default): wait for a change, then for it to hold still. change: return as soon as it differs. stable: return once it is still, even if nothing moved.',
        },
        since: { type: 'string', description: 'Frame hash to treat as the "before" state. Defaults to your last observation.' },
        stableMs: { type: 'number', description: 'How long the screen must hold still for mode "stable" (default 600).' },
        timeoutMs: { type: 'number', description: 'Give up after this long (default 8000).' },
        map: { type: 'boolean', description: 'Return the screen map afterwards (default true).' },
      },
    },
  },
  {
    name: 'sim_look',
    description:
      'A screenshot: ~1600 tokens, the most expensive call here. Only for what text cannot answer — layout, colour, spacing, a control the map omits. NOT for what a field contains, whether a button is enabled, or whether an action worked: sim_ui reports the first two and the flow\'s own verdict already answered the third.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        detail: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Image size: low (~420px, cheapest), normal (~700px, default), high (1024px, readable small text). Capped at 1024px on the long edge.',
        },
        region: {
          type: 'object',
          description: 'Crop to part of the screen and enlarge it, in POINTS — the same coordinates the element map prints: {"x":18,"y":260,"width":366,"height":80}. Use it when a whole screen cannot answer the question at 1024px: selected versus unselected, a chevron, a validation mark. Pair it with detail:"high".',
          properties: {
            x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
          },
        },
        maxAgeMs: { type: 'number', description: 'If the buffered frame is older than this, wait for a fresher one (default 900).' },
      },
    },
  },
  {
    name: 'sim_strip',
    description:
      'Return the last few buffered frames tiled into ONE image, oldest first — an image, so not cheap. Lets you understand a transition, animation or flicker in a single call instead of a burst of screenshots. Looks backwards in time; it does not wait.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        count: { type: 'number', description: 'How many frames to tile (default 5, max 12).' },
        spanMs: { type: 'number', description: 'Only include frames from the last N milliseconds.' },
        thumbMaxDim: { type: 'number', description: 'Height budget per frame in pixels (default 240).' },
      },
    },
  },
  {
    name: 'sim_recall',
    description:
      'What happened recently, as text: the screens visited, the actions taken, and what each one did. Use it to re-orient after a failure instead of taking a screenshot, and to learn the screen names sim_goto accepts.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        ...modeProps,
        action: { type: 'string', enum: ['timeline', 'at'], description: 'timeline (default) or at.' },
        spanMs: { type: 'number', description: 'For timeline: how far back to summarise (default 60000).' },
        msAgo: { type: 'number', description: 'For at: how long ago the moment of interest was, in milliseconds.' },
      },
    },
  },
  {
    name: 'sim_capture',
    description:
      'Inspect or control the background capture loops: action "status" (what is running and how fresh), "start", "stop". Capture starts automatically on first use, so you rarely need this.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop'] },
        ...deviceProp,
        ...modeProps,
        fps: { type: 'number', description: 'Capture rate while the screen is moving (default 4).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'sim_devices',
    description: 'List the booted devices simframe can drive — iOS simulators and Android emulators.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// What this MCP session last observed, per device. This is the baseline that
// makes "what changed since I last looked?" answerable without the caller
// having to thread a hash through every call — the mistake that made the
// frame-to-frame delta look broken in practice.
const lastSeen = new Map();

/** Report the real version: a hardcoded one silently drifts every release. */
function packageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function remember(udid, state) {
  lastSeen.set(udid, { hash: state.hash, seq: state.seq, at: state.capturedAt });
}

function baselineFor(udid, explicit) {
  if (explicit != null) return explicit;
  const seen = lastSeen.get(udid);
  return seen ? seen.hash : undefined;
}

const text = (s) => ({ type: 'text', text: s });
const image = (png) => ({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });

/**
 * The device's name, and its UDID when the name cannot identify it.
 *
 * Two booted simulators can share a name — measured on this machine: two called
 * "iPhone 17 Pro" at once, which is the default state after creating a second
 * device of the same model. A caller reading a header that says only
 * "iPhone 17 Pro" has no way to tell which one answered, and a reporter spent a
 * session unsure whether they were looking at their own app. `xcrun simctl list
 * devices booted` makes the collision trivial to see, so the header says which.
 */
function deviceLabel(device) {
  if (!device?.udid) return device?.name ?? 'unknown device';
  const clash = (lastBooted ?? []).filter((d) => d.name === device.name).length > 1;
  return clash ? `${device.name} (${device.udid.slice(0, 8)})` : device.name;
}

/** What the last device listing saw, so a name collision can be noticed at all. */
let lastBooted = null;
export function noteBooted(devices) {
  lastBooted = Array.isArray(devices) ? devices.map((d) => ({ name: d.name, udid: d.udid })) : null;
  const names = new Map();
  for (const d of lastBooted ?? []) names.set(d.name, (names.get(d.name) ?? 0) + 1);
  const shared = [...names].filter(([, n]) => n > 1).map(([name]) => name);
  return shared.length
    ? `WARNING: ${shared.map((n) => JSON.stringify(n)).join(', ')} names more than one booted device`
      + ' — pass "device" with a UDID, because a name cannot identify which one you mean'
    : null;
}

function header(device, state, ageMs, extra = '') {
  return (
    `${deviceLabel(device)} · ${device.runtime} · frame #${state.seq} · ${ageMs}ms old · ` +
    `${state.width}x${state.height} · still for ${state.stableForMs}ms${extra ? ` · ${extra}` : ''}`
  );
}

function livenessLine(live) {
  return live?.ok ? null : `WARNING: ${live.note}`;
}

function sinceLine(since) {
  if (!since) return 'no previous look in this session to compare against';
  if (since.kind === 'unmatched') {
    return `baseline ${since.requested} is not in the buffered history — cannot compare`;
  }
  if (since.kind === 'coarse') {
    return since.changed
      ? `the screen HAS changed since your baseline ${Math.round(since.ageMs / 1000)}s ago (too old for a detailed diff)`
      : `the screen has NOT changed since your baseline ${Math.round(since.ageMs / 1000)}s ago`;
  }
  return since.changed
    ? `CHANGED since your last look ${since.ageMs}ms ago (${(since.diff * 100).toFixed(1)}% of the screen)`
    : `unchanged since your last look ${since.ageMs}ms ago`;
}

export async function serve({ device: defaultDevice, options: baseOptions = {} } = {}) {
  // The last device a caller named, for the life of this server.
  let lastDevice = null;
  const server = new Server(
    { name: 'simframe', version: packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments || {};
    // Sticky, and stickiness is not guessing.
    //
    // Reported: `sim_launch` accepted `device`, and the very next `sim_ui`
    // refused with "2 simulators are booted and none was named" — so a UDID had
    // to ride on all ~15 subsequent calls. Refusing to *choose* between two
    // booted devices is right; forgetting which one the caller already named is
    // not. This remembers only what was explicitly passed, so nothing is ever
    // inferred from a boot list.
    const target = args.device || lastDevice || defaultDevice;
    if (args.device) lastDevice = String(args.device);
    // An MCP server's environment is fixed when it spawns, so a tester asked to
    // compare two sensor modes inside one session could not: round 6 ran its
    // baseline and could not run either variant. The suggested workaround was
    // three server entries with three env blocks, which is worse — three servers
    // on one device is three writers, against the one-writer-per-device rule.
    //
    // So the modes are arguments. Absent, the environment still decides, so
    // nothing that was working changes.
    const options = modesFor(baseOptions, args);
    // Name the missing argument, using the tool's own schema.
    //
    // Reported: `sim_scroll_to` called with `target:` instead of `sel:` answered
    // `simframe: empty step` — which names neither the tool, nor the parameter,
    // nor even that an argument was absent, and cost a schema lookup to decode.
    // The declared `required` list is right there, so the check is generic
    // rather than one guard per tool, and it says what to pass.
    const missing = missingRequired(req.params.name, args);
    if (missing) return { content: [text(missing)], isError: true };
    try {
      switch (req.params.name) {
        case 'sim_look':
          return await look(target, args, options);
        case 'sim_state':
          return await state(target, args, options);
        case 'sim_wait':
          return await wait(target, args, options);
        case 'sim_strip':
          return await strip(target, args, options);
        case 'sim_recall':
          return await recall(target, args, options);
        case 'sim_find':
          return await find(target, args, options);
        case 'sim_do':
          return await doScript(target, args, options);
        case 'sim_ui':
          return await ui(target, args, options);
        case 'sim_tap':
          return await oneStep(target, { tap: args.sel, index: args.index }, args, options);
        case 'sim_type_into':
          return await oneStep(
            target,
            args.paste
              ? { paste: { into: args.sel, text: args.text } }
              : { type: { into: args.sel, text: args.text } },
            args,
            options,
          );
        case 'sim_scroll_to':
          return await oneStep(
            target,
            { scrollTo: args.sel, direction: args.direction, maxScrolls: args.maxScrolls },
            args,
            options,
          );
        case 'sim_wait_for':
          return await oneStep(target, { waitFor: args.sel, timeoutMs: args.timeoutMs }, args, options);
        case 'sim_assert':
          return await oneStep(target, { assert: args.sel, is: args.is, equals: args.equals }, args, options);
        case 'sim_launch':
          return await oneStep(
            target,
            { launch: { value: args.bundleId, relaunch: args.relaunch, args: args.args, env: args.env } },
            args,
            options,
          );
        case 'sim_open_url':
          return await oneStep(target, { openUrl: args.url }, args, options);
        case 'sim_permission':
          return await oneStep(
            target,
            { permission: { value: args.service, grant: args.action, bundleId: args.bundleId } },
            args,
            options,
          );
        case 'sim_goto':
          return await goto(target, args, options);
        case 'sim_flow_run':
          return await flowRun(target, args, options);
        case 'sim_capture':
          return await capture(target, args, options);
        case 'sim_devices':
          return await devices();
        default:
          throw new Error(`unknown tool ${req.params.name}`);
      }
    } catch (err) {
      return { isError: true, content: [text(`simframe: ${err.message}`)] };
    }
  });

  await server.connect(new StdioServerTransport());
}

/**
 * Crop a frame to a region of the screen and enlarge it.
 *
 * A whole screen at 1024px cannot answer a question about one control: a
 * selected filter chip and an unselected one look identical at that size, and an
 * agent shelled out to `simctl io` and PIL to crop and upscale a chip row for
 * every check it made. The region arrives in **points** — the same coordinates
 * the element map prints — because that is what a caller has in hand.
 */
/**
 * Read a region argument that may not have arrived as an object.
 *
 * A client is free to hand a declared-object property over as a JSON string,
 * and one did: `{"x":0,"y":60,...}` arrived as text, every field read as
 * undefined, and the crop silently became the whole screen — reported back as
 * `cropped to 402x874pt at 0,0`, which is a crop that did not happen described
 * as one that did. An array is accepted too, because [x, y, width, height] is
 * the shape anyone would try first, and it used to fail exactly as quietly.
 */
export function readRegion(region) {
  let r = region;
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch { return null; }
  }
  if (Array.isArray(r)) {
    const [x, y, width, height] = r.map(Number);
    return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null;
  }
  if (!r || typeof r !== 'object') return null;
  const num = (...keys) => {
    for (const k of keys) if (Number.isFinite(Number(r[k]))) return Number(r[k]);
    return null;
  };
  const width = num('width', 'w');
  const height = num('height', 'h');
  // A region with no size is not a region. Saying so beats returning the whole
  // screen under a caption that claims otherwise.
  if (width == null && height == null) return null;
  return { x: num('x') ?? 0, y: num('y') ?? 0, width, height };
}

async function cropRegion(png, region, points) {
  try {
    const { decodePng, encodePng, cropBitmap, scaleBitmap } = await import('./png.js');
    const bmp = decodePng(png);
    const pw = points?.width;
    const ph = points?.height;
    if (!Number.isFinite(pw) || !Number.isFinite(ph) || !pw || !ph) return { note: 'the screen point size is unknown' };
    // The frame we hold is already downscaled for the model, so map points onto
    // *this* bitmap rather than onto the device's native pixels.
    const sx = bmp.width / pw;
    const sy = bmp.height / ph;
    const x = Number(region.x ?? 0) * sx;
    const y = Number(region.y ?? 0) * sy;
    const w = Number(region.width ?? region.w ?? pw) * sx;
    const h = Number(region.height ?? region.h ?? ph) * sy;
    if (!(w >= 1) || !(h >= 1)) return { note: 'the region has no size' };
    const cut = cropBitmap(bmp, x, y, w, h);
    // Enlarge to the same budget the whole screen gets, so the detail per point
    // is the whole reason to ask for a region.
    const long = Math.max(cut.width, cut.height);
    const factor = Math.min(6, Math.max(1, Math.round(1024 / long)));
    const big = factor > 1 ? scaleBitmap(cut, cut.width * factor, cut.height * factor) : cut;
    return {
      png: encodePng(big),
      note: `cropped to ${Math.round(Number(region.width ?? region.w ?? pw))}x`
        + `${Math.round(Number(region.height ?? region.h ?? ph))}pt at `
        + `${Math.round(Number(region.x ?? 0))},${Math.round(Number(region.y ?? 0))}`
        + `, enlarged ${factor}x`,
    };
  } catch (err) {
    return { note: String(err.message).split('\n')[0] };
  }
}

async function look(target, args, options) {
  const maxAge = args.maxAgeMs ?? 900;
  // Never native resolution. An image is the expensive path by a factor of ten
  // even when Claude Code handles it correctly; a 1024px frame says everything
  // a 393-point screen has to say.
  const detail = api.modelDetail(args.detail ?? 'normal');
  let res = await api.getFrame(target, { detail, options });
  if (res.ageMs > maxAge) {
    // Freshness was requested; the loop is already running, so just let it tick.
    const deadline = Date.now() + Math.min(2000, maxAge * 3);
    const p = store.paths(res.device.udid);
    while (Date.now() < deadline) {
      const next = store.readJson(p.state);
      if (next && Date.now() - next.capturedAt <= maxAge) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    res = await api.getFrame(target, { detail, options });
  }
  const prior = baselineFor(res.device.udid, undefined);
  const st = await api.getState(target, { since: prior, options });
  remember(res.device.udid, res.state);
  const lines = [header(res.device, res.state, res.ageMs), sinceLine(st.since)];
  // Louder than a trailing note, because it invalidates the image itself rather
  // than qualifying it.
  if (res.frameBehindMs) {
    lines.unshift(`WARNING: this image is ${Math.round(res.frameBehindMs / 100) / 10}s older than the screen state`
      + ' — it is very likely NOT what is on the device now. Read sim_ui, which is read live,'
      + ' or look again in a moment.');
  }
  const warn = livenessLine(st.live);
  if (warn) lines.unshift(warn);
  let png = res.png;
  if (args.region) {
    const parsed = readRegion(args.region);
    if (!parsed) {
      lines.push('that region could not be read (expected {"x":0,"y":260,"width":402,"height":80} in points,'
        + ' or [x, y, width, height]) — this is the whole screen');
    }
    // The point size, which the frame does not carry: `state.width/height` are
    // the *captured frame's* pixels (322x700 here), not the screen's points
    // (402x874). Scaling by them gave a 1:1 ratio, so a crop at y=760 clamped
    // to a single pixel row and returned a 119-byte image — which looked like
    // it had worked. `screenIdentity` answers it in ~17ms warm.
    const geo = await api.screenIdentity(target, { options, confirmNovel: false }).catch(() => null);
    const cropped = parsed ? await cropRegion(png, parsed, geo?.points) : { note: null };
    if (cropped.png) {
      png = cropped.png;
      lines.push(cropped.note);
    } else if (cropped.note) {
      lines.push(`could not crop that region (${cropped.note}) — this is the whole screen`);
    }
  }
  return { content: [text(lines.filter(Boolean).join('\n')), image(png)] };
}

async function state(target, args, options) {
  const { device } = await api.ensureDaemon(target, options);
  const requested = baselineFor(device.udid, args.since);
  const res = await api.getState(target, { since: requested, options, inputHealth: true });
  const s = res.state;
  const lines = [
    header(res.device, s, res.ageMs),
    `screen hash: ${s.hash}`,
    sinceLine(res.since),
    s.firstFrame
      ? 'this is the first frame of a freshly started capture loop'
      : s.stableForMs > 1200
        ? 'screen is idle right now'
        : 'screen is moving right now',
  ];
  if (res.since?.kind === 'history') {
    lines.push(
      `what moved since your last look (${REGION_COLS}x${REGION_ROWS}, top-left to bottom-right; "." to "@" = more movement):`,
      res.since.map,
    );
  }
  const warn = livenessLine(res.live);
  if (warn) lines.unshift(warn);
  // An agent that cannot see this spends five turns wondering why a correct
  // tap on a correct element did nothing. The repair happens before the next
  // action either way; this is so the cause is visible when it does.
  if (res.input?.stale) lines.unshift(`input: stale — ${res.input.reason}`);
  // §7's timing line. Worth a line because "is it still coming or is it done"
  // is a question an agent otherwise answers by waiting and guessing.
  if (res.timing?.samples) {
    lines.push(
      `timing: usually ${res.timing.edge_p50}ms to arrive here (p95 ${res.timing.edge_p95}ms over `
      + `${res.timing.samples} samples), ${res.timing.elapsed_ms}ms since the last change`
      + (res.timing.slower_than_usual ? ` — ${res.timing.note}` : ''),
    );
  }
  remember(device.udid, s);
  return { content: [text(lines.filter(Boolean).join('\n'))] };
}

async function wait(target, args, options) {
  const { device } = await api.ensureDaemon(target, options);
  const res = await api.waitFor(target, {
    mode: args.mode ?? 'settle',
    since: baselineFor(device.udid, args.since),
    stableMs: args.stableMs ?? 600,
    timeoutMs: args.timeoutMs ?? 8000,
    options,
  });
  let note;
  if (res.satisfied) {
    note = `${res.mode === 'change' ? 'screen changed' : 'screen settled'} after ${res.waitedMs}ms`;
    if (res.changedBeforeWait) note += ' (the change had already happened before this call)';
  } else if (res.noVisibleChange) {
    note =
      `no visible change after ${res.waitedMs}ms — the screen is stable but nothing moved. ` +
      'The action may have done nothing, or its effect may be too small to see (a checkbox, a radio, a button state). ' +
      'Check with sim_ui rather than waiting longer.';
  } else if (res.stalled) {
    note = `CAPTURE STALLED after ${res.waitedMs}ms — ${res.live.note}. This is a simframe problem, not a screen that failed to change.`;
  } else {
    note = `TIMED OUT after ${res.waitedMs}ms — screen never ${res.mode === 'change' ? 'changed' : 'settled'}`;
    if (!res.sawChange) {
      note += res.baselineResolved
        ? '. No change was seen at all; if the change happened before this call, pass the hash you saw beforehand as `since`.'
        : `. The baseline you passed was not in the buffered history, so "changed" could not be judged.`;
    }
  }
  remember(device.udid, res.state);
  const lines = [note, header(res.device, res.state, Date.now() - res.state.capturedAt)];
  // The screen map, not a frame. This call is almost always "what happened?",
  // and the answer to that is a list of elements, not 1,600 tokens of pixels.
  if (args.map !== false) {
    try {
      lines.push('', (await view.screenMap(target, { options })).text);
    } catch (err) {
      lines.push(`(could not read the screen: ${err.message})`);
    }
  }
  return { content: [text(lines.join('\n'))] };
}

async function strip(target, args, options) {
  const res = await api.getStrip(target, {
    count: Math.min(12, args.count ?? 5),
    spanMs: args.spanMs,
    thumbMaxDim: Math.min(api.MODEL_MAX_IMAGE_DIM, args.thumbMaxDim ?? 240),
    options,
  });
  const offsets = res.frames.map((f) => `+${f.offsetMs}ms`).join('  ');
  return {
    content: [
      text(
        `${res.device.name} · ${res.frames.length} frames spanning ${res.spanMs}ms, oldest first\n${offsets}`,
      ),
      image(res.png),
    ],
  };
}

function dur(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function ago(ms) {
  return `${dur(ms)} ago`;
}

async function recall(target, args, options) {
  if (args.action === 'at') {
    // No cap needed: buffered ring frames are captured at 700px, already under
    // the model image ceiling.
    const res = await api.getFrameAt(target, { msAgo: args.msAgo ?? 0, options });
    return {
      content: [
        text(
          `${res.device.name} · frame #${res.seq} from ${ago(res.actualMsAgo)}` +
            (Math.abs(res.actualMsAgo - res.requestedMsAgo) > 400
              ? ` (nearest buffered frame to the ${ago(res.requestedMsAgo)} you asked for)`
              : '') +
            `\nbuffered memory reaches back ${ago(res.oldestMsAgo)}`,
        ),
        image(res.png),
      ],
    };
  }

  const res = await api.getTimeline(target, { spanMs: args.spanMs ?? 60_000, options });
  const lines = [
    `${res.device.name} · remembering the last ${dur(res.coveredMs)} · ${res.buffered} frames buffered`,
  ];
  if (!res.events.length) {
    lines.push(`nothing changed in that window; the screen has been still for ${dur(res.idleForMs)}`);
  } else {
    lines.push(`${res.events.length} change${res.events.length === 1 ? '' : 's'}, oldest first:`);
    for (const e of res.events) {
      lines.push(
        `  ${ago(e.startedMsAgo).padStart(9)}  ${e.level === 'major' ? 'screen changed' : 'small change '}  ` +
          `${(e.magnitude * 100).toFixed(0)}% of the screen, over ${dur(e.durationMs)}`,
      );
    }
    lines.push(`the screen has been still for ${dur(res.idleForMs)}`);
    const last = res.events[res.events.length - 1];
    if (last.map) lines.push('what moved in the most recent change:', last.map);
  }
  const warn = livenessLine(res.live);
  if (warn) lines.unshift(warn);
  return { content: [text(lines.join('\n'))] };
}

/**
 * The compact map, from an identity reading that has already been taken.
 *
 * A flow verifies where it ended up in order to record the edge, and that
 * reading carries the elements with it — so describing the end state to Claude
 * is free. Reading the screen a second time to render it was the whole cost of
 * a text-first surface, and it does not have to be paid.
 */
/**
 * The map at the end of an action, and why it is re-read rather than recalled.
 *
 * It used to be rendered from whatever `screenIdentity` had in hand during
 * verification, which is memory-first by design — so the trailing map could
 * describe the screen as it was seconds earlier. Reported from a real session:
 * *"do's trailing dump is still stale, so I still ran `ui --refresh` after
 * nearly every call — that remains the biggest speed tax."*
 *
 * Saying how old it was (the header does) turned out not to be enough: an agent
 * that cannot trust the map spends a turn re-reading it, and a turn is the
 * expensive unit here. So an action pays one perception pass — a few hundred
 * milliseconds, locally, once — to save a model round trip. That is the whole
 * trade this phase is about, and it is the right way round.
 *
 * `refresh: false` is still available for the read-only tools, where the caller
 * asked for a map and can ask again.
 */
async function mapFrom(target, options, identity, extra = {}) {
  try {
    const fresh = extra.refresh !== false;
    const m = await view.screenMap(target, {
      options,
      refresh: fresh,
      identity: fresh ? undefined : (identity?.entry ? identity : undefined),
    });
    const rendered = view.render({ ...m, ...extra });
    // The line that decides whether the model stops to think. Everything it
    // needs is already computed for the map above it, so this costs nothing —
    // and "nothing here needs you" is a thing only the daemon can say.
    if (extra.hint === false) return rendered;
    return `${rendered}\n${view.hintFor(m, { flowOk: extra.flowOk, escalated: extra.escalated })}`;
  } catch (err) {
    return `(could not read the screen: ${err.message})`;
  }
}

function verdictLineFor(results) {
  const last = [...(results ?? [])].reverse().find((r) => r.verification);
  if (!last) return null;
  const v = last.verification;
  // `detail` already spells out the kind mismatch and the times-seen count, so
  // adding the prediction and the kind again made this line say everything
  // three times — in the one place where brevity is the entire feature.
  return `last action: [${last.index}] ${last.action} — ${v.verdict}: ${v.detail}`;
}

function stepLines(res) {
  const lines = [
    `${res.ok ? 'flow completed' : 'FLOW FAILED'} — ${res.ranSteps}/${res.totalSteps} steps in ${res.totalMs}ms`,
  ];
  for (const r of res.results) {
    const settle = r.settled
      ? r.settled.ok
        ? ` · settled in ${r.settled.waitedMs}ms`
        : ` · WARNING: ${r.settled.stalled ? 'capture stalled' : 'never settled'} after ${r.settled.waitedMs}ms`
      : '';
    lines.push(
      `  ${r.ok ? 'ok  ' : 'FAIL'} [${r.index}] ${r.action}: ${r.ok ? r.detail : r.error}${settle}`,
    );
  }
  if (!res.ok) lines.push('later steps were not run; the screen is left wherever the failing step stopped');
  return lines;
}

async function doScript(target, args, options) {
  const res = await actions.runScript(target, {
    steps: args.steps,
    autoSettle: args.autoSettle,
    stableMs: args.stableMs,
    timeoutMs: args.timeoutMs,
    continueOnError: args.continueOnError,
    // The plan's briefing for its own first responder. Ignored when no
    // supervisor is enabled, so passing it is always safe.
    supervise: args.supervise,
    options,
  });

  const lines = stepLines(res);
  // A map read without settling is not a reading of the screen you are now on,
  // and it used to arrive looking exactly like one. Reported: two taps under
  // `autoSettle:false` returned a map showing nothing had happened, so the
  // agent moved on — the page had in fact zoomed all the way out, and they only
  // found out two calls later when an unrelated failure printed a real map.
  if (args.autoSettle === false) {
    lines.push('autoSettle was off, so the map below was read without waiting for the last action to finish'
      + ' — it may describe the screen before that action landed. Re-read (sim_ui) before acting on it.');
  }
  // Every local ruling is reported, because a wrong one has to be correctable
  // rather than mysterious — and the model's own stated reason is shown as its
  // claim, not as the ground for what happened.
  for (const s_ of res.supervisions ?? []) {
    lines.push(`supervisor at step ${s_.index}: ${s_.decision} — ${s_.outcome}`
      + (s_.reason ? ` (it said: "${s_.reason}")` : ''));
  }
  if (args.saveAs) {
    const saved = navigate.saveFlow(res.device.udid, args.saveAs, res);
    lines.push(
      saved.ok
        ? `saved as flow "${saved.name}" (${saved.steps} steps) — replay with sim_flow_run`
        : `NOT saved as "${args.saveAs}": ${saved.reason}${saved.verdicts ? ` (${saved.verdicts.join(', ')})` : ''}`,
    );
  }
  const escalated = (res.results ?? []).some((r) => metrics.ESCALATING_VERDICTS.has(r.verification?.verdict));
  lines.push('', await mapFrom(target, options, res.endScreen, {
    verdictLine: verdictLineFor(res.results),
    flowOk: res.ok,
    escalated,
  }));

  const content = [text(lines.join('\n'))];
  // Images only when explicitly asked for. A frame attached to every flow was
  // the largest single cost in this server, and it answered a question the map
  // answers better.
  if (args.images) for (const f of res.frames) content.push(image(f.png));
  return { content, isError: !res.ok };
}

/** Every single-action tool is one sim_do step, so verification works the same way. */
async function oneStep(target, step, args, options) {
  const clean = Object.fromEntries(Object.entries(step).filter(([, v]) => v !== undefined));
  return await doScript(target, { ...args, steps: [clean], saveAs: undefined }, options);
}

async function goto(target, args, options) {
  const { device } = await api.ensureDaemon(target, options);
  if (!args.screen) {
    const known = navigate.knownScreens(device.udid);
    if (!known.length) {
      return {
        content: [text('no screens remembered on this device yet — drive a flow with sim_do and simframe learns them as it goes')],
      };
    }
    return {
      content: [
        text(
          `${known.length} screen(s) simframe can navigate to:\n` +
            known.map((k) => `  ${k.hash}  ${k.edges} exit(s)  ${k.name}`).join('\n'),
        ),
      ],
    };
  }

  const res = await navigate.goto(target, args.screen, { options });
  if (!res.ok && res.reason) {
    const why = {
      'unknown-screen': `no remembered screen matches "${args.screen}". Known: ${(res.known ?? []).map((k) => k.name).join(', ') || 'none'}`,
      ambiguous: `"${args.screen}" fits ${(res.candidates ?? []).length} screens equally: ${(res.candidates ?? []).map((c) => c.name).join(', ')} — say which`,
      'no-route': `"${res.to}" is known, but no remembered path reaches it from where you are (${res.from})`,
      'unreplayable-edge': `the route to "${res.to}" includes a step simframe cannot replay exactly`,
    }[res.reason] ?? res.reason;
    return { isError: true, content: [text(`sim_goto refused rather than guess: ${why}`)] };
  }

  const lines = res.already
    ? [`already on "${res.screen}"`]
    : [
        `${res.ok ? 'arrived at' : 'DID NOT REACH'} "${res.screen}" in ${res.ranSteps}/${res.steps.length} remembered steps`,
        ...(res.results ?? []).map((r) => `  ${r.ok ? 'ok  ' : 'FAIL'} [${r.index}] ${r.action}: ${r.ok ? r.detail : r.error}`),
      ];
  lines.push('', await mapFrom(target, options, null));
  return { content: [text(lines.join('\n'))], isError: !res.ok };
}

async function flowRun(target, args, options) {
  const { device } = await api.ensureDaemon(target, options);
  if (!args.name) {
    const flows = navigate.listFlows(device.udid);
    return {
      content: [
        text(
          flows.length
            ? `saved flows:\n${flows.map((f) => `  ${f.name} (${f.steps} steps)`).join('\n')}`
            : 'no saved flows — run one with sim_do and pass saveAs',
        ),
      ],
    };
  }
  const res = await navigate.runFlow(target, args.name, { options });
  if (res.reason === 'unknown-flow') {
    return {
      isError: true,
      content: [text(`no flow called "${args.name}". Saved: ${(res.known ?? []).join(', ') || 'none'}`)],
    };
  }
  const lines = [`flow "${args.name}"`, ...stepLines(res)];
  lines.push('', await mapFrom(target, options, res.endScreen, { verdictLine: verdictLineFor(res.results) }));
  return { content: [text(lines.join('\n'))], isError: !res.ok };
}

async function ui(target, args, options) {
  // No accessibility gate here any more. The old sim_ui asked the tree
  // directly, so a machine without idb could capture and tap perfectly well
  // and still not read the screen — even though OCR alone answers most of them.
  const m = await view.screenMap(target, {
    options,
    filter: args.filter,
    interactive: args.interactive,
    all: args.all,
    refresh: args.refresh,
  });
  if (m.identity.state) remember(m.device.udid, m.identity.state);
  // The hint belongs here too: the agent has just looked, so "you do not need
  // to look again" is exactly the thing worth saying at this moment.
  return { content: [text(`${m.text}\n${view.hintFor(m)}`)] };
}

async function find(target, args, options) {
  try {
    const r = await api.locate(target, String(args.intent ?? ''), { options });
    const lines = [
      `${r.target.label ?? '(icon-only)'} — tap at (${r.target.x}, ${r.target.y})`,
      `${r.target.region ?? 'content'} · ${r.target.type ?? '?'} · seen by ${r.target.source} · score ${r.score ?? '-'}`,
    ];
    if (r.reasons?.length) lines.push(`chosen because: ${r.reasons.join(', ')}`);
    if (r.alternatives?.length) {
      lines.push(`also considered: ${r.alternatives.map((a) => `"${a.label}" (${a.score})`).join(', ')}`);
    }
    return { content: [text(lines.join('\n'))] };
  } catch (err) {
    return { isError: true, content: [text(err.message)] };
  }
}

async function capture(target, args, options) {
  if (args.action === 'start') {
    const res = await api.ensureDaemon(target, { ...options, fps: args.fps ?? options.fps });
    return {
      content: [
        text(
          `${res.started ? 'started' : 'already running'} — ${res.device.name}, frame #${res.state.seq}`,
        ),
      ],
    };
  }
  if (args.action === 'stop') {
    const udids = target ? [(await api.ensureDaemon(target, options)).device.udid] : listStateDirs();
    const stopped = udids.filter((u) => api.stopDaemon(u));
    return { content: [text(`stopped ${stopped.length} capture loop(s)`)] };
  }
  const rows = listStateDirs().map((udid) => {
    const { meta, pid, alive } = api.daemonStatus(udid);
    const s = store.readJson(store.paths(udid).state);
    return `${alive ? '●' : '○'} ${meta?.device?.name ?? udid} pid=${pid ?? '-'} frame=#${s?.seq ?? '-'} age=${s ? Date.now() - s.capturedAt : '-'}ms`;
  });
  return { content: [text(rows.join('\n') || 'no capture loops running')] };
}

function listStateDirs() {
  try {
    return fs.readdirSync(store.ROOT);
  } catch {
    return [];
  }
}

async function devices() {
  const booted = await bootedDevices();
  if (!booted.length) return { content: [text('no booted devices')] };
  // Noticing a name collision here is what lets every later header disambiguate
  // itself, and it costs nothing: this listing is already being made.
  const clash = noteBooted(booted);
  const list = booted.map((d) => `${d.name} · ${d.runtime} · ${d.udid}`).join('\n');
  return { content: [text(clash ? `${clash}\n\n${list}` : list)] };
}
