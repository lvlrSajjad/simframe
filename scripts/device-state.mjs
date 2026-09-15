// Is a failed CI step the device's fault or the check's?
//
// Its own module, and the reason is the same one that moved `classifyStray` out
// of `eval-fingerprint.mjs`: `ci-device-guard.mjs` reads `process.argv` and
// `process.exit(2)`s at import, so nothing could ever test this table there —
// and the only thing that exercised it was a hosted runner, at the end of a
// fifteen-minute job, in the middle of a report. Two runtime bugs in this
// project came from logic that was correct and had never executed.
//
// Every entry here has been seen in a real run. Adding one from imagination is
// how a guard starts reviving genuine failures into passes.

/** Conditions that are the simulator, not the code. Each seen in a real run. */
export const DEVICE_STATE = [
  [/NSPOSIXErrorDomain.*code=?\s*60|Operation timed out/i, 'simctl stopped answering (NSPOSIXErrorDomain 60)'],
  [/did not produce a frame|produced no frame in \d+s/i, 'the daemon is up and the display renders nothing'],
  [/Timeout waiting for screen surfaces|display surface is not answering|display surface could not be read/i, 'the display surface is wedged'],
  [/no frames buffered|capture is wedged/i, 'capture stopped'],
  [/the second app never launched|could not be dispatched/i, 'an app would not launch'],
  // A launched app that never comes to the front, seen as the tour waiting for
  // one of its landmarks on a screen that is showing a clock and nothing else.
  //
  // Measured on a runner: `ok launch — launched com.apple.Preferences
  // (relaunched)` followed by `waited 8000ms for General: "General" is not on
  // this screen. Visible: 10:50, .?o (the screen has not moved for 6181ms)`.
  // Two labels, one of them a clock, on a still screen — the device is not
  // presenting the app, and the guard called that a check failing on its
  // merits and declined to revive.
  //
  // Deliberately narrow. It requires the wait to have failed AND the screen to
  // have been still AND almost nothing readable: a tour that genuinely asks for
  // the wrong label has a screen full of other labels, and must keep failing
  // rather than being retried into a pass.
  [
    /never arrived[\s\S]*?Visible:[^\n]{0,24}\(the screen has not moved for \d+ms/i,
    'a launched app never came to the front (the screen shows a clock and nothing else)',
  ],
  // The same condition, now said outright by the step that suffered it instead
  // of inferred from the shape of the screen afterwards. Item 169 gave `launch`
  // a pid to compare, so a launch that starts a process and never fronts it
  // reports itself; this signature fires on the cause rather than on a
  // consequence that had to be recognised by "two labels, one a clock".
  //
  // It cannot be triggered by a tour asking for the wrong label — only a failed
  // launch emits this sentence — so it needs none of the narrowing above.
  [
    /never came to the front within \d+ms/i,
    'a launched app never came to the front (the launch said so itself, by pid)',
  ],
  // Seen on the v0.14.3 bench run: `could not launch com.apple.Preferences:
  // The system shell (SpringBoard:36454) probably crashed.` The guest's window
  // server going down is the device, not the check, and nothing here matched it.
  [
    /system shell \(SpringBoard[^)]*\) probably crashed/i,
    "the guest's SpringBoard crashed, so nothing can be fronted",
  ],
];

/** The condition this output shows, or null when the check failed on its merits. */
export function deviceCause(text) {
  return DEVICE_STATE.find(([re]) => re.test(String(text ?? '')))?.[1] ?? null;
}
