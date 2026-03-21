# Testing Guide

AgentDeck uses [Vitest](https://vitest.dev/) for unit tests with v8 coverage reporting.

## Quick Start

```bash
pnpm test                        # Run all tests
pnpm test -- --watch             # Watch mode
pnpm vitest run --coverage       # Run with coverage report
```

## Test Structure

Tests live alongside source code in `__tests__/` directories:

```
shared/src/__tests__/timeline.test.ts      # Timeline parsing, dedup, text cleaning
bridge/src/__tests__/state-machine.test.ts  # State transitions, timeouts, billing
bridge/src/__tests__/output-parser.test.ts  # ANSI parsing, event extraction
bridge/src/__tests__/adapter.test.ts        # Adapter factory, protocol, capabilities
bridge/src/__tests__/cursor-sync.test.ts    # PTY cursor tracking, authority
bridge/src/__tests__/session-registry.test.ts # Session management, port allocation
plugin/src/__tests__/gateway-client.test.ts  # OpenClaw Gateway protocol, Ed25519 auth
plugin/src/__tests__/connection-manager.test.ts # Bridge/Gateway priority, event forwarding
plugin/src/__tests__/text-utils-and-labels.test.ts # CJK text width, button labels
plugin/src/__tests__/option-scenario.test.ts # Option layout, encoder takeover
hooks/src/__tests__/install.test.ts          # Hook format migration, idempotency
```

## Coverage

Coverage is configured with v8 provider in `vitest.config.ts`. To generate a report:

```bash
pnpm vitest run --coverage
```

This outputs both a terminal summary and an `lcov` report for CI integration.

### Current Coverage by Package

| Package | Statements | Lines | Status |
|---------|-----------|-------|--------|
| **shared/src** | ~51% | ~55% | Core timeline logic well-covered |
| **plugin/src** | ~22% | ~23% | Connection/text utils covered |
| **bridge/src** | ~14% | ~16% | Core logic covered, infra gaps |
| **hooks/src** | indirect | indirect | Tested via vitest mock |

### Well-Tested Areas

- **State Machine** — transitions, timeouts, permission/option/diff flows, billing detection
- **Output Parser** — ANSI parsing, mode detection, spinner events, cursor sync
- **Adapter Hierarchy** — factory pattern, ClaudeCode/OpenClaw capabilities, Gateway protocol
- **Timeline** — `parseLogLine()`, `cleanDetailText()`, semantic dedup, keyword similarity
- **Connection Manager** — Bridge/Gateway priority, failover, event forwarding
- **Hook Installation** — v2.1+ matcher-group format, migration, idempotency

### Known Gaps

These areas rely on manual testing or are covered by type checking only:

| Area | Files | Reason |
|------|-------|--------|
| **Plugin actions** | 9 action handlers | Heavy SD SDK dependency |
| **SVG renderers** | 10 renderer files | Visual output — snapshot testing TBD |
| **TUI dashboard** | 6 files | Terminal rendering — visual inspection |
| **Device modules** | adb, serial, mdns, pixoo | Hardware-dependent |
| **Voice system** | voice, whisper, TTS | Audio hardware + external process |
| **Daemon server** | daemon-server.ts | Requires full process lifecycle |
| **Android/Apple** | Kotlin/Swift apps | Separate test frameworks needed |

## CI Pipeline

GitHub Actions runs on every push and PR to `master`:

```yaml
# .github/workflows/ci.yml
- pnpm install --frozen-lockfile
- pnpm build
- pnpm typecheck
- pnpm test
```

Release workflows (Android, Apple, ESP32) are tag-triggered and do not run tests.

## Writing Tests

### Conventions

- Place tests in `{package}/src/__tests__/{module}.test.ts`
- Use `vi.mock()` for external dependencies (node-pty, ws, fs, child_process)
- Use `vi.useFakeTimers()` for timeout/interval testing
- Import from source with `.js` extension (ESM)

### Mocking Patterns

```typescript
// Module mock
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// Function spy
const handler = vi.fn();
emitter.on('event', handler);
expect(handler).toHaveBeenCalledWith(expected);

// Fake timers
vi.useFakeTimers();
vi.advanceTimersByTime(5000);
vi.useRealTimers();
```

### Priority for New Tests

When adding tests, prioritize by impact:

1. **Shared types/utils** — contract between packages, highest ROI
2. **State machine transitions** — core correctness
3. **Parser logic** — data transformation accuracy
4. **Protocol handling** — client-server contract
5. **Renderers** — snapshot tests if visual regressions matter

## Future Plans

### Short-term

- Coverage thresholds (prevent regression)
- `shared/src/protocol.ts` type guard tests
- Bridge timeline-store dedup pipeline tests

### Medium-term

- WebSocket integration tests (real server startup)
- Hook roundtrip tests (HTTP → state machine → WS broadcast)
- Android JUnit5 for Protocol.kt and TimelineStore.kt

### Long-term (E2E)

- Playwright for any web-based tooling
- Device serial protocol integration tests
- Cross-surface state synchronization tests
