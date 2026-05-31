/**
 * Bridge connection action — Property Inspector backend.
 *
 * Manages the list of paired bridges + the active bridge. The PI HTML
 * (ui/bridge-connection-pi.html) drives this action via sendToPlugin messages;
 * tokens live in the OS keychain (token-store.ts), bridge configs live in global
 * settings (bridge-settings.ts). On any change the action pushes the current
 * state back to the PI via sendToPropertyInspector.
 */

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
}

@action({ UUID: 'bound.serendipity.agentdeck.bridge-connection' })
export class BridgeConnectionAction extends SingletonAction {
  override async onWillAppear(_ev: WillAppearEvent): Promise<void> {
    // PI requests state explicitly via getState; nothing to do on appear.
  }

  /** Handle messages from the Property Inspector. */
  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
    const msg = ev.payload as unknown as PIMessage;
    switch (msg?.event) {
      case 'getState':
        await this.pushState();
        return;
      case 'addBridge':
        await this.addBridge(msg.bridge, msg.token);
        return;
      case 'setActive':
        await this.setActive(msg.id);
        return;
      case 'deleteBridge':
        await this.deleteBridge(msg.id);
        return;
      default:
        return;
    }
  }

  private async addBridge(bridge: PairedBridge, token: string): Promise<void> {
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
    await this.pushState(keychainError ? 'keychain_error' : undefined);
  }

  private async setActive(id: string): Promise<void> {
    const settings = await getGlobalSettings();
    if (!settings.pairedBridges.some((b: PairedBridge) => b.id === id)) return;
    await setGlobalSettings({ ...settings, activeBridgeId: id });
    // Isolate timeline history per active bridge.
    setTimelineBridge(id);
    await this.pushState();
  }

  private async deleteBridge(id: string): Promise<void> {
    const settings = await getGlobalSettings();
    let keychainError = false;
    try {
      await deleteToken(id);
    } catch {
      keychainError = true;
    }
    const pairedBridges = settings.pairedBridges.filter((b: PairedBridge) => b.id !== id);
    const activeBridgeId = settings.activeBridgeId === id ? null : settings.activeBridgeId;
    await setGlobalSettings({ ...settings, pairedBridges, activeBridgeId });
    await this.pushState(keychainError ? 'keychain_error' : undefined);
  }

  private async pushState(status?: 'keychain_error'): Promise<void> {
    const settings = await getGlobalSettings();
    const keychainAvailable = await isKeychainAvailable();
    const state: PIState & { status?: string } = {
      event: 'state',
      pairedBridges: settings.pairedBridges,
      activeBridgeId: settings.activeBridgeId,
      keychainAvailable,
      ...(status ? { status } : {}),
    };
    // Push to the currently-focused Property Inspector. The SDK's
    // sendToPropertyInspector is typed against JsonValue; our typed PIState
    // crosses that boundary through a locally-declared JSON shape (mirrors the
    // pattern in bridge-settings.ts).
    const ui = (streamDeck as unknown as {
      ui?: { current?: { sendToPropertyInspector: (p: JsonValue) => Promise<void> } };
    }).ui;
    await ui?.current?.sendToPropertyInspector(state as unknown as JsonValue);
  }
}
