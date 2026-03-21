/**
 * Shared timeline summarizer utilities — extractTopicHint and cleanLLMOutput.
 * Used by both bridge/src/timeline-summarizer.ts and plugin/src/timeline-summarizer.ts.
 */

import { cleanRawText } from './timeline.js';

export const SUMMARY_SYSTEM_PROMPT = `You are a timeline summarizer. Given an AI assistant's response text, produce a single-line Korean summary (max 80 characters) of what was accomplished. Focus on the result, not the process. No quotes, no markdown, no punctuation at the end. Output ONLY the summary line, nothing else. Examples:
- 봇마당 인박스에 AI 에이전트 운영 팁 3건 수집
- 주간 모델 사용량 리포트: glm-5 28회 최다
- GitHub 이슈 #10428 검토 완료, PR #16831 대기 중
- HBF 뉴스 9월~2월분 한글 정리 완료`;

/**
 * Extract a topic hint from the first few tokens of a response.
 * Used for immediate chat_start enrichment before LLM summarization.
 */
export function extractTopicHint(text: string): string | null {
  if (!text || text.length < 5) return null;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Find first non-markdown, non-code-fence, non-empty line
  let candidate: string | null = null;
  let inCodeFence = false;
  for (const line of lines) {
    // Track code fence boundaries
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Skip headings-only
    if (/^#{1,6}\s*$/.test(line)) continue;

    // Strip markdown decorators for evaluation
    const stripped = cleanRawText(line)
      .replace(/^[-*]\s+/, '')
      .replace(/^>\s+/, '')
      .trim();

    if (stripped.length >= 3) {
      candidate = stripped;
      break;
    }
  }

  if (!candidate) return null;

  const snippet = candidate.length > 80 ? candidate.slice(0, 77) + '...' : candidate;

  // Remove common Korean prefixes (chained — "네, 확인했습니다." → "")
  let cleaned = snippet;
  // Strip leading "네," / "네." first, then polite phrases
  cleaned = cleaned.replace(/^네[,.]?\s*/i, '');
  cleaned = cleaned.replace(/^(완료했습니다\.\s*|알겠습니다\.\s*|확인했습니다\.\s*)/i, '');
  cleaned = cleaned.trim();

  return cleaned || null;
}

/** Clean LLM output — strip thinking, quotes, markdown artifacts */
export function cleanLLMOutput(content: string): string | null {
  let cleaned = content
    // Strip <think>...</think> blocks (Qwen thinking mode)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    // Strip unclosed <think> at end (truncated output)
    .replace(/<think>[\s\S]*$/g, '')
    .trim();

  // If output has multiple lines, take the last non-empty line
  // (thinking text tends to come first, summary last)
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // Find the last line that looks like Korean summary (contains Korean chars)
    const koreanLine = lines.reverse().find(l => /[\uAC00-\uD7AF]/.test(l));
    cleaned = koreanLine || lines[lines.length - 1];
  }

  // Strip surrounding quotes, markdown list markers
  cleaned = cleaned
    .replace(/^[-*]\s*/, '')
    .replace(/^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g, '')
    .replace(/[.\u3002]$/, '') // remove trailing period
    .trim();

  if (!cleaned || cleaned.length < 3) return null;
  // Truncate to 80 chars if needed
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 77) + '...';
  return cleaned;
}
