// Kept as a re-export: the table moved to `src/device-state.js` so `src/` can
// use it without importing out of `scripts/`. `ci-device-guard.mjs` and the
// unit test both reach it through this path, and a redirect is cheaper than
// updating every caller for a move that changes nothing about the table.
export { DEVICE_STATE, deviceCause } from '../src/device-state.js';
