/**
 * Local voice recording & transcription for disconnected mode.
 *
 * Recording uses an iTerm2 utility session to run `rec` — this inherits
 * iTerm2's macOS microphone permission, bypassing the limitation that
 * Stream Deck plugin processes cannot obtain mic access.
 *
 * Transcription uses whisper-server (discovery) or whisper-cli fallback.
 */
import { spawn, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync, statSync, readFileSync } from 'fs';
import {
  REC_CANDIDATES, SOX_CANDIDATES,
  WHISPER_CANDIDATES,
  MODEL_SEARCH_DIRS, MODELS_WITH_METAL, MODELS_WITHOUT_METAL,
  WHISPER_SERVER_INFO_FILE,
} from '@agentdeck/shared';
import { osascript } from './utility-modes/macos.js';
import { dlog } from './log.js';

const TIMEOUT_BASE_MS = 15_000;
const TIMEOUT_MULTIPLIER_METAL = 1;
const TIMEOUT_MULTIPLIER_ROSETTA = 4;

// Poll interval for waiting on audio file
const FILE_POLL_MS = 100;
const FILE_POLL_MAX_MS = 5000;

function findBinary(candidates: string[], fallback: string): string {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return fallback;
}

function detectMetal(whisperPath: string): boolean {
  try {
    const otoolOut = execSync(`otool -L "${whisperPath}"`, { encoding: 'utf8' });
    const hasMetal = otoolOut.includes('libggml-metal');
    const fileOut = execSync(`file "${whisperPath}"`, { encoding: 'utf8' });
    const isArm64 = fileOut.includes('arm64');
    return hasMetal && isArm64;
  } catch {
    return false;
  }
}

function findWhisperModel(preference: string[]): string {
  for (const model of preference) {
    for (const dir of MODEL_SEARCH_DIRS) {
      const path = join(dir, model);
      if (existsSync(path)) return path;
    }
  }
  return join(MODEL_SEARCH_DIRS[0], preference[0]);
}

function findFallbackModel(currentModel: string): string | null {
  const all = [...MODELS_WITH_METAL];
  const currentName = currentModel.split('/').pop() ?? '';
  const idx = all.indexOf(currentName);
  for (let i = idx + 1; i < all.length; i++) {
    for (const dir of MODEL_SEARCH_DIRS) {
      const path = join(dir, all[i]);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

// Lazy-init state
let initialized = false;
let recBin: string;
let soxBin: string;
let whisperBin: string;
let whisperModel: string;
let hasMetal: boolean;

let recording = false;
let audioFile = '';

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  recBin = findBinary(REC_CANDIDATES, 'rec');
  soxBin = findBinary(SOX_CANDIDATES, 'sox');
  whisperBin = findBinary(WHISPER_CANDIDATES, 'whisper-cli');
  hasMetal = detectMetal(whisperBin);
  const preference = hasMetal ? MODELS_WITH_METAL : MODELS_WITHOUT_METAL;
  whisperModel = findWhisperModel(preference);
  dlog('VoiceLocal', `init: rec=${recBin}, whisper=${whisperBin}, model=${whisperModel}, metal=${hasMetal}`);
}

// ---- iTerm recording session (no write text — avoids paste dialog) ----

/**
 * Start rec in an iTerm2 window using `create window with default profile command`.
 * The command runs as the session's initial process — no `write text` (avoids paste dialog).
 * iTerm2 has macOS microphone permission, so rec inherits it.
 */
async function launchRecInIterm(recCommand: string): Promise<void> {
  const escaped = recCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await osascript(
    'set prevApp to (path to frontmost application as text)\n' +
    'tell application "iTerm2"\n' +
    `  set newWin to (create window with default profile command "${escaped}")\n` +
    '  set miniaturized of newWin to true\n' +
    'end tell\n' +
    'if prevApp does not contain "iTerm" then\n' +
    '  tell application prevApp to activate\n' +
    'end if',
  );
}

/** Kill the rec process by matching the audio file path in its arguments. */
function killRecProcess(): void {
  try {
    execSync(`pkill -INT -f "${audioFile}"`, { timeout: 2000 });
    dlog('VoiceLocal', 'Sent SIGINT to rec via pkill');
  } catch {
    dlog('VoiceLocal', 'pkill: no matching rec process (may have already exited)');
  }
}

// ---- Recording via iTerm ----

export async function startLocalRecording(): Promise<void> {
  ensureInit();
  if (recording) return;

  audioFile = join(tmpdir(), `agentdeck-voice-local-${Date.now()}.wav`);
  recording = true;

  try {
    const cmd = `${recBin} -r 16000 -c 1 -b 16 ${audioFile}`;
    await launchRecInIterm(cmd);
    dlog('VoiceLocal', `Recording started via iTerm → ${audioFile}`);
  } catch (err) {
    recording = false;
    const msg = err instanceof Error ? err.message : String(err);
    dlog('VoiceLocal', `Failed to start recording via iTerm: ${msg}`);
    throw new Error(`Failed to start recording: ${msg}`);
  }
}

export async function stopLocalRecording(): Promise<string> {
  if (!recording) {
    throw new Error('Not currently recording');
  }

  recording = false;

  // Kill rec process directly (avoids iTerm paste dialog for control characters)
  killRecProcess();

  // Wait for audio file to be finalized (rec needs a moment after Ctrl+C)
  await waitForFile(audioFile, FILE_POLL_MAX_MS);

  if (!existsSync(audioFile)) {
    cleanup();
    throw new Error(`Recording file not created: ${audioFile}`);
  }
  const sz = statSync(audioFile).size;
  dlog('VoiceLocal', `Recording file: ${sz} bytes`);
  if (sz < 100) {
    cleanup();
    throw new Error('Recording too short or empty');
  }

  // Check audio RMS to detect silence (whisper hallucinates on silent audio)
  const rms = computeRms(audioFile);
  dlog('VoiceLocal', `Audio RMS: ${rms.toFixed(4)}`);
  if (rms < 0.001) {
    cleanup();
    throw new Error('No audio detected — check microphone permission for iTerm2');
  }

  try {
    let text: string;

    // Try whisper-server first (discover from info file)
    const serverPort = discoverWhisperServer();
    if (serverPort) {
      try {
        text = await transcribeViaServer(audioFile, serverPort);
      } catch (err) {
        dlog('VoiceLocal', `Server transcription failed, falling back to CLI: ${err}`);
        text = await transcribeWithCli(audioFile);
      }
    } else {
      text = await transcribeWithCli(audioFile);
    }

    dlog('VoiceLocal', `Transcription: "${text.slice(0, 80)}"`);
    cleanup();
    return text;
  } catch (err) {
    cleanup();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function cancelLocalRecording(): Promise<void> {
  if (recording) {
    killRecProcess();
  }
  recording = false;
  // Brief delay for rec to flush/exit, then cleanup
  setTimeout(() => cleanup(), 300);
}

export function isLocalRecording(): boolean {
  return recording;
}

// ---- Helpers ----

/** Wait for a file to appear and stabilize (size stops changing). */
async function waitForFile(path: string, maxMs: number): Promise<void> {
  const start = Date.now();
  let lastSize = -1;
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, FILE_POLL_MS));
    if (!existsSync(path)) continue;
    const sz = statSync(path).size;
    if (sz > 0 && sz === lastSize) return; // size stabilized
    lastSize = sz;
  }
}

/** Compute RMS energy of a 16-bit PCM WAV file (skip 44-byte header). */
function computeRms(wavFile: string): number {
  const buf = readFileSync(wavFile);
  const headerSize = 44;
  if (buf.length <= headerSize + 2) return 0;
  const samples = (buf.length - headerSize) / 2;
  let sumSq = 0;
  for (let i = headerSize; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

function discoverWhisperServer(): number | null {
  try {
    const info = JSON.parse(readFileSync(WHISPER_SERVER_INFO_FILE, 'utf-8'));
    if (info?.port && info?.pid) {
      try { process.kill(info.pid, 0); } catch { return null; }
      return info.port;
    }
  } catch { /* no info file */ }
  return null;
}

async function transcribeViaServer(file: string, port: number): Promise<string> {
  const fileData = readFileSync(file);
  const boundary = `----whisper${Date.now()}`;
  const filename = file.split('/').pop() || 'audio.wav';

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileData, footer]);

  const url = `http://127.0.0.1:${port}/inference`;
  dlog('VoiceLocal', `POST ${url} (${fileData.length} bytes)`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`whisper-server returned ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as { text?: string };
  return (json.text ?? '').trim();
}

async function transcribeWithCli(file: string): Promise<string> {
  ensureInit();

  // Resample
  const resampledFile = file.replace('.wav', '_16k.wav');
  try {
    await resample(file, resampledFile);
  } catch {
    dlog('VoiceLocal', 'Resample failed, using original');
  }
  const whisperInput = existsSync(resampledFile) ? resampledFile : file;

  const audioDurationSec = (statSync(whisperInput).size - 44) / 32000;
  const multiplier = hasMetal ? TIMEOUT_MULTIPLIER_METAL : TIMEOUT_MULTIPLIER_ROSETTA;
  const timeoutMs = TIMEOUT_BASE_MS + Math.ceil(audioDurationSec * 1000 * multiplier);

  try {
    let text: string;
    try {
      text = await transcribe(whisperInput, whisperModel, timeoutMs);
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes('timed out');
      const fallback = isTimeout ? findFallbackModel(whisperModel) : null;
      if (fallback) {
        whisperModel = fallback;
        text = await transcribe(whisperInput, fallback, timeoutMs);
      } else {
        throw err;
      }
    }
    if (existsSync(resampledFile)) try { unlinkSync(resampledFile); } catch { /* */ }
    return text;
  } catch (err) {
    if (existsSync(resampledFile)) try { unlinkSync(resampledFile); } catch { /* */ }
    throw err;
  }
}

function resample(inputFile: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sox = spawn(soxBin, [
      inputFile, '-r', '16000', '-c', '1', '-b', '16', outputFile,
      'highpass', '80', 'norm',
    ]);
    let stderr = '';
    sox.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    sox.on('error', (err) => reject(new Error(`sox spawn error: ${err.message}`)));
    sox.on('close', (code) => {
      if (code !== 0) reject(new Error(`sox exited with code ${code}: ${stderr.slice(-200)}`));
      else resolve();
    });
  });
}

function transcribe(file: string, modelPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath, '-l', 'auto', '-f', file,
      '--no-timestamps', '-np',
      '--prompt', 'coding, programming, Claude, terminal, git, function, component, API',
    ];

    const whisper = spawn(whisperBin, args);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        whisper.kill('SIGKILL');
        reject(new Error(`whisper-cli timed out after ${(timeoutMs / 1000).toFixed(0)}s`));
      }
    }, timeoutMs);

    whisper.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    whisper.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    whisper.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to run whisper-cli: ${err.message}`));
      }
    });

    whisper.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(`whisper-cli exited with code ${code}: ${stderr.slice(-300)}`));
        return;
      }

      const text = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) =>
          line.length > 0 &&
          !line.startsWith('[') &&
          line !== '(blank audio)' &&
          !line.startsWith('(') &&
          !/^\[BLANK_AUDIO\]$/i.test(line)
        )
        .join(' ')
        .trim();

      resolve(text);
    });
  });
}

function cleanup(): void {
  if (audioFile && existsSync(audioFile)) {
    try { unlinkSync(audioFile); } catch { /* */ }
  }
  audioFile = '';
}
