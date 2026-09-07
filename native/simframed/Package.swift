// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "simframed",
    platforms: [.macOS(.v13)],
    targets: [
        // Every private-framework call lives here, behind a protocol, so a
        // signature change is a one-file fix and tests can run without a device.
        .target(name: "PrivateAPI"),
        // Platform-independent: hashing, downscaling, the on-disk frame layout.
        .target(name: "SimframeCore", dependencies: ["PrivateAPI"]),
        .executableTarget(name: "simframed", dependencies: ["SimframeCore", "PrivateAPI"]),
        .testTarget(name: "SimframeCoreTests", dependencies: ["SimframeCore"]),
    ]
)
