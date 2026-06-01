# 002 — Remote Stream Deck MVP 落地后 follow-ups（DEFERRED）

> 由 [001_remote-stream-deck-mvp.md](001_remote-stream-deck-mvp.md) 的**实机端到端测试**揭示。
> 001 的跨机链路(连接/认证/focus/状态/选项/命令路由)已全部验证通过并 merge 到 master
> (`b9a5dd1`)。本文件记录测试中卡住的、但**不在 001 scope** 的既有问题,供后续单独修。
>
> **状态**：DEFERRED。这些大多是 AgentDeck 既有架构行为(parser、gateway 路由、relay
> 边缘路径),plan 001 明确"所有跨机功能在 plugin 端 + 1 个 bridge focus_lost 小补丁,不重构
> server/gateway/parser"。

## 实测环境（重启时复现用）

- **MacBook**(192.168.1.109)：Stream Deck+ 遥控端,插件 symlink 到工作区,**不跑 daemon**
- **M4**(`m4server@192.168.1.108`,SSH 免密已配)：跑本地 build 的 daemon(`~/.agentdeck/`,
  token `334368…be96`)+ `agentdeck claude` session bridge(9121)
- daemon LaunchAgent `dev.agentdeck.daemon` 写了但**没调通**(启动后不 bind);当前用
  `nohup agentdeck daemon start` detached 跑。**M4 重启后需手动重起 daemon**
- OpenClaw Gateway LaunchAgent `ai.openclaw.gateway` 测试时被 `launchctl bootout` 停掉了
  (见下 #2);**要恢复**:`launchctl bootstrap gui/$(id -u) <plist>`

---

## Follow-up 清单（按优先级 / 用户体感）

### 1. PTY output-parser 多行长选项解析（**最高 —— 直接挡住端到端应答**）

**症状（实测）**：M4 的 claude 弹出 4 选项提示(每个选项 = 标题行 + 描述行,如
"1. 删除，释放 1.4GB / 这些是 app 安装包…"),但 session bridge(9121)的 PTY parser
**只解析出 2 个选项**,且抓的是最底部残留(`Type something` + 一行),漏掉真正的 1/2/3。
Stream Deck encoder 上因此显示错误的 2 选项,无法应答真实提示。

**定位**：
- [bridge/src/output-parser.ts:15](../bridge/src/output-parser.ts#L15) `OPTION_NUMBERED = /^\s*❯?\s*\d{1,2}[.)]\s*.+/m`
- [bridge/src/output-parser.ts:361](../bridge/src/output-parser.ts#L361)、[:499](../bridge/src/output-parser.ts#L499) 选项分组/分类逻辑
- emit 在 [:469](../bridge/src/output-parser.ts#L469)(yes_no_always)/[:485](../bridge/src/output-parser.ts#L485)(yes_no)/multi_select

**根因假设**：parser 按"单行 = 一个选项"分组,claude v2.x 的长选项是**标题+缩进描述多行**,
parser 没把描述行并入选项、也没正确识别选项边界 → 把整块读错。

**注意**：这是 **AgentDeck 既有行为**,本机直接 `agentdeck claude` 遇到同样提示也会一样错
(`git diff master..feat -- output-parser.ts` 为空,001 一行没动 parser)。

**修法方向**(待定,parser 是核心模块,改动需谨慎 + 加测试)：
- 复现：M4 `agentdeck claude -d`(debug)触发一个多行长选项提示,看 `/tmp/agentdeck-debug.log`
  里 parser 抓到的原始 chunk
- 把多行选项(标题 + 后续缩进行)正确分组成单个 option.label,或至少保留标题行
- 加 fixture 测试:用真实 claude 多行选项的 ANSI 输出做 snapshot

### 2. OpenClaw Gateway 命令路由优先级（架构）

**症状（实测）**：M4 上跑着 OpenClaw Gateway(port 18789),daemon 的 `onCommand`
对 `respond`/`select_option`/`send_prompt` **先给 gateway**,gateway.handleCommand 全返回 true
→ 早返回,命令到不了你 focus 的 claude session。状态广播也被打成 `agentType: openclaw`。

**定位**：
- [bridge/src/daemon-server.ts](../bridge/src/daemon-server.ts) `core.wsServer.onCommand` 里
  `if (gatewayAdapter?.isAlive() && gatewayAdapter.handleCommand(cmd)) { … return; }`
- [bridge/src/adapters/openclaw.ts:262](../bridge/src/adapters/openclaw.ts#L262) `handleCommand`
  对 respond/select_option/send_prompt 无条件 return true

**测试时的绕过**：`launchctl bootout gui/$(id -u)/ai.openclaw.gateway` 停掉 gateway,
daemon 转为路由到 focus 的 session。**这只是临时绕过,不是修复。**

**修法方向**：当 plugin 明确 focus 了一个**真实 session bridge**(`focusRelay.getFocusedSessionId()`
非 null)时,命令应优先路由到那个 session,而不是无脑给 gateway。需重新设计 gateway vs
session 的路由优先级。

### 3. daemon LaunchAgent 开机自启没调通（运维）

**症状（实测）**：`agentdeck daemon install` 写的 `dev.agentdeck.daemon.plist`、以及我手写的
plist,launchd 启动后进程**不 bind 9120**(可能是 `--foreground` 参数 / PATH / mDNS 冲突,
或 launchd 上下文里 `~/.agentdeck` 创建时序)。手动 `nohup agentdeck daemon start` 稳定。

**影响**：M4 重启后 daemon 不会自动回来,需手动 SSH 重起。

**修法方向**：查 daemon `--foreground` 在 launchd 上下文的 stdout/stderr 重定向 + 退出码;
对照 `agentdeck daemon install` 生成的 plist 与源码 build 路径(`bridge/dist/cli.js`);
可能要给 plist 加 `WorkingDirectory` + 显式 `mkdir ~/.agentdeck`。

### 4. daemon mDNS 名字冲突 = uncaught throw（健壮性）

**症状（实测）**：M4 daemon 启动时,若 LAN 上已有同名 `_agentdeck._tcp`(当时是 MacBook 的
陈旧 daemon 在播),bonjour-service 抛 "Service name is already in use on the network"
**未捕获异常 → daemon 崩溃**。

**定位**：daemon 硬编码 `initModules(…, { mdns: true, … })`
([bridge/src/daemon-server.ts:757](../bridge/src/daemon-server.ts#L757)),且**无 `--no-mdns` 标志**
(`agentdeck daemon start` 没暴露关 mDNS 的选项)。multicast-dns 的 error 没被 catch。

**测试时的绕过**:停掉 MacBook 的陈旧 daemon 释放名字。

**修法方向**:① bonjour registry 的 error 事件加 handler(冲突时降级,不崩溃);
② 给 `agentdeck daemon start` 加 `--no-mdns`(MVP 拓扑用 IP 直连,根本不需要 mDNS)。

### 5. 非-WS dispatchCommand 的 focus-relay 泄漏（边缘,来自 001 对抗 review）

**症状**:daemon 的 `dispatchCommand`(sender===null,D200H/agent stdin 管道)每次 mint 新
`Symbol('dispatch')`,focusRelay.routeCommand 在这个临时 token 下 implicit focus + acquire
session WS,但非-WS sender 无 onClientDisconnect → 该 token 的 focus entry 永不 unfocus →
session WS refcount 不归零(conn-pool 泄漏);交互命令也路由失效。

**定位**:[bridge/src/daemon-server.ts:1132](../bridge/src/daemon-server.ts#L1132)
`const token = sender ? … : Symbol('dispatch')`

**影响**:仅 D200H stdin 管道这条边缘路径,常规 WS plugin 不受影响。

**修法方向**:非-WS dispatch 用**一个稳定 token**,且仅当该 token 真有 focus 时才尝试路由。

---

## 不在本文件（归属别处）

- 全平台安全清理(删 server token 广播 / Apple/Android / Swift daemon parity / mDNS 重设计)→ [plan 000](000_cross-platform-security-cleanup.md)
- SessionFocusRelay 在 session bridge 死后**换端口重连**(focus_lost 已是 001 的缓解)→ 001 已记,POC 3 已知 gap
- Cursor / VS Code 扩展适配器 → 永不在 scope

---

## VERDICT

001 跨机 MVP 的**核心价值已交付且实测通过**:MacBook Stream Deck 能跨 LAN 配对 + 控制远端
Claude Code 的连接/认证/focus/状态/选项显示/命令路由全打通。本文件 5 项是落地时碰到的
**既有 AgentDeck 问题**,按"用户体感 × 工程量"排序,#1(parser)最该先修——它是端到端应答
体验的最后一道坎。
