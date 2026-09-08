import CoreGraphics
import PrivateAPI
import Foundation

/// Where an element's information came from. A single element can be seen by
/// more than one source, which is why this is a set rather than a tag.
public struct ElementSource: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let accessibility = ElementSource(rawValue: 1 << 0)
    public static let ocr = ElementSource(rawValue: 1 << 1)
    public static let contour = ElementSource(rawValue: 1 << 2)
    public static let template = ElementSource(rawValue: 1 << 3)

    public var names: [String] {
        var out: [String] = []
        if contains(.accessibility) { out.append("ax") }
        if contains(.ocr) { out.append("ocr") }
        if contains(.contour) { out.append("cv") }
        if contains(.template) { out.append("template") }
        return out
    }
}

public struct ElementState: Sendable, Equatable {
    public var enabled: Bool?
    public var selected: Bool?
    public var checked: Bool?
    public var focused: Bool?

    public init(enabled: Bool? = nil, selected: Bool? = nil, checked: Bool? = nil, focused: Bool? = nil) {
        self.enabled = enabled
        self.selected = selected
        self.checked = checked
        self.focused = focused
    }

    public var json: [String: Any] {
        var out: [String: Any] = [:]
        if let enabled { out["enabled"] = enabled }
        if let selected { out["selected"] = selected }
        if let checked { out["checked"] = checked }
        if let focused { out["focused"] = focused }
        return out
    }
}

/// One thing on screen. Frames are in **points**, because that is what input
/// speaks; the capture side works in pixels and converts once, here.
public struct Element: Sendable {
    public var id: Int
    public var frame: CGRect
    public var role: String
    public var label: String?
    public var value: String?
    /// The app's own name for the control, when it publishes one. Never shown
    /// to a reader, but it is what a test written against the app matches on.
    public var identifier: String?
    public var state: ElementState
    public var source: ElementSource
    public var confidence: Double

    public init(id: Int, frame: CGRect, role: String, label: String? = nil, value: String? = nil,
                identifier: String? = nil, state: ElementState = ElementState(),
                source: ElementSource, confidence: Double = 1) {
        self.id = id
        self.frame = frame
        self.role = role
        self.label = label
        self.value = value
        self.identifier = identifier
        self.state = state
        self.source = source
        self.confidence = confidence
    }

    public var center: CGPoint { CGPoint(x: frame.midX, y: frame.midY) }

    public var json: [String: Any] {
        var out: [String: Any] = [
            "id": id,
            "role": role,
            "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
            "center": ["x": Int(center.x.rounded()), "y": Int(center.y.rounded())],
            "source": source.names,
            "confidence": (confidence * 1000).rounded() / 1000,
        ]
        if let label { out["label"] = label }
        if let value { out["value"] = value }
        if let identifier { out["identifier"] = identifier }
        let state = state.json
        if !state.isEmpty { out["state"] = state }
        return out
    }
}

public extension Element {
    /// An accessibility node as an element.
    ///
    /// The role carries the subrole when there is one — a search field is a
    /// `TextField` to the tree and a `SearchField` to anyone reading the map,
    /// and the distinction is worth keeping.
    init(id: Int, node: AXNode) {
        self.init(
            id: id,
            frame: node.frame,
            role: node.subrole ?? node.role,
            label: node.label,
            value: node.value,
            identifier: node.identifier,
            state: ElementState(enabled: node.enabled, selected: node.selected,
                                checked: nil, focused: node.focused),
            source: .accessibility,
            confidence: 1)
    }
}

/// Everything known about one screen.
public struct ScreenMap: Sendable {
    public var fingerprint: String        // the layout hash
    public var hash: String               // the content hash
    public var size: CGSize               // points
    public var elements: [Element]
    public var sources: [String]
    public var capturedAt: Double

    public init(fingerprint: String, hash: String, size: CGSize, elements: [Element],
                sources: [String], capturedAt: Double) {
        self.fingerprint = fingerprint
        self.hash = hash
        self.size = size
        self.elements = elements
        self.sources = sources
        self.capturedAt = capturedAt
    }

    public var json: [String: Any] {
        [
            "fingerprint": fingerprint,
            "hash": hash,
            "size": ["width": Int(size.width), "height": Int(size.height)],
            "sources": sources,
            "capturedAt": capturedAt,
            "elements": elements.map(\.json),
        ]
    }
}
