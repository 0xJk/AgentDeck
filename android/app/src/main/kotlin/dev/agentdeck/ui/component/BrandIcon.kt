package dev.agentdeck.ui.component

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.graphics.PathParser

/**
 * SVG-path brand icon for agent types — matches Apple SessionListPanel BrandIcon.
 *
 * Renders agent-type-specific brand marks (Claude sparkle, OpenAI knot, OpenClaw crayfish)
 * as Compose Canvas paths.
 *
 * Android's PathParser doesn't support SVG arc flag compression (e.g. `01` → `0 1`).
 * [fixArcFlags] preprocesses path data to insert spaces between compressed flag pairs.
 */
@Composable
fun BrandIcon(
    agentType: String?,
    isEink: Boolean = false,
    size: Dp = 13.dp,
    modifier: Modifier = Modifier,
) {
    val spec = remember(agentType) { BrandIconSpec.fromAgentType(agentType) } ?: return
    val color = if (isEink) spec.einkColor else spec.color
    val paths = remember(agentType) { spec.pathDataList.map { parseSvgPath(it) } }

    Canvas(modifier = modifier.size(size)) {
        val s = this.size.minDimension / spec.viewBox
        scale(s, s) {
            for (path in paths) {
                drawPath(path, color)
            }
        }
    }
}

private fun parseSvgPath(svgPathData: String): Path {
    val fixed = fixArcFlags(svgPathData)
    return PathParser.createPathFromPathData(fixed).asComposePath()
}

/**
 * Fix SVG arc flag compression for Android's PathParser.
 *
 * SVG spec allows arc flags (large-arc, sweep) to be concatenated without separators:
 * `a.527.527 0 110 1.055` — flags are `1` and `1`, dx=`0`.
 * Android's PathParser requires: `a.527.527 0 1 1 0 1.055`.
 *
 * Strategy: after consuming 3 arc params (rx, ry, rotation), the next two values
 * MUST be single-digit flags (0 or 1). If they appear concatenated, insert a space.
 */
private fun fixArcFlags(path: String): String {
    val sb = StringBuilder(path.length + 32)
    var i = 0
    while (i < path.length) {
        val ch = path[i]
        if (ch == 'a' || ch == 'A') {
            sb.append(ch)
            i++
            // Process arc parameter groups (there can be implicit repeats)
            while (i < path.length) {
                i = skipWhitespaceAndCommas(path, i)
                if (i >= path.length) break
                val next = path[i]
                // If we hit another command letter, stop
                if (next.isLetter() && next != 'e' && next != 'E') break

                // rx
                i = appendNumber(path, i, sb)
                // ry
                i = skipWhitespaceAndCommas(path, i)
                i = appendNumber(path, i, sb)
                // rotation
                i = skipWhitespaceAndCommas(path, i)
                i = appendNumber(path, i, sb)

                // large-arc-flag (must be 0 or 1)
                i = skipWhitespaceAndCommas(path, i)
                if (i < path.length && (path[i] == '0' || path[i] == '1')) {
                    sb.append(' ').append(path[i])
                    i++
                }

                // sweep-flag (must be 0 or 1)
                // May be concatenated with large-arc-flag — no separator needed from SVG spec
                i = skipWhitespaceAndCommas(path, i)
                if (i < path.length && (path[i] == '0' || path[i] == '1')) {
                    sb.append(' ').append(path[i])
                    i++
                }

                // dx
                i = skipWhitespaceAndCommas(path, i)
                i = appendNumber(path, i, sb)
                // dy
                i = skipWhitespaceAndCommas(path, i)
                i = appendNumber(path, i, sb)
            }
        } else {
            sb.append(ch)
            i++
        }
    }
    return sb.toString()
}

private fun skipWhitespaceAndCommas(s: String, start: Int): Int {
    var i = start
    while (i < s.length && (s[i] == ' ' || s[i] == ',' || s[i] == '\n' || s[i] == '\t')) i++
    return i
}

private fun appendNumber(s: String, start: Int, sb: StringBuilder): Int {
    var i = start
    if (i >= s.length) return i
    sb.append(' ')
    // Optional sign
    if (s[i] == '-' || s[i] == '+') {
        sb.append(s[i])
        i++
    }
    // Integer part
    while (i < s.length && s[i].isDigit()) {
        sb.append(s[i])
        i++
    }
    // Decimal part
    if (i < s.length && s[i] == '.') {
        sb.append('.')
        i++
        while (i < s.length && s[i].isDigit()) {
            sb.append(s[i])
            i++
        }
    }
    return i
}

private class BrandIconSpec(
    val pathDataList: List<String>,
    val viewBox: Float,
    val color: Color,
    val einkColor: Color,
) {
    companion object {
        fun fromAgentType(agentType: String?): BrandIconSpec? = when (agentType) {
            "claude-code" -> BrandIconSpec(
                pathDataList = listOf(CLAUDE_PATH),
                viewBox = 24f,
                color = Color(0xFFC07058),  // terracotta
                einkColor = Color(0xFF333333),
            )
            "codex-cli" -> BrandIconSpec(
                pathDataList = listOf(OPENAI_PATH),
                viewBox = 24f,
                color = Color(0xFF6166E0),  // indigo
                einkColor = Color(0xFF444444),
            )
            "openclaw" -> BrandIconSpec(
                pathDataList = OPENCLAW_PATHS,
                viewBox = 24f,
                color = Color(0xFFFF4D4D),  // red
                einkColor = Color(0xFF333333),
            )
            else -> null
        }
    }
}

// Claude — sparkle mark (viewBox 0 0 24 24)
private const val CLAUDE_PATH =
    "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"

// OpenAI — knot mark / Codex CLI (viewBox 0 0 24 24)
private const val OPENAI_PATH =
    "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"

// OpenClaw — front-facing crayfish multi-path (viewBox 0 0 24 24)
private val OPENCLAW_PATHS = listOf(
    "M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z",
    "M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z",
    "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z",
    "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z",
    "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z",
)
