/**
 * D200H HID Protocol — D200-compatible 1024-byte packet protocol
 *
 * Packet structure:
 *   [0-1]  Header: 0x7C 0x7C
 *   [2-3]  Command: big-endian uint16
 *   [4-7]  Length:  little-endian uint32
 *   [8-1023] Payload (zero-padded)
 *
 * Image delivery: ZIP(manifest.json + icons/*.png) sent in chunked 1024-byte packets.
 * ZIP quirk: bytes at offset 1016, 2040, 3064... must NOT be 0x00 or 0x7C.
 */

import { createWriteStream } from 'fs';
import { randomBytes } from 'crypto';
import { debug } from '../logger.js';

const TAG = 'd200h-hid';
const PACKET_SIZE = 1024;
const HEADER = Buffer.from([0x7c, 0x7c]);
const INVALID_BOUNDARY_BYTES = [0x00, 0x7c];

// --- Commands ---

export const CMD = {
  SET_BUTTONS: 0x0001,
  PARTIAL_UPDATE: 0x000d,
  SET_SMALL_WINDOW: 0x0006,
  SET_BRIGHTNESS: 0x000a,
  SET_LABEL_STYLE: 0x000b,
  IN_BUTTON: 0x0101,
  IN_DEVICE_INFO: 0x0303,
} as const;

// --- Packet building ---

export function buildPacket(command: number, payload: Buffer, totalLength?: number): Buffer {
  const pkt = Buffer.alloc(PACKET_SIZE, 0);
  // Header
  pkt[0] = 0x7c;
  pkt[1] = 0x7c;
  // Command (big-endian uint16)
  pkt.writeUInt16BE(command, 2);
  // Length (little-endian uint32) — total file size for multi-packet, else payload length
  pkt.writeUInt32LE(totalLength ?? payload.length, 4);
  // Payload
  payload.copy(pkt, 8, 0, Math.min(payload.length, PACKET_SIZE - 8));
  return pkt;
}

/**
 * Build all packets for a ZIP file transfer (SET_BUTTONS or PARTIAL_UPDATE).
 * First packet has the header; subsequent packets are raw 1024-byte chunks.
 */
export function buildZipPackets(zipData: Buffer, command: number = CMD.SET_BUTTONS): Buffer[] {
  const packets: Buffer[] = [];
  const fileSize = zipData.length;

  // First packet: header(8) + first chunk
  const firstChunkSize = PACKET_SIZE - 8;
  const firstChunk = zipData.subarray(0, firstChunkSize);
  packets.push(buildPacket(command, firstChunk, fileSize));

  // Remaining chunks (raw, no header)
  for (let offset = firstChunkSize; offset < fileSize; offset += PACKET_SIZE) {
    const chunk = Buffer.alloc(PACKET_SIZE, 0);
    zipData.copy(chunk, 0, offset, Math.min(offset + PACKET_SIZE, fileSize));
    packets.push(chunk);
  }

  return packets;
}

export function buildBrightnessPacket(brightness: number): Buffer {
  const val = Math.max(0, Math.min(100, Math.round(brightness)));
  return buildPacket(CMD.SET_BRIGHTNESS, Buffer.from(String(val), 'utf-8'));
}

export function buildSmallWindowPacket(mode: number, cpu: number, mem: number, time: string, gpu: number): Buffer {
  const data = `${mode}|${cpu}|${mem}|${time}|${gpu}`;
  return buildPacket(CMD.SET_SMALL_WINDOW, Buffer.from(data, 'utf-8'));
}

// --- Incoming packet parsing ---

export interface ButtonEvent {
  index: number;
  pressed: boolean;
  state: number;
}

export interface DeviceInfo {
  serialNumber: string;
  firmwareVersion: string;
  deviceType: string;
  hardwareVersion: string;
}

export type IncomingEvent =
  | { type: 'button'; data: ButtonEvent }
  | { type: 'device_info'; data: DeviceInfo }
  | { type: 'unknown'; command: number; raw: Buffer };

export function parseIncoming(data: Buffer): IncomingEvent | null {
  if (data.length < 8) return null;
  if (data[0] !== 0x7c || data[1] !== 0x7c) return null;

  const command = data.readUInt16BE(2);

  if (command === CMD.IN_BUTTON && data.length >= 12) {
    return {
      type: 'button',
      data: {
        state: data[8],
        index: data[9],
        pressed: data[11] === 0x01,
      },
    };
  }

  if (command === CMD.IN_DEVICE_INFO) {
    try {
      const jsonStr = data.subarray(8).toString('ascii').split('\0')[0];
      const info = JSON.parse(jsonStr);
      return {
        type: 'device_info',
        data: {
          serialNumber: info.SerialNumber ?? '',
          firmwareVersion: info.Dversion ?? '',
          deviceType: info.DeviceType ?? '',
          hardwareVersion: info.HardwareVersion ?? '',
        },
      };
    } catch {
      return { type: 'unknown', command, raw: data };
    }
  }

  return { type: 'unknown', command, raw: data };
}

// --- ZIP validation (boundary byte workaround) ---

/**
 * Check if a ZIP has invalid bytes at 1024-byte chunk boundaries.
 * At offset 1016, 2040, 3064... the byte must not be 0x00 or 0x7C.
 */
export function validateZipBoundaries(zipData: Buffer): boolean {
  for (let i = 1016; i < zipData.length; i += PACKET_SIZE) {
    if (INVALID_BOUNDARY_BYTES.includes(zipData[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Generate a random dummy string to pad the ZIP until boundaries are valid.
 */
export function generateDummyPadding(attempt: number): string {
  return 'AgentDeck ' + randomBytes(8 * (attempt + 1)).toString('hex');
}
