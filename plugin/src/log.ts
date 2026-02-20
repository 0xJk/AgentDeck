/**
 * Plugin logger — wraps streamDeck.logger with scope caching and build-time level control.
 *
 * Dev build  (pnpm build):           __SDC_DEBUG__ = true  → setLevel('trace')
 * Prod build (SDC_PROD=1 pnpm build): __SDC_DEBUG__ = false → setLevel('info')
 *
 * Level guide:
 *   dtrace() — per-event/per-chunk detail (dev only)
 *   dlog()   — debug: action lifecycle, state transitions (dev only)
 *   dinfo()  — info:  operational events (startup, connect, disconnect) — always logged
 *   dwarn()  — warn:  abnormal but recoverable — always logged
 *   derr()   — error: requires attention — always logged
 */
import streamDeck from '@elgato/streamdeck';

declare const __SDC_DEBUG__: boolean;

const DEBUG: boolean =
  typeof __SDC_DEBUG__ !== 'undefined' ? __SDC_DEBUG__ : true;

// Set log level based on build mode — must happen before any logging
streamDeck.logger.setLevel(DEBUG ? 'trace' : 'info');

// Lazy scope cache — createScope() once per tag name
const scopes = new Map<string, ReturnType<typeof streamDeck.logger.createScope>>();

function scope(tag: string): ReturnType<typeof streamDeck.logger.createScope> {
  let s = scopes.get(tag);
  if (!s) {
    s = streamDeck.logger.createScope(tag);
    scopes.set(tag, s);
  }
  return s;
}

/** Trace — most verbose, dev builds only */
export function dtrace(tag: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  scope(tag).trace(args.map(String).join(' '));
}

/** Debug — action lifecycle and state detail, dev builds only */
export function dlog(tag: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  scope(tag).debug(args.map(String).join(' '));
}

/** Info — operational events (startup, connect, disconnect), always logged */
export function dinfo(tag: string, ...args: unknown[]): void {
  scope(tag).info(args.map(String).join(' '));
}

/** Warn — abnormal but recoverable, always logged */
export function dwarn(tag: string, ...args: unknown[]): void {
  scope(tag).warn(args.map(String).join(' '));
}

/** Error — requires immediate attention, always logged */
export function derr(tag: string, ...args: unknown[]): void {
  scope(tag).error(args.map(String).join(' '));
}
