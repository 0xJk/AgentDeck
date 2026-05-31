import streamDeck from '@elgato/streamdeck';

/**
 * Plugin-level global settings (plan 001 §2d).
 *
 * Paired bridges are stored here; the per-bridge auth **token lives only in the
 * macOS Keychain** (see token-store.ts), never in globalSettings.
 *
 * This module is the single choke-point for the Stream Deck SDK settings API so
 * tests can stub `@elgato/streamdeck` in one place.
 */
export interface PairedBridge {
  id: string;
  host: string;
  port: number;
}

export interface PluginGlobalSettings {
  pairedBridges: PairedBridge[];
  activeBridgeId: string | null;
}

const EMPTY: PluginGlobalSettings = {
  pairedBridges: [],
  activeBridgeId: null,
};

/** Normalise a raw SDK settings blob into a well-formed PluginGlobalSettings. */
function normalize(raw: Partial<PluginGlobalSettings> | undefined): PluginGlobalSettings {
  return {
    pairedBridges: Array.isArray(raw?.pairedBridges) ? raw!.pairedBridges : [],
    activeBridgeId: raw?.activeBridgeId ?? null,
  };
}

// The SDK settings API is generic over `JsonObject` (a recursive index-signature
// type the SDK does not re-export from its package root). Our typed shapes carry
// nested object arrays that don't structurally satisfy that constraint, so we
// cross the SDK boundary through a locally-declared JSON-object type and
// normalise on our side.
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

/** Read the plugin global settings, normalised. */
export async function getGlobalSettings(): Promise<PluginGlobalSettings> {
  const raw = (await streamDeck.settings.getGlobalSettings()) as unknown as Partial<PluginGlobalSettings>;
  return normalize(raw);
}

/** Persist the plugin global settings. */
export async function setGlobalSettings(settings: PluginGlobalSettings): Promise<void> {
  await streamDeck.settings.setGlobalSettings(settings as unknown as JsonObject);
}

/**
 * Subscribe to global-settings changes (e.g. the Property Inspector adding a
 * bridge or switching the active one). Returns the SDK disposable.
 */
export function onDidReceiveGlobalSettings(
  listener: (settings: PluginGlobalSettings) => void,
) {
  return streamDeck.settings.onDidReceiveGlobalSettings((ev) =>
    listener(normalize(ev.settings as unknown as Partial<PluginGlobalSettings>)),
  );
}

/** The default empty settings shape (no paired bridges, nothing active). */
export function emptySettings(): PluginGlobalSettings {
  return { ...EMPTY };
}

/**
 * Setup is "required" purely when there are no paired bridges (plan 001 §2f).
 * Deliberately does NOT probe the local machine (`~/.agentdeck`, `which
 * agentdeck`) — the MacBook is remote-only and never runs a local daemon.
 */
export function computeSetupRequired(settings: PluginGlobalSettings): boolean {
  return settings.pairedBridges.length === 0;
}

/** Find a paired bridge by its id. */
export function findBridge(
  settings: PluginGlobalSettings,
  id: string | null,
): PairedBridge | null {
  if (id == null) return null;
  return settings.pairedBridges.find((b) => b.id === id) ?? null;
}
