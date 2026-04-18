package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.SubscriptionInfo
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.component.AgentDeckMark
import dev.agentdeck.ui.component.brandColorForAgent
import dev.agentdeck.util.formatResetTime

/**
 * Relationship-centric rail that replaces the former `TankStatusPanel`.
 * Reads top-to-bottom as:
 *
 *   UPSTREAM (Claude · OpenClaw · MLX · Ollama)
 *       ↓
 *   ⎔ AgentDeck :9120   (hub node, neon cyan)
 *       ↓
 *   DOWNSTREAM (devices — placeholder until the bridge ships moduleHealth
 *               for the Android client)
 *
 * Each upstream provider row shows its status (LED glyph), label, compact
 * subtitle, optional inline rate-gauges (Claude's 5h/7d) and **consumer
 * creature dots** — the brand colors of sessions whose modelName maps to
 * this provider. "Who's using Claude right now" becomes visible at a
 * glance, which is the whole point of showing relationships instead of
 * two unrelated list boxes.
 *
 * Palette stays fully within `TerrariumColors` so the rail still reads as
 * aquarium HUD chrome, not a light-mode card. Mirrors the Swift
 * `TopologyRail.swift` contract.
 */
@Composable
fun TopologyRail(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        SectionHeader("UPSTREAM")
        UpstreamRows(state = state)
        FlowArrow()
        HubNode()
        FlowArrow()
        SectionHeader("DOWNSTREAM")
        DownstreamRows(state = state)
    }
}

// MARK: - Section chrome

@Composable
private fun SectionHeader(title: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.padding(bottom = 4.dp),
    ) {
        Text(
            text = title,
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 1.4.sp,
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(0.5.dp)
                .background(TerrariumColors.TetraNeon.copy(alpha = 0.25f)),
        )
    }
}

@Composable
private fun FlowArrow() {
    Text(
        text = "▼",
        color = TerrariumColors.TetraNeon.copy(alpha = 0.55f),
        fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
    )
}

@Composable
private fun HubNode() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = Color.Black.copy(alpha = 0.45f),
                shape = RoundedCornerShape(6.dp),
            )
            .border(
                border = BorderStroke(1.dp, TerrariumColors.TetraNeon.copy(alpha = 0.55f)),
                shape = RoundedCornerShape(6.dp),
            )
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AgentDeckMark(size = 18.dp, color = TerrariumColors.TetraNeon)
        Column {
            Text(
                text = "AgentDeck",
                color = TerrariumColors.HUDText,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = ":9120",
                color = TerrariumColors.HUDSubtext,
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

// MARK: - Upstream rows

@Composable
private fun UpstreamRows(state: DashboardState) {
    val usage = state.usage
    val ollama = state.ollamaStatus
    val modelCatalog = state.modelCatalog ?: emptyList()
    // `modelCatalog` belongs to the primary session's provider only — if
    // the primary session is a Claude session, the catalog has Claude
    // models; if OpenClaw, it has OpenClaw gateway models. Mis-reading
    // this caused `claude-opus` to render under the OpenClaw row.
    // Conservative — only the two known catalog publishers get trusted.
    val catalogOwner: ProviderKey = when (state.agentType) {
        "claude-code" -> ProviderKey.CLAUDE
        "openclaw" -> ProviderKey.OPENCLAW
        else -> ProviderKey.UNKNOWN
    }

    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        // Claude — subtitle carries the actually-available model catalog
        // (Opus / Sonnet / Haiku) only when the catalog belongs to
        // Claude. Otherwise we fall back to OAuth status or nil.
        val claudeModels = if (catalogOwner == ProviderKey.CLAUDE) {
            modelCatalog
                .filter { it.available }
                .sortedWith(
                    compareByDescending<ModelCatalogEntry> { it.role == "default" }
                        .thenBy { it.name }
                )
                .map { shortClaudeModel(it.name) }
        } else {
            emptyList()
        }
        ProviderRow(
            name = "Claude",
            status = when (state.oauthConnected) {
                true -> LEDStatus.OK
                false -> LEDStatus.WARN
                null -> LEDStatus.DIM
            },
            subtitle = when {
                claudeModels.isNotEmpty() -> claudeModels.joinToString(", ")
                state.oauthConnected == false -> "Not connected"
                else -> null
            },
            consumers = consumersFor(ProviderKey.CLAUDE, state),
            rateLimits = buildList {
                val isStale = usage.usageStale == true
                val fiveHour = usage.fiveHourPercent
                if (fiveHour != null) {
                    add(
                        RateChip(
                            label = "5h",
                            percent = fiveHour,
                            reset = usage.fiveHourResetsAt?.let { formatResetTime(it) },
                            stale = isStale,
                        )
                    )
                }
                val sevenDay = usage.sevenDayPercent
                if (sevenDay != null) {
                    add(
                        RateChip(
                            label = "7d",
                            percent = sevenDay,
                            reset = usage.sevenDayResetsAt?.let { formatResetTime(it) },
                            stale = isStale,
                        )
                    )
                }
            },
        )

        val openClawVisible = (state.gatewayAvailable == true || state.gatewayHasError == true)
        if (openClawVisible) {
            // Only surface the catalog under OpenClaw when it actually
            // belongs to OpenClaw — same gate we apply to the Claude row.
            val openClawLines = if (catalogOwner == ProviderKey.OPENCLAW) {
                openClawDisplayLines(modelCatalog)
            } else {
                emptyList()
            }
            val subtitle = if (openClawLines.isNotEmpty()) {
                openClawLines.joinToString(", ")
            } else {
                null
            }
            ProviderRow(
                name = "OpenClaw",
                status = when {
                    state.gatewayHasError == true -> LEDStatus.ERROR
                    // OK only when the Gateway is authenticated — reachability
                    // alone keeps the row amber so users know setup isn't
                    // finished (matches iOS topology semantics).
                    state.gatewayConnected == true -> LEDStatus.OK
                    else -> LEDStatus.WARN
                },
                subtitle = subtitle,
                consumers = consumersFor(ProviderKey.OPENCLAW, state),
                rateLimits = emptyList(),
            )
        }

        if (state.mlxModels.isNotEmpty()) {
            ProviderRow(
                name = "MLX",
                status = LEDStatus.OK,
                subtitle = state.mlxModels.joinToString(", "),
                consumers = consumersFor(ProviderKey.MLX, state),
                rateLimits = emptyList(),
            )
        }

        if (ollama != null) {
            // Prefer "running" models (VRAM-loaded) but fall back to the
            // full installed list so the row is never empty when Ollama is
            // installed but idle. Mirrors the iOS TopologyRail behavior.
            val running = ollama.models.filter { it.sizeVram > 0 }
            val source = if (running.isNotEmpty()) running else ollama.models
            val subtitle = when {
                source.isNotEmpty() -> source.joinToString(", ") { it.name }
                ollama.available -> "installed, no models loaded"
                else -> "stopped"
            }
            ProviderRow(
                name = "Ollama",
                status = if (ollama.available) LEDStatus.OK else LEDStatus.DIM,
                subtitle = subtitle,
                consumers = consumersFor(ProviderKey.OLLAMA, state),
                rateLimits = emptyList(),
            )
        }

        // Antigravity — surfaced whenever the bridge reports an active
        // plan. Hidden otherwise so the rail doesn't grow a pointless row
        // for users not on Google's product.
        val antiPlan = state.antigravityStatus?.planName?.takeIf { it.isNotBlank() }
        if (antiPlan != null) {
            ProviderRow(
                name = "Antigravity",
                status = LEDStatus.OK,
                subtitle = antiPlan,
                consumers = emptyList(),
                rateLimits = emptyList(),
            )
        }

        if (state.subscriptions.isNotEmpty()) {
            SubscriptionsFooter(state.subscriptions)
        }
    }
}

/**
 * Strip `claude-` prefix and ISO date suffix so the compact subtitle row
 * can fit 3+ model names horizontally. Mirrors the iOS helper with the
 * same name.
 */
private fun shortClaudeModel(name: String): String {
    var s = name
    if (s.startsWith("claude-")) s = s.removePrefix("claude-")
    s = s.replace(Regex("-\\d{8}$"), "")
    return s
}

/**
 * Pull display lines for the OpenClaw model catalog. Ported from the iOS
 * `DashboardDataRules.openClawDisplayLines` behaviour: the default role
 * wins the head slot, remaining entries are grouped by family name.
 * Compact here — returns the list of names rather than pre-joined.
 */
private fun openClawDisplayLines(catalog: List<ModelCatalogEntry>): List<String> {
    val available = catalog.filter { it.available }
    if (available.isEmpty()) return emptyList()
    val ordered = available.sortedWith(
        compareByDescending<ModelCatalogEntry> { it.role == "default" }
            .thenBy { it.name }
    )
    return ordered.map { it.name }
}

@Composable
private fun SubscriptionsFooter(subs: List<SubscriptionInfo>) {
    Column(
        verticalArrangement = Arrangement.spacedBy(1.dp),
        modifier = Modifier.padding(top = 4.dp),
    ) {
        Text(
            text = "SUBSCRIPTIONS",
            color = TerrariumColors.HUDSubtext.copy(alpha = 0.8f),
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 0.8.sp,
        )
        subs.forEach { sub ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = sub.name,
                    color = TerrariumColors.HUDText,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                )
                val until = sub.until?.take(10)
                if (until != null) {
                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        text = until,
                        color = TerrariumColors.HUDSubtext,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

// MARK: - Downstream rows

@Composable
private fun DownstreamRows(state: DashboardState) {
    // The Android client sits ON the downstream side of the graph — it IS
    // one of the devices the bridge dispatches to. Until the Android
    // client starts receiving `moduleHealth` events the way the Swift
    // daemon does, this section surfaces the one relationship we *do*
    // know: this tablet is a live dashboard client connected to the hub.
    //
    // This also keeps the Upstream → Hub → Downstream flow meaningful
    // even on a pure-client build — the user always sees "I am here" in
    // the downstream slot rather than a dead placeholder.
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        DeviceRailRow(
            name = "This tablet",
            status = LEDStatus.OK,
            detail = "dashboard client",
        )
        Text(
            text = "other devices visible via the Node CLI or macOS app",
            color = TerrariumColors.HUDSubtext.copy(alpha = 0.55f),
            fontSize = 9.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

// MARK: - Provider row + rate chip

private enum class LEDStatus(val color: Color, val glyph: String) {
    OK(TerrariumColors.LEDGreen, "●"),
    WARN(TerrariumColors.LEDAmber, "●"),
    ERROR(TerrariumColors.LEDRed, "●"),
    DIM(TerrariumColors.HUDSubtext.copy(alpha = 0.5f), "○"),
}

private data class RateChip(
    val label: String,
    val percent: Double,
    val reset: String?,
    /// Data-is-stale marker — when the bridge hasn't fetched fresh usage
    /// for > 10min the chip dims and shows `stale` in the reset slot so
    /// the cached value can't be mistaken for current data.
    val stale: Boolean = false,
)

@Composable
private fun ProviderRow(
    name: String,
    status: LEDStatus,
    subtitle: String?,
    consumers: List<Color>,
    rateLimits: List<RateChip>,
) {
    val tight = PlatformTextStyle(includeFontPadding = false)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = status.glyph,
                color = status.color,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = name,
                color = TerrariumColors.HUDText,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tight),
            )
            Spacer(modifier = Modifier.weight(1f))
            // Consumer creature dots — brand-colored, cap at 3 with +N.
            val visible = consumers.take(3)
            visible.forEach { color ->
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(color)
                        .border(
                            border = BorderStroke(0.5.dp, Color.Black.copy(alpha = 0.35f)),
                            shape = CircleShape,
                        ),
                )
                Spacer(modifier = Modifier.width(2.dp))
            }
            val overflow = consumers.size - visible.size
            if (overflow > 0) {
                Text(
                    text = "+$overflow",
                    color = TerrariumColors.HUDSubtext,
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        if (!subtitle.isNullOrEmpty()) {
            Text(
                text = subtitle,
                color = TerrariumColors.HUDSubtext,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 14.dp),
                style = TextStyle(platformStyle = tight),
            )
        }
        if (rateLimits.isNotEmpty()) {
            Column(
                verticalArrangement = Arrangement.spacedBy(2.dp),
                modifier = Modifier.padding(start = 14.dp, top = 2.dp),
            ) {
                rateLimits.forEach { chip -> RateChipView(chip) }
            }
        }
    }
}

@Composable
private fun RateChipView(chip: RateChip) {
    val pct = chip.percent.coerceIn(0.0, 100.0)
    val fillColor = when {
        pct >= 90 -> TerrariumColors.LEDRed
        pct >= 70 -> TerrariumColors.LEDAmber
        else -> TerrariumColors.LEDGreen
    }
    val fillFraction = (pct / 100.0).toFloat()
    // Dim the bar when the underlying value is stale — the user should
    // read it as "cached / don't trust" at a glance, same visual pattern
    // as the iOS TopologyRail.
    val barAlpha = if (chip.stale) 0.35f else 0.65f

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = chip.label,
            color = TerrariumColors.HUDSubtext,
            fontSize = 9.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.width(16.dp),
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(5.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(Color.White.copy(alpha = 0.10f)),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(fillFraction)
                    .fillMaxSize()
                    .background(fillColor.copy(alpha = barAlpha), RoundedCornerShape(2.dp)),
            )
        }
        Text(
            text = "${pct.toInt()}%",
            color = if (chip.stale) TerrariumColors.HUDSubtext else fillColor,
            fontSize = 9.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.width(32.dp),
            textAlign = TextAlign.End,
        )
        when {
            chip.stale -> Text(
                text = "stale",
                color = TerrariumColors.LEDAmber,
                fontSize = 9.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.width(42.dp),
                textAlign = TextAlign.End,
            )
            chip.reset != null -> Text(
                text = chip.reset,
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.75f),
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.width(42.dp),
                textAlign = TextAlign.End,
            )
            else -> Text(
                text = "—",
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.4f),
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.width(42.dp),
                textAlign = TextAlign.End,
            )
        }
    }
}

// MARK: - Provider inference + consumer resolution

private enum class ProviderKey { CLAUDE, OPENCLAW, MLX, OLLAMA, UNKNOWN }

/**
 * Best-effort mapping from a session's model name to a provider slot.
 * Mirrors the iOS `TopologyRail.providerFor(...)` switch — keep them in
 * sync when adding new providers or model families.
 */
private fun providerFor(
    modelName: String?,
    mlxModels: List<String>,
    ollama: OllamaStatus?,
): ProviderKey {
    val raw = modelName?.lowercase().orEmpty()
    if (raw.isEmpty()) return ProviderKey.UNKNOWN
    if (raw.startsWith("claude-") || raw.startsWith("opus") ||
        raw.startsWith("sonnet") || raw.startsWith("haiku")
    ) return ProviderKey.CLAUDE
    if (raw.startsWith("glm") || raw.contains("qwen-plus") ||
        raw.contains("deepseek") || raw.startsWith("z-") ||
        raw.startsWith("gpt-") || raw.startsWith("o1-") || raw.startsWith("o3-")
    ) return ProviderKey.OPENCLAW
    for (m in mlxModels) {
        val lower = m.lowercase()
        if (raw.contains(lower) || lower.contains(raw)) return ProviderKey.MLX
    }
    if (ollama != null && ollama.models.any { raw.contains(it.name.lowercase()) }) {
        return ProviderKey.OLLAMA
    }
    return ProviderKey.UNKNOWN
}

/**
 * Return a de-duplicated list of consumer brand colors for the given
 * provider. Dedup keys on `agentType` so two Claude sessions eat one slot
 * on the Claude row instead of two.
 */
private fun consumersFor(provider: ProviderKey, state: DashboardState): List<Color> {
    val seen = mutableSetOf<String>()
    val result = mutableListOf<Color>()

    // Primary (local) session — only count if its model maps to this
    // provider and its agent type isn't already represented by a sibling.
    val primaryAgentType = state.agentType
    val primaryModel = state.modelName
    if (primaryAgentType != null && primaryAgentType != "daemon") {
        val key = primaryAgentType
        if (seen.add(key) &&
            providerFor(primaryModel, state.mlxModels, state.ollamaStatus) == provider
        ) {
            result += brandColorForAgent(primaryAgentType)
        }
    }

    for (session in state.siblingSessions) {
        val agent = session.agentType ?: continue
        if (agent == "daemon") continue
        val key = agent
        if (!seen.add(key)) continue
        val modelName = session.modelName
        if (providerFor(modelName, state.mlxModels, state.ollamaStatus) == provider) {
            result += brandColorForAgent(agent)
        }
    }

    return result
}

// MARK: - Device (downstream) row

@Composable
private fun DeviceRailRow(
    name: String,
    status: LEDStatus,
    detail: String,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = status.glyph,
            color = status.color,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = name,
            color = TerrariumColors.HUDText,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.widthIn(min = 72.dp),
        )
        Text(
            text = detail,
            color = TerrariumColors.HUDSubtext,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

