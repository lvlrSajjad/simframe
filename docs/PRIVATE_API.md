# Private API reference

**This file is the source of truth for private simulator symbols.** Everything
here was verified against a live runtime on the environment below. The research
documents in `docs/research/` are background and motivation; where they disagree
with this file, this file is right.

Nothing in here is documented by Apple. Treat every symbol as version-coupled
and re-verify after an Xcode upgrade. Verify with the runtime — `NSProtocolFromString`
plus `protocol_copyMethodDescriptionList`, or `class_copyMethodList` — rather
than by reading write-ups, including this one.

## Verified on

| | |
| --- | --- |
| macOS | 15.x (Darwin 25.6.0) |
| Xcode | 26.x, `/Applications/Xcode.app/Contents/Developer` |
| Devices | iPhone 17 Pro / iOS 26.5 (3x) · iPad Pro 13-inch M5 / iOS 26.5 (2x) |
| Date | 2026-09 |

## Frameworks

| Framework | Path | Notes |
| --- | --- | --- |
| CoreSimulator | `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator` | System path, not inside Xcode |
| SimulatorKit | `$(xcode-select -p)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit` | **Not** in `SharedFrameworks` |

Both must be `dlopen`ed before any `NSClassFromString` lookup. Resolve the
developer directory with `xcode-select -p`, honouring `DEVELOPER_DIR`.

## Capture: the sequence that works

```
SimServiceContext                                     (CoreSimulator)
  +sharedServiceContextForDeveloperDir:error:         -> SimServiceContext
  -defaultDeviceSetWithError:                         -> SimDeviceSet
    .availableDevices                                 -> [SimDevice]
      .state == 3                                     -> Booted
      .UDID (NSUUID), .name (NSString), .runtime
      .io                                             -> SimDeviceIOClient
        .ioPorts                                      -> [SimDeviceIOPortInterface]  (13 on a booted iPhone)
          -descriptor                                 -> port descriptor
            conforms to SimDisplayIOSurfaceRenderable
            -displaySize  (CGSize)                    -> MUST be non-zero: this is how you pick the live port
            -framebufferSurface                       -> IOSurface, read on demand
            -registerCallbackWithUUID:damageRectanglesCallback:   -> per-redraw signal
```

### Port selection

A booted device exposes several ports whose descriptors conform to
`SimDisplayIOSurfaceRenderable`. **Only one is live.** On the test iPhone, port
index 1 reported `displaySize` 0x0 and a nil `framebufferSurface` forever; port
index 2 was the real display. Select by non-zero `displaySize` — never by
"first conforming port", and never by index, which is not stable.

Observed port descriptors on a booted iPhone (indices are illustrative, not stable):

| Descriptor | Use |
| --- | --- |
| `SimScreenCaptureService` | — |
| `SimScreen … SimDisplayIOSurfaceRenderable` (x2) | display; one live, one not |
| `SimScreenAdapter` | — |
| `SimAcceleratorMetalDevice`, `SimAcceleratorIOSurface` | — |
| **`SimLegacyHIDDescriptor`** | **input — the Phase 1 entry point** |
| `SimStreamProcessable` (x3) | — |
| `SimAudioHostRoutable` | — |
| `SimDeviceIOMachServiceProvider` (x2) | — |

### Reading pixels

`framebufferSurface` returns an `IOSurface` usable with the public accessors.
Lock read-only, honour `bytesPerRow` (it is **not** `width * 4` — a real surface
reported 4864 for a 1206-wide display), and treat the pixels as **BGRA**.

Do not cache the surface. Re-reading `framebufferSurface` each capture costs
~0.13 ms and means a reallocated surface (rotation, resize) is picked up with no
re-attach.

### Protocol method lists, as declared

`SimDisplayIOSurfaceRenderable`:

| Selector | Encoding |
| --- | --- |
| `registerCallbackWithUUID:ioSurfacesChangeCallback:` | `v32@0:8@16@?24` |
| `unregisterIOSurfacesChangeCallbackWithUUID:` | `v24@0:8@16` |
| `framebufferSurface` | `@16@0:8` |
| `maskedFramebufferSurface` | `@16@0:8` |

`SimDisplayRenderable`:

| Selector | Encoding |
| --- | --- |
| `registerCallbackWithUUID:damageRectanglesCallback:` | `v32@0:8@16@?24` |
| `unregisterDamageRectanglesCallbackWithUUID:` | `v24@0:8@16` |
| `registerCallbackWithUUID:displayPropertiesChanged:` | `v32@0:8@16@?24` |
| `displaySize` | `{CGSize=dd}16@0:8` |
| `displayPitch`, `displaySizeInBytes` | `Q16@0:8` |

`SimDeviceIOPortInterface`: `connectToDeviceIO:`, `disconnect`,
`portIdentifier`, `ioPortClass`, `uuid`, `descriptor`.

The callback blocks are declared untyped (`@?`), so arity cannot be read from
the protocol. `registerCallbackWithUUID:damageRectanglesCallback:` works with a
one-argument block. Keep a strong reference to the block for as long as it is
registered.

## Research said X, reality was Y

| Claim | Reality |
| --- | --- |
| `registerCallbackWithUUID:ioSurfacesChangeCallback:` delivers an IOSurface per frame | It fires when the surface is **reallocated**, which is rare. Registering it and waiting produced **zero** callbacks in 5 s of heavy screen activity. The per-redraw signal is `damageRectanglesCallback:` (~52/s), and pixels come from reading `framebufferSurface`. |
| `mainScreenSurfaceForSimulator:` is a SimulatorKit symbol | It does not exist in SimulatorKit. It appears to be a helper inside idb, not framework API. |
| The unregister selector is `unregisterIOSurfaceChangeCallbackWithUUID:` | It is `unregisterIOSurfacesChangeCallbackWithUUID:` — **plural**. |
| (implied) any port conforming to the renderable protocol will do | Several conform; only the one with non-zero `displaySize` vends a surface. Picking the first match yields a permanently nil `framebufferSurface`, which looks exactly like the API being broken. |

## Not yet verified

Everything below is a **hypothesis** carried over from the research and must be
checked against this machine before any code depends on it.

- `IndigoHIDMessageForMouseNSEvent` with a **9-argument** signature (the
  5-argument form is reported broken on iOS 26).
- Digitizer target `0x32`.
- `SimDeviceLegacyHIDClient` as the input client, reached via the
  `SimLegacyHIDDescriptor` port above.
- `AXPTranslator` / `AccessibilityPlatformTranslation` for the accessibility
  tree. Note `SimAccessibilityManager` also exists in SimulatorKit and may be
  the easier route; both are unverified.

To verify: dump the symbol from the binary on this machine, read the current
source of a working implementation (not its documentation), and confirm the
effect end to end — for input, send one tap at a known coordinate and check
`simframe state --since` reports the expected change. Record the result here.
