# Parser test fixtures

Real raw PTY captures from Claude Code, used for output-parser regression tests.

- `claude-v2.1.159-trust-prompt.chunks.jsonl` — the raw PTY chunk sequence Claude
  Code v2.1.159 emits for the "Do you trust the files in this folder?" startup
  prompt. One JSON object per line: `{ "ts": <epoch-ms>, "b64": <base64 of the raw
  chunk> }`. Captured 2026-06-01 on a real macOS terminal (xterm-256color, 120 cols)
  via a node-pty harness. Replay each chunk through `OutputParser.feed()` in order,
  advancing timers by the real inter-chunk `ts` deltas so the debounce fires exactly
  as it did live. Demonstrates Claude v2.x layout: each word is positioned with CHA
  (`ESC [ <col> G`) cursor-column jumps rather than literal spaces, and option rows
  are separated by `\r\r\n`.
