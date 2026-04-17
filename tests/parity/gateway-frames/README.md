# Gateway parity fixtures

Canonical JSON frames for the OpenClaw Gateway protocol. Both the Node adapter (`bridge/src/adapters/openclaw.ts`) and the Swift adapter (`apple/AgentDeck/Daemon/Gateway/OpenClawAdapter.swift`) must accept these same frames and produce equivalent observable behavior.

Each fixture conforms to the `GatewayFrame` union declared in [`shared/src/gateway-protocol.ts`](../../../shared/src/gateway-protocol.ts). Regenerate the JSON schema with `pnpm generate-protocol`; the Vitest test `bridge/src/__tests__/gateway-parity-fixtures.test.ts` validates every fixture loads and carries the expected discriminator shape.

## Coverage

| Fixture                          | Frame            | Scenario |
|----------------------------------|------------------|----------|
| `connect-challenge.json`         | event            | handshake start — Gateway sends nonce |
| `connect-ok.json`                | res              | handshake reply accepting the signed device auth |
| `chat-delta.json`                | event (chat)     | streaming delta with partial text |
| `chat-final-with-tools.json`     | event (chat)     | terminal turn with tool invocation summary and token counts |
| `exec-approval-requested.json`   | event            | bash approval prompt with allow/deny options |
| `rpc-error.json`                 | res              | error response (NOT_PAIRED code) |
| `tick.json`                      | event            | server heartbeat |

## Adding a fixture

1. Drop the JSON file in this directory.
2. Ensure it validates against `shared/src/gateway-protocol.ts` (run `pnpm test gateway-parity`).
3. Update the table above.
4. When adding Swift parity coverage (Phase 4-B follow-up), add a sibling `XCTest` case under `apple/AgentDeckTests/GatewayParityTests.swift` that decodes the same file and asserts the observable shape.
