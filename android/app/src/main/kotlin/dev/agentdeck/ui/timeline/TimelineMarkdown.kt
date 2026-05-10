package dev.agentdeck.ui.timeline

/**
 * Parsed markdown line for the timeline detail pane.
 *
 * Mirrors the parser in `shared/src/timeline-markdown.ts` and the Apple
 * `TimelineMarkdownLine` enum in `TimelineStripView.swift`. The grammar is
 * line-oriented; inline spans are computed at render time via
 * [parseInlineSpans] (called from [TimelineMarkdownView]).
 */
sealed class TimelineMarkdownLine {
    object Blank : TimelineMarkdownLine()
    data class Heading(val level: Int, val content: String) : TimelineMarkdownLine()
    data class Bullet(val content: String) : TimelineMarkdownLine()
    data class Numbered(val marker: String, val content: String) : TimelineMarkdownLine()
    data class Quote(val content: String) : TimelineMarkdownLine()
    data class Code(val content: String) : TimelineMarkdownLine()
    data class Plain(val content: String) : TimelineMarkdownLine()

    /**
     * Markdown table block. `rows[0]` is the header when [hasHeader] is true.
     * Cells contain raw inline-markdown text; render through [parseInlineSpans].
     */
    data class Table(val rows: List<List<String>>, val hasHeader: Boolean) : TimelineMarkdownLine()
}

/**
 * Inline span produced by [parseInlineSpans]. Mirrors `InlineSpan` in
 * `shared/src/timeline-markdown.ts`. The renderer turns these into a Compose
 * `AnnotatedString`.
 */
sealed class InlineSpan {
    data class Plain(val text: String) : InlineSpan()
    data class Bold(val text: String) : InlineSpan()
    data class Italic(val text: String) : InlineSpan()
    data class Code(val text: String) : InlineSpan()
    data class Link(val text: String, val href: String) : InlineSpan()
}

/**
 * Parse `text` into a flat list of typed lines for native rendering.
 *
 * Block grammar:
 *   - ``` toggles a code fence; lines inside become Code (verbatim, no inline parsing)
 *   - empty / whitespace-only line → Blank
 *   - 1..6 leading hashes followed by a space → Heading
 *   - "- " or "* " → Bullet
 *   - `<digits>.` or `<digits>)` + space → Numbered
 *   - "> " → Quote
 *   - `|...|` (with optional `|---|` separator) → Table block
 *   - anything else → Plain
 */
fun parseTimelineMarkdown(text: String): List<TimelineMarkdownLine> {
    if (text.isEmpty()) return emptyList()
    val out = mutableListOf<TimelineMarkdownLine>()
    var inCodeFence = false
    val lines = text.split('\n').map { it.trimEnd('\r') }

    var i = 0
    while (i < lines.size) {
        val rawLine = lines[i]
        val trimmed = rawLine.trim()

        if (trimmed.startsWith("```")) {
            inCodeFence = !inCodeFence
            i += 1
            continue
        }
        if (inCodeFence) {
            out += TimelineMarkdownLine.Code(rawLine)
            i += 1
            continue
        }
        if (trimmed.isEmpty()) {
            out += TimelineMarkdownLine.Blank
            i += 1
            continue
        }

        // Table block — current line is `|...|` and not a separator.
        if (isTableRow(trimmed)) {
            val rows = mutableListOf(splitCells(trimmed))
            var hasHeader = false
            var j = i + 1
            if (j < lines.size && isTableSeparator(lines[j].trim())) {
                hasHeader = true
                j += 1
            }
            while (j < lines.size) {
                val nextTrimmed = lines[j].trim()
                if (!isTableRow(nextTrimmed)) break
                rows += splitCells(nextTrimmed)
                j += 1
            }
            out += TimelineMarkdownLine.Table(rows = rows, hasHeader = hasHeader)
            i = j
            continue
        }

        val heading = parseHeading(trimmed)
        if (heading != null) {
            out += TimelineMarkdownLine.Heading(heading.first, heading.second)
            i += 1
            continue
        }

        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
            out += TimelineMarkdownLine.Bullet(trimmed.substring(2))
            i += 1
            continue
        }

        val numbered = NUMBERED_RE.matchEntire(trimmed)
        if (numbered != null) {
            out += TimelineMarkdownLine.Numbered(
                marker = numbered.groupValues[1] + numbered.groupValues[2],
                content = numbered.groupValues[3],
            )
            i += 1
            continue
        }

        if (trimmed.startsWith("> ")) {
            out += TimelineMarkdownLine.Quote(trimmed.substring(2))
            i += 1
            continue
        }

        out += TimelineMarkdownLine.Plain(rawLine)
        i += 1
    }

    return if (out.isEmpty()) listOf(TimelineMarkdownLine.Plain(text)) else out
}

/**
 * Tokenize a single line of inline content into spans. First-match-wins
 * left-to-right walker; never recurses. Mirrors the TS [parseInlineSpans] in
 * `shared/src/timeline-markdown.ts`.
 */
fun parseInlineSpans(text: String): List<InlineSpan> {
    if (text.isEmpty()) return emptyList()
    val out = mutableListOf<InlineSpan>()
    val pending = StringBuilder()
    fun flushPlain() {
        if (pending.isNotEmpty()) {
            out += InlineSpan.Plain(pending.toString())
            pending.clear()
        }
    }
    var i = 0
    while (i < text.length) {
        val ch = text[i]

        // `code`
        if (ch == '`') {
            val close = text.indexOf('`', i + 1)
            if (close > i) {
                flushPlain()
                out += InlineSpan.Code(text.substring(i + 1, close))
                i = close + 1
                continue
            }
        }

        // **bold**
        if (ch == '*' && i + 1 < text.length && text[i + 1] == '*') {
            val close = text.indexOf("**", i + 2)
            if (close > i + 1) {
                flushPlain()
                out += InlineSpan.Bold(text.substring(i + 2, close))
                i = close + 2
                continue
            }
        }

        // *italic* — single `*`, not adjacent to another `*`
        if (ch == '*' &&
            (i + 1 >= text.length || text[i + 1] != '*') &&
            (i == 0 || text[i - 1] != '*')) {
            var j = i + 1
            while (j < text.length) {
                if (text[j] == '*') {
                    val prev = if (j > 0) text[j - 1] else ' '
                    val next = if (j + 1 < text.length) text[j + 1] else ' '
                    if (prev != '*' && next != '*') break
                }
                j += 1
            }
            if (j < text.length && j > i + 1) {
                flushPlain()
                out += InlineSpan.Italic(text.substring(i + 1, j))
                i = j + 1
                continue
            }
        }

        // [text](href)
        if (ch == '[') {
            val closeBracket = text.indexOf(']', i + 1)
            if (closeBracket > i &&
                closeBracket + 1 < text.length &&
                text[closeBracket + 1] == '(') {
                val closeParen = text.indexOf(')', closeBracket + 2)
                if (closeParen > closeBracket + 1) {
                    flushPlain()
                    out += InlineSpan.Link(
                        text = text.substring(i + 1, closeBracket),
                        href = text.substring(closeBracket + 2, closeParen),
                    )
                    i = closeParen + 1
                    continue
                }
            }
        }

        pending.append(ch)
        i += 1
    }
    flushPlain()
    return if (out.isEmpty()) listOf(InlineSpan.Plain(text)) else out
}

private val NUMBERED_RE = Regex("""^(\d+)([.)])\s+(.*)$""")

private fun parseHeading(trimmed: String): Pair<Int, String>? {
    var level = 0
    for (ch in trimmed) {
        if (ch == '#') level += 1 else break
    }
    if (level !in 1..6) return null
    if (level >= trimmed.length || trimmed[level] != ' ') return null
    return level to trimmed.substring(level + 1)
}

// ---- Table helpers ----

private val TABLE_ROW_RE = Regex("""^\s*\|.+\|\s*$""")
private val TABLE_SEPARATOR_INNER = setOf('-', ':', ' ', '|', '\t')

private fun isTableRow(trimmed: String): Boolean {
    if (!TABLE_ROW_RE.matches(trimmed)) return false
    return !isTableSeparator(trimmed)
}

private fun isTableSeparator(trimmed: String): Boolean {
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 2) return false
    val inner = trimmed.substring(1, trimmed.length - 1)
    if (!inner.contains('-')) return false
    return inner.all { it in TABLE_SEPARATOR_INNER }
}

private fun splitCells(rowLine: String): List<String> {
    val inner = rowLine.trim().removePrefix("|").removeSuffix("|")
    return inner.split('|').map { it.trim() }
}
