# 🐙 Octopus — Claude Code 桌面宠物

一个实时盯着 **Claude Code**（及同类 coding agent）的桌面宠物：它会随 agent 的状态变表情（思考 / 干活 / 等你授权 / 完成庆祝 / 睡觉），把 Claude 说的话弹成气泡，遇到需要授权时让你一键允许 / 拒绝，并在详情面板里给出 **token 计量与花费**、用量趋势、会话列表。

共三款皮肤：章鱼 🐙、像素怪兽 👾、月薪喵 🐱（猫 meme 表情包，素材来自抖音 @月薪喵，见 `assets/cat/CREDITS.md`）。后端（状态机 / 计量 / 权限 / 进程对账）从零自有实现。整个项目以 **MIT** 开源，仅对接 Claude Code 的公开 hook 接口。

### 月薪喵皮肤 × 状态

| 表情 | 状态 | 什么时候出现 |
|:---:|:---|:---|
| <img src="assets/cat/cat-working.gif" width="72" alt="干活"> <img src="assets/cat/cat-working-2.gif" width="72" alt="干活2"> <img src="assets/cat/cat-working-3.gif" width="72" alt="干活3"> <img src="assets/cat/cat-working-4.gif" width="72" alt="干活4"> | 🛠️ **working 干活** | 正在调用工具 / 改文件——4 张打工姿态轮换：拍「上号」按钮 / 熬夜冠军 / 捂耳猛敲 / 边吃边敲 |
| <img src="assets/cat/cat-thinking.gif" width="72" alt="思考"> <img src="assets/cat/cat-thinking-2.gif" width="72" alt="思考2"> | 🤔 **thinking 思考** | 提交提问后 / 工具间隙的长推理——思考姿态轮换：挠头 / 躺想浮云 |
| <img src="assets/cat/cat-talking.gif" width="72" alt="回应中"> | 💬 **talking 回应中** | Claude 正在输出回复文本（对着笔记本疯狂输出喵喵喵） |
| <img src="assets/cat/cat-juggling.gif" width="72" alt="并行子任务"> | 🤹 **juggling 并行子任务** | 召唤 subagent 多线开工（趴键盘上还同时刷手机） |
| <img src="assets/cat/cat-sweeping.gif" width="72" alt="清理上下文"> | 🧹 **sweeping 清理** | 压缩 / 清理上下文（对手机喷消毒水） |
| <img src="assets/cat/cat-waiting.gif" width="72" alt="等你授权"> | ✋ **waiting 等你授权** | 需要你点「允许 / 拒绝」（抱着手机冒冷汗） |
| <img src="assets/cat/cat-needsinput.gif" width="72" alt="等你回复"> | ❓ **needsinput 等你回复** | 需要你选择 / 输入（头顶冒问号挠头） |
| <img src="assets/cat/cat-attention.gif" width="72" alt="需要注意"> | 🔔 **attention 看一眼** | 任务刚结束提醒你（从工位起身够手机看消息） |
| <img src="assets/cat/cat-happy.gif" width="72" alt="完成庆祝"> | 🎉 **happy 完成庆祝** | 一轮任务干完（摸小猫的头夸夸） |
| <img src="assets/cat/cat-greet.gif" width="72" alt="打招呼"> | 👋 **greet 打招呼** | 新会话开始（被闹钟炸醒弹射到工位） |
| <img src="assets/cat/cat-error.gif" width="72" alt="出错"> | 💥 **error 出错** | 执行失败 / API 报错（抱头崩溃大叫） |
| <img src="assets/cat/cat-loafing.gif" width="72" alt="摸鱼"> <img src="assets/cat/cat-loafing-2.gif" width="72" alt="摸鱼2"> <img src="assets/cat/cat-loafing-3.gif" width="72" alt="摸鱼3"> | 🍦 **loafing 摸鱼** | 上一步干完、下一步还没来的间隙——摸鱼轮换：躺地刷手机 / 点外卖 / 奶瓶手机 |
| <img src="assets/cat/cat-idle.gif" width="72" alt="待命"> | 🪑 **idle 待命** | 没有任务（转椅上冰淇淋+手机摸鱼） |
| <img src="assets/cat/cat-roam.gif" width="72" alt="闲逛"> | 🚶 **roam 闲逛** | 长时间空闲（撒腿跑着玩） |
| <img src="assets/cat/cat-sleeping.gif" width="72" alt="睡觉"> <img src="assets/cat/cat-sleeping-2.gif" width="72" alt="睡觉2"> | 😴 **sleeping 睡觉** | 会话结束 / 久无活动——睡姿轮换：被窝一坨 / 拔肚子毛当眼罩 |

---

## 工作原理

```
Claude Code ──(生命周期 hook)──► octopus-hook.js ──HTTP POST /state──┐
            ──(PermissionRequest HTTP hook，阻塞)──► /permission ──┤
                                                                   ▼
                                              ┌──────────────────────────────┐
                                              │  本地 HTTP server (127.0.0.1) │
                                              └──────────────┬───────────────┘
                                                             ▼
            会话状态机 (core) ── 适配器 ── pet:stats / pet:event ──► 桌宠/面板渲染
            计量扫描 (metering) ── 读 ~/.claude transcript → 算 token & 花费 ─┘
```

1. 安装时往 `~/.claude/settings.json` 注册两类钩子（**合并写入，不覆盖你已有的钩子**，卸载会先备份）：
   - **命令钩子**：Claude Code 在 `SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart …` 触发 `hook/octopus-hook.js`，它读 stdin + transcript 尾巴，POST 一个状态包给本地 server（`127.0.0.1:41330` 起）。
   - **PermissionRequest HTTP 钩子（阻塞）**：需要授权时 Claude Code POST `/permission` 并挂起，等桌宠回 `allow/deny`。
2. 本地 server 把状态喂给**会话状态机**；**适配器**翻译成前端契约（`pet:stats` 快照 + `pet:event` 事件）。
3. **计量模块**增量扫描 `~/.claude/projects/**/*.jsonl`，按 `message.id` 去重统计每轮 token，乘模型单价算花费，喂详情面板。

> **「Claude 客户端消息」**指的是 Claude Code（CLI agent）的回复内容——`Stop` 时从 transcript 抽最后一段 assistant 文本（截断 + 密钥脱敏），对应桌宠的 `💬` 气泡。（不是 Claude 桌面聊天 App 的消息。）

---

## 安装与运行

**前置条件**
- macOS（状态显示全平台可用；「去回复」终端聚焦等功能目前仅 macOS）
- Node.js ≥ 18（含 npm）
- 已安装并用过 [Claude Code](https://claude.com/claude-code)（桌宠通过它的公开 hook 接口感知状态）

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm install          # 装 electron（国内网络慢可加：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install）
npm start            # 启动桌宠（首次启动会注册 Claude Code 钩子）
```

启动后**新开**的 `claude` 会话即被感知（已开着的会话从下一个事件起出现）。右键桌宠可切三款皮肤。

- 首次启动会把钩子写进 `~/.claude/settings.json`（合并、可逆）。之后新开的 `claude` 会话即被桌宠感知。
- **左键点桌宠** = 弹出**会话列表**（每行：状态点 + 会话名 + 上下文用量%），点某行把该会话的终端调到前台；没有会话时给「新开 Claude」按钮。
- **右键** = 泡泡菜单；**拖动** = 移动位置。等授权/等回复时会**自动**弹允许/拒绝气泡。
- 托盘菜单可开详情面板、静音、唤起 Claude、打开日志、**卸载钩子**、退出。
- 详情面板里可切皮肤 / 模式 / 设 5h 预算。
- **🥊 领地模式**（macOS）：右键桌宠点“巡视”可立即扫描并执行一次；托盘可开启“自动巡逻”，开启后立即首巡、随后定时轮询（默认关）。两条定律：①**猫爪在上**——检测到别的桌面宠物（Desktop Goose / BongoCat / Shimeji 等）在跑，就把自己的窗口层级抬到最上，谁也不许压着咱（无需额外权限）；②**巡视行动**——发现对方窗口，小章鱼走过去把它一步步**顶到屏幕边上**。巡视需要**辅助功能**权限（移动别人的窗口）；没授权时「巡视」仍会执行猫爪在上，只是不推窗。物理拖拽档（对付 AXPosition 失效的透明窗宠物）只在你**输入空闲 ≥2s** 时才动真鼠标，你手上有活它就静默撤退。自定义对手：`~/.octopus/config.json` 的 `territoryRivals` 数组加进程名关键词。

### 开发 / 验证开关
- `OCTOPUS_NO_HOOKS=1 npm start` —— 启动但**不动** `~/.claude/settings.json`（只验证主进程 / 界面）。
- `OCTOPUS_ALLOW_MULTI=1 npm start` —— 跳过多实例防护（默认：实例锁 + 启动探测到别的 Octopus 实例就退出 + 存活期间守护 `runtime.json` 不被其他副本抢走）。
- `OCTOPUS_NO_NET=1 npm start` —— **完全离线**：关掉唯一的外联请求（每 24h 拉一次 [LiteLLM 公开价目表](https://github.com/BerriAI/litellm)，只下载、不上传任何本地数据），花费改用内置估算单价。
- `OCTOPUS_DEBUG=1 npm start` —— 开放 `GET /debug`（默认关闭，会暴露会话 cwd / 标题等，仅本机回环可访问）。
- `OCTOPUS_TERRITORY_RIVALS=TextEdit OCTOPUS_TERRITORY_INTERVAL=4000 npm start` —— 领地模式调试：临时追加对手进程名（逗号分隔）/ 调巡逻间隔（ms），配合托盘开关做实机验证。
- `npm test` —— 无头端到端冒烟测试（hook→server→core→adapter、权限持开→decide 字节级响应）。
- 日志：`~/.octopus/octopus.log`。

### 计量 / 计费
- 数据源：本机 `~/.claude/projects/**/*.jsonl`（只读 token 数 / 模型 / 时间戳，**不读内容**）。
- 状态持久化：`~/.octopus/usage.json`（含 90 天日历、游标）。首次启动会回填近 95 天历史。
- **按完整 model id 精确计价**：从 [LiteLLM 公开价目表](https://github.com/BerriAI/litellm) 同步每个模型的真实单价（opus 各代、fable、sonnet 各代各自独立），未同步时回退家族估算。可用 `~/.octopus/pricing.json` 覆盖（家族键或精确 `models` 映射）：
  ```json
  { "opus": {"input":15,"output":75,"cacheWrite":18.75,"cacheRead":1.5},
    "models": { "claude-fable-5": {"input":10,"output":50,"cacheWrite":12.5,"cacheRead":1} } }
  ```
  （单位：美元 / 百万 token。）
- **重算历史**：改了定价、或想用最新价目纠正过去存错价的历史，跑 `npm run meter:rebuild`（从 transcript 真相源重扫重算、写回 `usage.json`；`--no-sync` 用现有缓存价、`OCTOPUS_NO_NET=1` 完全离线）。

### 卸载钩子
托盘「🧹 卸载 Claude 钩子」，或：
```bash
npm run uninstall:hooks
```

---

## 目录结构

```
main.js                 Electron 主进程：窗口 / IPC / 托盘 / 启动编排
preload.js              前后端唯一接口（contextBridge）
renderer/  assets/      桌宠 + 面板的视觉与渲染
hook/
  octopus-hook.js        Claude Code 触发的钩子脚本（读 stdin/transcript，POST /state）
backend/
  transport.js          端口发现 / runtime 文件 / 标识头 / 钩子→server 传输 / node 定位
  transcript.js         transcript 解析（assistant 文本 / 上下文用量 / API 错误 / 标题）
  pidwalk.js            进程树解析（定位会话所在终端）
  hookinstall.js        merge-safe 钩子安装器（合并不覆盖 / 原子写 / 卸载备份）
  launch.js             开终端跑 claude
  core.js               会话存储 + 状态机 + 快照 + 陈旧清理
  server.js             本地 HTTP server（/state /permission /health）
  permission.js         授权持开/决策（字节级 CC 响应）
  adapter.js            内部模型 → 前端契约（事件 + 统计 + choice）
  metering.js           计量 + 计费（transcript 扫描 + 定价 + 持久化）
  hooks.js              钩子生命周期（安装 + settings 监视器）
  focus.js              定位会话（mac 优先）
  territory.js          领地模式（扫描别的桌宠 + 推窗驱逐战编排）
  config.js  log.js     配置持久化 / 日志
test/smoke.js           端到端冒烟测试
```

---

## 风险与权衡（已知）

| 项 | 说明 | 现状 / 缓解 |
|---|---|---|
| **本地 /permission 伪造** | 任何本机进程都能 POST `/permission` 弹一个假授权气泡 | 仅绑 `127.0.0.1` + loopback 校验；点「允许」只把决策回给持连接者，**无法让 Claude 执行任何东西**；属社工风险 |
| **本地 /state 伪造** | 本机进程可驱动桌宠动画 / 假气泡 | 仅装饰性，localhost-only |
| **钩子残留** | 退出后钩子仍在，Claude Code 每个事件会 spawn 一次钩子（连不上 server，100ms 超时） | 影响极小；托盘可一键卸载 |
| **定价准确度** | 内置单价为估算，未单独处理 1M 上下文变体 | 可用 `~/.octopus/pricing.json` 覆盖 |
| **读 transcript** | 读取本机 `~/.claude` 下的会话记录 | 仅本地、仅 token 计数，不外传、不读正文 |
| **focusSession** | 「去回复」目前仅 macOS 生效 | Windows/Linux 需原生 helper，暂未实现 |
| **计量去重边界** | 流式重复行若跨两次扫描被切开，可能极小概率重复计数 | 同文件内已去重；概率极低 |

### 安全加固（已做）
- HTTP 仅 `127.0.0.1` + loopback 校验；body 上限（state 4KB / permission 1MB）；全字段规范化校验。
- 配置 / 用量 / settings 全部**原子写**；钩子安装**合并不覆盖**、卸载先备份；settings 被外部清空时自动重注册。
- Electron：`contextIsolation` 开、`nodeIntegration` 关、拦截外部导航与 `window.open`。
- assistant 文本截断 + 控制字符清洗；命令行密钥样式标题脱敏（钩子内置）。

---

## 未做 / 后续
- 多 agent（Codex / Gemini / Copilot…）：本项目刻意只做 Claude Code。
- Windows / Linux 的会话定位、远程审批、自动更新：本项目暂未实现。
