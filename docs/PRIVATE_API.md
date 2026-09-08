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

## Accessibility: the sequence that works

Verified end to end: the frontmost app's tree read from the host, in device
points, with nothing injected into the guest, no `NSView`, and idb not on the
path at all.

```
AXPTranslator                                   (/System/Library/PrivateFrameworks/
                                                 AccessibilityPlatformTranslation.framework)
  +sharedInstance                               -> AXPTranslator (the macOS one, on a Mac)
  .bridgeTokenDelegate = <your delegate>        ← held WEAKLY; retain it yourself
  -frontmostApplicationWithDisplayId:bridgeDelegateToken:   -> AXPTranslationObject (.pid)

AXPMacPlatformElement
  +platformElementWithTranslationObject:        -> an element answering NSAccessibility
    -accessibilityAttributeValue:               -> AXChildren, AXRole, AXValue, AXIdentifier…
    -accessibilityLabel, -accessibilityFrame

SimDevice
  -accessibilityPlatformTranslationToken        ← the token. Do not invent one.
  -sendAccessibilityRequestAsync:completionQueue:completionHandler:
                                                completionHandler is ^(id) — ONE argument
```

The delegate implements three selectors. The first is the one that matters; it
returns a block taking **one** argument and returning the response:

```objc
- (id (^)(id))accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token;
- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)r withToken:(NSString *)t; // return r
- (id)accessibilityTranslationRootParentWithToken:(NSString *)token;                              // return nil
```

Inside the block, forward the request to the device and bridge async to sync:
wait on a semaphore, and return `AXPTranslatorResponse.emptyResponse` — never
nil — if the guest does not answer. **The completion queue must never be main**,
and every translator call belongs off the main queue.

Returning the rect unchanged from the frame conversion is deliberate: frames
then stay in the device's own top-left point space, which is the space input
speaks, so an element's centre is a tap point with no conversion.

### The two things that made the difference

An earlier attempt had the bridge and transport working — a real
`AXPTranslationObject` whose `pid` matched the app — and still read nothing,
because of these:

| | |
| --- | --- |
| **The token is the device's** | `SimDevice.accessibilityPlatformTranslationToken` publishes it. A token you invent routes to nothing. |
| **The translation object is not the element** | Passing it to `requestWithTranslation:` and `processTranslatorRequest:` returns a response whose `resultData` is nil. `AXPMacPlatformElement.platformElementWithTranslationObject:` wraps it in something that answers ordinary `accessibilityAttributeValue:` calls, and the whole tree walks from there. |

So the `AXPTranslatorRequest` constants below are not needed for reading a tree
host-side. They are kept because they are the in-guest vocabulary idb uses, and
because `processTranslatorRequest:` is still how a *custom* attribute would be
asked for.

`SimulatorKit.SimAccessibilityManager` implements those same three delegate
selectors and is what Simulator.app uses — but it wants an `NSView` through
`addWithDisplayView:`, which is exactly what a daemon does not have. Reading its
selector list is useful; instantiating it is not.

### What it costs

Same screen, same element count, alternating reads:

| Path | Median |
| --- | --- |
| `idb ui describe-all` | 203–224 ms |
| host-side, in-process | 42–55 ms |

A read on a freshly-switched app is slower — 700–900 ms once, while the guest
populates — then settles back. An app still launching genuinely has no tree yet
and returns the application node alone; that is worth reporting rather than
retrying until it looks populated.

### Constants (from idb's AXPAttributes.h)

Unused by the path above, kept for the in-guest request form.

| Request type | Value |
| --- | --- |
| `Attribute` | 2 |
| `MultipleAttribute` | 5 |

| Attribute | Value | | Attribute | Value |
| --- | --- | --- | --- | --- |
| ClassName | 7 | | Label | 33 |
| Children | 8 | | Role | 45 |
| Frame | 21 | | Value | 53 |
| Identifier | 25 | | Traits | 77 |
| IsEnabled | 27 | | | |

A multiple-attribute request carries its list as
`parameters[@"attributes"]` — **a dictionary with that key**, holding an
`NSArray<NSNumber *>`. idb's header warns that passing a bare array "throws
inside the guest and takes the reader down with it". idb also leaves
`clientType` unset deliberately: setting it makes the app-side children handler
answer from a stale `automationElements` override.

### idb and testa differ, and it matters

idb reads **in-guest**: `SimulatorFrameworkBridge` is loaded inside the
simulator, dlopens the framework from the booted runtime root, and closes the
loop locally through `processTranslatorRequest:`. testa reads **host-side**
through `sendAccessibilityRequestAsync:`, which is the topology above. Read idb
for the constants and semantics; read testa for the shape.

## Probing pitfalls

Every one of these cost real time here, and all of them look like "the private
API is broken" rather than like a mistake:

- **Handing a call `DispatchQueue.main` and then blocking main.** A deadlock
  that presents as the API silently returning nothing. The AX callback queue
  must never be main, and translator calls belong off the main queue entirely.
- **Wrong block arity crashes the process.** A two-argument
  `(response, error)` completion handler for `sendAccessibilityRequestAsync:`
  exits with SIGTRAP and no output. It takes one argument.
- **A weakly-held delegate that nobody retains** is deallocated immediately and
  the translator answers nil, exactly as if it were never installed.
- **`objc_copyClassList` enumeration crashes** the probe outright. Dump named
  classes instead.
- **Naming a Swift loop variable `type`** shadows `type(of:)` and produces a
  compile error that reads as unrelated.
- **Reading a text field to check typing without clearing it first** confirms
  whatever you hoped for, using text a previous attempt left behind.

## Not yet verified

Everything below is a **hypothesis** carried over from the research and must be
checked against this machine before any code depends on it.

- `SimAccessibilityManager` in SimulatorKit as a route to the tree. Its
  delegate selectors are verified by inspection; instantiating it is not, and
  it wants an `NSView`, so nothing here depends on it.

To verify: dump the symbol from the binary on this machine, read the current
source of a working implementation (not its documentation), and confirm the
effect end to end — for input, send one tap at a known coordinate and check
`simframe state --since` reports the expected change. Record the result here.
