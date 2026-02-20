import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { debug } from './logger.js';

export class PtyManager extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;

  spawn(command = 'claude', extraEnv?: Record<string, string>): void {
    if (this.ptyProcess) {
      throw new Error('PTY process already running');
    }

    const shell = process.env.SHELL || '/bin/zsh';
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;

    debug('PTY', `spawn: shell=${shell} cmd="${command}" cols=${cols} rows=${rows} cwd=${process.cwd()}`);

    const env = { ...(process.env as Record<string, string>), ...extraEnv };

    this.ptyProcess = pty.spawn(shell, ['-l', '-c', command], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env,
      handleFlowControl: true,
    });

    debug('PTY', `spawned pid=${this.ptyProcess.pid}`);

    this.ptyProcess.onData((data: string) => {
      this.emit('data', data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      debug('PTY', `exit: code=${exitCode} signal=${signal}`);
      this.ptyProcess = null;
      this.emit('exit', exitCode, signal);
    });
  }

  write(data: string): void {
    if (!this.ptyProcess) {
      debug('PTY', 'write() called but PTY not running — dropped');
      return;
    }
    // Log commands (not individual keystrokes) — heuristic: multi-char or contains newline
    if (data.length > 1 || data === '\n' || data === '\x03' || data === '\x1b[Z') {
      const preview = data.replace(/\n/g, '\\n').replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      debug('PTY', `write(${data.length}): "${preview.slice(0, 80)}"`);
    }
    this.ptyProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      debug('PTY', `resize: ${cols}x${rows}`);
      this.ptyProcess.resize(cols, rows);
    }
  }

  attachTerminal(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void {
    debug('PTY', 'attachTerminal');

    // Proxy PTY output to user's stdout
    this.on('data', (data: string) => {
      stdout.write(data);
    });

    // Proxy user's stdin to PTY
    stdin.on('data', (data: Buffer) => {
      if (this.ptyProcess) {
        this.ptyProcess.write(data.toString());
      }
    });

    // Handle terminal resize
    if (process.stdout.isTTY) {
      process.stdout.on('resize', () => {
        this.resize(
          process.stdout.columns || 120,
          process.stdout.rows || 40,
        );
      });
    }
  }

  interrupt(): void {
    if (this.ptyProcess) {
      debug('PTY', 'interrupt (Ctrl+C)');
      this.ptyProcess.write('\x03');
    }
  }

  kill(): void {
    if (this.ptyProcess) {
      debug('PTY', `kill pid=${this.ptyProcess.pid}`);
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
  }

  isAlive(): boolean {
    return this.ptyProcess !== null;
  }

  getPid(): number | null {
    return this.ptyProcess?.pid ?? null;
  }
}
