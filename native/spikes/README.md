# Spikes

Throwaway programs kept because their *numbers* are not throwaway. Nothing here
is built, shipped, or linked by the daemon; a spike exists to turn a question
into a measurement and then to be readable afterwards.

## `afm-rank-spike.swift` — is Apple's on-device model any use for ranking?

Answers the question the Phase 15 entry in `docs/PHASES-HUMAN-PARITY.md` asks:
given a goal and a list of on-screen labels that none of them lexically match,
can a small local model order them by which is likely to lead to the goal?

Build and run:

```bash
xcrun swiftc -O native/spikes/afm-rank-spike.swift -o /tmp/afm_bench && /tmp/afm_bench
```

Requires macOS 26 with Apple Intelligence enabled. It prints "unavailable" with
a reason otherwise, which is the behaviour any real integration must have too —
`doctor` would report `planner: none` and the existing ladder carries on.

Results as measured on 2026-09-10 are in `docs/BENCHMARKS.md`.
