# CodeWhale Provider 适配文档

> Octopus 桌面宠物支持 **Claude Code**（默认）和 **CodeWhale** 双 provider。
> 本文档说明 CodeWhale 适配的架构、启用方式、与 Claude Code 的差异、以及已知限制。

## 目录

- [快速启用](#快速启用)
- [架构概览](#架构概览)
- [CodeWhale 与 Claude Code 的关键差异](#codewhale-与-claude-code-的关键差异)
- [事件映射](#事件映射)
- [权限机制](#权限机制)
- [Token 计量与花费](#token-计量与花费)
- [会话列表](#会话列表)
- [文件结构](#文件结构)
- [Windows 支持](#windows-支持)
- [添加新 Provider](#添加新-provider)
- [已知限制与待办](#已知限制与待办)

---

## 快速启用

### 前置条件

1. **安装 CodeWhale**：`npm install -g codewhale`（[GitHub](https://github.com/Hmbown/CodeWhale)）
2. **安装 Octopus**：`npm ci` + `npm start`（与 Claude Code provider 相同流程）

### 启用步骤

1. 打开 Octopus 详情面板（点击桌宠 → 📊 详情）
2. 找到 **Provider** 区块
3. 勾选 **CodeWhale**（Claude Code 默认已启用且不可禁用）
4. 点击 **安装 Hook** 按钮（或重启 Octopus 自动安装）
5. 启动 CodeWhale 终端会话即可

Hook 会以完整条目写入 `~/.codewhale/config.toml` 的 `[[hooks.hooks]]` 数组。安装器按条目边界合并、可重复执行；卸载只删除命令中含 `codewhale-hook.js` 的 Octopus 条目，并保留用户原有内容与换行格式。

> **注意**：CodeWhale provider 也可以通过配置文件启用。编辑 `~/.octopus/config.json`，设置 `"providers": ["claude", "codewhale"]`。

### 验证 Hook 安装

面板 Provider 区块会显示 **Hook 状态**（已安装 / 未安装）。也可以手动检查：

```bash
grep -A2 'codewhale-hook.js' ~/.codewhale/config.toml
```

应该看到类似：

```toml
[[hooks.hooks]]
event = "session_start"
command = "node \"/absolute/path/hook/codewhale-hook.js\" session_start"
timeout_secs = 5
background = false
name = "octopus"
```

---

## 架构概览

```
CodeWhale TUI ──(TOML hooks, 10 events)──► codewhale-hook.js ──HTTP POST /state──┐
            ──(tool_call_before, blocking)──► /codewhale-permission ──────────┤
                                                                                    ▼
                                                           ┌──────────────────────────────┐
                                                           │  本地 HTTP server (127.0.0.1)  │
                                                           └──────────────┬───────────────┘
                                                                          ▼
                   providers/codewhale.js::parseHookStdin() ──► 统一 internal body
                                                                          │
                                          ┌───────────────────────────────┤
                                          ▼                               ▼
                                   会话状态机 (core)              metering-codewhale.js
                                          │                          (turn_end 直接记账)
                                          ▼
                                  adapter.js ──► pet:stats / pet:event ──► 桌宠/面板渲染
```

关键设计原则：

- **Provider 抽象层**（`providers/base.js` 定义契约）：每个 provider 封装了自己特有的 hook 事件词汇、stdin JSON 形状、权限机制、transcript 格式和计量方式。Core/adapter/server 对 provider 完全无感知。
- **统一 internal body**：无论 Claude Code 还是 CodeWhale 的 hook，最终都转换为同一形状的 JSON（包含 `state`、`event`、`session_id`、`provider` 等字段），core 只处理这一种格式。
- **CodeWhale 特有的后端模块**：`codewhale-permission.js`（权限桥接）、`metering-codewhale.js`（token 计量）、`toml-hooks.js`（TOML hook 安装/卸载）。

---

## CodeWhale 与 Claude Code 的关键差异

| 维度 | Claude Code | CodeWhale |
|:---|:---|:---|
| **配置格式** | JSON (`~/.claude/settings.json`) | TOML (`~/.codewhale/config.toml`) |
| **Hook 事件数** | 8（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop 等） | 10（session_start/message_submit/tool_call_before/tool_call_after/turn_end/mode_change 等） |
| **Hook 注册位置** | `settings.json` 的 `hooks` 数组 | `config.toml` 的 `[[hooks.hooks]]` 数组 |
| **权限机制** | 阻塞 HTTP POST `/permission`，返回 `{body, hookSpecificOutput}` | `tool_call_before` hook 进程输出 JSON 到 stdout：`{decision, reason}` |
| **tool_call_before 输入** | stdin JSON | **环境变量**（`DEEPSEEK_TOOL_NAME` 等），无 stdin |
| **超时策略** | 超时 = deny | 超时 = **allow**（危险！Octopus 在 8 分钟时主动 deny） |
| **Session ID 格式** | `sess_` 前缀 | 裸 UUID |
| **Transcript 格式** | JSONL（`projects/**/*.jsonl`） | Pretty JSON（`sessions/<UUID>.json`） |
| **Token 数据来源** | 扫描 transcript 文件统计 | `turn_end` 事件直接携带 `usage` 字段 |
| **定价来源** | 内置 DEFAULT_PRICING + LiteLLM API 同步 | 内置 `model-catalog.bundled.json` |
| **PATH 环境** | Hook 执行时 PATH 可能被清理，需 `resolveNodeBin` | 继承 PATH；启动器用 POSIX shell 的 `command -v` 或 Windows `where` 解析 CodeWhale |
| **「去回复」聚焦** | macOS 原生 | 当前也仅 macOS；Windows/Linux 回落到打开面板 |
| **Focus 事件** | SessionStart/UserPromptSubmit/PreToolUse | session_start/message_submit/tool_call_before |

---

## 事件映射

CodeWhale 注册的 10 个 hook 事件到 Octopus 内部事件的映射：

| CodeWhale 事件 | Octopus 内部事件 | 桌宠状态 | 说明 |
|:---|:---|:---|:---|
| `session_start` | `SessionStart` | idle | 新会话启动，adapter 处理 greet 逻辑 |
| `session_end` | `SessionEnd` | sleeping | 会话结束 |
| `message_submit` | `UserPromptSubmit` | thinking | 用户提交消息 |
| `tool_call_before` | `PreToolUse` | working | 工具调用前（+ 权限桥接） |
| `tool_call_after` | `PostToolUse` | working | 工具完成；清理已过期权限气泡 |
| `turn_end` | `Stop` | attention | 一轮对话结束（含 usage 数据） |
| `subagent_spawn` | `SubagentStart` | juggling | 子 agent 启动 |
| `subagent_complete` | `SubagentStop` | working | 子 agent 完成 |
| `on_error` | `StopFailure` | error | 出错 |
| `mode_change` | `Notification` | idle | 模式切换；不代表任务已结束 |

**未注册的事件**：`shell_env`（exec_shell 专用的环境注入器，非生命周期钩子）。`tool_call_after` 与 `mode_change` 已注册，以兼容当前/后续 CodeWhale 事件流。

---

## 权限机制

CodeWhale **没有** Claude Code 的阻塞 HTTP hook。取而代之，`tool_call_before` hook 进程必须：

1. 通过环境变量读取工具信息（`DEEPSEEK_TOOL_NAME`、`DEEPSEEK_TOOL_ARGS` 等）
2. POST 工具信息到 Octopus 的 `/codewhale-permission` 端点（阻塞等待用户决策）
3. 用户在桌宠上点击「允许」或「拒绝」
4. Hook 进程将决策 JSON 打印到 stdout 并退出
5. CodeWhale 读取 stdout 中的 `{decision: "allow"|"deny", reason: "..."}`

### 关键安全设计

- **失效安全回退**：Octopus 未运行、端口不可达、HTTP 状态异常、服务身份头不匹配、JSON 畸形、未知 decision、响应超过 16KB 或本地权限队列过载时，hook 都输出 `{"decision":"ask"}`，交回 CodeWhale 原生权限提示；不再用空 stdout 猜测行为。
- **超时主动 deny**：CodeWhale TOML 超时为 600 秒；Octopus 权限池在 8 分钟时主动 `deny`，避免长时间无人处理后被上游超时策略意外放行。
- **会话级批量授权**：「本会话允许全部」与「本会话允许此工具」只对当前 session 生效，30 分钟滑动过期；SessionEnd 会清除规则，不存在跨项目全局永久放行。
- **有界资源**：最多保留 128 个待决策请求；同一请求最多合并 8 个重试连接。超限时返回 `ask`。
- **独立权限池**：CodeWhale 的权限存储在 `backend/codewhale-permission.js` 的独立 Map 中，与 Claude Code 的 `permission.js` 完全隔离。
- **`background: false`**：`tool_call_before` 的 TOML 条目必须设为前台运行（`background = false`），否则无法阻塞等待决策。

### 决策格式

```json
{"decision": "allow"}
{"decision": "deny", "reason": "用户拒绝了此操作"}
{"decision": "ask"}  // 回退到 CodeWhale 自身的权限提示
```

---

## Token 计量与花费

与 Claude Code（扫描 JSONL transcript 文件）不同，CodeWhale 的 `turn_end` 事件**直接携带**完整的 usage 数据：

```json
{
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read_tokens": 890,
    "cache_write_tokens": 100
  },
  "totals": {
    "input_tokens": 50000,
    "output_tokens": 12000
  }
}
```

### 定价

- **数据源（三层）**：
  1. **Live cache**（`~/.octopus/catalog/models-dev.json`，24h TTL，从 [models.dev](https://models.dev) 异步刷新，[MIT 协议](https://github.com/anomalyco/models.dev)）—— 优先级最高，覆盖 bundled seed 中的同 ID 模型，并填补 bundled 没收录的新模型。
  2. **Bundled seed**（`backend/model-catalog.bundled.json`，schema v2，2026-07-20 重新核对厂商价格表）—— 49 个 CodeWhale 已注册模型，含 `input_usd_per_million` / `output_usd_per_million` / `cache_read_usd_per_million` / `cache_write_usd_per_million`，所有价格均引用厂商官网定价页。
  3. **null** —— 未知模型 honest 返回 null，记录 token 但 cost=0，统计中标记 `unknownPrice`。
- **Models.dev 同步**（`backend/models-dev-sync.js`）：启动时后台异步从 `https://models.dev/catalog.json` 拉取最新 catalog（~3 MB，含 5000+ 模型），15 秒超时，64 MiB 响应上限，无认证 / 无 cookie。完成后原子写入 `~/.octopus/catalog/models-dev.json`（0600 权限）。失败时优雅降级——继续用旧 cache 或 bundled seed，永不影响桌宠启动。**与 CodeWhale 上游实现一致**（CodeWhale 的 `crates/tui/src/models_dev_live.rs` 使用同一个 URL 和同样的 24h TTL）。
- **厂商优先级**：models.dev 中同一个模型 ID 可能被多个 provider 提供（如 `deepseek-v4-pro` 既有官方 `deepseek` provider 也有聚合器 `frogbot` 4× 加价）。`transformModelsDev` 按 **官方 provider 优先**顺序选择：
  1. 官方 provider（deepseek / openai / anthropic / zai / moonshot / xiaomi / minimax / stepfun / sakana / longcat / meta / xai / arcee / alibaba 等）有非零价 → 选之
  2. 官方 provider 有 $0 价 → 选之（如 xiaomi-token-plan 是 credit-based）
  3. 官方 provider 仅有 context 元数据 → 选之
  4. 任意 provider 有非零价 → 选之（聚合器转售价）
  5. 任意 provider 有 $0 价 → 选之
  6. 第一个候选
- **缓存定价（重要变更）**：不再一律套用 `0.1× input / 1.25× input` 启发式。catalog 现在携带**每个模型厂商公布的真实缓存费率**：
  - OpenAI / DeepSeek / Kimi / Claude / Qwen：cache_read ≈ 10% input（符合启发式）
  - **Z.AI GLM-5.x**：cache_read = $0.26（≈ 18.6% input），与官方文档一致
  - **Xiaomi MiMo**：cache_read ≈ 2% input（远低于 10% 启发式，旧逻辑会高估 5 倍）
  - **xAI Grok**：cache_read = 15% input（grok-4.5/4.3/4.20）/ 20% input（grok-build）
  - **Meta muse-spark**：cache_read = 12% input
  - **MiniMax M3**：cache_read = 20% input
  - **Meituan LongCat-2.0**：cache_read = 2% input
  - 厂商未公布 cache_write 的模型（Grok / Meta / MiniMax-M3 / LongCat / Kimi-K3）：cache_write 回落到 `1.25× input` 启发式
  - 厂商限时免费 cache_write 的模型（Xiaomi MiMo / Z.AI GLM-5.x）：cache_write = $0（待促销结束后需重新核对）
- **未知模型**：catalog 中没有的模型，`priceFor()` 返回 `null`，记录 token 数但花费标为 0，并在统计中标记 `unknownPrice` 计数。**不再伪造 $1/$5 默认价**（旧逻辑会让用户误以为花了钱，或对新 Opus 变体低估 15 倍）。
- **价格修正**：
  - `deepseek-v4-pro` 旧 catalog $2/$8 → 正确 $0.435/$0.87（核对 DeepSeek 官方文档 + models.dev）
  - `deepseek-v4-flash` 旧 catalog $0.5/$2 → 正确 $0.14/$0.28
  - `gpt-5.6-terra` 旧 catalog $3/$20 → 正确 $2.50/$15（与 OpenAI 官方文档核对）
  - `gpt-5.6-luna` 旧 catalog $2/$10 → 正确 $1/$6
  - `grok-build` context_window 旧 512K → 正确 256K（官方 SKU 是 `grok-build-0.1`）
  - `grok-4.20-0309-reasoning/non-reasoning` context_window 旧 2M → 正确 1M
- **新增 catalog 条目**（旧 catalog 缺失）：`deepseek-chat` / `deepseek-reasoner` / `kimi-k3` / `moonshotai/kimi-k3` / `glm-5.1` / `glm-5-turbo` / `z-ai/glm-5.1` / `z-ai/glm-5-turbo` / `gpt-5.5` / `gpt-5.5-pro` / `grok-4.5` / `grok-4.3` / `grok-build` / `grok-composer-2.5-fast` / `grok-4.20-0309-reasoning` / `grok-4.20-0309-non-reasoning` / `LongCat-2.0` / `longcat-2.0` / `minimax-m3`。
- **仍为 null 的模型**（无公开价格）：`mimo-v2.5-pro-ultraspeed`（小米私有内测，仅 CNY 价）、`grok-composer-2.5-fast`（xAI 未公布 composer SKU 价格）。
- **存储**：`~/.octopus/usage-codewhale.json`，按日聚合，保留 95 天。每个 `byModel` 条目新增 `unknownPrice` 计数字段，UI 可用于显示"价格未知"徽标。Models.dev cache 存于 `~/.octopus/catalog/models-dev.json`（0600 权限，~3 MB）。
- **环境变量**：
  - `OCTOPUS_MODELS_DEV_URL=<url>`：覆盖 models.dev URL（自建镜像 / 内网代理）
  - `OCTOPUS_MODELS_DEV_PATH=<path>`：从本地文件读 catalog（完全离线 / 调试）
  - `OCTOPUS_DISABLE_MODELS_DEV_FETCH=1`：禁用 models.dev 拉取（保留 Claude 的 LiteLLM 同步）
  - `OCTOPUS_NO_NET=1`：禁用所有外联请求（同时禁用 models.dev 和 LiteLLM）
- **价格调研证据**：见仓库根目录 `MODEL-PRICING-RESEARCH.md` 与 `MODEL-PRICE-SYNC-RESEARCH.md`（仅随源码包发布，不在便携 zip 中），含每个价格的厂商 URL 与访问日期。

### 与 Claude 计量的对比

| 维度 | Claude Code | CodeWhale |
|:---|:---|:---|
| 数据来源 | 扫描 transcript 文件 | turn_end 事件实时推送 |
| 定价数据 | 内置 + LiteLLM API | bundled catalog + models.dev 实时同步 |
| 实时同步源 | LiteLLM GitHub raw | models.dev/catalog.json (MIT) |
| 缓存定价 | 启发式 10%/1.25× | 厂商公布的真实费率（差异最大 5×） |
| 未知模型 | fallback 家族估算 | null（token-only，不伪造价格） |
| 需要文件扫描 | 是 | 否 |
| 跨会话聚合 | 按 transcript 文件 | 按 session_id + 日期 |

---

## 会话列表

CodeWhale 将会话存储在 `~/.codewhale/sessions/<UUID>.json`（pretty JSON 格式，非 JSONL）。每个文件包含 `metadata` 对象（`id`、`title`、`workspace`、`model`、`mode`、`message_count`、`total_tokens`、`created_at`、`updated_at`、`cost`）。

Octopus 的 `providers/codewhale.js::cwListSessions()` 扫描该目录，最多返回 50 个会话（按 `updated_at` 降序）。在桌宠的会话列表 HUD 中，CodeWhale 会话显示 🐋 图标，Claude Code 会话显示星形图标。

---

## 文件结构

与 CodeWhale 适配相关的源文件：

```
providers/
  base.js                    # Provider 接口契约 + 验证
  claude.js                  # Claude Code provider（封装原有逻辑）
  codewhale.js               # CodeWhale provider（事件映射/TOML schema/解析/启动）
  index.js                   # Provider 注册表 + 选择逻辑

hook/
  octopus-hook.js            # Claude Code 的 hook 脚本（原有）
  codewhale-hook.js          # CodeWhale 的 hook 脚本（R2 适配）

backend/
  codewhale-permission.js    # CodeWhale 权限桥接（独立于 Claude 的 permission.js）
  metering-codewhale.js      # CodeWhale token 计量（基于 turn_end 事件）
  toml-hooks.js              # TOML [[hooks.hooks]] 合并安装/卸载（merge-safe）
  model-catalog.bundled.json # CodeWhale 内置模型价格目录
  tray-icon.js               # Windows 运行时 .ico 生成（通用）
  pidwalk.js                 # 终端 pid 链解析（macOS + Windows）
  focus.js                   # 「去回复」窗口聚焦（当前仅 macOS）

renderer/
  pet.js                     # provider 感知 UI（图标/按钮文案/IPC 路由）
  pet.html                   # provider toggle + 会话列表
  panel.js                   # Provider 列表渲染 + hook 状态显示
  panel.html                 # Provider 区块

test/
  windows-adapt.js           # 92 项 Windows 适配验证
  toml-roundtrip.js          # TOML 序列化/反序列化安全测试
  server-security.js         # Host/Origin/body cap/字段归一化
  codewhale-permission-security.js # 会话级规则/过期/fail-safe
  codewhale-hook-security.js # 服务身份与异常响应回退
  toml_v2.js / toml_verify.js # 辅助诊断脚本
```

---

## Windows 支持

CodeWhale provider 在 Windows 上可用，以下功能已适配：

- **Hook 安装**：TOML hook 命令中的路径自动正斜杠化（`path.sep` → `/`），避免 TOML 转义问题。
- **CodeWhale 查找**：使用 Windows 内置 `where` 命令（非 `which`），搜索 `%APPDATA%\npm`、`%LOCALAPPDATA%\Programs\CodeWhale`、`%ProgramFiles%\nodejs` 等路径。
- **权限桥接**：与 macOS/Linux 相同的 `/codewhale-permission` HTTP 机制。
- **「去回复」聚焦**：Windows 当前只采集有限进程信息；真正前台激活仍未实现，点击后回落到打开面板。
- **系统托盘**：运行时将 PNG 转换为 `.ico` 格式。

详见 [`WINDOWS.md`](WINDOWS.md)。

---

## 添加新 Provider

要为新的 coding agent（如 aider、Cursor 等）添加支持，需实现 `providers/base.js` 定义的接口：

1. **创建 `providers/<id>.js`**，导出一个满足以下字段的对象：
   - `id` / `displayName` — 标识符和显示名
   - `dirs` — 配置文件路径、数据目录
   - `hookScript` / `hookMarker` / `hookEvents` / `eventToPetState` — hook 注册信息
   - `permission` — 权限机制描述
   - `capabilities` — 功能开关（`permissionBubble` / `metering` / `sessionList` 等）
   - `installHooks()` / `uninstallHooks()` / `parseHookStdin()` — 核心方法

2. **在 `providers/index.js` 中注册**：导入并添加到 provider 列表。

3. **创建对应的 hook 脚本**（如需要）：参考 `hook/codewhale-hook.js`。

4. **如果需要新的后端模块**（权限/计量）：参考 `backend/codewhale-permission.js` 的接口形状。

5. **在 `renderer/panel.js` 的 `PROVIDER_META` 中添加**图标和标签。

6. **编写测试**验证新 provider 的解析/安装/卸载逻辑。

`base.js::validateProvider()` 会在加载时检查所有必需字段是否齐全，缺失的字段会以列表形式报告，不会静默失败。

---

## 已知限制与待办

- **CodeWhale 消息气泡**：已实现（`transcriptBubble: true`），但 `sessions/<UUID>.json` 中消息格式可能与 Claude Code 的 transcript 不完全一致，极端情况下可能显示异常。
- **CodeWhale context_usage**：由 `turn_end` 直接提供，无需 transcript 扫描。`contextUsage()` 返回 null（数据已在事件中传递）。
- **Focus（Linux）**：目前仅 macOS 和 Windows 支持「去回复」聚焦。Linux 桌面环境碎片化，暂未适配。
- **CodeWhale 模型价格更新**：使用 bundled catalog，不会实时同步最新价格。如需更新，替换 `backend/model-catalog.bundled.json` 即可。
- **多 provider 同时运行**：Claude Code 和 CodeWhale 可以同时启用，桌宠会合并显示所有活跃会话。但两个 provider 的 hook 事件是独立的，不会互相干扰。