package dev.agentdeck.ui.deck

import androidx.compose.ui.graphics.Color
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PermissionMode
import dev.agentdeck.net.PromptOption
import dev.agentdeck.state.DashboardState

// --- Actions that a deck button can trigger ---

sealed class DeckAction {
    data object SwitchMode : DeckAction()
    data class Command(val text: String) : DeckAction()
    data class SelectOption(val index: Int) : DeckAction()
    data class Respond(val value: String) : DeckAction()
    data object Interrupt : DeckAction()
    data object Escape : DeckAction()
    data object ShowMoreOptions : DeckAction()
    data object Noop : DeckAction()
}

// --- Button config matching Stream Deck+ slots ---

data class DeckButtonConfig(
    val title: String,
    val subtitle: String? = null,
    val bgColor: Color,
    val textColor: Color = Color.White,
    val enabled: Boolean = true,
    val action: DeckAction = DeckAction.Noop,
    val dim: Boolean = false,
    val icon: String? = null,
    val badge: String? = null,
    val actionString: String? = null,
)

// Dim placeholder
private val DIM = DeckButtonConfig(
    title = "",
    bgColor = Color(0xFF1A1A1A),
    textColor = Color(0xFF444444),
    enabled = false,
    dim = true,
)

// --- Semantic colors for options (ported from layout-manager.ts) ---

data class OptionColors(val bg: Color, val text: Color)

fun colorForOption(opt: PromptOption): OptionColors {
    val shortcut = (opt.shortcut ?: "").lowercase()
    val lower = opt.label.lowercase()

    // Blue: always / "don't ask again" / "allow all sessions"
    if (lower.startsWith("always")) {
        return OptionColors(Color(0xFF1E40AF), Color.White)
    }
    if (Regex("""don[''\u2019]t\s+ask\s+again""").containsMatchIn(lower)) {
        return OptionColors(Color(0xFF1E40AF), Color.White)
    }
    if (Regex("""allow\s+all\s+sessions""").containsMatchIn(lower)) {
        return OptionColors(Color(0xFF1E40AF), Color.White)
    }

    // Red: no, deny
    if (shortcut == "n" || shortcut == "d" || lower.startsWith("no") || lower.startsWith("deny")) {
        return OptionColors(Color(0xFF991B1B), Color.White)
    }

    // Green: yes, apply, allow (shortcuts y/a)
    if (shortcut == "y" || shortcut == "a") {
        return OptionColors(Color(0xFF166534), Color.White)
    }

    // Recommended: dark green
    if (opt.recommended == true) {
        return OptionColors(Color(0xFF1E4D2B), Color(0xFF86EFAC))
    }

    // Teal default
    return OptionColors(Color(0xFF1E3A5F), Color(0xFF93C5FD))
}

// --- Layout computation: returns 8 buttons matching SD+ slot positions ---

fun computeDeckLayout(state: DashboardState): List<DeckButtonConfig> {
    val agentState = state.agentState
    val options = state.options

    return when (agentState) {
        AgentState.DISCONNECTED -> disconnectedLayout()
        AgentState.IDLE -> idleLayout(state)
        AgentState.PROCESSING -> processingLayout(state)
        AgentState.AWAITING_PERMISSION -> permissionLayout(state, options)
        AgentState.AWAITING_OPTION -> optionLayout(options)
        AgentState.AWAITING_DIFF -> diffLayout(state, options)
    }
}

// --- Per-state layouts ---

private fun disconnectedLayout(): List<DeckButtonConfig> =
    List(8) { DIM }

private fun idleLayout(state: DashboardState): List<DeckButtonConfig> {
    val modeColor = when (state.permissionMode) {
        PermissionMode.DEFAULT -> Color(0xFF2A2A2A)
        PermissionMode.PLAN -> Color(0xFF7C3AED)
        PermissionMode.ACCEPT_EDITS -> Color(0xFF2563EB)
        PermissionMode.DONT_ASK -> Color(0xFF0E7490)
        PermissionMode.BYPASS_PERMISSIONS -> Color(0xFF991B1B)
    }
    val modeLabel = when (state.permissionMode) {
        PermissionMode.DEFAULT -> "DEFAULT"
        PermissionMode.PLAN -> "PLAN"
        PermissionMode.ACCEPT_EDITS -> "ACCEPT"
        PermissionMode.DONT_ASK -> "DON'T ASK"
        PermissionMode.BYPASS_PERMISSIONS -> "BYPASS"
    }

    return listOf(
        // Row 1
        DeckButtonConfig(
            title = modeLabel,
            subtitle = "Mode",
            bgColor = modeColor,
            action = DeckAction.SwitchMode,
        ),
        DeckButtonConfig(
            title = state.projectName ?: "—",
            subtitle = state.modelName,
            bgColor = Color(0xFF1E293B),
        ),
        usageButton(state),
        DeckButtonConfig(
            title = "GO ON",
            bgColor = Color(0xFF1E3A2F),
            textColor = Color(0xFF22C55E),
            action = DeckAction.Command("go on"),
        ),
        // Row 2
        DeckButtonConfig(
            title = "REVIEW",
            bgColor = Color(0xFF1E293B),
            action = DeckAction.Command("/review"),
        ),
        DeckButtonConfig(
            title = "COMMIT",
            bgColor = Color(0xFF1E293B),
            action = DeckAction.Command("/commit"),
        ),
        DeckButtonConfig(
            title = "CLEAR",
            bgColor = Color(0xFF1E293B),
            action = DeckAction.Command("/compact"),
        ),
        DeckButtonConfig(
            title = "ESC",
            bgColor = Color(0xFF3D2607),
            textColor = Color(0xFFFFB347),
            action = DeckAction.Escape,
        ),
    )
}

private fun processingLayout(state: DashboardState): List<DeckButtonConfig> {
    val modeLabel = when (state.permissionMode) {
        PermissionMode.DEFAULT -> "DEFAULT"
        PermissionMode.PLAN -> "PLAN"
        PermissionMode.ACCEPT_EDITS -> "ACCEPT"
        PermissionMode.DONT_ASK -> "DON'T ASK"
        PermissionMode.BYPASS_PERMISSIONS -> "BYPASS"
    }

    return listOf(
        // Row 1
        DeckButtonConfig(
            title = modeLabel,
            bgColor = Color(0xFF1A1A1A),
            textColor = Color(0xFF444444),
            enabled = false,
        ),
        DeckButtonConfig(
            title = state.currentTool ?: "...",
            subtitle = state.toolProgress,
            bgColor = Color(0xFF1E3A5F),
            textColor = Color(0xFF93C5FD),
        ),
        usageButton(state),
        DIM,
        // Row 2
        DIM,
        DIM,
        DIM,
        DeckButtonConfig(
            title = "STOP",
            bgColor = Color(0xFFCC0000),
            textColor = Color.White,
            action = DeckAction.Interrupt,
        ),
    )
}

private fun permissionLayout(
    state: DashboardState,
    options: List<PromptOption>,
): List<DeckButtonConfig> {
    val fixedSlots = listOf(
        DIM, // slot 0: mode dim
        DeckButtonConfig(
            title = "PERMIT?",
            bgColor = Color(0xFFB45309),
            textColor = Color.White,
        ),
        usageButton(state),
    )

    val quickSlots = if (options.isEmpty()) {
        // Fallback: hardcoded YES/NO/ALWAYS
        listOf(
            DeckButtonConfig(
                title = "YES",
                bgColor = Color(0xFF166534),
                action = DeckAction.Respond("y"),
            ),
            DeckButtonConfig(
                title = "NO",
                bgColor = Color(0xFF991B1B),
                action = DeckAction.Respond("n"),
            ),
            DeckButtonConfig(
                title = "ALWAYS",
                bgColor = Color(0xFF1E40AF),
                action = DeckAction.Respond("a"),
            ),
            DIM,
        )
    } else {
        optionSlots(options, state.navigable)
    }

    val stopSlot = DeckButtonConfig(
        title = "ESC",
        bgColor = Color(0xFFB45309),
        textColor = Color.White,
        action = DeckAction.Escape,
    )

    return fixedSlots + quickSlots.take(1) + quickSlots.drop(1).take(3) + stopSlot
}

private fun optionLayout(options: List<PromptOption>): List<DeckButtonConfig> {
    val fixedSlots = listOf(
        DIM, // slot 0
        DeckButtonConfig(
            title = "SELECT",
            bgColor = Color(0xFFB45309),
            textColor = Color.White,
        ),
        DIM, // slot 2: no usage during selection
    )

    val quickSlots = optionSlots(options, navigable = null)

    val stopSlot = DeckButtonConfig(
        title = "ESC",
        bgColor = Color(0xFFB45309),
        textColor = Color.White,
        action = DeckAction.Escape,
    )

    return fixedSlots + quickSlots.take(1) + quickSlots.drop(1).take(3) + stopSlot
}

private fun diffLayout(
    state: DashboardState,
    options: List<PromptOption>,
): List<DeckButtonConfig> {
    // Diff review is structurally identical to permission
    return permissionLayout(state, options)
}

// --- Helpers ---

private fun usageButton(state: DashboardState): DeckButtonConfig {
    val pct = state.usage.fiveHourPercent
    val usageText = if (pct != null) "${(pct * 100).toInt()}%" else "—"
    val usageColor = when {
        pct == null -> Color(0xFF1E293B)
        pct >= 0.9 -> Color(0xFF991B1B) // red
        pct >= 0.7 -> Color(0xFF92400E) // amber
        else -> Color(0xFF166534) // green
    }
    return DeckButtonConfig(
        title = usageText,
        subtitle = "5h",
        bgColor = usageColor,
        textColor = Color.White,
    )
}

private fun optionSlots(
    options: List<PromptOption>,
    navigable: Boolean?,
): List<DeckButtonConfig> {
    if (options.isEmpty()) return List(4) { DIM }

    if (options.size <= 4) {
        return List(4) { i ->
            if (i < options.size) {
                optionToButton(options[i], navigable)
            } else {
                DIM
            }
        }
    }

    // 5+ options: first 3 + MORE
    return listOf(
        optionToButton(options[0], navigable),
        optionToButton(options[1], navigable),
        optionToButton(options[2], navigable),
        DeckButtonConfig(
            title = "MORE \u25BC",
            bgColor = Color(0xFF334155),
            textColor = Color(0xFF94A3B8),
            action = DeckAction.ShowMoreOptions,
        ),
    )
}

private fun optionToButton(
    opt: PromptOption,
    navigable: Boolean?,
): DeckButtonConfig {
    val colors = colorForOption(opt)
    val action = if (navigable == true) {
        DeckAction.SelectOption(opt.index ?: 0)
    } else {
        val key = opt.shortcut ?: opt.label.firstOrNull()?.lowercase() ?: "y"
        DeckAction.Respond(key)
    }
    return DeckButtonConfig(
        title = opt.label,
        subtitle = opt.description,
        bgColor = colors.bg,
        textColor = colors.text,
        action = action,
    )
}
