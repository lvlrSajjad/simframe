import CoreGraphics
import Foundation

/// One node of the simulator's live accessibility tree, read from the host.
///
/// Frames are in **points**, in the device's own top-left coordinate space —
/// the same space input speaks, so a node's centre is a tap point with no
/// conversion.
public struct AXNode: Sendable {
    public var role: String
    public var subrole: String?
    public var label: String?
    public var value: String?
    public var identifier: String?
    public var enabled: Bool?
    public var selected: Bool?
    public var focused: Bool?
    public var frame: CGRect
    public var depth: Int

    public init(role: String, subrole: String? = nil, label: String? = nil, value: String? = nil,
                identifier: String? = nil, enabled: Bool? = nil, selected: Bool? = nil,
                focused: Bool? = nil, frame: CGRect, depth: Int) {
        self.role = role
        self.subrole = subrole
        self.label = label
        self.value = value
        self.identifier = identifier
        self.enabled = enabled
        self.selected = selected
        self.focused = focused
        self.frame = frame
        self.depth = depth
    }
}

/// A tree, and whether it is all of one.
///
/// The walk has three ways to stop early and the bridge has a fourth, and every
/// one of them produces something that looks exactly like a small screen. A
/// partial tree is still useful — it is not, however, authoritative, and the
/// layer above merges accessibility elements as the real hit targets and then
/// writes them into screen memory. So the shortfall travels with the nodes.
public struct AXTree: Sendable {
    public let nodes: [AXNode]
    /// Nil when the whole tree was read; otherwise why it was not.
    public let truncated: String?

    public init(nodes: [AXNode], truncated: String? = nil) {
        self.nodes = nodes
        self.truncated = truncated
    }
}

public enum AccessibilityError: Error, CustomStringConvertible {
    case unavailable(String)
    case noFrontmostApplication

    public var description: String {
        switch self {
        case .unavailable(let d): return "accessibility unavailable: \(d)"
        case .noFrontmostApplication: return "no frontmost application on the device"
        }
    }
}

/// Reads the simulator's accessibility tree from the host, with nothing
/// injected into the guest and no `NSView`.
///
/// The shape that works, established against the live runtime:
///
///   * `AXPTranslator.sharedInstance` on the host is the **macOS** translator.
///     Its job is turning iOS accessibility data into mac platform elements,
///     which is exactly what a host-side reader wants.
///   * The bridge delegate is held **weakly**, so it must be retained here.
///     A delegate nobody retains is deallocated at once and the translator
///     answers nil, looking precisely like a broken private API.
///   * The delegate token is not ours to invent: `SimDevice` publishes its own
///     as `accessibilityPlatformTranslationToken`, and that is what routes a
///     request to the right guest.
///   * The element to read is **not** the translation object. Passing that to
///     `processTranslatorRequest:` returns a response whose `resultData` is nil.
///     `AXPMacPlatformElement.platformElementWithTranslationObject:` wraps it in
///     something that answers ordinary `accessibilityAttributeValue:` calls,
///     and the whole tree walks from there.
///
/// Every call must run off the main queue: the bridge blocks waiting on the
/// device, and blocking main is a deadlock that presents as silence.
public final class AccessibilityBridge {
    private let device: NSObject
    private let token: Any?
    private let translator: NSObject
    private let elementClass: NSObject.Type
    /// The translator holds this weakly. Releasing it breaks every later read.
    private let delegate: BridgeDelegate

    /// A tree this deep is a runaway, not a screen.
    private static let maxDepth = 40
    /// Enough for any real screen; a cap so a cycle cannot hang the daemon.
    private static let maxNodes = 4000

    // MARK: - Construction

    public init(device: NSObject, requestTimeout: TimeInterval = 5) throws {
        guard let handle = dlopen(Self.frameworkPath, RTLD_NOW), handle != nil else {
            throw AccessibilityError.unavailable(
                "AccessibilityPlatformTranslation did not load: \(String(cString: dlerror()))")
        }
        guard let translatorClass = NSClassFromString("AXPTranslator") as? NSObject.Type,
              let shared = translatorClass.perform(NSSelectorFromString("sharedInstance"))?
                  .takeUnretainedValue() as? NSObject else {
            throw AccessibilityError.unavailable("AXPTranslator.sharedInstance missing")
        }
        guard let elementClass = NSClassFromString("AXPMacPlatformElement") as? NSObject.Type,
              elementClass.responds(to: NSSelectorFromString("platformElementWithTranslationObject:")) else {
            throw AccessibilityError.unavailable("AXPMacPlatformElement missing")
        }
        guard shared.responds(to: NSSelectorFromString("frontmostApplicationWithDisplayId:bridgeDelegateToken:")) else {
            throw AccessibilityError.unavailable("frontmostApplicationWithDisplayId: missing")
        }
        guard device.responds(to: NSSelectorFromString("sendAccessibilityRequestAsync:completionQueue:completionHandler:")) else {
            throw AccessibilityError.unavailable("this SimDevice cannot carry accessibility requests")
        }

        self.device = device
        self.translator = shared
        self.elementClass = elementClass
        self.delegate = BridgeDelegate(device: device, timeout: requestTimeout)
        self.token = device.responds(to: NSSelectorFromString("accessibilityPlatformTranslationToken"))
            ? device.value(forKey: "accessibilityPlatformTranslationToken")
            : nil

        shared.setValue(delegate, forKey: "bridgeTokenDelegate")
        if shared.responds(to: NSSelectorFromString("setSupportsDelegateTokens:")) {
            shared.setValue(true, forKey: "supportsDelegateTokens")
        }
        if shared.responds(to: NSSelectorFromString("setAccessibilityEnabled:")) {
            shared.setValue(true, forKey: "accessibilityEnabled")
        }
    }

    private static let frameworkPath =
        "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation"

    // MARK: - Reading

    /// The frontmost application's tree, flattened depth-first.
    ///
    /// An app that is still launching genuinely has no tree yet — the read
    /// returns the application node alone. That is reported as it is, rather
    /// than retried into looking like a populated screen.
    public func tree(budget: TimeInterval = 3) throws -> AXTree {
        guard let app = frontmostApplication() else { throw AccessibilityError.noFrontmostApplication }
        guard let root = elementClass
            .perform(NSSelectorFromString("platformElementWithTranslationObject:"), with: app)?
            .takeUnretainedValue() as? NSObject else {
            throw AccessibilityError.unavailable("the frontmost application did not translate to an element")
        }
        delegate.resetTimeouts()
        var out: [AXNode] = []
        var cut: String?
        let deadline = Date().addingTimeInterval(budget)
        walk(root, depth: 0, into: &out, deadline: deadline, cut: &cut)
        // A guest that missed the deadline answers `emptyResponse`, which makes
        // the subtree below it look genuinely childless. Nothing in the nodes
        // can show that, so the count has to.
        let missed = delegate.timeouts
        if cut == nil, missed > 0 {
            cut = "\(missed) request(s) to the device timed out, so part of the tree is missing"
        }
        return AXTree(nodes: out, truncated: cut)
    }

    /// Read one attribute off the frontmost application.
    ///
    /// Constructing the bridge proves only that the classes and selectors are
    /// there. The failure this whole path took two attempts to get past was a
    /// bridge that constructed perfectly and then read nothing, so "available"
    /// has to mean a value came back, not that the symbols exist.
    public func probe() throws {
        guard let app = frontmostApplication() else { throw AccessibilityError.noFrontmostApplication }
        guard let root = elementClass
            .perform(NSSelectorFromString("platformElementWithTranslationObject:"), with: app)?
            .takeUnretainedValue() as? NSObject else {
            throw AccessibilityError.unavailable("the frontmost application did not translate to an element")
        }
        guard attribute(root, "AXRole") is String else {
            throw AccessibilityError.unavailable("the translator answered nil for the application's role")
        }
    }

    /// The pid of the app currently frontmost, or nil when the bridge cannot say.
    public func frontmostPid() -> Int32? {
        guard let app = frontmostApplication() else { return nil }
        return (app.value(forKey: "pid") as? NSNumber)?.int32Value
    }

    private func frontmostApplication() -> NSObject? {
        let sel = NSSelectorFromString("frontmostApplicationWithDisplayId:bridgeDelegateToken:")
        guard let imp = translator.method(for: sel) else { return nil }
        typealias FrontFn = @convention(c) (AnyObject, Selector, UInt32, AnyObject?) -> AnyObject?
        return unsafeBitCast(imp, to: FrontFn.self)(translator, sel, 0, token as AnyObject?) as? NSObject
    }

    private func walk(_ element: NSObject, depth: Int, into out: inout [AXNode],
                      deadline: Date, cut: inout String?) {
        if depth > Self.maxDepth {
            cut = cut ?? "the tree is deeper than \(Self.maxDepth) levels"
            return
        }
        if out.count >= Self.maxNodes {
            cut = cut ?? "the tree has more than \(Self.maxNodes) nodes, which is a cycle rather than a screen"
            return
        }
        if Date() > deadline {
            cut = cut ?? "the read ran out of time"
            return
        }
        out.append(node(from: element, depth: depth))
        guard let children = attribute(element, "AXChildren") as? [NSObject] else { return }
        for child in children {
            walk(child, depth: depth + 1, into: &out, deadline: deadline, cut: &cut)
        }
    }

    private func node(from element: NSObject, depth: Int) -> AXNode {
        let role = attribute(element, "AXRole") as? String ?? "AXUnknown"
        // The label is the app's own name for the control. AXDescription is
        // where UIKit puts an accessibility label that has no visible title,
        // so it is the fallback rather than a separate field.
        let label = string(element.responds(to: NSSelectorFromString("accessibilityLabel"))
            ? element.value(forKey: "accessibilityLabel") : nil)
            ?? string(attribute(element, "AXDescription"))
        return AXNode(
            role: Self.shortRole(role),
            subrole: Self.shortRole(attribute(element, "AXSubrole") as? String),
            label: label,
            value: string(attribute(element, "AXValue")),
            identifier: string(attribute(element, "AXIdentifier")),
            enabled: (attribute(element, "AXEnabled") as? NSNumber)?.boolValue,
            selected: (attribute(element, "AXSelected") as? NSNumber)?.boolValue,
            focused: (attribute(element, "AXFocused") as? NSNumber)?.boolValue,
            frame: frame(of: element),
            depth: depth)
    }

    private func attribute(_ element: NSObject, _ name: String) -> Any? {
        let sel = NSSelectorFromString("accessibilityAttributeValue:")
        guard element.responds(to: sel) else { return nil }
        return element.perform(sel, with: name as NSString)?.takeUnretainedValue()
    }

    private func frame(of element: NSObject) -> CGRect {
        let sel = NSSelectorFromString("accessibilityFrame")
        guard element.responds(to: sel), let imp = element.method(for: sel) else { return .zero }
        typealias RectFn = @convention(c) (AnyObject, Selector) -> CGRect
        return unsafeBitCast(imp, to: RectFn.self)(element, sel)
    }

    /// A value may be a string, a number, or something with no useful text.
    private func string(_ value: Any?) -> String? {
        switch value {
        case let s as String:
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case let n as NSNumber:
            return n.stringValue
        default:
            return nil
        }
    }

    /// `AXButton` is the mac vocabulary; the rest of simframe speaks `Button`.
    private static func shortRole(_ role: String?) -> String? {
        guard let role, !role.isEmpty else { return nil }
        return role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
    }

    private static func shortRole(_ role: String) -> String {
        shortRole(Optional(role)) ?? role
    }
}

/// Carries translator requests to the device and the answers back.
///
/// The translator asks for a block, calls it whenever it needs guest data, and
/// expects the answer synchronously — so this bridges async to sync on a queue
/// that is never main.
private final class BridgeDelegate: NSObject {
    private let device: NSObject
    private let timeout: TimeInterval
    private let queue = DispatchQueue(label: "simframe.accessibility.bridge")
    private let counter = NSLock()
    private var timedOut = 0

    init(device: NSObject, timeout: TimeInterval) {
        self.device = device
        self.timeout = timeout
    }

    /// How many requests the device failed to answer since the last reset.
    var timeouts: Int {
        counter.lock(); defer { counter.unlock() }
        return timedOut
    }

    func resetTimeouts() {
        counter.lock(); defer { counter.unlock() }
        timedOut = 0
    }

    fileprivate func recordTimeout() {
        counter.lock(); defer { counter.unlock() }
        timedOut += 1
    }

    @objc(accessibilityTranslationDelegateBridgeCallbackWithToken:)
    func bridgeCallback(token: NSString?) -> Any? {
        let device = self.device, queue = self.queue, timeout = self.timeout
        let block: @convention(block) (Any?) -> Any? = { [self] request in
            guard let request else { return nil }
            let sel = NSSelectorFromString("sendAccessibilityRequestAsync:completionQueue:completionHandler:")
            guard let imp = device.method(for: sel) else { return nil }
            var answer: Any?
            let waited = DispatchSemaphore(value: 0)
            let handler: @convention(block) (Any?) -> Void = { response in
                answer = response
                waited.signal()
            }
            typealias SendFn = @convention(c) (AnyObject, Selector, AnyObject, AnyObject, AnyObject) -> Void
            unsafeBitCast(imp, to: SendFn.self)(device, sel, request as AnyObject, queue, handler as AnyObject)
            if waited.wait(timeout: .now() + timeout) == .timedOut {
                self.recordTimeout()
                // An empty response is what the translator expects when the
                // guest does not answer. Returning nil crashes it.
                return (NSClassFromString("AXPTranslatorResponse") as? NSObject.Type)?
                    .perform(NSSelectorFromString("emptyResponse"))?.takeUnretainedValue()
            }
            return answer
        }
        return block
    }

    /// Frames arrive in the device's own point space, which is where they
    /// belong: converting them to host screen coordinates would make them
    /// useless for input.
    @objc(accessibilityTranslationConvertPlatformFrameToSystem:withToken:)
    func convertFrame(_ rect: CGRect, token: NSString?) -> CGRect { rect }

    @objc(accessibilityTranslationRootParentWithToken:)
    func rootParent(token: NSString?) -> Any? { nil }
}
