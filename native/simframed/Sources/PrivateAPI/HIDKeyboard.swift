import Foundation

/// USB HID usage codes for the keys simframe can type.
///
/// Only ASCII is covered. Anything outside it — emoji, accented text, other
/// scripts — has no usage code and must go through the pasteboard instead,
/// which is a separate path rather than something to fake here.
public enum HIDKeyboard {
    public static let leftShift: UInt32 = 0xE1

    public struct Key {
        public let code: UInt32
        public let shift: Bool
    }

    private static let lowercase: [Character: UInt32] = {
        var map: [Character: UInt32] = [:]
        for (i, c) in "abcdefghijklmnopqrstuvwxyz".enumerated() { map[c] = UInt32(0x04 + i) }
        for (i, c) in "1234567890".enumerated() { map[c] = UInt32(0x1E + i) }
        return map
    }()

    private static let symbols: [Character: (UInt32, Bool)] = [
        " ": (0x2C, false), "\n": (0x28, false), "\t": (0x2B, false),
        "-": (0x2D, false), "=": (0x2E, false), "[": (0x2F, false), "]": (0x30, false),
        "\\": (0x31, false), ";": (0x33, false), "'": (0x34, false), "`": (0x35, false),
        ",": (0x36, false), ".": (0x37, false), "/": (0x38, false),
        "_": (0x2D, true), "+": (0x2E, true), "{": (0x2F, true), "}": (0x30, true),
        "|": (0x31, true), ":": (0x33, true), "\"": (0x34, true), "~": (0x35, true),
        "<": (0x36, true), ">": (0x37, true), "?": (0x38, true),
        "!": (0x1E, true), "@": (0x1F, true), "#": (0x20, true), "$": (0x21, true),
        "%": (0x22, true), "^": (0x23, true), "&": (0x24, true), "*": (0x25, true),
        "(": (0x26, true), ")": (0x27, true),
    ]

    public static func usage(for scalar: Unicode.Scalar) -> Key? {
        let c = Character(scalar)
        if let code = lowercase[c] { return Key(code: code, shift: false) }
        if let code = lowercase[Character(String(c).lowercased())], c.isUppercase {
            return Key(code: code, shift: true)
        }
        if let (code, shift) = symbols[c] { return Key(code: code, shift: shift) }
        return nil
    }

    /// Whether every character in `text` can be typed as key events.
    public static func canType(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy { usage(for: $0) != nil }
    }

    /// IndigoHIDButtonKeyCode values.
    ///
    /// Only `home` is verified: code 2 with target 0 produced a full-screen
    /// transition to springboard. The rest are unverified and deliberately
    /// return nil rather than guessing, because a wrong code here is not a
    /// no-op — reports exist of the Siri path crashing backboardd, and
    /// silently locking someone's simulator is not a good failure mode.
    ///
    /// To identify one: send codes with target 0 and watch `simframe state
    /// --since` for a screen change, one at a time, on a simulator you are
    /// willing to disturb.
    public static func buttonCode(_ button: HardwareButton) -> UInt32? {
        switch button {
        case .home: return 2
        case .lock, .siri, .volumeUp, .volumeDown: return nil
        }
    }
}
