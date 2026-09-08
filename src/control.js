// Client for the simframed control socket.
//
// One JSON object per line over a per-device Unix socket. The socket is mode
// 0600, so reachability is the whole authorisation model: if you can open it,
// you are the user who owns the simulator.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as store from './store.js';

export function socketPath(udid) {
  return path.join(store.deviceDir(udid), 'control.sock');
}

/** Whether a daemon is listening for this device. */
export function available(udid) {
  const meta = store.readJson(path.join(store.deviceDir(udid), 'meta.json'));
  if (!meta || !store.isProcessAlive(meta.pid)) return false;
  try {
    return fs.statSync(socketPath(udid)).isSocket();
  } catch {
    return false;
  }
}

export function request(udid, payload, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(udid));
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.setTimeout(timeoutMs, () => finish(reject, new Error('control socket timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.indexOf('\n');
      if (line < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, line));
        if (response.ok === false) finish(reject, new Error(response.error || 'request failed'));
        else finish(resolve, response);
      } catch (err) {
        finish(reject, err);
      }
    });
    socket.on('error', (err) => {
      finish(
        reject,
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? new Error('no simframed daemon is listening for this device')
          : err,
      );
    });
  });
}

export const tap = (udid, x, y, opts = {}) => request(udid, { action: 'tap', x, y, ...opts });
export const swipe = (udid, from, to, opts = {}) =>
  request(udid, { action: 'swipe', x1: from.x, y1: from.y, x2: to.x, y2: to.y, ...opts });
export const type = (udid, text) => request(udid, { action: 'type', text });
export const paste = (udid, text) => request(udid, { action: 'paste', text });
export const press = (udid, button) => request(udid, { action: 'press', button });
export const status = (udid) => request(udid, { action: 'status' });
export const resetInput = (udid) => request(udid, { action: 'resetInput' });
export const longPress = (udid, x, y, opts = {}) => request(udid, { action: 'longPress', x, y, ...opts });
export const drag = (udid, from, to, opts = {}) =>
  request(udid, { action: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, ...opts });
export const launch = (udid, bundleId, opts = {}) => request(udid, { action: 'launch', bundleId, ...opts });
export const terminate = (udid, bundleId) => request(udid, { action: 'terminate', bundleId });
export const openUrl = (udid, url) => request(udid, { action: 'openUrl', url });
export const permission = (udid, permissionAction, service, bundleId) =>
  request(udid, { action: 'permission', permissionAction, service, bundleId });
