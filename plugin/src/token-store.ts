import { Entry } from '@napi-rs/keyring';

/**
 * Per-bridge auth tokens live in the macOS Keychain, never in plugin
 * globalSettings (plan 001 §2c / §2d). `bridgeId` is the user's friendly
 * name ("M4", "M1") and doubles as the keychain account.
 *
 * Probe note (@napi-rs/keyring v1.3.0, macOS, sync `Entry`):
 *   - getPassword() on a MISSING entry returns `null` (does NOT throw).
 *   - deletePassword() on a MISSING entry returns `false` (does NOT throw).
 * So the primary "not found" signal is the return value, not an exception.
 * `isNotFound()` is only a defensive fallback for other platforms / future
 * versions whose keyring backend surfaces a `NoEntry` error instead.
 */
const SERVICE = 'com.agentdeck.plugin';

export async function saveToken(bridgeId: string, token: string): Promise<void> {
  new Entry(SERVICE, bridgeId).setPassword(token.trim());
}

export async function loadToken(bridgeId: string): Promise<string | null> {
  try {
    // Missing entry -> null on the probed sync path (no throw). Normalise any
    // undefined (async backend / other platforms) to null as well.
    const stored = new Entry(SERVICE, bridgeId).getPassword();
    return stored ?? null;
  } catch (e) {
    // Defensive: some keystores raise NoEntry instead of returning null.
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function deleteToken(bridgeId: string): Promise<void> {
  try {
    // Missing entry -> false on the probed sync path (no throw). We don't care
    // whether something was actually removed; absence is the desired end state.
    new Entry(SERVICE, bridgeId).deletePassword();
  } catch (e) {
    // Defensive: swallow a NoEntry error, re-throw real keychain failures.
    if (!isNotFound(e)) throw e;
  }
}

/**
 * Probe whether the OS keychain backend is usable. Constructs an Entry and
 * reads a sentinel account; a missing entry (null/false) means the backend
 * works fine, only a thrown error that is NOT "not found" indicates the
 * keychain is unavailable (e.g. locked, no backend on the platform). Surfaced
 * in the Property Inspector as `keychain_error` status.
 */
export async function isKeychainAvailable(): Promise<boolean> {
  try {
    new Entry(SERVICE, '__agentdeck_probe__').getPassword();
    return true;
  } catch (e) {
    return isNotFound(e);
  }
}

/**
 * Best-effort classifier for the "no such entry" case on platforms/versions
 * where the keyring backend throws instead of returning `null`/`false`.
 * The probed macOS v1.3.0 sync path never throws on missing entries, so this
 * is dead code there — but other OS keystores in this lib can surface a
 * `NoEntry` error, so we match structurally rather than swallow everything.
 */
export function isNotFound(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  const msg = (e as { message?: unknown }).message;
  if (typeof code === 'string' && /NoEntry|NotFound/i.test(code)) return true;
  if (typeof msg === 'string' && /no (matching )?entry|not found|no entry found/i.test(msg)) {
    return true;
  }
  return false;
}
