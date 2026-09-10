import Foundation
import FoundationModels

@available(macOS 26.0, *)
@Generable
struct Ranking {
    @Guide(description: "Labels ordered most likely first")
    var order: [String]
}

let cases: [(String, [String])] = [
    ("change my username", ["General", "Notifications", "Privacy & Security", "Account", "Display & Brightness", "Sounds"]),
    ("turn on dark mode", ["General", "Accessibility", "Display & Brightness", "Wallpaper", "Battery"]),
    ("stop the app tracking me", ["Face ID & Passcode", "Privacy & Security", "Screen Time", "General"]),
    ("delete my saved cards", ["Wallet & Apple Pay", "Passwords", "General", "Notifications"]),
    ("make the text bigger", ["Display & Brightness", "Accessibility", "General", "Sounds & Haptics"]),
    ("find previous orders", ["Home", "Assets", "Work Orders", "Profile", "Notifications"]),
]

if #available(macOS 26.0, *) {
    let session = LanguageModelSession(instructions: """
    You rank UI controls. Given a thing the user is looking for and a list of \
    on-screen labels, order the labels from most to least likely to lead to it. \
    Use only the labels given, verbatim.
    """)
    // Warm the session once; the first call pays model load.
    let warm = Date()
    _ = try? await session.respond(to: "Looking for: test\nLabels: A, B", generating: Ranking.self)
    print("cold warm-up: \(Int(Date().timeIntervalSince(warm) * 1000))ms\n")
    var times: [Int] = []
    for (goal, options) in cases {
        let started = Date()
        do {
            let out = try await session.respond(
                to: "Looking for: \(goal)\nLabels: \(options.joined(separator: ", "))",
                generating: Ranking.self)
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            times.append(ms)
            print("\(String(ms).padding(toLength: 6, withPad: " ", startingAt: 0))ms  \(goal)")
            print("          -> \(out.content.order.prefix(3).joined(separator: " > "))")
        } catch {
            print("error on \(goal): \(error)")
        }
    }
    if !times.isEmpty {
        let sorted = times.sorted()
        print("\nwarm median \(sorted[sorted.count / 2])ms   min \(sorted.first!)ms   max \(sorted.last!)ms")
    }
}
