# 🐙 Octopus — Claude Code / CodeWhale 桌面宠物

一个实时盯着 **Claude Code** 及 **CodeWhale**（开源 Rust 终端 coding agent）等 coding agent 的桌面宠物：它会随 agent 的状态变表情（思考 / 干活 / 等你授权 / 完成庆祝 / 睡觉），把 agent 的回复弹成气泡，遇到需要授权时让你一键允许 / 拒绝，并在详情面板里给出 **token 计量与花费**、用量趋势、会话列表。

共三款皮肤：章鱼 🐙、像素怪兽 👾、月薪喵 🐱（猫 meme 表情包，素材来自抖音 @月薪喵，见 `assets/cat/CREDITS.md`）。后端（状态机 / 计量 / 权限 / 进程对账）从零自有实现。整个项目以 **MIT** 开源，通过 Claude Code 与 CodeWhale 的公开 hook 接口接入；不注入 agent 进程。

---

## ✨ v0.1.1 更新亮点

本版本在 v0.1.0 基础上做了 **46 个文件、+1,895 / −1,214 行**的深度加固。核心改进如下，详见 [CHANGELOG.md](CHANGELOG.md) 与 [DEEP_AUDIT_REPORT.md](DEEP_AUDIT_REPORT.md)：

### 🐋 CodeWhale 一等公民支持

- **新增独立 provider 架构**：`providers/codewhale.js` + `hook/codewhale-hook.js` + `backend/codewhale-permission.js` + `backend/metering-codewhale.js`，与 Claude Code 完全并行、互不污染。
- **状态映射**：CodeWhale 的 `turn_start` / `tool_call_before` / `tool_call_after` / `turn_end` / `session_end` 全部映射到桌宠状态机，干同样多的活（思考 / 调用工具 / 等授权 / 完成 / 睡觉）。
- **权限桥**：CodeWhale 的 `tool_call_before` 钩子转发到本地 `/codewhale-permission`，桌宠弹气泡让你一键 allow / deny / 本会话允许全部；服务不可达、身份头错、响应畸形、队列溢出、勿扰模式下**统一回退 `ask`**，永不 fail-open。
- **TOML 幂等安装**：往 `~/.codewhale/config.toml` 写入 10 个完整 `[[hooks.hooks]]` 条目；重复安装只替换自己的 marker 条目，不破坏用户已有 hook；卸载只删自己的，保留注释与排序。
- **计量**：`turn_end` 事件自带 `usage`，按 bundled 模型目录计价，与 Claude 计量一起进面板的今日 / 5h 窗口 / 按模型 / 按天 / 90 天日历。
- **模型目录 v2（2026-07-20 厂商价格核对）**：catalog 从 31 个条目扩到 49 个，覆盖 CodeWhale ModelRegistry 全部已注册模型（DeepSeek / OpenAI / Anthropic / Z.AI / Moonshot / Xiaomi MiMo / MiniMax / Alibaba Qwen / StepFun / Sakana Fugu / Meituan LongCat / Meta Muse / xAI Grok / Arcee Trinity）。**缓存费率按厂商官网公布值**——不再套用 10%/1.25× 启发式（Xiaomi MiMo 实际 2%、Z.AI GLM 18.6%、xAI Grok 15-20%、MiniMax M3 20%）。修正了 `gpt-5.6-terra` / `gpt-5.6-luna` 的错误价格、`grok-build` / `grok-4.20` 的错误 context_window。未知模型 honest 返回 null（token-only），不再伪造 $1/$5 默认价。详见 [CODEWHALE.md](CODEWHALE.md) §Token 计量与花费。
- **Models.dev 实时价格同步（与 CodeWhale 上游一致）**：新增 `backend/models-dev-sync.js`，启动后后台异步从 [models.dev/catalog.json](https://models.dev/catalog.json)（[MIT 协议](https://github.com/anomalyco/models.dev)，与本项目相同）拉取最新模型价格，24 小时 TTL，原子写入 `~/.octopus/catalog/models-dev.json`。失败时优雅降级到 bundled seed，永不影响桌宠启动。三层查询：`live cache > bundled seed > null`。修正了 DeepSeek 系列价格（旧 catalog 误把 CNY 价当 USD，高估 4-9 倍）。可通过 `OCTOPUS_DISABLE_MODELS_DEV_FETCH=1` / `OCTOPUS_MODELS_DEV_URL=<url>` / `OCTOPUS_MODELS_DEV_PATH=<path>` 控制。
- 详见 [CODEWHALE.md](CODEWHALE.md)。

### 🪟 Windows 原生便携构建

- 新增 `scripts/package-win.sh`：从 npmmirror 拉取官方 win32-x64 Electron 二进制，落地为 **`Octopus-win-x64-0.1.1.zip`**（约 141 MB）。
- 解压即用：双击 `run.bat` 启动；`create-desktop-shortcut.bat` 一键建桌面快捷方式（带章鱼图标）；`uninstall-hooks.bat` 用 `ELECTRON_RUN_AS_NODE=1` 跑卸载脚本，不需要单独装 Node。
- `electron.exe` 重命名为 **`Octopus.exe`**，任务管理器 / 文件管理器里看到的是自己的产品名，不再是 electron.exe。
- 兼容 Windows 10 1809+ / Windows 11 x64；Chromium 沙箱默认开启（`--no-sandbox` 仅作排障开关）。

### 🔒 Electron 安全边界全面收紧

- 渲染器开启 `sandbox: true` / `contextIsolation: true` / `webSecurity: true`，关闭 `nodeIntegration` / `webviewTag` / `unsafeInline` / 默认 DevTools。
- 严格 CSP：`default-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'`，禁止任何外联网络与外部脚本。
- 拦截导航、新窗口、下载、媒体与设备权限；所有 IPC 通道校验 sender 的 webContents 与精确 file URL 匹配。
- 渲染端动态字符串全部走 `escapeHtml`，数字走 `.toFixed()`，修掉 upstream 漏掉的 `${o.icon}` / `${m.icon}` HTML 注入面。
- Electron 升级 **43.1.1**（Chromium 150.0.7871.114 / Node.js 24.18.0）。

### 🛡️ 本地 HTTP 接口安全升级

- 不再仅依赖 `127.0.0.1`：每次启动用 `crypto.randomBytes(32)` 生成 256-bit 随机令牌，`timingSafeEqual` 比对。
- 校验 `Host`（防 DNS rebinding，手动解析 IPv6 括号与端口范围）、`Origin` / `Referer`（拒绝浏览器请求）、`x-octopus-server` 服务身份头。
- 多重上限：body（state 16 KB / permission 1 MB）、连接数、请求头数、字段长度、慢请求 10 秒超时；残缺请求 10 秒后返回 408 不再长期占用连接。
- 运行文件 `runtime.json` 0600，敏感目录 0700，文件 0600。

### ⚡ 长期运行性能与计量正确性

- transcript 改为 **4 MiB 固定内存分块读取**，单轮扫描总预算 **32 MiB**，会话上限 **256**，启动文件扫描上限 **5,000**，超长单行跳过不卡死游标。
- transcript 没有变化时跳过重复解析；日志改成异步有界队列；统计定时器防重叠执行。
- 计量状态用 **无原型字典**（`Object.create(null)`）+ `safeMapKey` 拒绝 `__proto__` / `prototype` / `constructor`，阻断原型污染。
- 拒绝 `Infinity` / 负数 / 异常大的 token 与 cost；配置 / 计量状态 / 价格缓存采用**原子写入**（`tmp + rename`）。
- 修复模型别名在基础价格缺失时绕过默认计价的漏洞。

### 🧩 跨平台与体验修复

- 默认启动**不再携带 `--no-sandbox`**；路径含空格 / 引号 / 特殊字符时也能正确启动。
- 修复 Unix 下 `command -v` 探测 CodeWhale 的兼容性问题。
- 显示器拔插或分辨率变化后，窗口会**自动回到可见工作区**（`display-added/removed/metrics-changed` 触发 `scheduleDisplayRepair`）。
- 详情面板开在 pet 所在的显示器上（修掉 upstream 多显示器错屏 bug）。
- provider 禁用后自动卸载旧 hook；服务启动稍慢时按 250ms 间隔最多重试 40 次（10 秒），避免漏装 hook。
- Windows 卸载 hook 用正确的 Electron Node 模式（`ELECTRON_RUN_AS_NODE=1`）。

### 🧪 验证结果

| 项目 | 结果 |
|---|---|
| 核心测试 | **18/18 通过**（60 个 JS 文件语法遍历） |
| Windows 适配断言 | **92/92 通过** |
| 压力请求 | 401 次 / 0 失败；p50 **33 ms** / p95 **54 ms**（50 并发） |
| 残缺 HTTP 请求 | ~10 秒返回 408，随后 200 立即恢复 |
| 400 个伪会话输入后 | 稳定限制为 **256/256** |
| ESLint Security | 0 error / 131 warning |
| 高置信度密钥扫描 | 0 命中 |
| `npm audit` | 所有严重度均为 **0** |
| `npm ls --all` | 无 missing / invalid / extraneous |

> ⚠️ **发布前必须做的真机验收**（受限于环境，未在本轮完成）：三平台 BrowserWindow / 托盘 / 透明窗口真实启动、Windows 代码签名、macOS codesign + notarization、休眠唤醒、多显示器长期 soak test。详见 [DEEP_AUDIT_REPORT.md](DEEP_AUDIT_REPORT.md) §目标平台发布验收步骤。

---

## 月薪喵皮肤 × 状态

| 表情 | 状态 | 什么时候出现 |
|:---:|:---|:---|
| <img src="assets/cat/cat-working.gif" width="72" alt="干活"> <img src="assets/cat/cat-working-2.gif" width="72" alt="干活2"> <img src="assets/cat/cat-working-3.gif" width="72" alt="干活3"> <img src="assets/cat/cat-working-4.gif" width="72" alt="干活4"> | 🛠️ **working 干活** | 正在调用工具 / 改文件——4 张打工姿态轮换：拍「上号」按钮 / 熬夜冠军 / 捂耳猛敲 / 边吃边敲 |
| <img src="assets/cat/cat-thinking.gif" width="72" alt="思考"> <img src="assets/cat/cat-thinking-2.gif" width="72" alt="思考2"> | 🤔 **thinking 思考** | 提交提问后 / 工具间隙的长推理——思考姿态轮换：挠头 / 躺想浮云 |
| <img src="assets/cat/cat-talking.gif" width="72" alt="回应中"> | 💬 **talking 回应中** | coding agent 正在输出回复文本（对着笔记本疯狂输出喵喵喵） |
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
Claude Code ──生命周期/权限 hooks──► octopus-hook.js ───────┐
CodeWhale  ──TOML lifecycle hooks──► codewhale-hook.js ───────┼─► 本地 HTTP server (127.0.0.1)
           ──tool_call_before 权限桥──► /codewhale-permission ─┘             │
                                                                             ▼
                                      provider 解析 → 会话状态机 → adapter → 桌宠/面板
                                      Claude transcript / CodeWhale turn_end → token 与花费
```

1. Claude Code 启用时往 `~/.claude/settings.json` 注册两类钩子（**合并写入，不覆盖已有钩子**，卸载前备份）：
   - **命令钩子**：Claude Code 在 `SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart …` 触发 `hook/octopus-hook.js`，它读 stdin + transcript 尾巴，POST 一个状态包给本地 server（`127.0.0.1:41330` 起）。
   - **PermissionRequest HTTP 钩子（阻塞）**：需要授权时 Claude Code POST `/permission` 并挂起，等桌宠回 `allow/deny`。
2. 本地 server 把状态喂给**会话状态机**；**适配器**翻译成前端契约（`pet:stats` 快照 + `pet:event` 事件）。
3. Claude Code 计量模块按固定内存分块增量扫描 `~/.claude/projects/**/*.jsonl`；单轮总读取量和 transcript 数量均有上限。CodeWhale 从 `turn_end` 事件直接记账。两者统一进入详情面板。
4. CodeWhale provider 启用后，使用幂等 TOML 合并器向 `~/.codewhale/config.toml` 写入 10 个完整 `[[hooks.hooks]]` 条目；重复安装不会拆坏用户已有条目，卸载只移除 Octopus 自己的条目。

> **「Claude 客户端消息」**指的是 Claude Code（CLI agent）的回复内容——`Stop` 时从 transcript 抽最后一段 assistant 文本（截断 + 密钥脱敏），对应桌宠的 `💬` 气泡。（不是 Claude 桌面聊天 App 的消息。）

---

## 安装与运行

**前置条件**
- macOS / Windows / Linux（核心状态、权限与计量可用；「去回复」终端聚焦和领地模式仅 macOS）
- Node.js ≥ 18（含 npm）
- 已安装并用过 [Claude Code](https://claude.com/claude-code) 或 [CodeWhale](https://github.com/Hmbown/CodeWhale)（桌宠通过公开 hook 接口感知状态）
- Windows 用户另见 [WINDOWS.md](WINDOWS.md)（安装注意事项、已知限制、故障排查）

```bash
git clone https://github.com/purrfecto114-lgtm/LLMPET.git
cd LLMPET
npm ci               # 严格按 package-lock.json 安装；开发中改依赖时再用 npm install
npm start            # 启动桌宠；首次启动注册 Claude hooks，可在面板启用 CodeWhale
```

启动后**新开**的 `claude` 会话即被感知（已开着的会话从下一个事件起出现）。右键桌宠可切三款皮肤。

- 首次启动会把钩子写进 `~/.claude/settings.json`（合并、可逆）。之后新开的 `claude` 会话即被桌宠感知。
- **左键点桌宠** = 弹出**会话列表**（每行：状态点 + 会话名 + 上下文用量%），点某行把该会话的终端调到前台；没有会话时给「新开 Claude」按钮。
- **右键** = 泡泡菜单；**拖动** = 移动位置。等授权/等回复时会**自动**弹允许/拒绝气泡。
- 托盘菜单可开详情面板、静音、唤起 Claude、打开日志、**卸载钩子**、退出。
- 详情面板里可切皮肤 / 模式 / 设 5h 预算。
- **🥊 领地模式**（仅 macOS）：右键桌宠点“巡视”可立即扫描并执行一次；托盘可开启“自动巡逻”，开启后立即首巡、随后定时轮询（默认关）。两条定律：①**猫爪在上**——检测到别的桌面宠物（Desktop Goose / BongoCat / Shimeji 等）在跑，就把自己的窗口层级抬到最上，谁也不许压着咱（无需额外权限）；②**巡视行动**——发现对方窗口，小章鱼走过去把它一步步**顶到屏幕边上**。巡视需要**辅助功能**权限（移动别人的窗口）；没授权时「巡视」仍会执行猫爪在上，只是不推窗。对付 AXPosition 失效的透明窗桌宠时，会像 Computer Use 一样显示独立的橙色爪软件光标；底层兼容拖拽仍只在你**输入空闲 ≥2s** 时执行，期间隐藏系统光标，结束或异常都会补发 mouseUp 并把原光标复位，你手上有活时则静默撤退。自定义对手：`~/.octopus/config.json` 的 `territoryRivals` 数组加进程名关键词。

### 开发 / 验证开关
- `OCTOPUS_NO_HOOKS=1 npm start` —— 启动但**不动** `~/.claude/settings.json`（只验证主进程 / 界面）。
- `OCTOPUS_ALLOW_MULTI=1 npm start` —— 跳过多实例防护（默认：实例锁 + 启动探测到别的 Octopus 实例就退出 + 存活期间守护 `runtime.json` 不被其他副本抢走）。
- `OCTOPUS_NO_NET=1 npm start` —— **完全离线**：关掉所有外联请求——CodeWhale 的 [models.dev](https://models.dev) catalog 同步 + Claude 的 [LiteLLM](https://github.com/BerriAI/litellm) 价目表同步——只下载、不上传任何本地数据；花费改用内置估算单价。
- `OCTOPUS_DEBUG=1 npm start` —— 开放 `GET /debug`（默认关闭，会暴露会话 cwd / 标题等；仍要求本次启动的随机令牌）。
- `OCTOPUS_DEVTOOLS=1 npm start` —— 仅开发调试时开放 DevTools；正式运行默认关闭。
- `OCTOPUS_DISABLE_CHROMIUM_SANDBOX=1` —— **仅用于排障**的显式降级开关；正常启动和发布包默认保留 Chromium 沙箱。
- `OCTOPUS_DISABLE_MODELS_DEV_FETCH=1` —— 仅禁用 CodeWhale 的 models.dev catalog 拉取（保留 Claude 的 LiteLLM 同步）；离线 / 网络受限场景使用。
- `OCTOPUS_MODELS_DEV_URL=<url>` —— 覆盖 models.dev catalog URL（自建镜像 / 内网代理）。
- `OCTOPUS_MODELS_DEV_PATH=<path>` —— 从本地文件读 catalog（完全离线 / 调试），跳过网络。
- `OCTOPUS_TERRITORY_RIVALS=TextEdit OCTOPUS_TERRITORY_INTERVAL=4000 npm start` —— 领地模式调试：临时追加对手进程名（逗号分隔）/ 调巡逻间隔（ms），配合托盘开关做实机验证。
- `npm test` / `npm run test:core` —— 20 文件无头套件：60+ 个 JavaScript 文件语法遍历、状态机、server 输入边界、权限 fail-safe、计量持久化/大文件边界、TOML 往返、models.dev 同步、仓库一致性等。
- `npm run test:windows` —— Windows 适配测试（92 项；需先 `npm ci`）。
- `npm run test:all` —— 核心套件 + Windows 静态/跨平台适配套件。
- 日志：`~/.octopus/octopus.log`。CodeWhale catalog 同步状态：`~/.octopus/catalog/models-dev.json`。


### 打包与下载

**直接下载预构建 Windows 便携包**（无需自己打包）：

- **`Octopus-win-x64-0.1.1.zip`**（约 141 MB）— 解压即用，双击 `run.bat` 启动；详见 [WINDOWS-INSTALL.md](WINDOWS-INSTALL.md) 与 [WINDOWS.md](WINDOWS.md)。

**自己打包**：

```bash
npm run package:mac      # macOS .app / zip 脚本
npm run package:linux    # Linux 便携目录 / tar.gz 脚本
npm run package:win      # Windows 便携目录/zip 脚本（需 curl + unzip + zip）
```

`dist:mac`、`dist:linux`、`dist:win` 是以上命令的兼容别名。当前仓库以 `scripts/package-*.sh` 为唯一打包真相源，未混用缺少锁文件依赖的 electron-builder 配置。Windows 打包脚本会自动从 npmmirror 下载官方 win32-x64 Electron 二进制（约 138 MB，首次下载后缓存复用），把 `electron.exe` 重命名为 `Octopus.exe`，并生成 `run.bat` / `create-desktop-shortcut.bat` / `uninstall-hooks.bat` 三个启动器。

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

### 手动安装 / 卸载钩子
桌宠正常启动后会自动安装当前已启用 provider 的钩子。需要手动重装 Claude 钩子时，必须先保持桌宠正在运行（安装器需要读取本次启动的随机令牌）：
```bash
npm run install:hooks
```

托盘「🧹 卸载所有钩子」，或：
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
  octopus-hook.js        Claude Code hook（读 stdin/transcript，POST /state）
  codewhale-hook.js       CodeWhale hook（状态转发 + fail-safe 权限决策）
backend/
  transport.js          端口发现 / runtime 文件 / 标识头 / 钩子→server 传输 / node 定位
  transcript.js         transcript 解析（assistant 文本 / 上下文用量 / API 错误 / 标题）
  pidwalk.js            进程树解析（定位会话所在终端）
  hookinstall.js        merge-safe 钩子安装器（合并不覆盖 / 原子写 / 卸载备份）
  launch.js             开终端跑 claude
  core.js               会话存储 + 状态机 + 快照 + 陈旧清理
  server.js             本地 HTTP server（/state /permission /health）
  permission.js         Claude Code 授权持开/决策
  codewhale-permission.js CodeWhale 授权池（会话级规则、TTL、队列上限）
  toml-hooks.js          CodeWhale TOML 幂等安装/精确卸载
  adapter.js            内部模型 → 前端契约（事件 + 统计 + choice）
  metering.js           计量 + 计费（transcript 扫描 + 定价 + 持久化）
  hooks.js              钩子生命周期（安装 + settings 监视器）
  focus.js              定位会话（macOS only）
  territory.js          领地模式（仅 macOS：扫描别的桌宠 + 推窗驱逐战编排）
  tray-icon.js          Windows 托盘 .ico 运行时生成（tray.png → tray.ico）
  config.js  log.js     配置持久化 / 日志
  safe-json.js           启动期小型 JSON/TOML 有界读取
  metering-state.js      计量状态清洗 / 动态键防原型污染
providers/
  base.js               provider 抽象基类
  claude.js             Claude Code provider
  codewhale.js          CodeWhale provider（含 Windows 适配）
  index.js              provider 切换逻辑
CODEWHALE.md            CodeWhale provider 与权限/TOML 说明
WINDOWS.md              Windows 安装/已知限制/故障排查
SECURITY.md             本地威胁模型与安全约束
AUDIT_REPORT.md         第一轮全面审计与上游同步记录
DEEP_AUDIT_REPORT.md    运行期安全、性能与体验深审计记录
test/run-all.js         核心测试入口（18 文件）
test/windows-adapt.js   Windows 适配测试（92 项）
```

---

## 风险与权衡（已知）

| 项 | 说明 | 现状 / 缓解 |
|---|---|---|
| **本地接口伪造** | 未持有令牌的浏览器页面或同机进程尝试伪造状态/授权 | 仅绑 `127.0.0.1`，并要求每次启动随机令牌、Host/Origin/Referer 与服务身份校验；运行文件为 0600。已被同一系统账号完全控制的恶意进程仍在威胁模型之外 |
| **钩子残留** | 退出后 agent 仍可能触发已注册 hook | Claude 快速失败；CodeWhale 明确输出 `ask`，交回原生权限提示；托盘可一键卸载 |
| **定价准确度** | 内置单价为估算，未单独处理 1M 上下文变体 | 可用 `~/.octopus/pricing.json` 覆盖 |
| **读 transcript** | 读取本机会话记录 | token/模型/时间戳用于计量；最后一段回复用于本地气泡；均截断、清洗且不外传 |
| **focusSession** | 「去回复」目前仅 macOS 生效 | Windows/Linux 需原生 helper，暂未实现。详见 WINDOWS.md §3 |
| **超大历史 transcript** | 首次回填可能涉及较多磁盘数据 | 固定 4 MiB 分块、单轮 32 MiB 总预算、最多 5000 个文件、轮转扫描；超长单行会跳过而不会卡死游标 |

### 安全加固（已做）
- HTTP 仅 `127.0.0.1`，每次启动生成随机令牌；校验 loopback、Host、Origin/Referer、令牌和服务身份；body 上限（state 16KB / permission 1MB）；慢请求 10 秒超时；连接、请求头和字段均有上限。
- CodeWhale 授权桥在服务不可达、身份头错误、响应畸形、队列溢出或勿扰模式下统一返回 `ask`，不再依赖空 stdout；批量授权仅限当前会话，30 分钟滑动过期。
- 配置 / 用量 / settings / 价格缓存采用私有权限和**原子写**；启动读取有体积上限；计量状态使用无原型字典并过滤危险键、NaN/Infinity 和异常集合。钩子安装**合并不覆盖**、卸载先备份。
- Electron 43.1.1：渲染器 `sandbox` / `contextIsolation` / `webSecurity` 开，`nodeIntegration` / `webviewTag` 关；CSP 禁止外部脚本与网络连接；拦截导航、新窗口、下载、设备/媒体权限，并校验每个 IPC 的 sender 与本地页面。
- assistant 文本截断 + 控制字符清洗；命令行密钥样式标题脱敏（钩子内置）。

---

## 未做 / 后续
- 多 agent（Codex / Gemini / Copilot…）：本项目支持 Claude Code + CodeWhale 双 provider，可扩展。
- Windows/Linux focus tracking（「去回复」终端聚焦）：需原生 helper，暂未实现。详见 WINDOWS.md。
- Windows 领地模式：需 Win32 MoveWindow + 窗口枚举，复杂且低价值，暂未实现。
- 远程审批、自动更新：暂未实现。
