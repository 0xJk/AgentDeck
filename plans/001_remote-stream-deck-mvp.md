# 001 — Stream Deck 跨机 MVP（MacBook 控 M4/M1 上的 Claude Code）

> 由 [000_cross-platform-security-cleanup.md](000_cross-platform-security-cleanup.md) 拆出。原 v5 plan 在 codex 三轮 review 后被判定 scope 过大（22 个真实 findings 涉及 5 套实现联动）。本 MVP 只做"用户直接体感到的跨机功能"，不动 server token 广播、不动 Apple/Android、不做 mDNS。安全清理 deferred 到 000。

## Context

**问题**：MacBook 上的 Stream Deck+ 想跨 LAN 操作 M4 / M1 上的 Claude Code 会话。当前 plugin 只能连本机 daemon。

**MVP 目标**：让 MacBook plugin 能**手动配置**一个或多个远端 daemon（host + port + token），然后**应答 yes/no/permission + 发文本 prompt（含语音转文）**。

**MVP 明确不在范围内**：
- mDNS 自动发现（**deferred 到 000**）
- 删除 server 端 token 广播（**deferred 到 000**——安全漏洞独立修）
- Apple / Android 客户端任何改动（**deferred 到 000**）
- Swift in-process daemon 改动（**deferred 到 000**）
- Cursor 扩展面板（永久不在 scope）
- 多台同屏聚合视图

**前提**：用户在 M4 / M1 上自己装 daemon（`pnpm setup` / `npx @agentdeck/setup`），自己用 `cat ~/.agentdeck/auth-token` 拿 token。

---

## 拓扑

```
MacBook（Stream Deck+ 物理连接，纯遥控；不跑 daemon）
   │
   │ WS over LAN (ws://<host>:<port>?token=...)
   │ 用户手填 host:port + token（每台一次性配对）
   ▼
┌──────────────────────┐    ┌──────────────────────┐
│ Mac mini M4          │    │ Mac mini M1          │
│ ─ AgentDeck daemon   │    │ ─ AgentDeck daemon   │
│   (0.0.0.0:9120)     │    │   (0.0.0.0:9120)     │
│ ─ ~/.claude hooks    │    │ ─ ~/.claude hooks    │
│ ─ Claude Code (CLI)  │    │ ─ Claude Code (CLI)  │
└──────────────────────┘    └──────────────────────┘
```

**Daemon 端不变**：已经绑 `0.0.0.0`，已经做 token 鉴权（[bridge/src/ws-server.ts:30-80](../bridge/src/ws-server.ts#L30-L80)）。所有跨机功能在 plugin 端完成。

---

## 改动清单

### 1. Bridge（POC 3 已落地，保留）

POC 3 的 SessionFocusRelay per-client refactor + ws-server 签名 + daemon-server WeakMap 已经在工作区，4/4 新测试 + 1267 既有测试通过。**保留**。

#### 1a. SessionFocusRelay 已经改完（无新工作）
- [bridge/src/session-focus-relay.ts](../bridge/src/session-focus-relay.ts) — per-client focus + 共享 WS pool refcount + async routeCommand
- [bridge/src/ws-server.ts](../bridge/src/ws-server.ts) — `onCommand(cmd, sender: WebSocket)` / `onClientDisconnect(ws: WebSocket)`
- [bridge/src/daemon-server.ts](../bridge/src/daemon-server.ts) — `WeakMap<WebSocket, ClientToken>` + 删 `setTimeout(..., 100)`
- [bridge/src/index.ts:873](../bridge/src/index.ts#L873) — 一行 callback 签名

#### 1b. focus_lost 事件（新工作，小）
**理由**：plugin focus 的 session 死了之后 silent fail 是 POC 3 已知 gap。eng review Issue 1 决策"bridge 主动推 focus_lost"。

实现：
- `SessionFocusRelay` 加 `onFocusLost: (token, sessionId) => void` 回调，在 `_acquireConn` 的 `ws.on('close')` 内遍历 `clientFocus` 找到该 conn 的所有 entry 触发
- daemon-server 注入回调 → 反查 WS connection → `ws.send({type:'focus_lost', sessionId})`
- `shared/src/protocol.ts` 加 `FocusLostEvent` 类型

### 2. Plugin（主要工作）

#### 2a. BridgeClient 接受 host/port/token + 暴露 close-code

**当前**：[bridge-client.ts:163](../plugin/src/bridge-client.ts#L163) 硬编码 `ws://localhost:${port}`，[bridge-client.ts:196](../plugin/src/bridge-client.ts#L196) `ws.on('close', () => ...)` 丢 close code。

**改法**：
- 构造函数签名：`new BridgeClient({ host, port, token })`，URL 拼 `ws://${host}:${port}?token=${encodeURIComponent(token)}`
- 本地 daemon 兼容：host=`localhost` / `127.0.0.1` 时 token 可空（daemon 本地放行）
- `ws.on('close', (code, reason) => this.emit('close', { code, reason: reason.toString() }))`
- **关键**：close code=4001 时**不要 schedule 自动重连**（codex r3 finding 5 race）。让 ConnectionManager 决定下一步

#### 2b. ConnectionManager 重写

**当前**：[connection-manager.ts:180](../plugin/src/connection-manager.ts#L180) 读 `~/.agentdeck/daemon.json` 拿本地 port。

**改法**：
- 从 plugin globalSettings 读 active bridge config
- 状态机：
```
                  ┌────────────┐
                  │    idle    │
                  └─────┬──────┘
                        │ plugin 启动，读 globalSettings
                        ▼
              ┌─────────┴─────────┐
              │ activeBridgeId    │
              │   non-null?       │
              └─┬───────────────┬─┘
       yes      │               │ no
                ▼               ▼
         ┌────────────┐    ┌────────────┐
         │ connecting │    │unconfigured│
         └─────┬──────┘    └────────────┘
               │                │
       open    │ 4001/error     │ PI: user 添加 bridge
               ▼                ▼
         ┌────────────┐    ┌────────────┐
         │ connected  │    │  pairing   │
         └─────┬──────┘    └────────────┘
               │                │
   onClose 4001│                │ user 提交 host/port/token
   stop reconn │                │ keytar.setPassword
   delete tok  │                ▼
               ▼          ┌────────────┐
         pairing          │ connecting │
                          └────────────┘
         keytar fail
               ▼
         ┌────────────┐
         │keychain_err│
         └────────────┘
```
- 关键转换：
  - `connected` ─ `onClose code=4001` → **立即 stop reconnect loop** → keytar.delete → `pairing`（eng review Issue 3，codex r3 finding 5 race fix）
  - `connecting/connected` ─ keytar 异常 → `keychain_error`（eng review Issue 4，不重试不 in-memory）
  - `connected` ─ bridge `focus_lost` event → 清本地 focus，留 connected，UI 提示重选

#### 2c. Token 存储用 `@napi-rs/keyring`

**理由**：codex r3 finding 8 实证 `security -w <stdin>` 命令模式错误。需要 native binding 直接走 macOS Keychain Services C API。

**选 `@napi-rs/keyring`**：跟 keytar 一样直接调 SecKeychainAddGenericPassword，但属于 napi-rs 现代生态（更活跃维护、prebuilt binary 覆盖 darwin-arm64+x64）。**功能上跟 keytar 等价，packaging 风险也等价**——所以 POC 必须验证 native `.node` 能进 `.sdPlugin` bundle 并被 Stream Deck app 的 Node 20.20.0 加载。

- `plugin/package.json` 加 `@napi-rs/keyring` 依赖
- 新增 `plugin/src/token-store.ts`：
  ```typescript
  import { Entry } from '@napi-rs/keyring';
  const SERVICE = 'com.agentdeck.plugin';

  export async function saveToken(bridgeId: string, token: string): Promise<void> {
    new Entry(SERVICE, bridgeId).setPassword(token.trim());
  }
  export async function loadToken(bridgeId: string): Promise<string | null> {
    try { return new Entry(SERVICE, bridgeId).getPassword(); }
    catch (e) { if (isNotFound(e)) return null; throw e; }
  }
  export async function deleteToken(bridgeId: string): Promise<void> {
    try { new Entry(SERVICE, bridgeId).deletePassword(); }
    catch (e) { if (!isNotFound(e)) throw e; }
  }
  ```
- `bridgeId` 用户自定义友好名（"M4", "M1"）；纯用户输入

**Keychain ACL 行为**：napi-rs/keyring 用 SecKeychainAddGenericPassword，ACL owner 是 plugin 进程二进制 identity——plugin 自己写自己读不弹 GUI；bundle 路径变化下次读弹一次 "Always Allow"。

**POC A 结果 ✅ SHIP-BLOCKER CLEARED**（已在工作区落地验证）：

确认的 packaging 方案（3 步全 PASS，隔离 bundle smoke test 通过）：

1. **`plugin/package.json`** dependencies 加 `"@napi-rs/keyring": "^1.3.0"`；**devDependencies 必须同时显式声明**：
   ```json
   "@napi-rs/keyring-darwin-arm64": "1.3.0",
   "@napi-rs/keyring-darwin-x64":   "1.3.0"
   ```
   **⚠️ 不能依赖 optionalDependencies 隐式装**——pnpm 只装 host 平台 optional；CI 在 arm64 runner build 出 arm64-only bundle 会让 Intel Mac 用户直接挂

2. **`plugin/rollup.config.mjs`** external predicate：
   ```js
   const keyringExternal = (id) =>
     id === '@napi-rs/keyring' || id.startsWith('@napi-rs/keyring-');
   ```
   每个 import 了 keyring 的 plugin entry 把它加进 `external`

3. **`plugin/scripts/build.mjs`** rollup 后 copy（**`dereference: true`** 让 pnpm symlink 变实文件）：
   ```js
   fs.rmSync('bin/node_modules/@napi-rs', { recursive: true, force: true });
   for (const p of ['keyring', 'keyring-darwin-arm64', 'keyring-darwin-x64']) {
     fs.cpSync(`node_modules/@napi-rs/${p}`, `bin/node_modules/@napi-rs/${p}`,
               { recursive: true, dereference: true });
   }
   ```

4. **`scripts/package-plugin.sh` 不用动**——现有 `$PLUGIN_ID.sdPlugin/node_modules/*` zip 排除规则路径前缀绑死 top-level，不踩 `bin/node_modules`

**Bundle 体积**：+~1MB（arm64 491KB + x64 516KB）

**剩余未验证**：真 Stream Deck.app spawn 上下文里跑（@elgato/cli 没装）。**架构风险已闭**，POC B Phase 2 ship 前补这一步

#### 2d. globalSettings 模型
```typescript
type PluginGlobalSettings = {
  pairedBridges: Array<{
    id: string;           // 用户输入的友好名（不重复，作为主键）
    host: string;         // IP 或 hostname
    port: number;
  }>;
  activeBridgeId: string | null;
};
```
**Token 只在 keychain，不在 globalSettings**。

#### 2e. Property Inspector — bridge-connection action

manifest 加 action `bound.serendipity.agentdeck.bridge-connection`：

PI 内容：
- 已配对 bridge 列表（id / host:port / 连接状态）
- "+" 按钮加 bridge：表单 `{id: text, host: text, port: number (default 9120), token: password}` → submit → keytar.setPassword(id, token) + globalSettings 追加
- 选中已配对 bridge → "Set as active" 按钮 → 切 activeBridgeId 触发重连
- 删除 bridge → keytar.deletePassword(id) + globalSettings 移除
- 当前连接状态 / 错误显示（包括 `pairing` / `keychain_error`）

数据流：PI ↔ plugin 用 Stream Deck SDK `setGlobalSettings` / `onDidReceiveGlobalSettings`。

#### 2f. 适配 remote-only first-run UX（**全扫**，codex 001 review #3）

**问题**：当前 plugin 多处文案 / 行为假定"用户在本机装了 daemon"，remote-only MacBook 拓扑下全错。Codex 实证除了 detectSetupState 和 session-slot OFFLINE，还有：

- [utility-renderer.ts:39](../plugin/src/renderers/utility-renderer.ts#L39) `SETUP Required`
- [response-renderer.ts:120](../plugin/src/renderers/response-renderer.ts#L120) `INSTALL / Push START`

**改法**：
- `plugin/src/plugin.ts:86` `detectSetupState`：**"globalSettings.pairedBridges 非空"** = setup 完成；空 = `setupRequired = true`
- 全 grep 一遍 `plugin/src/`：`setup|SETUP|install|INSTALL|Open AgentDeck` 所有命中点改成 remote-friendly 文案：
  - `OFFLINE / Open AgentDeck` → `OFFLINE / Open PI to pair`
  - `SETUP Required / Open AgentDeck` → `SETUP Required / Open PI`
  - `INSTALL / Push START` → `NO BRIDGE / Open PI`
  - 其他实例同样原则：引导用户去 PI，不再说"装 / 启动"

#### 2g. Voice 路径远端路由（codex 001 review #2）

**问题**：[voice-dial.ts:274](../plugin/src/actions/voice-dial.ts#L274), [voice-dial.ts:397](../plugin/src/actions/voice-dial.ts#L397) 现在：
1. 本机 iTerm2 + rec + whisper 录音/转写（保留）
2. 转写完成后，**只在 session State.IDLE 时走 WS**；否则贴本机前台 app（AppleScript paste）

后果：MacBook 上 voice 转写完，如果 M4 上 CC 正在 PROCESSING，文本会被贴到 **MacBook 的前台 app** 而不是 M4 CC。"voice → 远端 CC" 不成立。

**改法**：
- voice-dial.ts 转写后路由前加判断：**当前 activeBridge.host 不是 `localhost`/`127.0.0.1` → 总是走 WS `send_prompt`**，不管 session state，**不调** AppleScript paste
- 本机 daemon（host=localhost）路径保留原行为，兼容老用法
- 加 1 个 test：mock activeBridge.host="192.168.1.5" + State.PROCESSING → 验证调 `send_prompt`，不调 osascript

#### 2h. Timeline per-bridge namespace（codex 001 review #4）

**问题**：[timeline-store.ts:8](../plugin/src/timeline-store.ts#L8) 单一 `~/.agentdeck/timeline.json`。切换 M4↔M1 会看到上一台 daemon 的残留历史。

**改法**：
- timeline-store.ts 构造时接收 `bridgeId`，文件路径变 `~/.agentdeck/timeline-<bridgeId>.json`
- 切换 active bridge 时 plugin.ts 创建新 `TimelineStore(newBridgeId)` 实例（旧的 GC）
- 迁移：plugin 启动时如果有老 `timeline.json` + 至少一个 paired bridge，把它 rename 成 `timeline-<firstPairedBridgeId>.json`（一次性）

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 发现机制 | **手填**（PI 表单） | MVP，不引入 bonjour-service 复杂度 |
| Token 存储 | **`@napi-rs/keyring` npm 包** | 不调 `security` CLI（codex r3 #8 证明命令错），不引入 token-in-argv 漏洞；现代 napi-rs 生态 |
| Native 模块打包 | **POC A 必须通过**（rollup + .sdPlugin bundle） | codex 001 #1：rollup 默认不复制 native `.node` |
| Voice 路由 | **远端 bridge 总走 WS**，不调 AppleScript paste | codex 001 #2：原行为在远端拓扑下贴到 MacBook 前台 app |
| Setup/install UX 文案 | **全 grep 一遍改成 PI-centric** | codex 001 #3：散落多处 |
| Timeline 持久化 | **per-bridge namespace** (`timeline-<bridgeId>.json`) | codex 001 #4：跨 daemon 切换避免脏历史 |
| Bridge ID | 用户友好名（如 "M4", "M1"） | 不依赖 mDNS / machineId，纯本地标识 |
| 多 daemon 同时连 | 一次一台 | 用户明确 |
| Server token 广播 | **不动** | deferred 到 plan 000 |
| Apple / Android | **不动** | deferred 到 plan 000 |
| Swift in-process daemon | **不动** | deferred 到 plan 000 |
| 4001 reconnect race | **stop reconnect loop on 4001 before pairing 切换**（codex r3 #5） | 防 race |
| BridgeClient close-code | emit `{code, reason}` 给 ConnectionManager | 必须能区分 4001 |
| MacBook 是否跑 daemon | 不跑 | 用户明确 |
| Cursor 扩展面板 | 不做 | 永久不在 scope |

---

## 验证

### Step 0 — Pre-flight POCs

#### POC A：`@napi-rs/keyring` packaging ✅ CLEARED
（详见 Section 2c 文字版方案，已在工作区验证）

#### POC B：streamdeck link 后 plugin 实际能从 Stream Deck.app 内 spawn 起来
**Phase 2 ship 前必跑**。~5 min。`npm i -g @elgato/cli` → `streamdeck link` → 打开 Stream Deck app 拖 bridge-connection action → 看 `~/Library/Logs/ElgatoStreamDeck/` log plugin 起来 + `new Entry(...).setPassword(...)` 成功。POC A 的隔离 bundle 测验证 Node 自身能加载 keyring；POC B 闭合 Stream Deck app spawn 上下文这条最后路径。

### 端到端清单
1. **M4 上**：
   ```bash
   pnpm setup                   # 或 npx @agentdeck/setup
   cat ~/.agentdeck/auth-token  # 复制 token
   # Cursor 集成终端跑：claude
   ```
2. **M1 上**：同上（不同 token）
3. **MacBook 上**：
   - `cd AgentDeck/plugin && pnpm install && pnpm build && streamdeck link`
   - 打开 Stream Deck app，拖 `bridge-connection` 到 key
   - PI 弹出 → 点 "+" → `{id: "M4", host: "192.168.1.5", port: 9120, token: "...token..."}` → save
   - Set active → 看 PI 状态变 connected
4. **应答测试**：M4 上 `claude` 触发 permission → Stream Deck 按 Y → M4 CC 收 allow
5. **prompt 测试**：Stream Deck voice → 说话 → 转文 → M4 CC 收到回应
6. **切机**：PI 加 "M1" → set active → 重连 → 5/6 重复
7. **token rotation**：M4 上 `rm ~/.agentdeck/auth-token && pnpm setup` → 新 token → MacBook plugin 自动断开 → PI 自动回 pairing（**Issue 3 + r3 #5 修复验证**）
8. **focus_lost**：M4 上 ctrl+C CC 退出，重新 `claude` → MacBook plugin 收到 focus_lost → UI 提示重选

---

## 测试需求清单

### Bridge（POC 3 已有 + 1 个新）
| # | 测试 | 文件 |
|---|---|---|
| 1 | `session-focus-relay` 双 client 共享 session 一方 disconnect refcount 正确（POC 3 已有） | `bridge/src/__tests__/session-focus-relay-multi-client.test.ts` |
| 2 | `session-focus-relay` session WS close → `onFocusLost` 对相关 client 触发 | `bridge/src/__tests__/session-focus-relay-focus-lost.test.ts` |
| 3 | `daemon-server` 收 conn close → 向 affected plugin WS send `focus_lost` 事件 | `bridge/src/__tests__/daemon-server-focus-lost-emit.test.ts` |
| 4 | `shared/src/protocol.ts` 新增 `FocusLostEvent` schema | `shared/src/__tests__/protocol.test.ts` |

### Plugin
| # | 测试 | 文件 |
|---|---|---|
| 5 | `bridge-client.ts` 接 host/port/token 构造 URL 正确（encodeURIComponent token） | `plugin/src/__tests__/bridge-client-url.test.ts` |
| 6 | `bridge-client.ts` close event 携带 `{code, reason}` | 同上 |
| 7 | `bridge-client.ts` close code 4001 时**不**自动重连（无 setTimeout schedule） | 同上 |
| 8 | `token-store.ts` save/load/delete（mock `@napi-rs/keyring`） | `plugin/src/__tests__/token-store.test.ts` |
| 9 | `token-store.ts` save 前 trim 输入 | 同上 |
| 10 | `token-store.ts` keyring throw not-found → load 返回 null；其他错误上抛 | 同上 |
| 11 | `connection-manager.ts` 状态机：connected → onClose 4001 → keyring.delete → pairing | `plugin/src/__tests__/connection-manager-state.test.ts` |
| 12 | `connection-manager.ts` keyring throw → keychain_error，不重试 | 同上 |
| 13 | `connection-manager.ts` focus_lost event → 清 UI focus，留 connected | 同上 |
| 14 | `plugin.ts` `detectSetupState` 用 pairedBridges.length 判定，不读本地 `~/.agentdeck` | `plugin/src/__tests__/detect-setup-state.test.ts` |
| 15 | UX 文案 grep 不再返回 `Open AgentDeck` / `INSTALL` / "SETUP Required / Open" 老文案 | `plugin/src/__tests__/ux-strings.test.ts` |
| 16 | `voice-dial.ts` activeBridge.host="remote-ip" + State.PROCESSING → 调 `send_prompt` WS，不调 osascript | `plugin/src/__tests__/voice-dial-remote-routing.test.ts` |
| 17 | `voice-dial.ts` activeBridge.host="localhost" 时保留原 paste 行为 | 同上 |
| 18 | `timeline-store.ts` 构造接收 bridgeId，文件路径正确（`timeline-<id>.json`） | `plugin/src/__tests__/timeline-store-namespace.test.ts` |
| 19 | `timeline-store.ts` 老 `timeline.json` 一次性迁移到 `timeline-<firstBridgeId>.json` | 同上 |
| 20 | 切换 active bridge → 旧 timeline store 替换为新 store（不混历史） | `plugin/src/__tests__/bridge-switch-timeline.test.ts` |

---

## 已知前置依赖

- Plugin 主机必须能装 `keytar`（macOS Apple Silicon / Intel 都有 prebuilt binary）
- Stream Deck Mac app 维持非沙箱化（POC 1 隐含；若改沙箱要加 entitlements）
- Plugin bundle 安装路径稳定（重装/迁路径下次读 token 触发一次 "Always Allow"）
- 用户能在 daemon 机器上跑 `cat ~/.agentdeck/auth-token`（不引入 `agentdeck token show` CLI，省了 bridge 改动）
- 同 LAN 网络可达（无 mDNS 要求，只要 IP 可达）

---

## Worktree 并行策略

只有两 lane：
- **Lane A**: `shared/src/protocol.ts` FocusLostEvent type + `bridge/src/session-focus-relay.ts` onFocusLost + `bridge/src/daemon-server.ts` focus_lost emit + 3 tests
- **Lane B**: `plugin/*` 改动（bridge-client、token-store、connection-manager state machine、PI manifest + form、plugin.ts detectSetupState）+ 10 tests

A 必须先 merge（shared protocol 类型）→ B 开始。

---

## 后续 todo（不在 001）

- **落地实测发现的 follow-ups → [plan 002](002_remote-mvp-followups.md)**：PTY 多行选项解析、OpenClaw gateway 路由优先级、daemon LaunchAgent 自启、mDNS 冲突崩溃、非-WS dispatch 泄漏
- mDNS auto-discovery（plan 000）
- 删除 server token 广播 + Apple/Android URL 拆分 + Apple fetchHealthInfo localToken 修复 + Swift in-process daemon parity（全部 plan 000）
- Cursor / VS Code 扩展适配器（永不在 001 scope）
- SessionFocusRelay reconnect on session bridge death（POC 3 已知 gap）

## 实施结果（已 merge）

001 已实现并 merge 到 master（`b9a5dd1`），实机端到端验证通过：MacBook Stream Deck 跨 LAN 配对 M4 daemon（token 认证）→ focus M4 的 managed claude 会话 → 真实状态 + 选项稳定上 encoder。落地中另修 2 个既有 bug（daemon focus 时序闪烁 `6792412`、PI 通信 `b9a5dd1`）。卡在最末端的 PTY 多行选项解析等 5 项既有问题 → [plan 002](002_remote-mvp-followups.md)。

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | 拆出 001 后需重新跑一轮 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open（decisions inherit 从 000 v5） | 4 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Scope 收敛**：v5 是 5 套实现联动重构（22 个 codex findings）。001 退回到 "plugin 单边 + 1 个 bridge 小补丁" 形态。

**继承自 000 v5 的 eng review 决策**：
1. focus_lost 事件推送（保留）
2. pre-flight gate（保留，转为 POC A + B）
3. 4001 → pairing 自动恢复（保留，加 codex r3 #5 race fix：stop reconnect loop）
4. keychain_error 状态（保留，但底层换 keytar npm 不是 security CLI）

**VERDICT**: 001 待 codex 跑一轮验证 MVP 的 scope 收敛是否真有效。
