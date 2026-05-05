/**
 * Shared timeline types and log parser for OpenClaw mode.
 * Used by both bridge (BridgeLogStream) and plugin (LogStream).
 */

export type TimelineEntryType =
  | 'tool_request' | 'tool_resolved' | 'chat_start' | 'chat_end'
  | 'chat_response' | 'error' | 'scheduled' | 'user_action'
  | 'model_call' | 'model_response' | 'memory_recall' | 'tool_exec'
  | 'eval_result';

export interface TimelineEntry {
  ts: number;
  type: TimelineEntryType;
  raw: string;
  detail?: string;
  approvalId?: string;
  status?: 'pending' | 'approved' | 'denied';
  agentType?: string;
  projectName?: string;
  sessionId?: string;
  runId?: string;
  startedAt?: number;
  endedAt?: number;
  repeatCount?: number;
  automated?: boolean;
}

/**
 * Extract a human-readable summary from a raw OpenClaw log message.
 * Strips JSON prefixes, key=value noise, and extracts error descriptions.
 */
function extractReadableMessage(message: string): string {
  let cleaned = message;

  // If entire message is a JSON object, extract error field
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed.error) cleaned = String(parsed.error);
      else cleaned = JSON.stringify(parsed).slice(0, 200);
    } catch { /* not valid JSON, continue with regex strip */ }
  }

  // Strip leading JSON object fragments: {"subsystem":"diagnostic"} ...
  cleaned = cleaned.replace(/^\{[^}]*\}\s*/, '');

  // Strip [subsystem] prefix: "[tools] read failed..." → "read failed..."
  const bracketMatch = cleaned.match(/^\[(\w+)\]\s*(.*)/);
  const contextTag = bracketMatch ? bracketMatch[1] : null;
  if (bracketMatch) cleaned = bracketMatch[2];

  // Extract error= quoted value if present: error="FailoverError: LLM request timed out."
  const errorMatch = cleaned.match(/error="([^"]+)"/);
  if (errorMatch) {
    // Also extract lane/context if available
    const laneMatch = cleaned.match(/lane=(\S+)/);
    const lane = laneMatch ? `[${laneMatch[1]}] ` : (contextTag ? `[${contextTag}] ` : '');
    cleaned = `${lane}${errorMatch[1]}`;
  } else {
    // For ENOENT/file errors: extract the file path and simplify
    const enoentMatch = cleaned.match(/ENOENT:.*?['"]([^'"]+)['"]/);
    if (enoentMatch) {
      const filePath = enoentMatch[1];
      // Show just filename or last 2 path components
      const shortPath = filePath.split('/').slice(-2).join('/');
      cleaned = `파일 없음: ${shortPath}`;
    } else {
      // Strip key=value pairs that are noise (conn=..., durationMs=...)
      cleaned = cleaned
        .replace(/\b(conn|durationMs|stateVersion|seq)=\S+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }

  // Truncate
  if (cleaned.length > 500) cleaned = cleaned.slice(0, 497) + '...';
  return cleaned || message.slice(0, 500);
}

/**
 * Clean detail text — strip markdown artifacts, JSON blobs, and system noise.
 * Applied to timeline entry `detail` fields before storage.
 */
export function cleanDetailText(text: string): string {
  if (!text) return text;
  if (typeof text !== 'string') return '';

  // If entire text is a JSON object, extract readable message
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      // System JSON blobs (connectionId, status codes, etc.) → filter
      if (parsed.connectionId || parsed.stateVersion || parsed.seq) return '';
      if (parsed.error) return String(parsed.error);
      // Other JSON → compact readable form
      return JSON.stringify(parsed).slice(0, 200);
    } catch { /* not valid JSON, continue */ }
  }

  let cleaned = text;

  // Strip code fences: ```lang\n...\n``` → contents
  cleaned = cleaned.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');

  // Strip bold: **text** → text
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  // Strip italic: *text* or _text_ (but not __dunder__)
  cleaned = cleaned.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');

  // Strip headings: ## heading → heading
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

  // Strip blockquotes: > text → text
  cleaned = cleaned.replace(/^>\s+/gm, '');

  // Strip markdown links: [text](url) → text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip list markers: - item or * item → item (only at line start)
  cleaned = cleaned.replace(/^[-*]\s+/gm, '');

  // Strip inline code backticks: `code` → code
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * Strip inline markdown from raw text (lightweight version of cleanDetailText).
 * Handles: **bold**, # heading, `code`, [text](url).
 */
export function cleanRawText(text: string): string {
  if (!text) return text;
  if (typeof text !== 'string') return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * Remove NOP/NOOP markers from text.
 * Applied to both raw and detail fields.
 */
export function cleanNopMarkers(text: string): string {
  if (!text) return text;
  return text
    .replace(/\bN[Oo][Oo]?[Pp]\b\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the semantic core of a timeline entry for dedup comparison.
 * For chat_end: strip duration/tool suffix (everything after first ' · ').
 * For chat_start: use full raw text.
 */
export function extractSemanticCore(raw: string, type: TimelineEntryType): string {
  if (type === 'chat_end') {
    const sepIdx = raw.indexOf(' \u00b7 ');
    return sepIdx >= 0 ? raw.slice(0, sepIdx).trim() : raw.trim();
  }
  return raw.trim();
}

/**
 * Normalize a semantic core for fuzzy comparison.
 * Extracts sorted unique keywords, stripping punctuation and common suffixes.
 * "WhatsApp 연결 상태 확인 완료, 정상 작동" → "whatsapp 연결 상태 완료 작동 정상 확인"
 */
function normalizeCore(core: string): string {
  return core
    .toLowerCase()
    .replace(/[.,!?·✓✅:…""''`\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a keyword bag from text for similarity comparison.
 * Strips Korean verb/adjective endings and common fillers.
 */
function extractKeywords(text: string): Set<string> {
  const normalized = normalizeCore(text);
  const words = normalized.split(' ').filter(w => w.length >= 2);

  // Strip common Korean verbal endings for stemming
  const stemmed = words.map(w =>
    w.replace(/(하겠습니다|합니다|합니다|한다|시작|완료|중|확인됨|됨|했습니다)$/, '')
     .replace(/(을|를|이|가|의|에|에서|으로|로|는|은|도|만|까지)$/, '')
  ).filter(w => w.length >= 2);

  // Remove common filler words
  const fillers = new Set(['시작', '완료', '중', '및', '조치', '불필요', '정상', 'completed', 'prompt', 'sent', 'noop', 'nop']);
  return new Set(stemmed.filter(w => !fillers.has(w)));
}

/**
 * Check if two semantic cores are similar enough to be considered duplicates.
 * Uses keyword overlap — if 60%+ of smaller keyword set overlaps, it's a dupe.
 */
function isSimilarCore(a: string, b: string): boolean {
  const na = normalizeCore(a);
  const nb = normalizeCore(b);
  if (na === nb) return true;

  // Keyword-based similarity
  const ka = extractKeywords(a);
  const kb = extractKeywords(b);
  if (ka.size === 0 || kb.size === 0) return false;

  const smaller = ka.size <= kb.size ? ka : kb;
  const larger = ka.size > kb.size ? ka : kb;
  let overlap = 0;
  for (const w of smaller) {
    if (larger.has(w)) overlap++;
  }

  // 60% overlap of the smaller set → similar
  return overlap >= smaller.size * 0.6 && overlap >= 2;
}

/**
 * Check if an entry is repetitive compared to recent entries.
 * Returns the index of the matching entry in recentEntries, or -1 if not repetitive.
 */
export function isRepetitiveEntry(
  entry: TimelineEntry,
  recentEntries: readonly TimelineEntry[],
  windowMs = 3_600_000,
): number {
  if (
    entry.type !== 'chat_end' &&
    entry.type !== 'chat_start' &&
    entry.type !== 'error' &&
    entry.type !== 'chat_response'
  ) {
    return -1;
  }

  // Automated entries (cron/channel-initiated): 8h window, any automated pair is a dupe
  const effectiveWindowMs = entry.automated ? 8 * 3_600_000 : windowMs;

  const core = extractSemanticCore(entry.raw, entry.type);
  if (!core) return -1;

  for (let i = recentEntries.length - 1; i >= 0; i--) {
    const e = recentEntries[i];
    if (entry.ts - e.ts > effectiveWindowMs) break;
    if (e.type !== entry.type) continue;

    // Automated entries: content-agnostic dedup (any two automated chats collapse)
    if (entry.automated && e.automated) return i;

    const eCore = extractSemanticCore(e.raw, e.type);
    if (isSimilarCore(core, eCore)) return i;
  }
  return -1;
}

/**
 * Shared dedup pipeline for timeline stores.
 * Cleans text, checks exact dedup (8s), and repetitive dedup (1h).
 * Returns: 'skip' (duplicate), 'merge' + index (repetitive), or 'add' (new).
 *
 * Window rationale: PTY fallback fires 1.5s after spinner_stop; Stop hook can
 * arrive several seconds later if Claude Code's transcript_path JSONL flush is
 * slow. 8s covers worst-case race without merging genuinely separate turns.
 */
export type DeduplicateResult =
  | { action: 'skip' }
  | { action: 'merge'; index: number; removeChatStartIndex?: number }
  | { action: 'add'; entry: TimelineEntry };

export function deduplicateEntry(
  entry: TimelineEntry,
  entries: readonly TimelineEntry[],
): DeduplicateResult {
  // 1. Clean text artifacts
  if (entry.raw) entry = { ...entry, raw: cleanNopMarkers(cleanRawText(entry.raw)) };
  if (entry.detail) entry = { ...entry, detail: cleanNopMarkers(entry.detail) };

  // 2. Exact dedup: skip if same type + raw within 8 seconds
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (entry.ts - e.ts > 8_000) break;
    if (e.type === entry.type && e.raw === entry.raw) return { action: 'skip' };
  }

  // 3. Repetitive entry dedup (1h window)
  const repIdx = isRepetitiveEntry(entry, entries);
  if (repIdx >= 0) {
    let removeChatStartIndex: number | undefined;
    // For chat_end dedup, find paired chat_start that's also repetitive
    if (entry.type === 'chat_end') {
      for (let j = entries.length - 1; j >= 0; j--) {
        const cs = entries[j];
        if (cs.type !== 'chat_start') continue;
        if (entry.ts - cs.ts > 3_600_000) break;
        if (isRepetitiveEntry(cs, entries.slice(0, j)) >= 0) {
          removeChatStartIndex = j;
          break;
        }
      }
    }
    return { action: 'merge', index: repIdx, removeChatStartIndex };
  }

  return { action: 'add', entry };
}

/** Parse a single JSON log line into a TimelineEntry, or null if unrecognized. */
export function parseLogLine(json: unknown): TimelineEntry | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;

  // ===== OpenClaw logs --json format =====
  // { type: "log", time: "ISO", level: "info|debug", message: "...", subsystem?: "...", module?: "...", raw: "..." }
  const message = (obj.message as string | undefined) || (obj.msg as string | undefined) || '';
  const subsystem = obj.subsystem as string | undefined;
  const module_ = obj.module as string | undefined;

  // Parse timestamp: ISO string (OpenClaw) or numeric
  let ts: number;
  const timeStr = obj.time as string | undefined;
  if (timeStr && typeof timeStr === 'string') {
    const parsed = new Date(timeStr).getTime();
    ts = isNaN(parsed) ? Date.now() : parsed;
  } else {
    ts = (obj.ts as number) || (obj.timestamp as number) || Date.now();
  }

  // ===== Legacy structured format (backward compat) =====
  const action = obj.action as string | undefined;
  const model = obj.model as string | undefined;
  const tool = obj.tool as string | undefined;
  const component = obj.component as string | undefined;
  const tokens = obj.tokens as number | undefined;

  // Model inference start/complete (legacy structured) — suppressed
  // Adapter generates richer chat_start/chat_end with prompt, duration, tool summary
  if (model && (action === 'start' || action === 'request' || action === 'complete' || action === 'done' || action === 'response')) {
    return null;
  }

  // Memory / recall (legacy structured)
  if (component === 'memory' || action === 'recall' || action === 'search') {
    const query = (obj.query as string) || message || 'memory search';
    return {
      ts, type: 'memory_recall',
      raw: `Memory: ${query}`,
      detail: query.length > 50 ? query : undefined,
    };
  }

  // Tool execution (legacy structured)
  if (tool || (component === 'tool' && action)) {
    const toolName = tool || action || 'tool';
    const toolDetail = (obj.detail as string) || (obj.command as string) || '';
    const toolRaw = toolDetail ? `${toolName}: ${toolDetail}` : toolName;
    return {
      ts, type: 'tool_exec',
      raw: toolRaw.length > 500 ? toolRaw.slice(0, 497) + '...' : toolRaw,
      detail: toolDetail.length > 100 ? (toolDetail.length > 1000 ? toolDetail.slice(0, 997) + '...' : toolDetail) : undefined,
    };
  }

  // ===== OpenClaw message-text based matching =====
  if (!message) return null;

  // Skip very short messages (JSON fragments, truncated output)
  if (message.length < 5) return null;

  // Gateway WS subsystem: all RPC events are redundant with adapter-generated timeline
  // (chat.send → chat_start, chat.abort → chat_end, exec.approval.resolve → tool_resolved)
  if (subsystem === 'gateway/ws') return null;

  // Cron list table rows: UUID-prefixed lines from `openclaw cron list` output
  // Keep error rows as summarized entries; skip ok/skipped rows
  const cronRowMatch = message.match(/^[0-9a-f]{8}-[0-9a-f]{4}-\S+\s+(\S+(?:\.\.\.)?\S*)\s+.*?\b(error|ok|skipped)\b/i);
  if (cronRowMatch) {
    const [, jobName, status] = cronRowMatch;
    if (status.toLowerCase() !== 'error') return null; // ok/skipped → skip
    // Extract human-readable job name (strip trailing ...)
    const name = jobName.replace(/\.{3}$/, '').replace(/-/g, ' ');
    return { ts, type: 'error', raw: `Cron error: ${name}` };
  }

  // Skip cron module noise and JSON blobs (internal state, not user-facing)
  if (module_ === 'cron' || subsystem === 'cron') return null;
  if (/^"jobs"\s*:\s*\[|^\{"jobs":/i.test(message)) return null;

  // Skip noisy infrastructure messages
  if (message.startsWith('- agent:main:') && message.includes(' ago)')) return null;
  if (message.startsWith('Agents:') || message.startsWith('Session store')) return null;
  if (message.startsWith('Heartbeat interval:') || message.startsWith('WhatsApp:') || message.startsWith('LINE:')) return null;
  if (message.startsWith('Web Channel:') || message.startsWith('Run "openclaw')) return null;
  if (message.includes('web gateway heartbeat') || module_ === 'web-heartbeat') return null;
  // Skip hook registration and session setup noise
  if (/\bRegistered hook\b/i.test(message)) return null;
  if (/\bSession (store|restored|loaded)\b/i.test(message)) return null;
  // Skip diagnostic noise, but keep errors
  if (subsystem === 'diagnostic' && !/\b(error|fail|timed?\s*out)\b/i.test(message)) return null;

  // Skip transient/retriable errors that agents handle internally
  if (/\b(web_fetch|http_request|fetch)\b/i.test(message) &&
      /\b(timed?\s*out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|retry|retrying)\b/i.test(message)) {
    return null;
  }

  // Skip web_fetch/browser tool failures (404, generic fetch, tab errors) — agents handle internally
  if (/\bweb_fetch failed\b/i.test(message) && /\b(404|403)\b/.test(message)) {
    return null;
  }
  if (/\bweb_fetch failed:\s*fetch failed\b/i.test(message)) {
    return null;
  }
  if (/\bbrowser failed:\s*tab not found\b/i.test(message)) {
    return null;
  }
  // Skip browser sandbox configuration messages (setting issue, not runtime error)
  if (/\bSandbox browser is unavailable\b/i.test(message)) {
    return null;
  }

  // Skip tool errors that agents retry internally (edit mismatch, EISDIR, ENOENT on memory)
  if (/\bedit failed:\s*Could not find the exact text\b/i.test(message)) {
    return null;
  }
  if (/\bread failed\b/i.test(message) && /\bEISDIR\b/.test(message)) {
    return null;
  }
  if (/\bread failed\b/i.test(message) && /\bENOENT\b/.test(message) &&
      /workspace\/memory\//i.test(message)) {
    return null;
  }

  // Skip failover cascade noise — the initial timeout/error is already shown
  if (/\bProfile\s+\S+\s+timed out\b/i.test(message) ||
      /\bFailoverError:\s+LLM request timed out\b/i.test(message)) {
    return null;
  }

  // Messaging channel infrastructure detection — only filter when from known infra subsystems/modules
  // (avoid filtering user-facing messages that mention "whatsapp" etc.)
  const isChannelInfra = subsystem === 'channel' || module_ === 'whatsapp' || module_ === 'line'
    || module_ === 'web-channel' || subsystem === 'messaging';

  // Skip transient network_error — only from known infra subsystems (not user-facing tool errors)
  if (/\bnetwork_error\b/i.test(message) &&
      (subsystem === 'gateway/ws' || subsystem === 'diagnostic' || module_ === 'web-heartbeat' || isChannelInfra)) {
    return null;
  }
  if (/\bembedded run agent end\b/i.test(message) && /\berror=500\b/.test(message)) {
    return null;
  }

  if (isChannelInfra) {
    // Auto-reconnect, retry, connection status — all infra noise
    if (/\b(Web connection closed|Retry \d+\/\d+|reconnect|heartbeat)\b/i.test(message)) {
      return null;
    }
    if (/\bWebSocket error\b/i.test(message)) {
      return null;
    }
  }
  // Skip raw JSON blobs — connection status, event payloads, cron state
  if (/^\{"connectionId":/i.test(message)) {
    return null;
  }
  if (/^\{"event":/i.test(message)) {
    return null;
  }

  // Skip delivery retry noise (infrastructure auto-recovery)
  if (/\bDelivery\b.*\bexceeded max retries\b/i.test(message)) {
    return null;
  }
  if (/\bDelivery recovery complete\b/i.test(message)) {
    return null;
  }
  if (/\bRetry failed for delivery\b/i.test(message)) {
    return null;
  }

  // Skip model_fallback_decision JSON blobs (internal routing noise)
  if (/model_fallback_decision/i.test(message)) {
    return null;
  }

  // --- Error patterns FIRST (before model/tool matching to avoid misclassification) ---
  if (obj.level === 'error' || /\b(error|fail(?:ed|ure)?|exception|timed?\s*out|ENOENT|EACCES)\b/i.test(message)) {
    // Extract meaningful error description from structured messages
    const errorRaw = extractReadableMessage(message);
    return { ts, type: 'error', raw: errorRaw };
  }

  // Model/inference patterns: suppressed — adapter generates richer chat_start/chat_end
  // (these broad patterns match too many internal logs: "inference completed", "thinking process", etc.)
  if (/\b(inference|model|llm)\b.*\b(start|request|call|complet|done|response|finish)\b/i.test(message)) {
    return null;
  }

  // Anything else — skip. Real chat/tool/error activity flows through the
  // OpenClaw Gateway adapter's RPC events, not heuristic log parsing.
  return null;
}
