import CoreGraphics
import Foundation
import ObjectiveC.runtime

/// Raw Indigo HID message plumbing.
///
/// Signatures here were read out of the SimulatorKit binary, which carries its
/// own C prototypes as strings, and confirmed end to end by sending a tap and
/// watching the screen change. See docs/PRIVATE_API.md. If an Xcode upgrade
/// breaks input, re-read the prototypes first:
///
///     strings SimulatorKit | grep '^IndigoHIDMessage'
public final class IndigoHID {
    /// The digitizer. Touch events routed anywhere else are ignored.
    public static let digitizerTarget: UInt32 = 0x32
    /// Hardware buttons do NOT use the digitizer target. Sending a home press
    /// to 0x32 is silently swallowed; target 0 is what actually reaches the
    /// device. Verified by sweeping the target with a known-good button code.
    public static let buttonTarget: UInt32 = 0

    /// AppKit NSEventType values, spelled out so this file needs no AppKit.
    public enum MouseEvent: UInt {
        case down = 1
        case up = 2
        case dragged = 6
    }

    public enum ButtonOp: UInt32 {
        case down = 1
        case up = 2
    }

    private let client: NSObject
    private let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
    private let send: @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void

    private typealias MouseFn = @convention(c) (
        UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32
    ) -> UnsafeMutableRawPointer?
    private typealias ButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private typealias KeyboardFn = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?

    private let makeMouse: MouseFn
    private let makeButton: ButtonFn?
    private let makeKeyboard: KeyboardFn?

    public init(device: NSObject, simulatorKit: UnsafeMutableRawPointer?) throws {
        // A Swift class, so it is registered under its qualified name; a bare
        // "SimDeviceLegacyHIDClient" does not resolve.
        guard let cls = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") else {
            throw PrivateAPIError.frameworksUnavailable("SimDeviceLegacyHIDClient missing")
        }
        // `alloc` is unavailable in Swift; go through the runtime.
        typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject?
        let allocSel = NSSelectorFromString("alloc")
        guard let allocMethod = class_getClassMethod(cls, allocSel),
              let allocated = unsafeBitCast(method_getImplementation(allocMethod), to: AllocFn.self)(cls, allocSel) else {
            throw PrivateAPIError.frameworksUnavailable("could not allocate the HID client")
        }
        let initSel = NSSelectorFromString("initWithDevice:error:")
        typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutableRawPointer?) -> AnyObject?
        guard let initIMP = (allocated as AnyObject).method(for: initSel),
              let created = unsafeBitCast(initIMP, to: InitFn.self)(allocated, initSel, device, nil) as? NSObject else {
            throw PrivateAPIError.hidUnavailable("initWithDevice: returned nil")
        }
        client = created
        guard client.responds(to: sendSel), let sendIMP = client.method(for: sendSel) else {
            throw PrivateAPIError.hidUnavailable("client cannot send messages")
        }
        send = unsafeBitCast(sendIMP, to: (@convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void).self)

        guard let mouseSym = dlsym(simulatorKit, "IndigoHIDMessageForMouseNSEvent") else {
            throw PrivateAPIError.hidUnavailable("IndigoHIDMessageForMouseNSEvent missing")
        }
        makeMouse = unsafeBitCast(mouseSym, to: MouseFn.self)
        makeButton = dlsym(simulatorKit, "IndigoHIDMessageForButton").map { unsafeBitCast($0, to: ButtonFn.self) }
        makeKeyboard = dlsym(simulatorKit, "IndigoHIDMessageForKeyboardArbitrary").map { unsafeBitCast($0, to: KeyboardFn.self) }
    }

    private func dispatch(_ message: UnsafeMutableRawPointer?) {
        guard let message else { return }
        // freeWhenDone: the framework allocated it and owns it after this.
        send(client, sendSel, message, true, nil, nil)
    }

    /// One mouse event at a point in device points.
    public func mouse(at point: CGPoint, event: MouseEvent, screen: CGSize) {
        var p = point
        dispatch(makeMouse(&p, nil, Self.digitizerTarget, event.rawValue, screen, 0))
    }

    public func button(keyCode: UInt32, op: ButtonOp) {
        guard let makeButton else { return }
        dispatch(makeButton(keyCode, op.rawValue, Self.buttonTarget))
    }

    public func key(usage: UInt32, op: ButtonOp) {
        guard let makeKeyboard else { return }
        dispatch(makeKeyboard(usage, op.rawValue))
    }

    public func resetSession() {
        let sel = NSSelectorFromString("resetHIDSession")
        if client.responds(to: sel) { _ = client.perform(sel) }
    }
}
