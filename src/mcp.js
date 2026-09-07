// MCP server. The point of every tool here is that the expensive part
// (capturing) already happened in the background, so a call is a file read.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { REGION_COLS, REGION_ROWS, regionMap } from './analyze.js';
import * as api from './index.js';
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
      'Cheap TEXT-ONLY check of what the simulator screen is doing: a stable screen hash, how long it has been still, how much changed since the last frame, and an ASCII map of which regions moved. Costs a tiny fraction of an image. Use this to poll ("has it finished loading?", "did my tap do anything?") and only call sim_look when you actually need to see pixels.',
    inputSchema: { type: 'object', properties: { ...deviceProp } },
  },
  {
    name: 'sim_wait',
    description:
      'Block until the simulator screen settles (mode "stable") or until it changes away from what it shows now (mode "change"), then return the frame. Use this after a tap, launch or navigation instead of screenshotting repeatedly and hoping the animation finished.',
    inputSchema: {
      type: 'object',
      properties: {
        ...deviceProp,
        mode: {
          type: 'string',
          enum: ['stable', 'change'],
          description: 'stable: wait for the screen to stop moving. change: wait for it to differ from now.',
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

const text = (s) => ({ type: 'text', text: s });
const image = (png) => ({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });

function header(device, state, ageMs, extra = '') {
  return (
    `${device.name} · ${device.runtime} · frame #${state.seq} · ${ageMs}ms old · ` +
    `${state.width}x${state.height} · still for ${state.stableForMs}ms${extra ? ` · ${extra}` : ''}`
  );
}

export async function serve({ device: defaultDevice, options = {} } = {}) {
  const server = new Server(
    { name: 'simframe', version: '0.1.0' },
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
          return await state(target, options);
        case 'sim_wait':
          return await wait(target, args, options);
        case 'sim_strip':
          return await strip(target, args, options);
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
  return {
    content: [text(header(res.device, res.state, res.ageMs)), image(res.png)],
  };
}

async function state(target, options) {
  const res = await api.getState(target, { options });
  const s = res.state;
  const body = [
    header(res.device, s, res.ageMs),
    `screen hash: ${s.hash}   change since previous frame: ${(s.diff * 100).toFixed(1)}%`,
    s.stableForMs > 1200 ? 'screen is idle' : 'screen is currently changing',
    `region change map (${REGION_COLS}x${REGION_ROWS}, top-left to bottom-right; "." to "#" = more movement):`,
    regionMap(s.regions || []),
  ].join('\n');
  return { content: [text(body)] };
}

async function wait(target, args, options) {
  const res = await api.waitFor(target, {
    mode: args.mode ?? 'stable',
    stableMs: args.stableMs ?? 600,
    timeoutMs: args.timeoutMs ?? 8000,
    options,
  });
  const note = res.satisfied
    ? `${res.mode === 'change' ? 'screen changed' : 'screen settled'} after ${res.waitedMs}ms`
    : `TIMED OUT after ${res.waitedMs}ms — screen never ${res.mode === 'change' ? 'changed' : 'settled'}`;
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
