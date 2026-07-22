// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ClaudeRemoteMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ClaudeRemoteMac", targets: ["ClaudeRemoteMac"]),
    ],
    targets: [
        .executableTarget(
            name: "ClaudeRemoteMac",
            path: "Sources/ClaudeRemoteMac"
        ),
    ]
)
