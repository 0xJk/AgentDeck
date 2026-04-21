package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PermissionMode
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.component.AgentDeckLogo
import dev.agentdeck.ui.component.BrandIcon
import dev.agentdeck.ui.component.stateColor
import dev.agentdeck.ui.eink.agentTypeRank
import dev.agentdeck.ui.eink.compactStateMarker
import dev.agentdeck.ui.eink.mapSessionState
import dev.agentdeck.ui.eink.stateRank

/**
 * Left HUD panel — AgentDeck logo + unified session list (primary + siblings).
 * Replaces the old MultiAgentPanel with a comprehensive session overview.
 */
@Composable
fun SessionListPanel(
    projectName: String?,
    agentType: String?,
    modelName: String?,
    effortLevel: String? = null,
    agentState: AgentState,
    sessionId: String?,
    siblingSessions: List<SessionInfo>,
    workerSessionCount: Int?,
    permissionMode: PermissionMode = PermissionMode.DEFAULT,
    modifier: Modifier = Modifier,
) {
    // Build unified entry list: primary + siblings (excluding self)
    data class SessionEntry(
        val projectName: String,
        val agentType: String?,
        val modelName: String?,
        val effortLevel: String?,
        val agentState: AgentState,
        val isPrimary: Boolean,
    )

    val entries = mutableListOf<SessionEntry>()

    // Daemon-like detection: skip primary if daemon, if it's the OpenClaw gateway
    // proxy (always virtualized into siblings), or if sessions already contain an
    // entry with the same agentType. Hardening "openclaw" unconditionally protects
    // against a race between state_update and sessions_list where the primary
    // briefly carries agentType=openclaw + agentState=DISCONNECTED.
    val isDaemonLike = agentType == "daemon" ||
        agentType == "openclaw" ||
        siblingSessions.any { it.agentType == agentType }
    if (!isDaemonLike) {
        entries += SessionEntry(
            projectName = projectName ?: "Agent",
            agentType = agentType,
            modelName = modelName,
            effortLevel = effortLevel,
            agentState = agentState,
            isPrimary = true,
        )
    }

    // Siblings (skip self and daemon), stable sort: agentType → projectName
    // (case-insensitive — must match Apple/shared sortSessions exactly)
    siblingSessions
        .filter { it.id != sessionId && it.agentType != "daemon" }
        .sortedWith(
            compareBy<SessionInfo> { agentTypeRank(it.agentType) }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.projectName ?: "" }
        )
        .forEach { session ->
            entries += SessionEntry(
                projectName = session.projectName ?: "Agent",
                agentType = session.agentType,
                modelName = session.modelName,
                effortLevel = null,
                agentState = mapSessionState(session),
                isPrimary = false,
            )
        }

    // Count occurrences per (projectName, agentType) for #N suffix —
    // different agent types (🦞 vs 🐙) with the same project name don't need numbering
    data class NameKey(val projectName: String, val agentType: String?)
    val nameCounts = entries.groupBy { NameKey(it.projectName, it.agentType) }
        .mapValues { it.value.size }
    val nameCounters = mutableMapOf<NameKey, Int>()

    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Brand logo
        AgentDeckLogo(isEink = false, modifier = Modifier.fillMaxWidth())
        Spacer(modifier = Modifier.height(4.dp))

        // Permission mode badge — hidden (too noisy, mode info visible on SD+ already)
        if (false && permissionMode != PermissionMode.DEFAULT) {
            Text(
                text = "mode:${permissionMode.name.lowercase()}",
                color = TerrariumColors.HUDSubtext,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .background(TerrariumColors.HUDBg, RoundedCornerShape(4.dp))
                    .padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }

        Spacer(modifier = Modifier.height(2.dp))

        // Session entries
        entries.forEach { entry ->
            val stateMarker = compactStateMarker(entry.agentState)
            val modelEffort = when {
                entry.modelName != null && entry.effortLevel != null
                    && entry.effortLevel != "medium" && entry.effortLevel != "default" ->
                    "${entry.modelName} \u00B7 ${entry.effortLevel}"
                entry.modelName != null -> entry.modelName
                else -> null
            }
            val subLine = if (modelEffort != null) {
                "$modelEffort \u00B7 $stateMarker"
            } else {
                stateMarker
            }

            // #N suffix for duplicate sessions of the same agent type
            val key = NameKey(entry.projectName, entry.agentType)
            val needsSuffix = (nameCounts[key] ?: 1) > 1
            val suffix = if (needsSuffix) {
                val idx = (nameCounters[key] ?: 0) + 1
                nameCounters[key] = idx
                " #$idx"
            } else {
                ""
            }

            Column(modifier = Modifier.fillMaxWidth()) {
                // Agent brand icon + session name
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    BrandIcon(agentType = entry.agentType, isEink = false)
                    Text(
                        text = "${entry.projectName}$suffix",
                        color = TerrariumColors.HUDText,
                        fontSize = 12.sp,
                        fontWeight = if (entry.isPrimary) FontWeight.Bold else FontWeight.Normal,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // Model · state (state colored)
                Text(
                    text = subLine,
                    color = stateColor(entry.agentState),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        // Worker count
        if (workerSessionCount != null && workerSessionCount > 0) {
            Text(
                text = "Workers: $workerSessionCount",
                color = TerrariumColors.HUDText,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}
