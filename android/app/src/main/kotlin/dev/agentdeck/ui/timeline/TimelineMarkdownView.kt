package dev.agentdeck.ui.timeline

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.terrarium.TerrariumColors

/**
 * Compose renderer for parsed timeline markdown. Mirrors the SwiftUI
 * `TimelineMarkdownPreview` view in `TimelineStripView.swift` — same line
 * shapes, sizes, and colors so the dashboards read consistently across
 * platforms.
 */
@Composable
fun TimelineMarkdownView(
    text: String,
    modifier: Modifier = Modifier,
) {
    val lines = remember(text) { parseTimelineMarkdown(text) }
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (line in lines) {
            when (line) {
                TimelineMarkdownLine.Blank -> Spacer(modifier = Modifier.height(4.dp))
                is TimelineMarkdownLine.Heading -> Text(
                    text = annotatedInline(line.content),
                    color = TerrariumColors.HUDText.copy(alpha = 0.95f),
                    fontSize = if (line.level == 1) 11.sp else 10.sp,
                    fontWeight = FontWeight.Bold,
                    style = tight,
                )
                is TimelineMarkdownLine.Bullet -> Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        text = "•",
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.78f),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        style = tight,
                    )
                    Text(
                        text = annotatedInline(line.content),
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.86f),
                        fontSize = 10.sp,
                        softWrap = true,
                        style = tight,
                    )
                }
                is TimelineMarkdownLine.Numbered -> Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        text = line.marker,
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.78f),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.width(22.dp),
                        style = tight,
                    )
                    Text(
                        text = annotatedInline(line.content),
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.86f),
                        fontSize = 10.sp,
                        softWrap = true,
                        style = tight,
                    )
                }
                is TimelineMarkdownLine.Quote -> Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        text = "│",
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.72f),
                        fontSize = 10.sp,
                        style = tight,
                    )
                    Text(
                        text = annotatedInline(line.content),
                        color = TerrariumColors.HUDSubtext.copy(alpha = 0.72f),
                        fontSize = 10.sp,
                        softWrap = true,
                        style = tight,
                    )
                }
                is TimelineMarkdownLine.Code -> Text(
                    text = if (line.content.isEmpty()) " " else line.content,
                    color = TerrariumColors.LEDGreen.copy(alpha = 0.8f),
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                    softWrap = true,
                    style = tight,
                )
                is TimelineMarkdownLine.Plain -> Text(
                    text = annotatedInline(line.content),
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.86f),
                    fontSize = 10.sp,
                    softWrap = true,
                    style = tight,
                )
                is TimelineMarkdownLine.Table -> TableBlock(
                    rows = line.rows,
                    hasHeader = line.hasHeader,
                    tight = tight,
                )
            }
        }
    }
}

/**
 * Compose [AnnotatedString] from inline-markdown content. Wraps
 * [parseInlineSpans] and pushes Compose `SpanStyle`s for bold / italic /
 * code / link. Plain spans inherit the surrounding `Text` style.
 */
private fun annotatedInline(content: String): AnnotatedString = buildAnnotatedString {
    for (span in parseInlineSpans(content)) {
        when (span) {
            is InlineSpan.Plain -> append(span.text)
            is InlineSpan.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(span.text) }
            is InlineSpan.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(span.text) }
            is InlineSpan.Code -> withStyle(
                SpanStyle(
                    fontFamily = FontFamily.Monospace,
                    color = TerrariumColors.LEDGreen.copy(alpha = 0.85f),
                )
            ) { append(span.text) }
            is InlineSpan.Link -> withStyle(
                SpanStyle(
                    color = TerrariumColors.TetraNeon.copy(alpha = 0.9f),
                    textDecoration = TextDecoration.Underline,
                )
            ) { append(span.text) }
        }
    }
}

private inline fun androidx.compose.ui.text.AnnotatedString.Builder.withStyle(
    style: SpanStyle,
    block: androidx.compose.ui.text.AnnotatedString.Builder.() -> Unit,
) {
    val idx = pushStyle(style)
    try { block() } finally { pop(idx) }
}

/**
 * Compact table layout. Rows scroll horizontally so wide tables don't blow
 * up the detail-pane width on iPhone-portrait inline-detail. First row
 * bold + bottom hairline when [hasHeader].
 */
@Composable
private fun TableBlock(
    rows: List<List<String>>,
    hasHeader: Boolean,
    tight: TextStyle,
) {
    if (rows.isEmpty()) return
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier.horizontalScroll(scroll).padding(vertical = 2.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        rows.forEachIndexed { i, row ->
            val isHeaderRow = hasHeader && i == 0
            Row(verticalAlignment = Alignment.Top) {
                row.forEach { cell ->
                    Text(
                        text = annotatedInline(cell),
                        color = if (isHeaderRow)
                            TerrariumColors.HUDText.copy(alpha = 0.95f)
                        else
                            TerrariumColors.HUDSubtext.copy(alpha = 0.86f),
                        fontSize = 9.sp,
                        fontWeight = if (isHeaderRow) FontWeight.Bold else FontWeight.Normal,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .padding(end = 8.dp)
                            .widthIn(min = 60.dp),
                        style = tight,
                    )
                }
            }
            if (isHeaderRow) {
                HorizontalDivider(
                    thickness = 0.5.dp,
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.35f),
                )
            }
        }
    }
}

/**
 * Whether a detail blob duplicates the summary row enough to suppress.
 * Mirrors the Swift `detailIsRedundant(detail:raw:)` rule. Real entries
 * from `~/.agentdeck/timeline.json` look like:
 *   raw    = "정리\n\nfocusSession 의 시각 효과 추가됨..."
 *   detail = "## 정리\n\n**focusSession 의 시각 효과 추가됨**..."
 * — i.e. detail is the markdown-formatted version of raw. Strip markdown
 * from detail and compare the FULL strings (not just the first paragraph).
 */
fun timelineDetailIsRedundant(detail: String, raw: String): Boolean {
    if (detail == raw) return true
    val nRaw = normalizeForFuzzy(raw)
    val strippedDetail = stripMarkdownInline(detail)
    val nDetail = normalizeForFuzzy(strippedDetail)

    if (nRaw.isNotEmpty() && nDetail.isNotEmpty()) {
        if (nRaw == nDetail) return true
        val rTokens = nRaw.split(' ')
        val dTokens = nDetail.split(' ')
        // Detail covers raw fully, raw covers ≥ 85% of detail's tokens → redundant.
        val common = rTokens.take(dTokens.size)
        if (dTokens.size >= 3 && common == dTokens.take(common.size)) {
            val ratio = common.size.toDouble() / dTokens.size.coerceAtLeast(1)
            if (ratio >= 0.85) return true
        }
        val r8 = rTokens.take(8)
        val d8 = dTokens.take(8)
        if (r8.size >= 3 && r8 == d8) return true
    }

    // Legacy first-paragraph rule (heuristic summary "Topic · 4s · 2 tools" form).
    val firstPara = detail.split("\n\n").firstOrNull() ?: detail
    val nDetailPara = normalizeForFuzzy(stripMarkdownInline(firstPara))
    if (nRaw.isNotEmpty() && nDetailPara.isNotEmpty()) {
        if (nDetailPara.startsWith(nRaw)) return true
        val rawHead = raw.split(" · ").firstOrNull()?.takeIf { it.isNotBlank() }
        if (rawHead != null) {
            val nHead = normalizeForFuzzy(rawHead)
            if (nHead.isNotEmpty() && nHead.split(' ').size >= 2 && nDetailPara.startsWith(nHead)) {
                return true
            }
        }
        val rawTokens = nRaw.split(' ').take(6)
        val detailTokens = nDetailPara.split(' ').take(6)
        if (rawTokens.size >= 3 && rawTokens == detailTokens) return true
    }
    return false
}

/**
 * Lightweight inline markdown stripper for plain-text surfaces (e-ink).
 * Strips block markers AND table syntax — bridge now ships chat detail with
 * markdown markers preserved for the colour-screen renderer, so plain
 * surfaces have to clean up before display.
 *
 * Mirrors `cleanDetailText` from `shared/src/timeline.ts` plus extra table
 * handling: separator rows (`|---|---|`) are dropped entirely; body rows
 * (`| a | b |`) become space-delimited (`a  b`).
 */
fun stripMarkdownInline(s: String): String {
    if (s.isEmpty()) return s
    var out = s
    // Code fences ```lang\n...\n``` → contents
    out = out.replace(Regex("```[\\w]*\\n?([\\s\\S]*?)```"), "$1")
    // Bold **x** → x
    out = out.replace(Regex("\\*\\*([^*]+)\\*\\*"), "$1")
    // Italic *x* (not **) → x
    out = out.replace(Regex("(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)"), "$1")
    // Headings (multiline)
    out = out.replace(Regex("(?m)^#{1,6}\\s+"), "")
    // Blockquote
    out = out.replace(Regex("(?m)^>\\s+"), "")
    // List bullets
    out = out.replace(Regex("(?m)^[-*]\\s+"), "")
    // Links [text](url) → text
    out = out.replace(Regex("\\[([^\\]]+)]\\([^)]+\\)"), "$1")
    // Inline code
    out = out.replace(Regex("`([^`]+)`"), "$1")
    // Table handling — line-walker (regex-multiline `\\s*$` interactions
    // with `\n` proved brittle). Walk each line:
    //   - separator row (`|---|---|`, only `-`/`:`/` `/`\t`/`|` between
    //     boundary pipes, must contain at least one `-`) → drop entirely
    //   - body row (starts AND ends with `|`) → strip the boundary pipes
    //     and convert internal `|` to double-space cell separators
    //   - everything else → leave intact
    out = out.split('\n').mapNotNull { line ->
        val trimmed = line.trim()
        if (trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|")) {
            val inner = trimmed.substring(1, trimmed.length - 1)
            val isSeparator = inner.contains('-') &&
                inner.all { it == '-' || it == ':' || it == ' ' || it == '\t' || it == '|' }
            if (isSeparator) null else inner.split('|').joinToString("  ") { it.trim() }
        } else {
            line
        }
    }.joinToString("\n")
    return out.trim()
}

/** Lightweight text-stripping mirror of `cleanRawText` from shared. Used to
 *  keep markdown decorators out of the summary row in the timeline. */
fun stripMarkdownForSummary(s: String): String {
    if (s.isEmpty()) return s
    var out = s
    out = out.replace(Regex("\\*\\*([^*]+)\\*\\*"), "$1")
    out = out.replace(Regex("(?m)^#{1,6}\\s+"), "")
    out = out.replace(Regex("\\[([^\\]]+)]\\([^)]+\\)"), "$1")
    out = out.replace(Regex("`([^`]+)`"), "$1")
    return out.trim()
}

private fun normalizeForFuzzy(s: String): String =
    s.lowercase()
        .map { if (it.isLetterOrDigit()) it else ' ' }
        .joinToString("")
        .split(' ')
        .filter { it.isNotEmpty() }
        .joinToString(" ")
