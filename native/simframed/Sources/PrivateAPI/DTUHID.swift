// The dtuhidd connection sequence and wire format are adapted from facebook/idb
// (FBSimulatorControl/HID, FBSimulatorControl/XPC), Copyright (c) Meta
// Platforms, Inc. and affiliates, used under the MIT License.

import CoreGraphics
import Darwin
import Foundation
import ObjectiveC.runtime
import XPC

/// One gesture's worth of contact state, in the vocabulary both transports share.
public enum TouchPhase: Sendable {
    case began, moved, ended
}

/// Where touches, keys and hardware buttons go. Two implementations, chosen per
/// CoreSimulator version: the legacy Indigo client, and `dtuhidd`.
///
/// Every method throws because the DTUHID side can discover mid-gesture that its
/// daemon went away and fail to bring it back; the legacy side never throws,
/// which is the reason it was trusted and the reason that trust was misplaced.
public protocol HIDTransport: AnyObject {
    /// What doctor and `sim_state` print.
    var transportName: String { get }
    func touch(at point: CGPoint, phase: TouchPhase, screen: CGSize) throws
    func key(usage: UInt32, op: IndigoHID.ButtonOp) throws
    func press(_ button: HardwareButton, op: IndigoHID.ButtonOp) throws
    /// Returns once everything sent so far has been handed to the transport, so
    /// a settle that starts after a gesture starts after the gesture.
    func flush()
    func resetSession()
}

extension IndigoHID: HIDTransport {
    public var transportName: String { "Indigo HID (SimDeviceLegacyHIDClient)" }

    public func touch(at point: CGPoint, phase: TouchPhase, screen: CGSize) throws {
        let event: MouseEvent
        switch phase {
        case .began: event = .down
        case .moved: event = .dragged
        case .ended: event = .up
        }
        mouse(at: point, event: event, screen: screen)
    }

    // `key(usage:op:)` and `resetSession()` are IndigoHID's own and satisfy the
    // protocol as they are.

    public func press(_ button: HardwareButton, op: ButtonOp) throws {
        guard let code = HIDKeyboard.buttonCode(button) else {
            throw PrivateAPIError.hidUnavailable("no legacy key code for \(button.rawValue)")
        }
        self.button(keyCode: code, op: op)
    }

    public func flush() {}
}

/// Input through `dtuhidd`, the HID daemon CoreSimulator puts in the guest from
/// 1155.4 (Xcode 27).
///
/// **Why this exists.** On that CoreSimulator the guest drops legacy Indigo
/// input: buttons and keys always, touches on some boots and intermittently
/// within one. Each message is accepted, nothing reaches the app, and the legacy
/// client has no way to know. Measured on 2026-10-01: on one device every tap,
/// swipe and button press failed across two boots, a fresh daemon and a session
/// reset, while another tool speaking this transport landed first time. Once
/// anything connects to `dtuhidd`, `backboardd` tears down the legacy digitizer,
/// button and keyboard services for the rest of the boot.
///
/// **Wire format** follows facebook/idb's `SimulatorDTUHIDTransport` (MIT,
/// FBSimulatorControl/HID and FBSimulatorControl/XPC): look the service up in
/// the guest's bootstrap namespace, wrap the port with the private
/// `xpc_endpoint_create_mach_port_4sim`, and mark the connection
/// simulator-to-host with `xpc_connection_enable_sim2host_4sim`. Without that
/// last call the service sees the peer but never a payload. Messages are plain
/// XPC dictionaries: `messageType` / `isBarrier` / `featureIdentifier` /
/// `payload`. See docs/PRIVATE_API.md.
public final class DTUHID: HIDTransport {
    public static let serviceName = "com.apple.coredevice.feature.remote.hid.digitizer"
    /// The first CoreSimulator that ships `dtuhidd`.
    public static let firstCoreSimulatorVersion = "1155.4"

    /// The CoreSimulator actually loaded in this process. The Xcode installer
    /// overwrites the system copy, so this can differ from the selected Xcode.
    public static var loadedCoreSimulatorVersion: String? {
        guard let cls = NSClassFromString("SimDevice") else { return nil }
        return Bundle(for: cls).infoDictionary?["CFBundleVersion"] as? String
    }

    /// Whether this CoreSimulator drops legacy input, and so should prefer this.
    /// Compared numerically: 1155.10 is newer than 1155.4.
    public static func suppressesLegacyInput(coreSimulatorVersion: String?) -> Bool {
        guard let v = coreSimulatorVersion else { return false }
        return v.compare(firstCoreSimulatorVersion, options: .numeric) != .orderedAscending
    }

    public var transportName: String { "DTUHID (dtuhidd digitizer service)" }

    /// How long a liveness reply may take. Generous, because this is the send
    /// that demand-launches `dtuhidd`.
    static let livenessTimeout: Double = 4
    /// Device-open time after the first reply, before events are trusted.
    static let replyTail: Double = 0.2

    private let device: NSObject
    private let queue = DispatchQueue(label: "simframed.dtuhid")
    private let lock = NSLock()
    private var connection: xpc_connection_t?
    /// Set by the event handler. An interrupted connection reconnects on the
    /// next send, but the daemon behind it may be a fresh one that has not
    /// opened its device yet, so the next send proves liveness first.
    private var needsLiveness = false
    private var invalidated = false

    public init(device: NSObject) throws {
        self.device = device
        try connectAndConfirm()
    }

    deinit {
        if let connection { xpc_connection_cancel(connection) }
    }

    // MARK: - HIDTransport

    public func touch(at point: CGPoint, phase: TouchPhase, screen: CGSize) throws {
        guard screen.width > 0, screen.height > 0 else {
            throw PrivateAPIError.hidUnavailable("screen size unknown, cannot normalise a touch")
        }
        let p = xpc_dictionary_create(nil, nil, 0)
        let one = xpc_dictionary_create(nil, nil, 0)
        // Normalised top-left coordinates in 0...1, clamped so a point on the
        // very edge is still on the screen.
        xpc_dictionary_set_double(one, "x", min(1, max(0, Double(point.x / screen.width))))
        xpc_dictionary_set_double(one, "y", min(1, max(0, Double(point.y / screen.height))))
        xpc_dictionary_set_value(p, "pointOne", one)
        // start / position / end. `dtuhidd` rejects these as strings.
        let type: UInt64
        switch phase {
        case .began: type = 0
        case .moved: type = 1
        case .ended: type = 2
        }
        xpc_dictionary_set_uint64(p, "eventType", type)
        xpc_dictionary_set_uint64(p, "edge", 0)
        xpc_dictionary_set_uint64(p, "target", 0)
        try send("IndigoDigitizerEvent", p)
    }

    public func key(usage: UInt32, op: IndigoHID.ButtonOp) throws {
        let p = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(p, "usageCode", UInt64(usage))
        xpc_dictionary_set_uint64(p, "state", Self.state(op))
        try send("IndigoKeyboardButtonEvent", p)
    }

    public func press(_ button: HardwareButton, op: IndigoHID.ButtonOp) throws {
        // HID Consumer page (0x0C) usages, as idb maps them.
        let code: UInt64
        switch button {
        case .home: code = 0x40       // Menu
        case .lock: code = 0x30       // Power
        case .siri: code = 0xCF       // Voice Command
        case .volumeUp: code = 0xE9
        case .volumeDown: code = 0xEA
        }
        let p = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(p, "usagePage", 0x0C)
        xpc_dictionary_set_uint64(p, "usageCode", code)
        xpc_dictionary_set_uint64(p, "state", Self.state(op))
        try send("IndigoButtonEvent", p)
    }

    public func flush() {
        lock.lock()
        let c = connection
        lock.unlock()
        guard let c else { return }
        let done = DispatchSemaphore(value: 0)
        xpc_connection_send_barrier(c) { done.signal() }
        _ = done.wait(timeout: .now() + 1)
    }

    public func resetSession() {
        lock.lock()
        defer { lock.unlock() }
        if let connection { xpc_connection_cancel(connection) }
        connection = nil
        invalidated = true
    }

    // MARK: - Connection

    /// 1-based on the wire: 0 is rejected at decode.
    private static func state(_ op: IndigoHID.ButtonOp) -> UInt64 { op == .down ? 1 : 2 }

    private func send(_ type: String, _ payload: xpc_object_t) throws {
        lock.lock()
        defer { lock.unlock() }
        if connection == nil || invalidated {
            try connectAndConfirmLocked()
        } else if needsLiveness {
            try confirmLivenessLocked()
        }
        guard let connection else { throw PrivateAPIError.hidUnavailable("dtuhidd connection unavailable") }
        xpc_connection_send_message(connection, message(type, payload, barrier: false))
    }

    private func connectAndConfirm() throws {
        lock.lock()
        defer { lock.unlock() }
        try connectAndConfirmLocked()
    }

    private func connectAndConfirmLocked() throws {
        if let old = connection { xpc_connection_cancel(old) }
        connection = nil
        let c = try Self.makeConnection(device: device)
        xpc_connection_set_target_queue(c, queue)
        xpc_connection_set_event_handler(c) { [weak self] event in
            guard let self, xpc_get_type(event) == XPC_TYPE_ERROR else { return }
            // Called on `queue`, never under `lock`'s owner, so taking it is safe.
            self.lock.lock()
            if xpc_equal(event, XPC_ERROR_CONNECTION_INTERRUPTED) {
                self.needsLiveness = true
            } else if xpc_equal(event, XPC_ERROR_CONNECTION_INVALID) {
                self.invalidated = true
            }
            self.lock.unlock()
        }
        xpc_connection_resume(c)
        connection = c
        invalidated = false
        do {
            try confirmLivenessLocked()
        } catch {
            xpc_connection_cancel(c)
            connection = nil
            throw error
        }
    }

    /// Round-trip a barrier carrying usage 0 ("no event"), so the guest sees no
    /// keypress. The only observation available: every step of building the
    /// connection succeeds against a daemon that cannot run, and a send to one
    /// reports no error, so an unanswered probe is what separates a transport
    /// from a black hole.
    private func confirmLivenessLocked() throws {
        guard let connection else { throw PrivateAPIError.hidUnavailable("dtuhidd connection unavailable") }
        let p = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(p, "usageCode", 0)
        xpc_dictionary_set_uint64(p, "state", 2)
        let probe = message("IndigoKeyboardButtonEvent", p, barrier: true)
        let done = DispatchSemaphore(value: 0)
        var answer: String?
        // Delivered on a queue of its own: `queue` also runs the event handler,
        // which takes `lock`, and this thread holds it while it waits.
        xpc_connection_send_message_with_reply(connection, probe, DispatchQueue.global()) { reply in
            if xpc_get_type(reply) == XPC_TYPE_ERROR {
                answer = xpc_dictionary_get_string(reply, XPC_ERROR_KEY_DESCRIPTION).map { String(cString: $0) }
                    ?? "XPC error reply"
            }
            done.signal()
        }
        guard done.wait(timeout: .now() + Self.livenessTimeout) == .success else {
            throw PrivateAPIError.hidUnavailable("dtuhidd did not answer a liveness probe within \(Int(Self.livenessTimeout))s")
        }
        if let answer { throw PrivateAPIError.hidUnavailable("dtuhidd refused the liveness probe: \(answer)") }
        needsLiveness = false
        Thread.sleep(forTimeInterval: Self.replyTail)
    }

    private func message(_ type: String, _ payload: xpc_object_t, barrier: Bool) -> xpc_object_t {
        let m = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(m, "messageType", type)
        xpc_dictionary_set_bool(m, "isBarrier", barrier)
        xpc_dictionary_set_string(m, "featureIdentifier", Self.serviceName)
        xpc_dictionary_set_value(m, "payload", payload)
        return m
    }

    private typealias LookupFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutableRawPointer?) -> UInt32
    private typealias EndpointFromPort = @convention(c) (mach_port_t, UInt64, UInt64) -> Unmanaged<AnyObject>?
    private typealias ConnectionFromEndpoint = @convention(c) (xpc_object_t) -> Unmanaged<AnyObject>?
    private typealias EnableSim2Host = @convention(c) (xpc_connection_t) -> Void

    /// The host side of a connection to the guest service, unresumed.
    private static func makeConnection(device: NSObject) throws -> xpc_connection_t {
        let lookupSel = NSSelectorFromString("lookup:error:")
        guard device.responds(to: lookupSel), let imp = device.method(for: lookupSel) else {
            throw PrivateAPIError.hidUnavailable("SimDevice has no lookup:error: on this CoreSimulator")
        }
        guard let handle = dlopen(nil, RTLD_NOW) else {
            throw PrivateAPIError.hidUnavailable("dlopen failed")
        }
        defer { dlclose(handle) }
        guard let e = dlsym(handle, "xpc_endpoint_create_mach_port_4sim"),
              let c = dlsym(handle, "xpc_connection_create_from_endpoint"),
              let s = dlsym(handle, "xpc_connection_enable_sim2host_4sim") else {
            throw PrivateAPIError.hidUnavailable("the private _4sim XPC symbols are not in this process")
        }
        let endpointFromPort = unsafeBitCast(e, to: EndpointFromPort.self)
        let connectionFromEndpoint = unsafeBitCast(c, to: ConnectionFromEndpoint.self)
        let enableSim2Host = unsafeBitCast(s, to: EnableSim2Host.self)

        let port = unsafeBitCast(imp, to: LookupFn.self)(device, lookupSel, serviceName as NSString, nil)
        guard port != MACH_PORT_NULL else {
            throw PrivateAPIError.hidUnavailable("the guest does not vend \(serviceName)")
        }
        // Both create functions return +1; the endpoint consumes the send right.
        guard let endpoint = endpointFromPort(port, 0, 0)?.takeRetainedValue() as? xpc_object_t,
              let connection = connectionFromEndpoint(endpoint)?.takeRetainedValue() as? xpc_connection_t else {
            throw PrivateAPIError.hidUnavailable("could not build an XPC connection to \(serviceName)")
        }
        enableSim2Host(connection)
        return connection
    }
}
