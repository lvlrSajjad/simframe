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
import { bootedDevices } from './simctl.js';
import * as store from './store.js';

const deviceProp = {
  device: {
    type: 'string',
    description: 'Simulator UDID or name substring. Defaults to the booted simulator.',
  },
};

const TOOLS = [
  {
    name: 'sim_look',
    description:
      'Look at the iOS Simulator screen right now. Returns the newest buffered frame immediately — a background capture loop keeps it warm, so there is no screenshot wait. Use this instead of taking a screenshot. Prefer detail "low" for layout checks and "high" only when you must read small text.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        detail: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'full'],
          description:
            'Image size: low (~420px, cheapest), normal (~700px, default), high (~1100px, readable small text), full (native resolution).',
        },
        maxAgeMs: {
          type: 'number',
          description:
            'If the buffered frame is older than this, wait for a fresher one (default 900).',
        },
      },
    },
  },
  {
    name: 'sim_state',
    description:
      'Cheap TEXT-ONLY check of the simulator screen: a stable screen hash, whether anything has changed SINCE YOUR LAST LOOK in this session, how long the screen has been still, and an ASCII map of which regions moved. Costs a tiny fraction of an image. Use it to poll ("has it finished loading?", "did my tap register?") and call sim_look only when you need to see pixels. The comparison is against the last frame you observed through any simframe tool, so calling this before and after an action is the reliable way to tell whether the action did anything.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        since: {
          type: 'string',
          description:
            'Compare against this specific frame hash instead of your last look. Defaults to your previous observation in this session.',
        },
      },
    },
  },
  {
    name: 'sim_wait',
    description:
      'Block until the screen finishes reacting, then return the frame. Use after a tap, launch or navigation instead of sleeping and screenshotting. Default mode "settle" waits for the screen to CHANGE and then hold still, which is what you want after acting — plain "stable" can return instantly if you call it in the moment before an animation starts. The baseline is whatever you last observed in this session, so the normal pattern is: call sim_state or sim_look, act, then call sim_wait. If the change already completed before you call, that is detected rather than waited out.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        mode: {
          type: 'string',
          enum: ['settle', 'change', 'stable'],
          description:
            'settle (default): wait for a change, then for it to hold still. change: return as soon as it differs from the baseline. stable: return once it is still, even if nothing ever changed.',
        },
        since: {
          type: 'string',
          description:
            'Frame hash to treat as the "before" state. Defaults to your last observation in this session. Pass this when you captured a hash before acting.',
        },
        stableMs: { type: 'number', description: 'How long the screen must hold still for mode "stable" (default 600).' },
        timeoutMs: { type: 'number', description: 'Give up after this long (default 8000).' },
        includeImage: { type: 'boolean', description: 'Attach the resulting frame as an image (default true).' },
        detail: { type: 'string', enum: ['low', 'normal', 'high', 'full'] },
      },
    },
  },
  {
    name: 'sim_strip',
    description:
      'Return the last few buffered frames tiled into ONE image, left to right, oldest first. Lets you understand a transition, animation or flicker in a single call instead of a burst of screenshots. Frames are already buffered, so this looks backwards in time — it does not wait.',
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
      'Look BACKWARDS in time. simframe remembers roughly the last 60 seconds of the screen — every frame for the last 10s, thinned to about 2fps before that. action "timeline" (default) returns a TEXT-ONLY summary of what happened and when: each change, how long ago it started, how long it took, how much of the screen it moved. action "at" returns the buffered frame from a moment in the past. Use this when you look up and find the screen already different, or when something flashed by and you need to know what it was — instead of guessing or re-running the action.',
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
    name: 'sim_do',
    description:
      'Run a whole flow in ONE call: tap, type, scroll, wait and assert, in order. Each action automatically waits for the screen to settle before the next step, using a baseline captured before that action, so steps do not race the UI. This is the fastest way to drive the simulator — a twelve-step flow costs one round trip instead of twelve. Prefer it over single taps whenever you know more than one step ahead. Steps stop at the first failure and the result says exactly which step failed and why. Requires idb for input; observation-only steps work without it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        steps: {
          type: 'array',
          description:
            'Ordered steps. Shorthand forms: {"tap":"Save"} (by accessibility label; add "index" if ambiguous), {"tapAt":{"x":100,"y":200,"space":"points"|"image"}}, {"type":{"into":"Name","text":"Fryer 3"}}, {"paste":{"into":"Notes","text":"long text"}}, {"scroll":"down"}, {"swipe":{"from":[x,y],"to":[x,y]}}, {"button":"HOME"}, {"launch":"com.example.app"}, {"openUrl":"myapp://x"}, {"waitText":"Saved","timeoutMs":5000}, {"assertText":"Saved"}, {"assertGone":"Spinner"}, {"settle":{"stableMs":600}}, {"look":{"detail":"low"}}, {"pause":300}.',
          items: { type: 'object' },
        },
        autoSettle: {
          type: 'boolean',
          description: 'Wait for the screen to settle after each action (default true). Turn off only for deliberate rapid input.',
        },
        stableMs: { type: 'number', description: 'How still the screen must be to count as settled (default 500).' },
        timeoutMs: { type: 'number', description: 'Per-step settle timeout (default 8000).' },
        continueOnError: { type: 'boolean', description: 'Keep going after a failed step (default false).' },
        finalLook: { type: 'boolean', description: 'Attach a frame of the end state (default true).' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'sim_ui',
    description:
      'Read the screen as an accessibility tree instead of an image: every element with its label, value, type and position in points. Often cheaper AND more useful than a screenshot, because it tells you what is actually tappable and gives exact coordinates — no measuring pixels by eye. Use it before tapping something you are unsure about. Requires idb.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        filter: { type: 'string', description: 'Only elements whose label, value or identifier contains this text.' },
        interactive: { type: 'boolean', description: 'Only elements that look tappable (buttons, fields, cells).' },
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
        case 'sim_do':
          return await doScript(target, args, options);
        case 'sim_ui':
          return await ui(target, args, options);
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
  let res = await api.getFrame(target, { detail: args.detail ?? 'normal', options });
  if (res.ageMs > maxAge) {
    // Freshness was requested; the loop is already running, so just let it tick.
    const deadline = Date.now() + Math.min(2000, maxAge * 3);
    const p = store.paths(res.device.udid);
    while (Date.now() < deadline) {
      const next = store.readJson(p.state);
      if (next && Date.now() - next.capturedAt <= maxAge) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    res = await api.getFrame(target, { detail: args.detail ?? 'normal', options });
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
  const content = [text(`${note}\n${header(res.device, res.state, Date.now() - res.state.capturedAt)}`)];
  if (args.includeImage !== false) {
    const frame = await api.getFrame(target, { detail: args.detail ?? 'normal', options });
    content.push(image(frame.png));
  }
  return { content };
}

async function strip(target, args, options) {
  const res = await api.getStrip(target, {
    count: Math.min(12, args.count ?? 5),
    spanMs: args.spanMs,
    thumbMaxDim: args.thumbMaxDim ?? 240,
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

async function doScript(target, args, options) {
  const res = await actions.runScript(target, {
    steps: args.steps,
    autoSettle: args.autoSettle,
    stableMs: args.stableMs,
    timeoutMs: args.timeoutMs,
    continueOnError: args.continueOnError,
    options,
  });

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

  const content = [text(lines.join('\n'))];
  for (const f of res.frames) content.push(image(f.png));
  if (args.finalLook !== false) {
    const frame = await api.getFrame(target, { detail: args.detail ?? 'normal', options });
    remember(res.device.udid, frame.state);
    content.push(text(`end state — ${header(frame.device, frame.state, frame.ageMs)}`), image(frame.png));
  }
  return { content, isError: !res.ok };
}

async function ui(target, args, options) {
  const { device } = await api.ensureDaemon(target, options);
  const driver = await input.detectDriver();
  if (!driver.available) return { isError: true, content: [text(driver.reason)] };

  let nodes = await input.describeAll(device.udid);
  if (args.filter) {
    const q = String(args.filter).toLowerCase();
    nodes = nodes.filter((n) =>
      [n.label, n.value, n.identifier].filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }
  if (args.interactive) {
    nodes = nodes.filter((n) => /button|field|cell|link|switch|slider|tab|menu/i.test(n.type || ''));
  }
  if (!nodes.length) return { content: [text('no matching elements on screen')] };

  const rows = nodes.slice(0, 200).map((n) => {
    const c = input.centerOf(n);
    const name = [n.label, n.value && `= ${n.value}`, n.identifier && `#${n.identifier}`]
      .filter(Boolean)
      .join(' ');
    const fallback = n.rawLabel ? '(icon-only — tap by these coordinates)' : '(unlabelled)';
    return `  ${(n.type || '?').padEnd(14)} ${String(`${c.x},${c.y}`).padEnd(10)} ${name || fallback}`;
  });
  const head = `${device.name} — ${nodes.length} element${nodes.length === 1 ? '' : 's'} (type, tap point in points, label)`;
  const tail = nodes.length > 200 ? `\n  ... ${nodes.length - 200} more; use filter to narrow` : '';
  return { content: [text(`${head}\n${rows.join('\n')}${tail}`)] };
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
