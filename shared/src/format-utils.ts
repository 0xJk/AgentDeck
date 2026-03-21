/**
 * Shared format utilities — canonical implementations for time, count, bytes.
 * Used by bridge, plugin, and ported to Android/Apple (manual sync).
 */

/** Format ISO timestamp to relative time like "2h 30m" or "1d 5h" */
export function formatResetTime(isoString: string | undefined): string | undefined {
  if (!isoString) return undefined;
  // Already pre-formatted (no 'T' in ISO dates means it's a relative string)
  if (!isoString.includes('T')) return isoString;

  try {
    const resetMs = new Date(isoString).getTime();
    if (isNaN(resetMs)) return undefined;
    const diffMs = resetMs - Date.now();

    if (diffMs <= 0) return 'now';

    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;

    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;

    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  } catch {
    return undefined;
  }
}

/** Compact format without spaces — "2d5h", "4h23m". For pixel-constrained displays. */
export function formatResetTimeCompact(isoString: string): string {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return '0m';
  const totalMins = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const mins = totalMins % 60;
  if (days > 0 && remHours > 0) return `${days}d${remHours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && mins > 0) return `${hours}h${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

/** Format count: 1234 → "1.2K", 1500000 → "1.5M" */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format byte size: 1073741824 → "1.0G", 1048576 → "1M" */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    const gb = bytes / 1_073_741_824;
    return gb >= 10 ? `${Math.round(gb)}G` : `${gb.toFixed(1)}G`;
  }
  if (bytes >= 1_048_576) {
    const mb = bytes / 1_048_576;
    return mb >= 10 ? `${Math.round(mb)}M` : `${mb.toFixed(1)}M`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

/** Format uptime from seconds: 3725 → "1h 2m" */
export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** Plain-text gauge bar: "████░░" (no ANSI colors) */
export function gaugeBar(percent: number, width = 6): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
