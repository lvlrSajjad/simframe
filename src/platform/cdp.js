// A dependency-free Chrome DevTools Protocol client.
//
// Hand-rolled rather than `ws`, and not because of ideology: CLAUDE.md keeps
// the runtime dependency list at exactly one (the MCP SDK), and the alternative
// does not exist anyway. The global `WebSocket` is **absent on Node 18 and
// flag-only on Node 20** — verified here on v20.20.0, where `typeof WebSocket`
// is `undefined` — and this package supports 18, 20 and 22. So the choice is
// between a dependency and forty lines of RFC 6455, and forty lines is smaller
// than the surface a dependency brings.
//
// The other thing a probe on 2026-09-11 established, recorded because it costs
// an afternoon to rediscover: Chrome refuses the upgrade with **401
// Unauthorized** when an `Origin` header is present and does not match the
// inspector's own host. A browser's own WebSocket API always sends one and
// cannot change it, which is why a page cannot drive CDP — and why a
// hand-rolled client, which simply omits the header, can.
//
// Scope: enough CDP to be the transport under `src/platform/web.js`. It speaks
// one target at a time, it does not multiplex sessions, and it has no
// reconnection policy. Anything cleverer belongs above the boundary or nowhere.
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';

/** RFC 6455's fixed GUID, concatenated with the client key to prove the handshake. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** Ask a browser what it has open. `targetId` is the udid: a tab is a device. */
export function listTargets(port, host = '127.0.0.1', { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/json/list', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`the browser's debugging endpoint answered ${res.statusCode} — is it running with --remote-debugging-port=${port}?`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error(`the debugging endpoint returned something that is not JSON: ${err.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`no answer from ${host}:${port} within ${timeoutMs}ms`)); });
    req.on('error', (err) => reject(new Error(
      `cannot reach a browser on ${host}:${port} — ${err.message}.`
      + ' Start one with --remote-debugging-port, or pass --port.',
    )));
  });
}

/**
 * One frame, encoded.
 *
 * Client frames must be masked — an unmasked client frame is a protocol error
 * and Chrome closes the socket rather than answering, which reads as a hang.
 */
function encodeFrame(payload, opcode = OPCODE.text) {
  const data = Buffer.from(payload, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = data.length;
  const header = len < 126
    ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536
      ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(len); return b; })()])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Pull whole frames out of a growing buffer.
 *
 * Returns the frames it could complete and what is left over. CDP replies
 * routinely exceed one TCP segment — a full accessibility tree is tens of
 * kilobytes — so a reader that assumes one frame per `data` event works on a
 * hello-world and fails on the first real payload.
 */
export function decodeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) break;
    const opcode = rest[0] & 0x0f;
    const fin = Boolean(rest[0] & 0x80);
    const masked = Boolean(rest[1] & 0x80);
    let len = rest[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (rest.length < 10) break;
      len = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? rest.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (rest.length < offset + len) break;
    let payload = rest.subarray(offset, offset + len);
    if (maskKey) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    }
    frames.push({ opcode, fin, payload });
    rest = rest.subarray(offset + len);
  }
  return { frames, rest };
}

/**
 * Open a CDP session against a websocket URL from `listTargets`.
 *
 * Resolves once the upgrade is accepted, so a caller that gets a connection has
 * a usable one — the failure mode this avoids is a `send` that queues silently
 * against a socket the browser refused.
 */
export function connect(wsUrl, { timeoutMs = 5000 } = {}) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 80) });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`the browser did not complete the websocket upgrade within ${timeoutMs}ms`)), timeoutMs);

    socket.on('error', (err) => fail(new Error(`cannot open a debugging socket: ${err.message}`)));
    socket.on('connect', () => {
      // No `Origin` header, deliberately. Chrome answers 401 when one is
      // present and does not match the inspector's host, and nothing here needs
      // to claim an origin.
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n`
        + `Host: ${url.host}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });

    let handshake = Buffer.alloc(0);
    const onHandshake = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = handshake.subarray(0, end).toString('latin1');
      const status = /^HTTP\/1\.1 (\d+)/.exec(head)?.[1];
      if (status !== '101') {
        fail(new Error(
          `the browser refused the debugging socket with HTTP ${status ?? '(no status)'}.`
          + (status === '401'
            ? ' That is the Origin check: Chrome rejects an upgrade whose Origin header does not'
              + ' match the inspector host. This client sends none, so something else set one.'
            : ' Check the target still exists — a closed tab keeps its id but not its socket.'),
        ));
        return;
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (accept !== expected) {
        fail(new Error('the browser accepted the upgrade with a key that does not match — this is not a websocket peer'));
        return;
      }
      clearTimeout(timer);
      settled = true;
      socket.removeListener('data', onHandshake);
      resolve(session(socket, handshake.subarray(end + 4)));
    };
    socket.on('data', onHandshake);
  });
}

/** A connected session: one id space, one pending map, text frames only. */
function session(socket, leftover) {
  let buffer = leftover ?? Buffer.alloc(0);
  let nextId = 1;
  let closedWith = null;
  const pending = new Map();
  const listeners = new Set();

  const rejectAll = (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === OPCODE.ping) { socket.write(encodeFrame(frame.payload.toString('utf8'), OPCODE.pong)); continue; }
      if (frame.opcode === OPCODE.close) { closedWith = 'the browser closed the debugging socket'; socket.end(); continue; }
      if (frame.opcode !== OPCODE.text) continue;
      let message;
      try { message = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
      if (message.id != null && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        // A CDP error is a reply, not a transport failure, and it carries the
        // only sentence that says what was wrong with the call.
        if (message.error) reject(new Error(`${message.error.message ?? 'CDP error'}${message.error.data ? ` — ${message.error.data}` : ''}`));
        else resolve(message.result ?? {});
      } else if (message.method) {
        for (const fn of listeners) { try { fn(message); } catch { /* a listener must not break the socket */ } }
      }
    }
  });

  socket.on('close', () => { rejectAll(new Error(closedWith ?? 'the debugging socket closed')); });
  socket.on('error', (err) => { rejectAll(new Error(`debugging socket error: ${err.message}`)); });

  return {
    /** One CDP call. Rejects with the browser's own message on a protocol error. */
    send(method, params = {}, { timeoutMs = 10000 } = {}) {
      if (socket.destroyed) return Promise.reject(new Error(closedWith ?? 'the debugging socket is closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} did not answer within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        socket.write(encodeFrame(JSON.stringify({ id, method, params })));
      });
    },
    /** Subscribe to CDP events. Returns an unsubscribe. */
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() { try { socket.end(encodeFrame('', OPCODE.close)); } catch { socket.destroy(); } },
    get closed() { return socket.destroyed; },
  };
}
