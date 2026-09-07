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
| `IndigoHIDMessageForMouseNSEvent` takes **9 arguments** on iOS 26 | It takes **six** on this Xcode: `(CGPoint *, CGPoint *, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)`. The binary states its own prototype as a string, so this needs no guessing. The digitizer target `0x32` was correct. |
| The HID client is reached through the `SimLegacyHIDDescriptor` IO port | It is constructed directly from the `SimDevice` with `initWithDevice:error:`. The port exists but is not on the path used here. |

## Input: the sequence that works

Verified end to end: a single tap at (200, 835) points landed on the intended
tab bar item and the screen changed, with idb not installed in the path at all.

```
SimulatorKit.SimDeviceLegacyHIDClient            (Swift class, ObjC-visible)
  NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient")
  -initWithDevice:error:                          -> client
  -sendWithMessage:freeWhenDone:completionQueue:completion:
  -resetHIDSession

IndigoHIDMessageForMouseNSEvent                   (exported C, dlsym from SimulatorKit)
  (CGPoint *location, CGPoint *unused, IndigoHIDTarget, NSEventType, NSSize screen, IndigoHIDEdge)
```

The class is **not** registered under a bare `SimDeviceLegacyHIDClient`; it is a
Swift class, so look it up as `SimulatorKit.SimDeviceLegacyHIDClient` (or the
mangled `_TtC12SimulatorKit24SimDeviceLegacyHIDClient`). Its `alloc` must go
through the runtime, since `alloc()` is unavailable in Swift.

### Verified argument values

| Argument | Value that works |
| --- | --- |
| `location` | `CGPoint` in **points**, in the device's own coordinate space |
| second `CGPoint *` | `nil` is accepted for down/up |
| `IndigoHIDTarget` | **`0x32`** — the digitizer. The research's one correct guess. |
| `NSEventType` | AppKit values: `leftMouseDown` (1), `leftMouseUp` (2), `leftMouseDragged` (6) |
| `NSSize` | the device screen size in points, e.g. 402x874 |
| `IndigoHIDEdge` | `0` |

A tap is a `leftMouseDown` followed by a `leftMouseUp` at the same point.

### Buttons use a different target

`IndigoHIDMessageForButton` does **not** use the digitizer target. Sending a
home press to `0x32` is silently swallowed — no error, no effect. Target `0`
works.

| Button | `IndigoHIDButtonKeyCode` | Verified |
| --- | --- | --- |
| home | **2** (with target **0**) | yes — full transition to springboard |
| lock, siri, volume | unknown | no |

The unverified codes deliberately return nil rather than a guess. A wrong code
here is not a no-op: reports exist of the Siri path crashing `backboardd`, and
silently locking someone's simulator is a poor failure mode. To identify one,
sweep codes with target 0 on a simulator you are willing to disturb and watch
`simframe state --since` for a screen change.

### Typing goes through the active keyboard layout

`IndigoHIDMessageForKeyboardArbitrary` sends raw USB HID **usage codes**, not
characters. iOS maps those through whatever keyboard is currently active, so
the same usage produces different text on different layouts.

Measured on the same field, same device, back to back:

| Route | Result for `"Fryer 3"` |
| --- | --- |
| `type()` — key events | `إقغثق ۳` |
| `paste()` — pasteboard | `Fryer 3` |

The device had `fa` (Persian) among its installed keyboards. Note the mangled
text is exactly five letters, a space and a digit: the usage codes were right,
the layout mapped them elsewhere.

The device setting is what decides this, and it is not the software keyboard
picker:

```
AppleKeyboards = ( "en_US@sw=QWERTY;hw=Automatic",
                   "fa@sw=Persian;hw=Automatic", ... )
```

`hw=Automatic` means the **hardware** layout follows whichever software keyboard
is currently active, which iOS remembers per field. Automation cannot reliably
control that, and switching the phone's keyboard to English does not fix a field
iOS has already associated with another layout.

### The NSEvent path does not help — tested

`IndigoHIDMessageForKeyboardNSEvent(NSEvent *)` looks like the answer, since an
`NSEvent` carries `characters` as well as a `keyCode`, and it is what
Simulator.app uses. It is not.

Synthesising events with `NSEvent.keyEvent(... characters: "X" ... keyCode: 0)`
produced `ش` for **every** character — letters, digits and space alike — with the
count growing by exactly the number typed. The constructor reads `keyCode`, not
`characters`, so `keyCode: 0` mapped everything to one key, which the Persian
layout renders as `ش`. Supplying real virtual key codes only returns you to
layout mapping.

Beware a trap here: an earlier run appeared to type `Fryer` correctly through
this path. That text was left in the field by a previous `paste()` call. Clear
the field between attempts, or you will confirm whatever you hoped for.

So: **key events are for interaction, the pasteboard is for content.** There is
no layout-independent key-event route from outside the device. `paste()` runs
`simctl pbcopy` and then Command-V (usage `0x19` with left GUI `0xE3`), which
carries characters rather than key positions.

Because the failure is silent — text appears, so nothing looks broken —
`inputStatus()` reads `AppleKeyboards` and warns when any non-English, non-emoji
keyboard is installed. `simframe doctor` surfaces it.

### Other message constructors, as declared by the binary

All exported C, all `dlsym`-able from SimulatorKit:

| Function | Signature |
| --- | --- |
| `IndigoHIDMessageForButton` | `(IndigoHIDButtonKeyCode, IndigoHIDButtonOp, IndigoHIDTarget)` |
| `IndigoHIDMessageForKeyboardNSEvent` | `(NSEvent *)` |
| `IndigoHIDMessageForKeyboardArbitrary` | `(uint32_t, IndigoHIDButtonOp)` |
| `IndigoHIDMessageForScrollEvent` | `(uint32_t, double, double, double, IndigoHIDTarget)` |
| `IndigoHIDMessageForPressureEvent` | `(CGPoint *, float, float, IndigoHIDTarget, NSSize)` |
| `IndigoHIDMessageForDigitalCrownEvent` | `(double)` |

The binary carries these prototypes verbatim as strings, which is the fastest
way to check a signature after an Xcode upgrade:

```
strings SimulatorKit | grep '^IndigoHIDMessage'
```

## Accessibility: what is mapped so far

Partly explored, **not working yet**. Recorded so the next attempt starts here.

### The transport exists and needs no bridge delegate

```
SimDevice                                             (CoreSimulator)
  -sendAccessibilityRequestAsync:completionQueue:completionHandler:   ← responds: yes
  -accessibilityConnection                            ← an XPC connection, present
```

This matters: the obvious reading of the framework is that you must implement
the `accessibilityTranslation*WithToken:` bridge delegate that
`SimAccessibilityManager` declares — which is what idb does. But CoreSimulator
already carries requests into the simulator, so that whole layer may be
avoidable. `SimAccessibilityManager.addWithDisplayView:` wants an `NSView`,
which a headless daemon does not have, so avoiding it matters.

### The pieces

| Symbol | Notes |
| --- | --- |
| `AXPTranslator` | `/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework` |
| `+sharedInstance` | works; its `platformTranslator` is `AXPTranslator_macOS` |
| `+sharediOSInstance` | present — presumably the simulator-side translator |
| `+sharedmacOSInstance` | present |
| `AXPTranslatorRequest` | NSSecureCoding. `requestType`, `attributeType`, `actionType`, `clientType`, `translation`, `parameters`; `+requestWithTranslation:` |
| `AXPTranslatorResponse` | `resultData`, `attribute`, `boolResponse`, `error`, `translationResponse`, `associatedRequestType` |
| Useful translator methods | `processPlatformAXTreeDump:`, `generateAXTreeDumpTypeOnBackgroundThread:completionHandler:`, `objectAtPoint:displayId:bridgeDelegateToken:`, `frontmostApplicationWithDisplayId:bridgeDelegateToken:`, `processAttributeRequest:`, `processHitTest:`, `enableAccessibility` |

### What is not known

- The `requestType` / `attributeType` enum values. Sweeping 0–6 with an
  otherwise-empty request produced no reply.
- The completion handler's block signature. A two-argument
  `(response, error)` block crashed the process with SIGTRAP, which suggests
  the arity or types are wrong rather than the call being rejected.
- Whether accessibility must be enabled on the device first
  (`enableAccessibility` exists on the translator).

### Traps already hit

- Passing `DispatchQueue.main` as the completion queue and then blocking the
  main thread waiting for the reply is a deadlock that looks exactly like "the
  API returned nothing".
- `objc_copyClassList` enumeration crashed the probe outright; dump named
  classes instead.
- Naming a loop variable `type` shadows `type(of:)` and produces a confusing
  compile error.

### Routes ruled out

- `simctl` has no accessibility command; `simctl ui` only sets appearance.
- idb links `AccessibilityPlatformTranslation` weakly and implements the bridge
  delegate itself, so there is no simpler public path it is hiding.

## Not yet verified

Everything below is a **hypothesis** carried over from the research and must be
checked against this machine before any code depends on it.

- `AXPTranslator` / `AccessibilityPlatformTranslation` for the accessibility
  tree. Note `SimAccessibilityManager` also exists in SimulatorKit and may be
  the easier route; both are unverified.

To verify: dump the symbol from the binary on this machine, read the current
source of a working implementation (not its documentation), and confirm the
effect end to end — for input, send one tap at a known coordinate and check
`simframe state --since` reports the expected change. Record the result here.
