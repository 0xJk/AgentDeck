package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.PermissionMode
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.component.stateColor
import dev.agentdeck.ui.eink.agentIcon
import dev.agentdeck.ui.eink.compactStateMarker
import dev.agentdeck.ui.eink.mapSessionState

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

    // Primary agent — skip if daemon (not a coding agent; openclaw shows as 🦞)
    if (agentType != "daemon") {
        entries += SessionEntry(
            projectName = projectName ?: "Agent",
            agentType = agentType,
            modelName = modelName,
            effortLevel = effortLevel,
            agentState = agentState,
            isPrimary = true,
        )
    }

    // Siblings (skip self and daemon)
    siblingSessions.forEach { session ->
        if (session.id == sessionId) return@forEach
        if (session.agentType == "daemon") return@forEach
        entries += SessionEntry(
            projectName = session.projectName ?: "Agent",
            agentType = session.agentType,
            modelName = null,
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
        // Permission mode badge (non-default only)
        if (permissionMode != PermissionMode.DEFAULT) {
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
            val icon = agentIcon(entry.agentType)
            val stateMarker = compactStateMarker(entry.agentState)
            val modelEffort = when {
                entry.modelName != null && entry.effortLevel != null && entry.effortLevel != "medium" ->
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

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Top,
            ) {
                // State color dot
                Spacer(
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(stateColor(entry.agentState)),
                )

                Column(modifier = Modifier.weight(1f)) {
                    // Agent icon + session name
                    Text(
                        text = "$icon ${entry.projectName}$suffix",
                        color = TerrariumColors.HUDText,
                        fontSize = 12.sp,
                        fontWeight = if (entry.isPrimary) FontWeight.Bold else FontWeight.Normal,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    // Model · state
                    Text(
                        text = subLine,
                        color = TerrariumColors.HUDSubtext,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
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
