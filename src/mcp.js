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
import * as navigate from './navigate.js';
import { bootedDevices, PERMISSION_SERVICES } from './simctl.js';
import * as store from './store.js';
import * as view from './view.js';

const deviceProp = {
  device: {
    type: 'string',
    description: 'Simulator UDID or name substring. Defaults to the booted simulator.',
  },
};

/**
 * One selector grammar everywhere.
 *
 * `#3` is the cheapest thing a caller can say and the least ambiguous, because
 * simframe numbered it; a bare phrase is resolved by intent, which is more
 * forgiving and occasionally has to ask which one was meant.
 */
const SELECTOR = 'Selector: "#3" (a number from the last screen map — cheapest and unambiguous), a label or phrase like "Save" or "the Assets tab" (resolved by intent), or "@120,400" for raw point coordinates.';

const selectorProp = (what = 'What to act on') => ({
  sel: { type: 'string', description: `${what}. ${SELECTOR}` },
});

const TOOLS = [
  {
    name: 'sim_ui',
    description:
      'READ THE SCREEN. Returns a compact text map: every element with a number, its region (nav-bar / content / tab-bar), type, label, state and tap point, plus which screen this is and how much simframe already knows about it. Roughly a tenth the cost of a screenshot and strictly more useful, because it says what is tappable and where — no measuring pixels by eye. The numbers are selectors: whatever this returns as #3, you can tap as "#3". Start here, not with sim_look.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
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
      'THE MAIN TOOL. Run a whole flow in ONE call: tap, type, scroll, wait and assert, in order. Each step waits for the screen to settle against a baseline captured before it, and is verified against what that action did here last time — so a step that navigated somewhere unintended stops the flow instead of tapping on into the wrong screen. A twelve-step flow costs one round trip instead of twelve. Prefer this over the single-action tools whenever you know more than one step ahead, and put asserts in the flow rather than checking between calls. Returns the compact screen map of where the flow ended; no image.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        steps: {
          type: 'array',
          description:
            'Ordered steps. Every selector below accepts "#3" | "Save" | "@120,400". Act: {"tap":"Save"} (add "index" if a label is ambiguous), {"type":{"into":"Name","text":"Fryer 3"}}, {"paste":{"into":"Notes","text":"long text"}}, {"scroll":"down"}, {"scrollTo":"Delete account"}, {"swipe":{"from":[x,y],"to":[x,y]}}, {"button":"HOME"}, {"launch":{"value":"com.example.app","relaunch":true,"args":["-uiTest","1"]}}, {"openUrl":"myapp://x"}, {"permission":{"value":"photos","grant":"grant","bundleId":"com.example.app"}}. Check: {"assert":{"value":"Saved","is":"visible"}} (also gone | enabled | disabled | value with "equals"), {"waitFor":{"value":"Saved","timeoutMs":5000}}, {"settle":{"stableMs":600}}, {"pause":300}.',
          items: { type: 'object' },
        },
        autoSettle: {
          type: 'boolean',
          description: 'Wait for the screen to settle after each action (default true). Turn off only for deliberate rapid input.',
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
      properties: { ...deviceProp, ...selectorProp('What to tap'), index: { type: 'number', description: 'Which match, when the selector fits several.' } },
      required: ['sel'],
    },
  },
  {
    name: 'sim_type_into',
    description: 'Focus a field and type into it. Prefer a sim_do step when this is part of a sequence.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, ...selectorProp('The field'), text: { type: 'string' }, paste: { type: 'boolean', description: 'Use the pasteboard instead of the keyboard — much faster for long strings.' } },
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
      properties: { ...deviceProp, ...selectorProp('What to wait for'), timeoutMs: { type: 'number', description: 'Default 8000.' } },
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
      'Walk to a screen simframe has already been to, by name, planning the route through remembered transitions and verifying every step. Zero reasoning and zero images: the graph knows which taps lead where. Refuses rather than guesses — if the destination is unknown, ambiguous, or unreachable through known transitions, it says which and lists what it does know. Call it with no target to see the known screens.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, screen: { type: 'string', description: 'What the screen is called, e.g. "Settings" or an 8-character screen hash. Omit to list what is known.' } },
    },
  },
  {
    name: 'sim_flow_run',
    description: 'Replay a saved flow by name, verifying each step. Omit `name` to list the saved flows. Save one with sim_do\'s `saveAs`.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, name: { type: 'string', description: 'Flow to run. Omit to list.' } },
    },
  },
  {
    name: 'sim_launch',
    description: 'Launch or relaunch an app, optionally with launch arguments and environment variables — the way to put an app into a test mode without touching its UI.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
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
    description: 'Open a URL or deep link on the simulator — the fastest way to reach a screen when the app has a link for it.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'sim_permission',
    description: `Grant, revoke or reset a privacy permission for an app. Do this instead of tapping the system alert: the alert is not part of the app under test, and its buttons move between iOS versions. Services: ${PERMISSION_SERVICES.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
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
      'Resolve an intent to one control: "tap Save", "the Assets tab", "back". Understands verbs, typos, where on screen you meant, and icon-only controls by their common name. When two things answer equally well it says so and lists them rather than guessing — a wrong tap is worse than a question, because it can do something and leave you believing it did the right thing. Use it when you are unsure a selector will resolve; otherwise just tap.',
    inputSchema: {
      type: 'object',
      properties: { ...deviceProp, intent: { type: 'string', description: 'What you want to act on, in your own words.' } },
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
        since: { type: 'string', description: 'Compare against this frame hash instead of your last look.' },
      },
    },
  },
  {
    name: 'sim_wait',
    description:
      'Block until the screen finishes reacting. Default mode "settle" waits for the screen to CHANGE and then hold still, which is what you want after acting — plain "stable" can return instantly in the moment before an animation starts. Returns the compact screen map by default, not an image. Inside a flow you rarely need this: sim_do settles after every step already.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
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
      'THE ONLY TOOL THAT RETURNS AN IMAGE, and the most expensive one. Returns the newest buffered frame immediately — no screenshot wait. Call it only when the text map is genuinely not enough: checking visual layout, colour, spacing, an animation, or something the accessibility tree and OCR both cannot see. For "what is on screen and what can I tap", sim_ui answers better and costs a tenth as much.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        detail: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Image size: low (~420px, cheapest), normal (~700px, default), high (1024px, readable small text). Capped at 1024px on the long edge.',
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
        count: { type: 'number', description: 'How many frames to tile (default 5, max 12).' },
        spanMs: { type: 'number', description: 'Only include frames from the last N milliseconds.' },
        thumbMaxDim: { type: 'number', description: 'Height budget per frame in pixels (default 240).' },
      },
    },
  },
  {
    name: 'sim_recall',
    description:
      'Look BACKWARDS in time. simframe remembers roughly the last 60 seconds of the screen. action "timeline" (default) returns a TEXT-ONLY summary of what happened and when: each change, how long ago, how long it took, how much of the screen moved. action "at" returns the buffered frame from a past moment — an image. Use this when you look up and find the screen already different, instead of re-running the action.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
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
        fps: { type: 'number', description: 'Capture rate while the screen is moving (default 4).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'sim_devices',
    description: 'List booted iOS simulators that simframe can capture.',
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

function header(device, state, ageMs, extra = '') {
  return (
    `${device.name} · ${device.runtime} · frame #${state.seq} · ${ageMs}ms old · ` +
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

export async function serve({ device: defaultDevice, options = {} } = {}) {
  const server = new Server(
    { name: 'simframe', version: packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments || {};
    const target = args.device || defaultDevice;
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
  const warn = livenessLine(st.live);
  if (warn) lines.unshift(warn);
  return { content: [text(lines.filter(Boolean).join('\n')), image(res.png)] };
}

async function state(target, args, options) {
  const { device } = await api.ensureDaemon(target, options);
  const requested = baselineFor(device.udid, args.since);
  const res = await api.getState(target, { since: requested, options });
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
async function mapFrom(target, options, identity, extra = {}) {
  try {
    const m = await view.screenMap(target, { options, identity: identity?.entry ? identity : undefined });
    return view.render({ ...m, ...extra });
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
    options,
  });

  const lines = stepLines(res);
  if (args.saveAs) {
    const saved = navigate.saveFlow(res.device.udid, args.saveAs, res);
    lines.push(
      saved.ok
        ? `saved as flow "${saved.name}" (${saved.steps} steps) — replay with sim_flow_run`
        : `NOT saved as "${args.saveAs}": ${saved.reason}${saved.verdicts ? ` (${saved.verdicts.join(', ')})` : ''}`,
    );
  }
  lines.push('', await mapFrom(target, options, res.endScreen, { verdictLine: verdictLineFor(res.results) }));

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
  return { content: [text(m.text)] };
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
  if (!booted.length) return { content: [text('no booted simulators')] };
  return {
    content: [text(booted.map((d) => `${d.name} · ${d.runtime} · ${d.udid}`).join('\n'))],
  };
}
