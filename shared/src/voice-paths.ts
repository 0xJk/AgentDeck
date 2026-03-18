/**
 * Voice binary/model path constants shared between bridge and plugin.
 */
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

export const MODEL_SEARCH_DIRS = [
  join(homedir(), '.local/share/whisper-cpp'),
  '/opt/homebrew/share/whisper-cpp',   // arm64 Homebrew
  '/usr/local/share/whisper-cpp',      // x86 Homebrew
  join(homedir(), 'models'),
];

// Model tiers: Metal-accelerated GPU can handle large models; CPU/Rosetta cannot
export const MODELS_WITH_METAL = [
  'ggml-large-v3-turbo.bin',
  'ggml-small.bin',
  'ggml-base.bin',
];
export const MODELS_WITHOUT_METAL = [
  'ggml-base.bin',
  'ggml-small.bin',
];

// Preferred binary paths: arm64 Homebrew first, then system PATH
export const WHISPER_CANDIDATES = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
];
export const REC_CANDIDATES = [
  '/opt/homebrew/bin/rec',
  '/usr/local/bin/rec',
];
export const SOX_CANDIDATES = [
  '/opt/homebrew/bin/sox',
  '/usr/local/bin/sox',
];
export const WHISPER_SERVER_CANDIDATES = [
  '/opt/homebrew/bin/whisper-server',
  '/usr/local/bin/whisper-server',
];

/** Whisper-server discovery info file path */
export const WHISPER_SERVER_INFO_FILE = join(homedir(), '.agentdeck', 'whisper-server.json');

// ===== Porcupine Wake Word =====

/** Directory for custom .ppn wake word model files */
export const WAKE_WORD_MODEL_DIR = join(homedir(), '.agentdeck', 'wake-word');

/** Picovoice access key file */
export const PICOVOICE_ACCESS_KEY_FILE = join(homedir(), '.agentdeck', 'picovoice-access-key');

/** OpenClaw binary candidates */
export const OPENCLAW_CANDIDATES = [
  '/opt/homebrew/bin/openclaw',
  '/usr/local/bin/openclaw',
  join(homedir(), 'Library', 'pnpm', 'openclaw'),                        // macOS pnpm global bin
  join(homedir(), 'Library', 'pnpm', 'nodejs_current', 'bin', 'openclaw'), // pnpm node bin
  join(homedir(), '.local/bin/openclaw'),
  join(homedir(), '.cargo/bin/openclaw'),
  join(homedir(), 'go/bin/openclaw'),
  join(homedir(), '.openclaw/bin/openclaw'),
  join(homedir(), '.bun/bin/openclaw'),
];

/** Resolve `openclaw` binary: try known candidate paths, fallback to bare name on PATH. */
export function resolveOpenClawBin(): string {
  for (const candidate of OPENCLAW_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'openclaw';
}

/**
 * Augmented PATH for CLI child processes — ensures binaries installed via
 * Homebrew, pip --user, etc. are discoverable even when the parent process
 * (e.g. Stream Deck SDK) has a minimal PATH.
 */
export function augmentedPath(): string {
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), 'Library', 'pnpm'),  // macOS pnpm global bin
    join(homedir(), '.local/bin'),
    join(homedir(), '.cargo/bin'),
    join(homedir(), 'go/bin'),
    join(homedir(), '.openclaw/bin'),
    join(homedir(), '.bun/bin'),
  ];
  const existing = process.env.PATH ?? '/usr/bin:/bin';
  return [...extra, existing].join(':');
}
