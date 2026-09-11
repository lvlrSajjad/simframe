/**
 * Where the testbed gets its data, and where it fails on purpose.
 *
 * Two modes, and the default is the boring one.
 *
 * **Offline (default).** Content is local, delays come from the seeded stream,
 * and failures are injected at known points. This is the mode the supervisor
 * items need: a ruling is only scoreable if the failure that provoked it can be
 * reproduced, and `ci-integration-local.sh` must not depend on the internet.
 *
 * **Live.** The same screens against a real public API, so there is genuine
 * network latency, genuine error bodies, and genuine traffic for simframe's
 * network visibility work (DEFERRED 80) to observe. Switched from outside so a
 * session can move between them without a rebuild:
 *
 *   simframe do '[{"openUrl":"simframetestbed://live/on"}]'
 *
 * Live mode deliberately points at endpoints that let a caller *ask* for a
 * delay or an error, rather than waiting for one to happen: a 500 you can
 * summon is worth more than a 500 you might see.
 */
import { between, chance, delayMs, random } from './seed';

export type Mode = 'offline' | 'live';

let mode: Mode = 'offline';
export const currentMode = (): Mode => mode;
export const setMode = (to: Mode): void => { mode = to; };

/** A public, no-auth API. Content for lists, and summonable failures. */
const CONTENT = 'https://jsonplaceholder.typicode.com';
const CONTROL = 'https://httpbin.org';

export type Item = { id: number; title: string; body: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The local corpus. Stable text, because the screen's *shape* is the subject. */
const LOCAL: Item[] = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1,
  // Deliberately a domain nobody here works in, and deliberately varied in
  // length: a two-word label and a five-word one stress OCR and the region
  // bands differently, and a testbed that mirrors somebody's real product
  // teaches you about that product.
  title: [
    'Monstera', 'Fiddle Leaf Fig', 'Snake Plant', 'Peace Lily',
    'String of Pearls', 'Rubber Plant', 'Boston Fern', 'Jade',
  ][i % 8] + ` #${i + 1}`,
  body: 'Prefers bright indirect light and a thorough watering once the top inch of soil is dry.',
}));

/**
 * How the app reports what it is doing, for the network-visibility work.
 *
 * Kept even in offline mode, on purpose: the *screens* should look identical in
 * both modes, so a fixture recorded offline still describes the live app. What
 * differs is whether bytes crossed a socket.
 */
export type Call = { url: string; method: string; status: number | null; ms: number; mode: Mode };
const calls: Call[] = [];
export const recentCalls = (): Call[] => calls.slice(-20);

async function record<T>(url: string, method: string, run: () => Promise<{ value: T; status: number | null }>): Promise<T> {
  const started = Date.now();
  try {
    const { value, status } = await run();
    calls.push({ url, method, status, ms: Date.now() - started, mode });
    return value;
  } catch (err) {
    calls.push({ url, method, status: null, ms: Date.now() - started, mode });
    throw err;
  }
}

/**
 * A list, eventually.
 *
 * The count header renders before the rows on purpose — it is the shape that
 * has repeatedly fooled settle detection and the supervisor alike, because the
 * screen is *stable* and *incomplete* at the same moment. See `stillFillingIn`
 * on the simframe side.
 */
export async function fetchItems(): Promise<Item[]> {
  if (mode === 'offline') {
    // Slow enough that a step issued straight after launch genuinely races it.
    await sleep(delayMs(1500, 3500));
    return record('local://items', 'GET', async () => ({ value: LOCAL, status: 200 }));
  }
  return record(`${CONTENT}/posts?_limit=24`, 'GET', async () => {
    const res = await fetch(`${CONTENT}/posts?_limit=24`);
    const rows = (await res.json()) as Array<{ id: number; title: string; body: string }>;
    return { value: rows, status: res.status };
  });
}

export async function fetchItem(id: number): Promise<Item> {
  if (mode === 'offline') {
    await sleep(delayMs(250, 900));
    const hit = LOCAL.find((i) => i.id === id) ?? LOCAL[0];
    return record(`local://items/${id}`, 'GET', async () => ({ value: hit, status: 200 }));
  }
  return record(`${CONTENT}/posts/${id}`, 'GET', async () => {
    const res = await fetch(`${CONTENT}/posts/${id}`);
    return { value: (await res.json()) as Item, status: res.status };
  });
}

/**
 * A submit that fails the first time and succeeds on a retry.
 *
 * The single most valuable fixture here. `retry` is one of the supervisor's
 * three words and the only one whose correctness can be checked cheaply: if the
 * step works on the second attempt, `retry` was right. Nothing in Apple's
 * Settings fails on command, which is why the ruling log held one entry.
 */
let submitAttempts = 0;
export const resetSubmits = (): void => { submitAttempts = 0; };

export async function submitForm(fields: Record<string, string>): Promise<{ ok: true }> {
  submitAttempts += 1;
  const failFirst = submitAttempts === 1;
  if (mode === 'offline') {
    await sleep(delayMs(500, 1800));
    if (failFirst) {
      await record('local://submit', 'POST', async () => { throw new Error('offline: injected first-attempt failure'); });
    }
    return record('local://submit', 'POST', async () => ({ value: { ok: true } as const, status: 201 }));
  }
  // Live: ask for the failure rather than hoping for one.
  const url = failFirst ? `${CONTROL}/status/503` : `${CONTENT}/posts`;
  return record(url, 'POST', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error(`the server said ${res.status}`);
    return { value: { ok: true } as const, status: res.status };
  });
}

/**
 * How long a control stays disabled — the `wait` fixture's window.
 *
 * Widened from 1200-4000 after the first attempt to use it failed to race at
 * all: navigating to the form takes a step of its own, and by the time the next
 * step ran the control was already live. A fixture that only sometimes
 * reproduces the condition is a fixture you cannot trust a null result from.
 *
 * Worth recording alongside it: tapping a disabled control does **not** consult
 * the supervisor. The tap is delivered, nothing happens, and simframe reports a
 * `no-visible-change` verdict rather than throwing — and the supervisor is only
 * asked about steps that throw. So the window matters for `waitFor` and
 * `assert` steps, which do throw, not for the tap itself.
 */
export const enableAfterMs = (): number => delayMs(3000, 6000);

/** Whether this run's list should arrive in two waves. */
export const listArrivesInWaves = (): boolean => chance(0.5);

/** How long the first wave takes to be joined by the second. */
export const secondWaveMs = (): number => between(600, 2000);

/** A jittered pull-to-refresh, so no two refreshes take the same time. */
export const refreshMs = (): number => Math.round(400 + random() * 1600);
