#if os(macOS)
// ModuleManager.swift — Device module lifecycle management
// Ported from bridge/src/modules/index.ts

import Foundation

protocol DeviceModule: AnyObject, Sendable {
    var name: String { get }
    func start() async
    func stop() async
    func handleWake() async
}

extension DeviceModule {
    func handleWake() async {}  // Default no-op for modules that don't need wake recovery
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

    /// Notify all modules of system wake — each module handles recovery independently (parallel)
    func wakeAll() async {
        await withTaskGroup(of: Void.self) { group in
            for module in modules {
                group.addTask {
                    DaemonLogger.shared.debug("Modules", "Wake recovery: \(module.name)")
                    await module.handleWake()
                }
            }
        }
    }
}
#endif
