// TerrariumState.swift — Visual state mapping from DashboardState
// Ported from android TerrariumState.kt

import Foundation

// MARK: - Octopus Visual State

enum OctopusVisualState {
    case sleeping   // Curled at bottom, dim
    case floating   // Gentle bob, tentacle wave (idle)
    case working    // Swim + starburst (processing)
    case asking     // Fidget + "?" bubble (awaiting input)
}

// MARK: - Crayfish Visual State

enum CrayfishVisualState {
    case dormant    // Hidden behind rocks
    case sitting    // Idle, heartbeat glow
    case observing  // Watching, gentle fidget
    case routing    // Claws clap, signal waves
    case waiting    // Claws raised
    case sick       // Desaturated, tilted (gateway error)
}

// MARK: - Tetra Visual State

enum TetraVisualState {
    case absent
    case circling   // Boids orbit
    case streaming  // Line up, food chase
    case hovering   // Near options
}

// MARK: - Agent Creature State

struct AgentCreatureState: Identifiable {
    let id: String           // session ID
    let projectName: String?
    let modelName: String?
    let state: OctopusVisualState
    let homeX: Float
    let homeY: Float
    let scale: Float

    /// Whether this session just exited ASKING (triggers pop burst)
    var exitedAsking = false
}

// MARK: - Terrarium State (aggregate)

struct TerrariumState {
    var creatures: [AgentCreatureState] = []
    var crayfishState: CrayfishVisualState = .dormant
    var crayfishVisible: Bool = false
    var tetraState: TetraVisualState = .circling
    var environment: EnvironmentVisualState = .calm
    var hasError: Bool = false

    /// Pop burst positions (from ASKING exit)
    var popBurstPositions: [(x: Float, y: Float)] = []
}

// MARK: - Mapping from DashboardState

extension DashboardState {
    func toTerrariumState(previous: TerrariumState? = nil) -> TerrariumState {
        var result = TerrariumState()

        // Primary session creature (skip daemon and openclaw — they're not octopuses)
        let primaryIsOctopus = state != .disconnected
            && agentType != "daemon"
            && agentType != "openclaw"

        // Octopus siblings (exclude daemon + openclaw)
        let siblings = siblingSessions.filter {
            $0.agentType != "daemon" && $0.agentType != "openclaw"
        }

        let octopusCount = (primaryIsOctopus ? 1 : 0) + siblings.count
        let slots = CreatureLayout.layoutOctopuses(count: max(1, octopusCount))

        var creatures: [AgentCreatureState] = []
        var slotIdx = 0

        if primaryIsOctopus {
            let primaryState = mapToOctopusState(state)
            let slot = slots.first ?? CreatureSlot(x: 0.4, y: 0.45, scale: 1.0)

            // Detect ASKING exit for pop burst
            let wasAsking = previous?.creatures.first?.state == .asking
            let exitedAsking = wasAsking && primaryState != .asking

            creatures.append(AgentCreatureState(
                id: sessionId ?? "primary",
                projectName: projectName,
                modelName: modelName,
                state: primaryState,
                homeX: slot.x,
                homeY: slot.y,
                scale: slot.scale,
                exitedAsking: exitedAsking
            ))
            slotIdx = 1
        }
        // Sibling octopuses
        for (i, sibling) in siblings.enumerated() {
            let idx = min(slotIdx + i, slots.count - 1)
            let s = slots[idx]
            let sibState = mapSiblingState(sibling.state)
            creatures.append(AgentCreatureState(
                id: sibling.id,
                projectName: sibling.projectName,
                modelName: nil,
                state: sibState,
                homeX: s.x,
                homeY: s.y,
                scale: s.scale
            ))
        }

        result.creatures = creatures

        // Environment state — in daemon mode, derive from most active sibling
        let isDaemonLike = agentType == "daemon" ||
            (agentType != nil && siblingSessions.contains(where: { $0.agentType == agentType }))
        let effectiveState: AgentConnectionState
        if isDaemonLike && state == .disconnected {
            effectiveState = mostActiveSiblingState(siblingSessions) ?? .idle
        } else {
            effectiveState = state
        }
        result.environment = mapToEnvironment(effectiveState)
        result.hasError = gatewayHasError

        // Crayfish (OpenClaw gateway)
        result.crayfishVisible = gatewayAvailable

        if gatewayHasError {
            result.crayfishState = .sick
        } else if let ocSibling = siblingSessions.first(where: { $0.agentType == "openclaw" }) {
            result.crayfishState = ocSibling.state == "processing" ? .routing : .sitting
        } else if gatewayAvailable {
            result.crayfishState = .sitting
        } else {
            result.crayfishState = .dormant
        }

        // Tetra state — use effectiveState so daemon mode isn't stuck on ABSENT
        if effectiveState == .processing || creatures.contains(where: { $0.state == .working }) {
            result.tetraState = .streaming
        } else if effectiveState.isAwaiting {
            result.tetraState = .hovering
        } else if effectiveState == .disconnected {
            result.tetraState = .absent
        } else {
            result.tetraState = .circling
        }

        // Pop bursts from ASKING exits
        result.popBurstPositions = creatures
            .filter { $0.exitedAsking }
            .map { (x: $0.homeX, y: $0.homeY) }

        return result
    }

    private func mapToOctopusState(_ connState: AgentConnectionState) -> OctopusVisualState {
        switch connState {
        case .disconnected: .sleeping
        case .idle: .floating
        case .processing: .working
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .asking
        }
    }

    private func mapSiblingState(_ stateStr: String?) -> OctopusVisualState {
        switch stateStr {
        case "processing": .working
        case "awaiting_permission", "awaiting_option", "awaiting_diff": .asking
        case "idle": .floating
        default: .sleeping
        }
    }

    private func mapToEnvironment(_ connState: AgentConnectionState) -> EnvironmentVisualState {
        switch connState {
        case .disconnected: .dark
        case .idle: .calm
        case .processing: .active
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .alert
        }
    }

    /// In daemon mode, derive the most active state from sibling sessions.
    private func mostActiveSiblingState(_ siblings: [SessionInfo]) -> AgentConnectionState? {
        func priority(_ s: AgentConnectionState) -> Int {
            switch s {
            case .disconnected: return 0
            case .idle: return 1
            case .processing: return 2
            case .awaitingPermission, .awaitingOption, .awaitingDiff: return 3
            }
        }
        var best: AgentConnectionState? = nil
        for s in siblings {
            if s.agentType == "daemon" { continue }
            let mapped: AgentConnectionState? = switch s.state {
            case "processing": .processing
            case "awaiting_permission": .awaitingPermission
            case "awaiting_option": .awaitingOption
            case "awaiting_diff": .awaitingDiff
            case "idle": .idle
            default: nil
            }
            guard let m = mapped else { continue }
            if best == nil || priority(m) > priority(best!) {
                best = m
            }
        }
        return best
    }
}
