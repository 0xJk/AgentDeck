import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import type { WillAppearEvent, SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonValue, JsonObject } from '@elgato/utils';
import {
  getGlobalSettings,
  setGlobalSettings,
  type PairedBridge,
  type PluginGlobalSettings,
} from '../bridge-settings.js';
import { saveToken, deleteToken, isKeychainAvailable } from '../token-store.js';
import { setTimelineBridge } from '../timeline-store.js';

/**
 * Bridge connection action — Property Inspector backend.
 *
 * Manages the list of paired bridges + the active bridge. The PI HTML
 * (ui/bridge-connection-pi.html) drives this action via sendToPlugin messages;
 * tokens live in the OS keychain (token-store.ts), bridge configs in global
 * settings (bridge-settings.ts). The action pushes state back to the PI via
 * Action.sendToPropertyInspector.
 *
 * Connection-state wiring: the action persists settings only; the live
 * connection state (connecting/connected/pairing/keychain_error) lives in the
 * ConnectionManager owned by plugin.ts. plugin.ts injects an accessor via
 * initBridgeConnection() so the PI can show the ACTIVE bridge's real status —
 * not merely which bridge is selected — and calls refreshBridgeConnectionPI()
 * whenever the connection state changes so the open inspector stays live.
 */

/** Connection states surfaced to the PI (mirrors ConnectionManager). */
type ConnState =
  | 'idle'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'pairing'
  | 'keychain_error';

/** Messages the PI sends to this action. */
type PIMessage =
  | { event: 'getState' }
  | { event: 'addBridge'; bridge: PairedBridge; token: string }
  | { event: 'setActive'; id: string }
  | { event: 'deleteBridge'; id: string };

/** State pushed to the PI for rendering. */
interface PIState {
  event: 'state';
  pairedBridges: PairedBridge[];
  activeBridgeId: string | null;
  keychainAvailable: boolean;
  /** Live connection state of the ACTIVE bridge (selected ≠ connected). */
  connectionState: ConnState;
}

/** A sink capable of pushing state back to the Property Inspector. */
type PISink = { sendToPropertyInspector?: (p: JsonValue) => Promise<void> } | undefined;

// ── Wiring injected by plugin.ts (see initBridgeConnection) ──────────────────
let getConnectionState: () => ConnState = () => 'idle';
let onActiveBridgeChanged: () => void = () => {};
/** Remembered sink for the currently-open PI, so connMgr state changes can
 *  re-render it without a fresh inbound message. */
let lastSink: PISink;

/**
 * Wire the action to the ConnectionManager. Called once from plugin.ts after
 * connMgr is constructed.
 * - getConnectionState: read connMgr's live state for the active bridge.
 * - onActiveBridgeChanged: tell connMgr to (re)connect after the active bridge
 *   is set/cleared in globalSettings.
 */
export function initBridgeConnection(opts: {
  getConnectionState: () => ConnState;
  onActiveBridgeChanged: () => void;
}): void {
  getConnectionState = opts.getConnectionState;
  onActiveBridgeChanged = opts.onActiveBridgeChanged;
}

/** Re-push current state to the open PI (call when connMgr state changes). */
export function refreshBridgeConnectionPI(): void {
  void pushState(undefined);
}

async function pushState(sink: PISink, statusOverride?: 'keychain_error'): Promise<void> {
  if (sink) lastSink = sink;
  const settings = await getGlobalSettings();
  const keychainAvailable = await isKeychainAvailable();
  const connectionState: ConnState =
    statusOverride === 'keychain_error' ? 'keychain_error' : getConnectionState();
  const state: PIState = {
    event: 'state',
    pairedBridges: settings.pairedBridges,
    activeBridgeId: settings.activeBridgeId,
    keychainAvailable,
    connectionState,
  };
  const payload = state as unknown as JsonValue;
  const target = sink ?? lastSink;
  if (target?.sendToPropertyInspector) {
    await target.sendToPropertyInspector(payload);
    return;
  }
  // Fallback: the SDK exposes sendToPropertyInspector on streamDeck.ui for the
  // currently-focused inspector (no-ops if none is open).
  const ui = (streamDeck as unknown as {
    ui?: { sendToPropertyInspector?: (p: JsonValue) => Promise<void> };
  }).ui;
  await ui?.sendToPropertyInspector?.(payload);
}

async function addBridge(sink: PISink, bridge: PairedBridge, token: string): Promise<void> {
  const settings = await getGlobalSettings();
  let keychainError = false;
  try {
    if (token) await saveToken(bridge.id, token);
  } catch {
    keychainError = true;
  }
  const without = settings.pairedBridges.filter((b: PairedBridge) => b.id !== bridge.id);
  const next: PluginGlobalSettings = {
    ...settings,
    pairedBridges: [...without, bridge],
  };
  await setGlobalSettings(next);
  // Adding a bridge does NOT change the active bridge — no reconnect here.
  await pushState(sink, keychainError ? 'keychain_error' : undefined);
}

async function setActive(sink: PISink, id: string): Promise<void> {
  const settings = await getGlobalSettings();
  if (!settings.pairedBridges.some((b: PairedBridge) => b.id === id)) return;
  await setGlobalSettings({ ...settings, activeBridgeId: id });
  // Isolate timeline history per active bridge.
  setTimelineBridge(id);
  // Tell connMgr to tear down the old connection and connect the new active
  // bridge. Its state_change events will refresh the PI with the real result
  // (connected / pairing-on-4001 / keychain_error).
  onActiveBridgeChanged();
  await pushState(sink);
}

async function deleteBridge(sink: PISink, id: string): Promise<void> {
  const settings = await getGlobalSettings();
  let keychainError = false;
  try {
    await deleteToken(id);
  } catch {
    keychainError = true;
  }
  const pairedBridges = settings.pairedBridges.filter((b: PairedBridge) => b.id !== id);
  const wasActive = settings.activeBridgeId === id;
  const activeBridgeId = wasActive ? null : settings.activeBridgeId;
  await setGlobalSettings({ ...settings, pairedBridges, activeBridgeId });
  if (wasActive) onActiveBridgeChanged(); // deleted the active bridge → tear down
  await pushState(sink, keychainError ? 'keychain_error' : undefined);
}

@action({ UUID: 'bound.serendipity.agentdeck.bridge-connection' })
export class BridgeConnectionAction extends SingletonAction {
  override async onWillAppear(_ev: WillAppearEvent): Promise<void> {
    // PI requests state explicitly via getState; nothing to do on appear.
  }

  /** Handle messages from the Property Inspector. */
  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
    const msg = ev.payload as unknown as PIMessage;
    // ev.action.sendToPropertyInspector targets the PI that sent this message —
    // the reliable reply sink.
    const sink = ev.action as unknown as PISink;
    lastSink = sink;
    switch (msg?.event) {
      case 'getState':
        await pushState(sink);
        return;
      case 'addBridge':
        await addBridge(sink, msg.bridge, msg.token);
        return;
      case 'setActive':
        await setActive(sink, msg.id);
        return;
      case 'deleteBridge':
        await deleteBridge(sink, msg.id);
        return;
      default:
        return;
    }
  }
}
