# 000 — 全平台安全持久化清理（DEFERRED）

> **状态**：DEFERRED。原本是 "MacBook 用 Stream Deck 跨机控 CC" v5，codex 三轮揭示是 5 处实现联动的全平台重构，不是原始需求该承担的工程量。
>
> **当前 MVP**：见 [001_remote-stream-deck-mvp.md](001_remote-stream-deck-mvp.md)
>
> **本计划留作未来重启时参考材料**——已经过 3 轮 codex review、5 POC、interactive eng review，scope 是 "Node bridge + Swift in-process daemon + Apple client + Android client + Stream Deck plugin 五处持久化和 token 流程同步重构"。

> 修订史：
> - v1：codex consult FAIL（7 findings 全修）
> - v2/v3：5 POC 跑完（POC 5 误报"Apple HANG"，后被 codex 二轮纠正）
> - v4：eng review interactive 加 4 决策（focus_lost / pre-flight / 4001 recovery / keychain_error）+ 17 test items
> - v5：codex 二轮 FAIL — 揭示 v4 的 7 个下层假设错误，本版重写覆盖所有客户端持久化层
> - **v5 deferred**：codex 三轮 FAIL（8 finding 含 Swift daemon 也广播 token / lastBridgeUrl 迁移欠规范 / 4001 reconnect race / security CLI 命令错误 / localhost 不需 token / tap-to-connect UX 退化 / mDNS port fallback / transport refactor framing）。Scope 远超原始需求。拆 MVP 到 001。

## DEFERRED — 重启时必读

本期 review 揭示的 22 个真实问题（codex 三轮 7+7+8）大部分**不是 MVP 该解决的**。重启时按 MVP 完成、用户反馈、安全边界优先级综合判断：

- **Swift in-process daemon 同步更新**（`apple/AgentDeck/Daemon/Server/DaemonServer.swift:634, 1086` 都还在广播 token）
- **Apple/Android lastBridgeUrl 拆 identity + token** + 迁移路径（offline 怎么从老 URL 反推 machineId）
- **Apple `fetchHealthInfo` localToken 兜底安全漏洞**（`BridgeDiscovery.swift:258, 284`）
- **Apple/Android discovery 对象 token 字段剥离 + tap-to-connect UX 重设计**
- **Apple 本地 127.0.0.1 不需 token 的特殊路径**
- **mDNS 服务名格式变更 vs Apple 的 name-port port fallback**

---

## 以下为 v5 完整计划（参考材料）

---

## Context

**问题**：MacBook 上 Stream Deck+ 想跨 LAN 控制 M4 / M1 上的 Claude Code / Codex / OpenCode 会话。当前 plugin 是 localhost-only。

**目标**：MacBook plugin 远程**应答 yes/no/permission** + **发文本 prompt（含语音转文）**到 M4/M1 上 CC 会话。一次连一台。

**为什么 scope 比想象大**：codex 二轮揭示——当前 Apple/Android 客户端把**完整 WS URL（含 token）**存到 prefs 里，并且 macOS Apple 端有个**对任何 LAN host 都用本机 auth-token 兜底**的 fetchHealthInfo 路径。**把 plugin token 放 Keychain 是装样子**，除非顺手把这两个 issue 也修了。所以本期不是单做 plugin，而是**三客户端持久化层一并清理**。

**明确不在范围内**：
- Cursor 的 CC 扩展面板（webview，无 PTY 无 hook）
- MacBook 本机 daemon / 中继转发（纯遥控）
- 多台同屏聚合视图（一次一台 daemon）

---

## 拓扑

```
MacBook（Stream Deck+ 物理连接，纯遥控；不跑 daemon）
   │
   │ WS over LAN (ws://<host>:<port>?token=...)
   │ mDNS 发现 _agentdeck._tcp.（仅广播身份，不广播 token）
   ▼
┌──────────────────────┐    ┌──────────────────────┐
│ Mac mini M4          │    │ Mac mini M1          │
│ ─ AgentDeck daemon   │    │ ─ AgentDeck daemon   │
│   (0.0.0.0:9120)     │    │   (0.0.0.0:9120)     │
│ ─ ~/.claude hooks    │    │ ─ ~/.claude hooks    │
│ ─ Claude Code (CLI)  │    │ ─ Claude Code (CLI)  │
│   在 Cursor 集成终端 │    │ ─ codex / opencode   │
│   或 iTerm2 里跑     │    │                      │
└──────────────────────┘    └──────────────────────┘
```

---

## 安全模型（本期核心改动）

| 项目 | 当前（漏洞） | 改完 |
|---|---|---|
| Token 广播 mDNS TXT | `mdns.ts:89` `txt.token=token` | **删** |
| Token 广播 /health | `daemon-server.ts:376` `pairingToken` | **删** |
| Apple 健康检查 token 兜底 | `BridgeDiscovery.swift:258,284` 用本机 `auth-token` 给任何 host 兜底 | **删** local token fallback |
| Apple lastBridgeUrl 持久化 | `AgentStateHolder.swift:37,885` 存**含 token 的完整 URL** | **拆**：身份 → UserDefaults，token → Keychain |
| Android pairing URL 持久化 | `DisplayPreferences.kt:52`、`MainActivity.kt:181,240` 存**含 token 的完整 URL** | **拆**：身份 → SharedPreferences，token → EncryptedSharedPreferences |
| Plugin token | 不存在 | macOS Keychain（`security` CLI via stdin） |
| Discovery 对象字段 | Apple/Android `{name, host, port, token}` | `{machineId, host, port, agent, project}`（**token 字段去掉**） |
| Daemon 鉴权 | 本地放行、远端要 token | 不变 |

**前提理由**：当前任何 LAN 设备能从 mDNS / `/health` 嗅到 token，**并且** Apple 客户端会主动把本机 auth-token 灌进任何 host 的连接。这两条不修，所谓"Keychain 安全存储"是装样子。

---

## 改动清单（按模块）

### 1. Bridge

#### 1a. 删 token 广播
- **[bridge/src/mdns.ts:89](../bridge/src/mdns.ts#L89)**：删 `if (token) txt.token = token;` 整行
- **[bridge/src/daemon-server.ts:376](../bridge/src/daemon-server.ts#L376)**：`/health` 响应 JSON 字段 `pairingToken` 删除
- 同步检查并改 `bridge/src/__tests__/` 里检查这两个字段的测试

#### 1b. mDNS 服务身份（保留现有 TXT 字段名 + 新增 machineId/hostname）
- **保留** `project`、`agent`、`v`、`port`、`ip`（避免破坏现有客户端解析）
- **新增** TXT：`machineId`（持久化 UUID）、`hostname`（`os.hostname()` 去 `.local`）
- 服务实例名 `${projectName}-${port}` → `${machineId}`
- `v` TXT **不 bump**（codex 实证客户端不分支 v）

#### 1c. machineId 持久化（**遵守 data-dir contract**）
codex finding 3：[session-registry.ts:32](../bridge/src/session-registry.ts#L32) 明文要求 "Writes stay in the process's own dir via `getDataDir()`. Only reads iterate this list."

实现：
- 新增 `bridge/src/machine-id.ts`：**只写到 `getDataDir()`**（即 process 自己的 dir），**不**用 first-writable-candidate 策略
- 读时用 `getCandidateDataDirs()` 按现有优先级迭代（CLI > App Store > legacy），但读到任何一个就返回
- 不存在则在 `getDataDir()` 生成 UUIDv4 落盘
- Swift 端新增 `apple/AgentDeck/App/MachineId.swift`：通过 `AgentDeckPaths.shared.machineIdFile` 读写，遵守同样语义（只写自己进程的 dir）
- **Node daemon 和 Swift daemon 同 mac 并存**：各写各的 machineId，会产生两条 mDNS 记录。这是接受的 known limitation，文档提醒"don't run both"

#### 1d. SessionFocusRelay per-client focus + focus_lost 推送

**改造**（POC 3 已落到工作区，多 4/4 测试通过）：
- `clientFocus: Map<ClientToken, FocusEntry>` 替换全局 focus
- 共享 WS pool `Map<sessionId, SessionConn>` refcount
- `async routeCommand(token, cmd, sessionId?)` `await openPromise` 后 send
- 删 `daemon-server.ts:1184` 的 100ms `setTimeout` race
- `ws-server.ts` `onCommand(cmd, sender: WebSocket)` / `onClientDisconnect(ws)`
- `daemon-server.ts` `WeakMap<WebSocket, ClientToken>` + onClientDisconnect 时 unfocus
- `index.ts:873` 一行同步改签名

**新增 focus_lost 事件**（eng review Issue 1）：
- `SessionFocusRelay` 增加 `onFocusLost: (token: ClientToken, sessionId: string) => void` 回调，在 `_acquireConn` 内 `ws.on('close')` 时遍历 `clientFocus` 找到该 conn 的所有 entry 触发
- daemon-server 注入回调 → 反查 WS connection → send `{type: 'focus_lost', sessionId}` 给该 plugin
- 协议层（`shared/src/protocol.ts`）增加 `FocusLostEvent` 类型

**已知不修**：state_update 仍全局广播；D200H pipe 路径 ephemeral Symbol

#### 1e. CLI `agentdeck token show`
- `bridge/src/cli.ts` 新增 subcommand：读 `~/.agentdeck/auth-token` 打印；不存在 → 友好错误 + exit 1

### 2. Plugin

#### 2a. 依赖
- `plugin/package.json` 加 `bonjour-service`（version 对齐 bridge/package.json）

#### 2b. BridgeClient close-code 事件传递（**codex finding 7 新增**）

**问题**：[bridge-client.ts:196](../plugin/src/bridge-client.ts#L196) 现在 `ws.on('close', () => ...)` 把 close code 丢掉。Issue 3 的 "4001 → 清 Keychain" 没法落地。

**改法**：
- BridgeClient emit `'close'` event 带 `{code, reason}`
- ConnectionManager 订阅 → 状态机入口判断

#### 2c. ConnectionManager 状态机（完整版）

```
                  ┌────────────┐
                  │    idle    │
                  └─────┬──────┘
                        │ plugin 启动
                        ▼
                  ┌────────────┐ mDNS up event ┌────────────┐
                  │ discovering├──────────────►│  selecting │ ←─ PI 列表
                  └─────┬──────┘                └─────┬──────┘
                        │ mDNS 不通                    │ user 选 daemon
                        ▼                              ▼
                  ┌────────────┐                ┌────────────┐
                  │ mdns_error │                │  pairing   │ ←─ PI 弹 token 输入
                  └────────────┘                └─────┬──────┘
                                                      │ Keychain.write(machineId, token.trim())
                                                      │ globalSettings 存 {machineId, host, port, hostname}
                                                      ▼
                  ┌────────────┐                ┌────────────┐
                  │keychain_err│◄──.write fail──┤ connecting │
                  └────────────┘                └─────┬──────┘
                                                      │ WS open + handshake
                                                      ▼
                                                ┌────────────┐
                  ┌────────────┐                │ connected  │
                  │  paired_   │   onClose      │            │
                  │  re_pair   │◄──code=4001────┤            │
                  └─────┬──────┘                │            │
                        │ Keychain.delete       │            │
                        ▼                       │            │
                  pairing                       │            │
                                                │            │
                  focus_lost event ─────────────┤            │
                  → 清 UI focus，留 connected   └────────────┘
```

转换规则：
- `connected` ─ `onClose code=4001` → `paired_re_pair`（**新中间态**：清 Keychain 后立即跳 `pairing`）
- `connected/connecting` ─ Keychain throw → `keychain_error`（不重试不 fallback）
- `connected` ─ bridge `focus_lost` event → 清本地 focus（**留在 connected**），UI 提示"会话已结束，请重选"

#### 2d. Discovery 模块
- 新增 `plugin/src/bridge-discovery.ts`：用 `bonjour-service` `browse({ type: 'agentdeck', protocol: 'tcp' })` 形式（**不是字符串 `'_agentdeck._tcp.'`**，POC 1 实测）
- 解析 TXT 用现有字段名（`project`、`agent`），新字段 `machineId`、`hostname`
- emit `bridge_discovered`/`bridge_lost`，payload `{ machineId, hostname, project, agent, host, port }`（**不含 token**，codex finding 4）
- 没有 manual IP fallback；mDNS 不通直接 `mdns_error`

#### 2e. Token 存储
新增 `plugin/src/token-store.ts`：
- 服务名 `com.agentdeck.plugin`、account = `machineId`
- 写：**token 走 stdin 不进 argv**（POC 2 gotcha），3s timeout
  ```typescript
  await new Promise<void>((resolve, reject) => {
    const child = spawn('security', ['add-generic-password',
      '-a', machineId, '-s', 'com.agentdeck.plugin', '-w', '-U'],
      { signal: AbortSignal.timeout(3000) });
    child.stdin.write(token.trim());
    child.stdin.end();
    child.on('close', code => code === 0 ? resolve() : reject(new KeychainError(code)));
    child.on('error', reject);
  });
  ```
- 读：`security find-generic-password -a <mid> -s <svc> -w`，exit 44 = 返回 null（未配对），其他 non-0 / ENOENT / timeout → throw `KeychainError`
- 删：`security delete-generic-password -a <mid> -s <svc>`，exit 44 当成功

**ACL 行为**（POC 2 实测）：plugin 自己写自己读，不弹 GUI。**例外**：plugin bundle 路径变化 → 下次读弹一次 "Always Allow"。docs 提醒。

#### 2f. globalSettings 存储模型
```typescript
type PluginGlobalSettings = {
  pairedBridges: Array<{
    machineId: string;
    hostname: string;     // 显示名
    host: string;         // IP 或 hostname
    port: number;
  }>;
  activeMachineId: string | null;
};
```
**Token 只在 Keychain，不在 globalSettings**。

#### 2g. Property Inspector — bridge-connection action
- 新增 action `bound.serendipity.agentdeck.bridge-connection`（占 key 位用于挂 PI）
- PI 渲染：
  - mDNS 发现列表（按 hostname 排序，agent 标签）
  - 选中 → token 输入框（密码字段、submit 按钮）
  - 已配对下拉切换
  - 状态显示：connected / disconnected / keychain_error / mdns_error
  - 复制 token 提示（"在 daemon 机器上跑 `agentdeck token show`"）

#### 2h. 适配 remote-only first-run UX（**codex finding 5 新增**）

**问题**：
- [plugin.ts:86](../plugin/src/plugin.ts#L86) `detectSetupState` 用"本机有 `~/.agentdeck` 目录 + `agentdeck` 在 PATH"判断 setup
- [session-slot-button.ts:195](../plugin/src/actions/session-slot-button.ts#L195) 断连时显示 `OFFLINE / Open AgentDeck` 文案

remote-only 拓扑下这两条都误导（MacBook 故意没本地 daemon）。

**改法**：
- `detectSetupState` 改逻辑：**"有任何 paired bridge"** 视为 setup 完成（即 globalSettings.pairedBridges 非空）；没有则 `setupRequired = true`
- OFFLINE 文案改成 `OFFLINE / Open PI to pair`（断连默认引导去 PI）
- 当 state machine 在 `mdns_error` / `keychain_error` 时，按钮文案对应错误

### 3. Apple

#### 3a. 删 fetchHealthInfo localToken 兜底（**codex finding 2 安全漏洞**）
**[BridgeDiscovery.swift:254-262, 281, 284](../apple/AgentDeck/Net/BridgeDiscovery.swift#L254-L262)** 现在：
```swift
let localToken = try? String(contentsOf: AgentDeckPaths.authToken, ...)  // 读本机 token
let token = (json["pairingToken"] as? String) ?? localToken              // 兜底给任何 host
```
**删除** `localToken` 变量及其所有使用点。`pairingToken` 没有就是没有，回返 `HealthInfo(token: nil, ...)`。

#### 3b. 删 TXT/health 自动 token 读
- **[BridgeDiscovery.swift:159](../apple/AgentDeck/Net/BridgeDiscovery.swift#L159)** 删除从 TXT 读 `token`（保留其他字段读取）
- `fetchHealthInfo` 整个删除（已经无意义：删完 1a 后 daemon 不再返 pairingToken；删完 3a 后没有 localToken 兜底）
- `DiscoveredBridge` 结构去掉 `token` 字段

#### 3c. lastBridgeUrl 拆分（**codex finding 1**）

**问题**：[AgentStateHolder.swift:37](../apple/AgentDeck/State/AgentStateHolder.swift#L37) 存的 `lastBridgeUrl` 是完整 `ws://host:port?token=xyz`。token 在 UserDefaults 明文。

**改法**：
- 删除 `lastBridgeUrlKey`
- 新增 `lastBridgeIdentity` UserDefaults entry：`{ machineId: String?, host: String, port: Int }`（JSON 编码）
- 新增 `apple/AgentDeck/State/AppleKeychainStore.swift`：用 Keychain Services API（**Swift 原生 API，不调 `security` CLI**，符合 App Store 2.5.2）
- 连接逻辑：从 `lastBridgeIdentity` 读 host/port，按 `machineId` 从 Keychain 查 token，组装 URL。token 缺失 → 走 manual URL UI（已有）
- `AgentStateHolder.swift:885` 等所有写 `lastBridgeUrl` 处改写新 entry

#### 3d. SettingsScreen manual URL 行为不变
**[SettingsScreen.swift:412](../apple/AgentDeck/UI/Settings/SettingsScreen.swift#L412)** 现有 `TextField("ws://192.168.1.x:9120", text: $manualUrl)` + Connect 流程**保留**。用户粘 `ws://host:port?token=xxx` → connectTo 解析时拆出 token → Keychain，剥光 token 后存 identity。**不需要新 UI**。

### 4. Android

#### 4a. 删 TXT 自动 token 读
- **[BridgeDiscovery.kt:51](../android/app/src/main/kotlin/dev/agentdeck/net/BridgeDiscovery.kt#L51)** 删除 `si.attributes["token"]?.let { ... }`
- `DiscoveredBridge` data class 去掉 `token` 字段

#### 4b. URL 持久化拆分（**codex finding 1**）
**问题**：[DisplayPreferences.kt:52](../android/app/src/main/kotlin/dev/agentdeck/data/DisplayPreferences.kt#L52) 和 [MainActivity.kt:181,240](../android/app/src/main/kotlin/dev/agentdeck/MainActivity.kt#L181) 存完整 URL。

**改法**：
- 新增 `android/.../data/SecureTokenStore.kt`：用 EncryptedSharedPreferences（AndroidX security-crypto）
- `DisplayPreferences` 重命名 `lastBridgeUrl` → `lastBridgeIdentity`（host/port/machineId JSON）
- ConnectionManager 重连时按 `machineId` 从 EncryptedSharedPreferences 查 token、组 URL
- 现有 `ManualUrlInput()` 解析 `ws://host:port?token=xxx` → 拆 token 进 SecureTokenStore、identity 进 SharedPreferences

#### 4c. Manual URL UI 不动
[ConnectionComponents.kt:231](../android/app/src/main/kotlin/dev/agentdeck/ui/ConnectionComponents.kt#L231) 现有 `ManualUrlInput()` 在断连时永远可见。**不改 UI**。

### 5. Hooks（不动）
[hooks/src/install.ts:46-58](../hooks/src/install.ts#L46-L58) `127.0.0.1:$PORT/hooks/${eventName}` 设计正确。

### 6. 文档
- `docs/daemon.md` 加 "Remote Stream Deck plugin" + "Token pairing flow" + "macOS Keychain notes"
- `docs/plugin-conventions.md` 加 bridge-connection action + globalSettings shape
- `CLAUDE.md` "Daemon hub" 一行：**"远端客户端 token 必须手动配对，不再从 mDNS/health 自动读取"**
- `apple/APP_REVIEW_NOTES.md`：更新"如何获取 LAN 连接的 token"说明

---

## 发布顺序（**Phase 1/2 合并**）

codex finding 6 揭示 Phase 1（Apple manual URL）是假需求——已存在。所以**单 Phase 发布**：

1. **同步发**：bridge + plugin + Apple + Android 所有改动一起 ship
2. 兼容性：旧版 Apple/Android 客户端在新 daemon 上首次连会 fail（4001，因为 fetchHealthInfo 拿不到 token + manual URL 没填）→ 用户输入 `ws://host:port?token=xxx` → 工作
3. 老 daemon + 新客户端：新客户端不再读 TXT token，必须 manual URL 输入 → 工作
4. 老老（升级前）：照旧
5. **唯一不能旧老组合**：旧 Apple/Android 客户端的 fetchHealthInfo localToken 兜底（finding 2 安全漏洞）只能通过升级客户端修复，无法服务端补救——这是已知风险，docs 标注"建议升级所有客户端"

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| MacBook 是否跑 daemon | 不跑 | 用户明确 |
| 多台同屏聚合视图 | 不做 | 用户明确 |
| Cursor 扩展面板 | 本期不做 | 需新写 VS Code 扩展 |
| 连接发现 | mDNS only | 用户环境支持 |
| Server token 广播 | **删除两处** | 真实安全漏洞 |
| Apple fetchHealthInfo localToken 兜底 | **删除** | 真实安全漏洞 |
| Apple/Android URL 持久化 | **拆 identity + token，token 进各自 Keychain/EncryptedSharedPreferences** | 真实安全漏洞 |
| Plugin token 存储 | macOS Keychain via `security` CLI（stdin 传值） | plugin 非 App Store |
| Apple token 存储 | Keychain Services Swift API | App Store 2.5.2 不允许 spawn |
| Android token 存储 | EncryptedSharedPreferences | 标准 |
| daemon 身份 key | `machineId`（UUID） | 不依赖可变字段 |
| machineId 写位置 | **process 自己的 `getDataDir()` only**（不 first-writable） | repo 既定 contract |
| TXT 字段名 | 保留 `project`，新增 `machineId`、`hostname` | 不无谓破坏 |
| 协议 v bump | 不 bump | 客户端不分支 v |
| SessionFocusRelay | per-client + WS pool + focus_lost 推送 | 解决根因 |
| BridgeClient close-code | emit `{code, reason}` 上传 ConnectionManager | finding 7 |
| Plugin first-run setup | 用"有 paired bridge 存在"判定 | finding 5 |
| 发布顺序 | 单 Phase 全部一起 | finding 6 Phase 1 不必要 |

---

## 验证

### Step 0 — Ship 前 pre-flight（eng review Issue 2，**必跑**）

```bash
# MacBook
npm i -g @elgato/cli
cd AgentDeck/plugin && streamdeck link
# 打开 Stream Deck app → 拖 bridge-connection action 到 key
# 看 ~/Library/Logs/ElgatoStreamDeck/ 里 plugin log：
#   - "bonjour-service browse started" ✓
#   - LAN 上 M4 daemon 起来后 "bridge_discovered: <hostname>" ✓
```

任何一项失败 → 不 ship；检查 Stream Deck app 是否引入沙箱。

### 端到端清单
1. M4 上：`pnpm setup` → `cat ~/.agentdeck/machine-id` 应有 UUID → `agentdeck token show` 打印 token → Cursor 集成终端跑 `claude`
2. M1 上：同上
3. MacBook：`streamdeck link` 后 `dns-sd -B _agentdeck._tcp.` 看到两台；`dns-sd -L "<machineId>"` TXT 无 `token` 字段
4. PI 打开：看到 M4/M1（按 hostname），选 M4 → 弹 token 输入 → 粘贴 → connected
5. M4 上 `claude` 触发 permission → Stream Deck yes/no 弹出 → 按 Y → CC 收 allow
6. Stream Deck voice prompt → 说话 → 转文 → M4 CC 收到回应
7. PI 切到 M1 → 5/6 重复
8. **并发**：MacBook 连 M4 + iPad 连 M1 → 不串台（per-client focus 验证）
9. **删除验证**：另一台机器 `dns-sd -L` 查 TXT 无 token；`curl http://<m4>:9120/health` 无 pairingToken
10. **Apple URL 拆分验证**：旧版 Apple app 升级到新版后第一次连，旧 lastBridgeUrl 应被迁移（token 进 Keychain、identity 进 UserDefaults），下次启动 UserDefaults 里 `lastBridgeUrl` 应不存在
11. **Android 同理**
12. **token rotation**：rm M4 token、重启 daemon、新 token → MacBook plugin 自动报错 → PI 自动回 pairing → 重粘贴
13. **focus_lost**：M4 上 CC 退出，再启 → MacBook plugin 看到 focus_lost event → UI 提示"会话已结束"
14. **Apple 安全漏洞验证**：测试在 M4 上跑旧 Apple app → 连 M1 daemon → 应 4001 失败（不再用 M4 本地 token 兜底）

---

## 测试需求清单（Boil the Lake — 25 项）

### Bridge
| # | 测试 | 文件 |
|---|---|---|
| 1 | publish 后 TXT **无** `token`（REGRESSION） | `bridge/src/__tests__/mdns-no-token-broadcast.test.ts` |
| 2 | `/health` 响应**无** `pairingToken`（REGRESSION） | `bridge/src/__tests__/health-no-pairing-token.test.ts` |
| 3 | `machine-id.ts` 文件不存在 → 生成 UUID + write 到 `getDataDir()` | `bridge/src/__tests__/machine-id.test.ts` |
| 4 | `machine-id.ts` 文件存在 → 读出 + format validate | 同上 |
| 5 | `machine-id.ts` candidate dirs 多个有 → 按优先级读，**写只到 getDataDir()** | 同上 |
| 6 | `machine-id.ts` write 失败 → throw 清晰错误 | 同上 |
| 7 | `mdns.ts` publish TXT 新增 `machineId`、`hostname` | `bridge/src/__tests__/mdns-identity.test.ts` |
| 8 | `session-focus-relay` 双 client 共享 session 一方 disconnect refcount 正确 | `bridge/src/__tests__/session-focus-relay-multi-client.test.ts` |
| 9 | `session-focus-relay` session WS close → `onFocusLost` 对相关 client 触发 | `bridge/src/__tests__/session-focus-relay-focus-lost.test.ts` |
| 10 | `daemon-server` 推 `focus_lost` event 给 affected plugin WS | `bridge/src/__tests__/daemon-server-focus-lost-emit.test.ts` |
| 11 | `cli.ts agentdeck token show` 存在/不存在两路径 | `bridge/src/__tests__/cli-token-show.test.ts` |
| 12 | `shared/src/protocol.ts` 新增 `FocusLostEvent` 类型 schema | `shared/src/__tests__/protocol.test.ts` |

### Plugin
| # | 测试 | 文件 |
|---|---|---|
| 13 | `bridge-client.ts` close event 携带 `{code, reason}` | `plugin/src/__tests__/bridge-client-close-code.test.ts` |
| 14 | `token-store.ts` write 走 stdin（验证 spawn 参数不含 token） | `plugin/src/__tests__/token-store.test.ts` |
| 15 | `token-store.ts` read exit 44 → null；其他 non-0/timeout → KeychainError | 同上 |
| 16 | `token-store.ts` 写前 trim() | 同上 |
| 17 | `bridge-discovery.ts` mock bonjour-service browse → emit up/down | `plugin/src/__tests__/bridge-discovery.test.ts` |
| 18 | `bridge-discovery.ts` TXT 无 `machineId` → 拒绝该 record | 同上 |
| 19 | `connection-manager.ts` 状态机：connected → onClose 4001 → paired_re_pair → Keychain.delete → pairing | `plugin/src/__tests__/connection-manager-state.test.ts` |
| 20 | `connection-manager.ts` Keychain throw → keychain_error，不重试 | 同上 |
| 21 | `connection-manager.ts` focus_lost event → 清 UI focus，留 connected | 同上 |
| 22 | `plugin.ts` `detectSetupState` 用 paired bridges 判定，不读本地 `~/.agentdeck` | `plugin/src/__tests__/detect-setup-state.test.ts` |

### Apple
| # | 测试 | 文件 |
|---|---|---|
| 23 | `BridgeDiscovery.swift` `fetchHealthInfo` 不再读 local auth-token（REGRESSION 安全） | `apple/AgentDeckTests/BridgeDiscoveryTests.swift` |
| 24 | `AgentStateHolder.swift` 旧 `lastBridgeUrl` 迁移：token → Keychain，identity → UserDefaults | `apple/AgentDeckTests/AgentStateHolderTests.swift` |

### Android
| # | 测试 | 文件 |
|---|---|---|
| 25 | `BridgeDiscovery.kt` 不读 TXT `token` + URL 拆分迁移 | `android/app/src/test/.../BridgeDiscoveryTest.kt` |

---

## 已知前置依赖

- mDNS 跨设备解析必须工作（用户已确认）
- 每台跑 CC 的 mac mini 必须有 machineId（daemon 启动自动生成）
- Stream Deck Mac app 维持非沙箱化（POC 1 隐含；若改沙箱要加 `com.apple.security.network.client` entitlement）
- Plugin bundle 安装路径稳定（POC 2：重装/迁路径会触发一次 "Always Allow"）
- macOS App Store Apple app 用 Swift Keychain Services（不用 `security` CLI，符合 2.5.2）
- Apple lastBridgeUrl 迁移代码必须**只跑一次**（用 `migrationVersion` UserDefaults 标志位）

---

## Worktree 并行策略

| Lane | 模块 | 依赖 |
|---|---|---|
| **A** | bridge/* (mdns 删 token、machine-id、session-focus-relay focus_lost、cli token show、shared protocol FocusLostEvent) | — |
| **B** | plugin/* (bridge-client close-code、token-store、bridge-discovery、connection-manager state machine、PI、detectSetupState) | A 的 shared protocol 改动 merge 后 |
| **C** | apple/* (BridgeDiscovery 删 localToken + TXT/health token 读、AppleKeychainStore、AgentStateHolder URL 拆分) | 独立 |
| **D** | android/* (BridgeDiscovery 删 TXT token、SecureTokenStore、DisplayPreferences identity 迁移) | 独立 |
| **E** | docs/* | 全部 merge 后 |

Lane A 单跑；A merge 后 B/C/D 三个 worktree 并行；E 收尾。

冲突风险：C 和 D 都不改 bridge，不互踩。B 等 A 的 shared protocol 类型加进来再开始。

---

## 后续 todo（不在本期）
- Cursor / VS Code 扩展适配器
- PIN-code pairing 协议（取代手动复制 token）
- SessionFocusRelay reconnect on session bridge death（POC 3 已知 gap）
- Per-client state_update broadcast 隔离（POC 3 已知 gap）

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | v1 FAIL→修；v2 FAIL→v5 重写 | 14 findings, 14/14 fixed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open（4 决策已写 v5） | 4 issues, 4 critical gaps（待 v5 codex 三轮验证） |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX 两轮**：
- v1: token 广播矛盾 / POC 指错子系统 / TXT 字段乱改 / machineId 路径欠规范 / "连去哪"言过其实 / bonjour-service 不在 plugin / PI 欠规范 / "不做向后兼容" → v2 全修
- v2: Apple/Android URL 持久化假冒 / Apple fetchHealthInfo localToken 安全漏洞 / machineId 违反 data-dir contract / Discovery 对象 token 耦合 / Plugin first-run UX 冲突 / Apple Phase 1 不必要 / BridgeClient close-code 丢失 → v5 全修

**ENG REVIEW**：focus_lost 事件 + pre-flight gate + 4001 recovery + keychain_error state + 17→25 测试 enumeration

**UNRESOLVED**: v5 未跑 codex 三轮验证

**VERDICT**: 需要 codex 三轮跑一遍 v5 确认 14 findings 都关闭、没新引入。再走实施
