/**
 * Pixoo device settings CRUD — reads/writes pixooDevices[] in ~/.agentdeck/settings.json.
 * Preserves all other settings in the file.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PixooDevice } from './pixoo-bridge.js';

const SETTINGS_DIR = join(homedir(), '.agentdeck');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export function loadPixooDevices(): PixooDevice[] {
  const settings = readSettings();
  return Array.isArray(settings.pixooDevices) ? settings.pixooDevices : [];
}

export function savePixooDevices(devices: PixooDevice[]): void {
  const settings = readSettings();
  settings.pixooDevices = devices;
  writeSettings(settings);
}

export function addDevice(device: PixooDevice): boolean {
  const devices = loadPixooDevices();
  if (devices.some(d => d.ip === device.ip)) return false;
  devices.push(device);
  savePixooDevices(devices);
  return true;
}

export function removeDevice(ip: string): boolean {
  const devices = loadPixooDevices();
  const filtered = devices.filter(d => d.ip !== ip);
  if (filtered.length === devices.length) return false;
  savePixooDevices(filtered);
  return true;
}
