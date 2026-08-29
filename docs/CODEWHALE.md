# CodeWhale Provider 适配文档

> LLMPET 桌面宠物支持 **Claude Code**（默认）、**OpenAI Codex**、**DeepSeek Harness** 与
> **CodeWhale** 四个 provider。本文档说明 CodeWhale 适配的架构、启用方式、与
> Claude Code 的关键差异、安全边界与已知限制。
>
> 本文所有协议事实均对照 CodeWhale 上游仓库（docs/HOOKS.md、docs/CONFIGURATION.md
> 与 `crates/tui/src/hooks/` 源码）逐条验证过，不是从旧文档抄写的。

## 目录

- [快速启用](#快速启用)
- [架构概览](#架构概览)
- [与 Claude Code 的关键差异](#与-claude-code-的关键差异)
- [事件映射](#事件映射)
- [权限机制](#权限机制)
- [Token 计量与花费](#token-计量与花费)
- [多实例与 runtime 配置](#多实例与-runtime-配置)
- [已知限制与设计取舍](#已知限制与设计取舍)

---

## 快速启用

### 前置条件

1. **安装 CodeWhale**：`npm install -g codewhale`（[GitHub](https://github.com/Hmbown/CodeWhale)，Rust TUI 编码代理，前身是 `deepseek-tui`）
2. **安装 LLMPET**：`npm ci && npm start`

### 启用步骤

LLMPET 启动时检测 `~/.codewhale/config.toml`：

- 文件存在（即用户装过 CodeWhale）→ 自动合并写入 LLMPET 的 managed hook 区块
- 文件不存在 → provider 待机；用 `LLMPET_ENABLE_CODEWHALE=1` 显式启用

```bash
# 验证安装结果
grep -A6 'BEGIN LLMPET CODEWHALE HOOKS' ~/.codewhale/config.toml
```

卸载只需删除 managed 区块（用户原有 TOML 内容不动）：

```bash
node -e "console.log(require('./backend/codewhale-provider').uninstall())"
```

---

## 架构概览

```
CodeWhale TUI ──(TOML hooks, 10 事件)──► codewhale-hook.js ──HTTP POST /state──┐
            ──(tool_call_before 阻塞)──► /codewhale-permission ──────────────┤
                                                                                ▼
                                                       ┌──────────────────────────────┐
                                                       │  本地 HTTP server (127.0.0.1)  │
                                                       └──────────────┬───────────────┘
                                                                      ▼
                                              core/adapter（Claude 等价事件词汇）
                                                                      │
                                          ┌───────────────────────────┤
                                          ▼                           ▼
                                   桌宠状态/授权气泡          codewhale-metering.js
                                                              (turn_end 记账)
```

关键设计原则：

- **统一事件词汇**：CodeWhale 事件映射为 Claude Code 等价的内部事件
  （`session_start → SessionStart` 等），core/adapter 不需要任何 CodeWhale 专用路径。
- **独立权限池**：`backend/codewhale-permission.js` 与 Claude 的 `permission.js`
  完全隔离，`cw-` 前缀的请求 id 在 IPC 层分流。
- **计量走事件不走文件**：`turn_end` 的 stdin JSON 自带 usage，无需解析
  `~/.codewhale/sessions/*.json`。

## 与 Claude Code 的关键差异

| 维度 | Claude Code | CodeWhale |
|:---|:---|:---|
| **配置格式** | JSON (`~/.claude/settings.json`) | TOML (`~/.codewhale/config.toml`) |
| **Hook 事件数** | 15+（SessionStart/PreToolUse/…） | 11 个生命周期事件（注册 10 个） |
| **tool_call_before 输入** | stdin JSON | **环境变量**（`DEEPSEEK_TOOL_NAME`/`DEEPSEEK_TOOL_ARGS`） |
| **权限响应** | HTTP hook 返回 `hookSpecificOutput` | hook 进程 **stdout** JSON `{decision, reason}` |
| **无响应超时** | 走自身权限流程 | **默认 allow**（legacy passthrough）—— 除非 strict gate |
| **turn_end 数据** | 需扫 transcript JSONL | stdin 直接携带 `usage`/`totals` |
| **变量前缀** | 无 | `DEEPSEEK_`（上游为兼容改名前保留）+ `CODEWHALE_SESSION_ID` 双写 |

> ⚠️ 上游 `DEEPSEEK_` 前缀是刻意保留的兼容层（"The DEEPSEEK_ prefix is retained
> for compatibility with hooks written before the rebrand"）。不存在
> `CODEWHALE_TOOL_NAME` / `CODEWHALE_TOOL_ARGS`。

## 事件映射

CodeWhale 的 11 个生命周期事件（上游 `ALL_HOOK_EVENTS`；`shell_env` 是 exec_shell
的环境注入器，非生命周期钩子，刻意不注册）：

| CodeWhale 事件 | LLMPET 内部事件 | 桌宠状态 | 说明 |
|:---|:---|:---|:---|
| `session_start` | SessionStart | idle | 欢迎表情由 adapter 按 session 身份判定 |
| `session_end` | SessionEnd | sleeping | 同时清理由该会话挂起的权限请求 |
| `message_submit` | UserPromptSubmit | thinking | stdin 携带消息文本 |
| `tool_call_before` | PreToolUse | working | **权限门**（见下节） |
| `tool_call_after` | PostToolUse | working | |
| `turn_end` | Stop | attention | stdin 携带 usage → 计量 |
| `subagent_spawn` | SubagentStart | juggling | |
| `subagent_complete` | SubagentStop | working | |
| `on_error` | StopFailure | error | 传输/容量/auth/工具失败 |
| `mode_change` | Notification | notification | plan/agent/operate 切换 |

**注意**：上游不存在 `turn_start` 和 `error` 事件（正确名是 `message_submit` 与
`on_error`）。早期适配草稿注册过这两个名字，属于未经验证的臆造协议。

## 权限机制

CodeWhale 的 `tool_call_before` 是唯一的 steering 点。hook 进程：

1. 从环境变量读取工具信息（`DEEPSEEK_TOOL_NAME`、`DEEPSEEK_TOOL_ARGS` ≤10KB）
2. POST 到 LLMPET 的 `/codewhale-permission`（带 runtime token），阻塞等待用户决策
3. 用户在桌宠气泡点「允许 / 拒绝」
4. hook 将 `{decision: "allow"|"deny"|"ask", reason}` 打到 stdout，exit 0

### 安全设计（每一层都对应上游已验证的行为）

- **strict gate**：TOML 条目 `continue_on_error = false` + `timeout_secs = 600`。
  上游对普通 hook 的超时行为是 **allow**（legacy passthrough）——对权限门是灾难。
  strict gate 让无法回答的 hook 变成 deny 而不是放行。
- **8 分钟主动 deny**：LLMPET 侧在 480 秒无人决策时回答 deny，赶在 600 秒
  TOML 超时之前；即便用户挂机也不会被上游超时策略意外放行。
- **fail-closed 到 ask**：LLMPET 未运行 / 端口不可达 / 响应身份头不匹配 /
  JSON 畸形 / 未知 decision / 响应超过 16KB → 一律输出 `{"decision":"ask"}`，
  交回 CodeWhale 原生权限提示。绝不输出空 stdout（空 = allow）。
- **读-only 命令免打扰**：与 Claude Code 的 PreToolUse 门共用同一个
  fail-closed 识别器（`backend/command-safety.js`）。组合命令（`;`、`&&`、管道、
  重定向、`$()`、反引号）、执行类选项（`find -exec`、`rg --pre`、`fd -x`）、
  可变子命令（`git branch -D`、`git remote add`、`env CMD`）全部回落到正常询问。
- **有界资源**：最多 64 个挂起请求，超限立即回答 ask；连接断开自动清理。
- **loopback + token**：`/codewhale-permission` 与 `/state` 同一条信任边界
  （loopback 校验、Host 校验、Origin/Referer 拒绝浏览器、每次启动随机 token）。

## Token 计量与花费

数据源是 `turn_end` 的 stdin JSON（上游已验证形状）：

```json
{
  "turn_id": "turn_…", "model": "deepseek-chat", "provider": "deepseek",
  "usage": {
    "input_tokens": 1234, "output_tokens": 567,
    "prompt_cache_hit_tokens": 890, "prompt_cache_miss_tokens": 344,
    "prompt_cache_write_tokens": 100,
    "reasoning_tokens": 12, "reasoning_replay_tokens": 0
  }
}
```

- **去重**：按 `turn_id`（hook 重试不会重复计费）；无 turn_id 时退化为
  session+model+usage 摘要。去重窗口有界（20000 条）。
- **DeepSeek 缓存语义**：`input_tokens` 已包含缓存命中部分。计费时
  未缓存输入 × input 价 + 命中 × cache_read 价，缓存 token 永远不会被收两次钱。
- **reasoning_replay_tokens**：上游定价语义不明——只进诊断计数，刻意不计费
  （诚实缺口优于瞎猜）。
- **定价来源**：`https://models.dev/catalog.json`（MIT 协议，无鉴权，24h TTL，
  实测 ~4.7MB / 204 providers / 7435 模型）。查询顺序：`provider/model` 限定键 →
  裸模型名 → 未知（tokens 照记、cost=$0、进 `unknownModels` 诊断）。
- **安全边界**：catalog 里合法存在 `__proto__`/`constructor` 这类 key（真的有
  provider 或模型叫这个名）——缓存用 null-prototype 字典构建、危险 key 直接丢弃、
  所有数值有界校验、64MiB body 上限、原子写入 0600。
  网络失败永不阻塞启动，旧缓存继续生效。

## 多实例与 runtime 配置

`~/.octopus/runtime.json` 把 hook 流量路由到某一个 server 实例：

- **默认模式**：Electron 单实例锁 + 启动端口探测，两个副本不能共存。
- **显式多开**（`OCTOPUS_ALLOW_MULTI=1`）：**first-live-wins**——后启动的实例
  探测到记录指向存活实例时不抢写；记录指向的端口死了（陈旧记录）才接管。
  旧版守护逻辑每 15 秒无条件抢回，两个存活实例会永远翻转配置文件、互相
  作废对方的 token——这正是本轮翻新移除的行为。
- 同端口不同 token（自己崩溃重启的残留）立即重写修复。

## 已知限制与设计取舍

- **无专属 CodeWhale 桌宠**：CodeWhale 的会话/事件/授权与 Claude 共用主宠
  （duo 模式下事件仍路由到主宠）。分身宠是后续工作。
- **读-only 识别器偏保守**：`grep -c`（计数）会被 `-c` 拦截回落到询问——
  这是刻意的 fail-closed：`-c` 的危险形态（`sh -c`）无法在词法层区分上下文。
  可用性换安全性，安全授权里永远选安全。
- **hooks 只在交互式 TUI 触发**：`codewhale exec`、CLI 子命令、app-server/ACP
  都不触发 hook（上游行为），headless 场景 LLMPET 看不到。
- **`[hooks].default_timeout_secs` 陷阱**：用户在 config.toml 里设置它会
  **覆盖**每个 hook 自己的 `timeout_secs`（上游行为）。若用户设了 30，权限门
  会在 30 秒被上游杀掉——LLMPET 的 8 分钟主动 deny 兜底不依赖这个字段，
  但 strict gate 的 600 秒设计会被缩短。文档里明确提醒用户不要为权限门调低它。
- **计量不含 Codex/Claude 的 LiteLLM 价格链**：CodeWhale 独立用 models.dev，
  不并入 `pricing-sync.js` 的 Claude 计价，避免一次迁移改变历史账单。
