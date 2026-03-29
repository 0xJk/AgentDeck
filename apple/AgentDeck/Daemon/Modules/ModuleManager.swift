#if os(macOS)
// ModuleManager.swift — Device module lifecycle management
// Ported from bridge/src/modules/index.ts

import Foundation

protocol DeviceModule: AnyObject, Sendable {
    var name: String { get }
    func start() async
    func stop() async
}

@MainActor
final class ModuleManager {
    private var modules: [DeviceModule] = []

    func register(_ module: DeviceModule) {
        modules.append(module)
    }

    func startAll() async {
        for module in modules {
            DaemonLogger.shared.debug("Modules", "Starting \(module.name)")
            await module.start()
        }
    }

    func stopAll() async {
        for module in modules {
            await module.stop()
        }
    }
}
#endif
