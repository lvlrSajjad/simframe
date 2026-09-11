// Minimal CDP client over a hand-rolled WebSocket — no dependencies, because
// simframe has exactly one runtime dependency and this would not be it.
//
// Node 20 has no global WebSocket, so the upgrade and the framing are done by
// hand. Item 80 records that the upgrade 401s without an `Origin` matching the
// inspector's host; this sends one.
import http from 'node:http';
import crypto from 'node:crypto';

const wsUrl = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);
const u = new URL(wsUrl);

const key = crypto.randomBytes(16).toString('base64');
const req = http.request({
  hostname: u.hostname,
  port: u.port,
  path: u.pathname + u.search,
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    Origin: `http://${u.host}`,
  },
});

/** A client frame must be masked; the server's are not. */
const frame = (text) => {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, masked]);
};

req.on('upgrade', (res, socket) => {
  console.log(`upgraded: ${res.statusCode} ${res.headers.upgrade ?? ''}`);
  let buf = Buffer.alloc(0);
  let id = 0;
  const send = (method, params) => {
    id += 1;
    socket.write(frame(JSON.stringify({ id, method, params })));
    console.log(`-> ${method}`);
    return id;
  };

  const seen = new Map();
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Enough framing to read small unfragmented text frames, which is all CDP
    // sends here. Deliberately not a WebSocket implementation.
    for (;;) {
      if (buf.length < 2) return;
      const len0 = buf[1] & 0x7f;
      let offset = 2;
      let len = len0;
      if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
      else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      if (buf.length < offset + len) return;
      const text = buf.slice(offset, offset + len).toString('utf8');
      buf = buf.slice(offset + len);
      try {
        const msg = JSON.parse(text);
        if (msg.method) {
          seen.set(msg.method, (seen.get(msg.method) ?? 0) + 1);
          // The contents are the whole question: "settled, and these three
          // requests fired with these statuses" is only sayable if the status
          // and the URL are actually in here.
          if (msg.method.startsWith('Network.')) {
            const p = msg.params ?? {};
            const bits = [
              p.requestId && `id=${p.requestId}`,
              p.request?.method && `${p.request.method} ${p.request.url}`,
              p.response && `status=${p.response.status} ${p.response.mimeType ?? ''}`,
              p.response?.timing && 'timing=yes',
              p.encodedDataLength != null && `bytes=${p.encodedDataLength}`,
              p.type && `type=${p.type}`,
            ].filter(Boolean);
            console.log(`   ${msg.method}: ${bits.join('  ')}`);
          }
        }
        else console.log(`<- reply #${msg.id} ${msg.error ? `ERROR ${JSON.stringify(msg.error)}` : JSON.stringify(msg.result).slice(0, 120)}`);
      } catch { /* not JSON; ignore */ }
    }
  });

  send('Network.enable', {});
  send('Runtime.enable', {});
  send('Log.enable', {});

  // Trigger real traffic through the app's own JS runtime, rather than through
  // its UI. This isolates the question — does React Native's networking layer
  // report to CDP at all — from whether my app happens to call anything, and it
  // needs no screen, so it does not fight whatever else is driving the device.
  setTimeout(() => {
    send('Runtime.evaluate', {
      expression: "fetch('https://jsonplaceholder.typicode.com/todos/1')"
        + ".then(r => r.json()).then(j => 'FETCHED ' + JSON.stringify(j))",
      awaitPromise: true,
      returnByValue: true,
    });
  }, 1500);

  setTimeout(() => {
    console.log('\nevents received, by method:');
    if (!seen.size) console.log('  (none)');
    for (const [m, n] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}x ${m}`);
    socket.destroy();
    process.exit(0);
  }, seconds * 1000);
});
req.on('response', (res) => { console.log(`NOT upgraded: ${res.statusCode}`); process.exit(1); });
req.on('error', (e) => { console.log('error:', e.message); process.exit(1); });
req.end();
