Goal: human-speed simulator control; Claude consulted at milestones, not per step.
Architecture: persistent Swift daemon; IOSurface framebuffer capture; 9-arg Indigo HID (iOS 26); Unix socket + thin CLI; MCP server and skill as front-ends.
Perception order: AX tree → Vision OCR + classical CV fused → local model only if ambiguous → Claude.
Return compact text state by default; images only on sim_look, downscaled.
Memory: layout-hash element cache + transition graph.
Non-goals for now: physical devices, Tier-2 model (behind a flag).
Pointers: "see docs/research/ for rationale and benchmarks."
