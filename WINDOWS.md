# Windows 平台支持说明

> Octopus (LLMPET → CodeWhale 适配版) 在 Windows 上的支持状态、已知限制与故障排查。
> 对应代码：`providers/codewhale.js` (W1/W2)、`backend/launch.js` (W3)、`main.js` (W4)、`backend/tray-icon.js` (W5)。

---

## 一、安装

### 前置条件
- **Windows 10 1809+** 或 **Windows 11**（推荐 Win11，自带 Windows Terminal）。
- **Node.js 18+**（LTS 推荐）。从 https://nodejs.org 下载，或用 `winget install OpenJS.NodeJS.LTS`。
- **Claude Code**：`npm install -g @anthropic-ai/claude-code`（2025 起原生支持 Windows）。
- **CodeWhale**（可选，启用 🐋 provider 时）：`npm install -g codewhale`。
- **Windows Terminal**（推荐）：Win11 自带；Win10 从 Microsoft Store 安装。未安装时自动降级到 `cmd.exe`。

### 安装 Octopus
```powershell
cd C:\path\to\llmpet-codewhale
npm ci
npm start
```

首次启动会：
1. 在 `%USERPROFILE%\.claude\settings.json` 注册 Claude Code hooks（幂等、merge-safe）。
2. 在 `%USERPROFILE%\.codewhale\config.toml` 注册 CodeWhale hooks（仅当启用 codewhale provider 时）。
3. 在 `%APPDATA%\octopus\tray.ico` 生成多尺寸托盘图标（W5，从 `assets/tray@2x.png` 生成，缓存）。

---

## 二、已支持的 Windows 功能 ✅

| 功能 | 状态 | 代码位置 | 备注 |
|---|---|---|---|
| 状态机表情 | ✅ 完全可用 | `backend/core.js`, `renderer/pet.js` | GIF/SVG 软件渲染（W4 关闭 GPU 合成） |
| Claude Code 权限气泡 | ✅ 完全可用 | `backend/permission.js` | 阻塞 HTTP hook |
| CodeWhale 权限气泡 | ✅ 完全可用 | `backend/codewhale-permission.js` | `tool_call_before` 阻塞决策 |
| Token/花费计量 | ✅ 完全可用 | `backend/metering*.js` | Claude + CW 合并显示 |
| 会话列表 | ✅ 完全可用 | `backend/core.js`, `renderer/panel.js` | 🐋 标识 CW 会话 |
| 终端启动 | ✅ 完全可用 | `backend/launch.js` | wt.exe 包 cmd.exe /c（W3） |
| CodeWhale 二进制定位 | ✅ 完全可用 | `providers/codewhale.js::findCodeWhale` | `where` + 路径候选（W1） |
| TOML hook 安装 | ✅ 完全可用 | `backend/toml-hooks.js` | 命令路径正斜杠化（W2） |
| Provider 切换 UI | ✅ 完全可用 | `renderer/panel.js` | checkbox + 实时 hook 安装/卸载 |
| 托盘图标 | ✅ 完全可用 | `backend/tray-icon.js`, `main.js` | 运行时生成 .ico（W5） |
| 透明无边框窗口 | ✅ 完全可用 | `main.js` | `disableHardwareAcceleration`（W4） |

---

## 三、已知限制（graceful degradation）⚠️

以下功能在 Windows 上**不可用或降级**，属于设计决策（非 bug）。原因与替代方案见下表。

### 1. Focus tracking（"💬 去回复"按钮）
- **状态**：❌ Windows 不可用。点击"去回复"无效果，需手动切换到终端窗口。
- **原因**：macOS 用 `osascript` 激活 GUI 应用；Windows 无纯 JS 方案获取/激活前台窗口 PID，需 PowerShell `Add-Type` 内联 C# 调 `GetForegroundWindow`/`SetForegroundWindow`（~200-500ms 延迟，且 PowerShell 子进程可能闪窗）。
- **代码位置**：`backend/focus.js` — `process.platform !== 'darwin'` 守卫提前返回 false。
- **决策依据**：focus 是便利功能，核心功能（状态/权限/计量/会话）不依赖它。完整实现成本高、价值低、有副作用。
- **临时替代**：用 `Alt+Tab` 手动切换到终端。

### 2. Territory（巡视/拔河模式）
- **状态**：❌ Windows 不可用。面板已隐藏 territory 控件。
- **原因**：territory 全 macOS 实现（`osascript` + `swiftc` + AXPosition API）。Windows 等价需 `EnumWindows` + `MoveWindow` + 进程匹配，复杂度极高，且移动其他应用窗口有安全隐患。
- **代码位置**：`backend/territory.js` — `platform !== 'darwin'` 守卫不启动。
- **决策依据**：趣味性功能，Windows 实现成本与风险均高，不在核心适配范围内。

### 3. Hook 控制台闪窗（Claude Code & CodeWhale）
- **状态**：⚠️ 可能偶发。Claude Code / CodeWhale 每次 spawn hook 子进程时，可能短暂闪一个 cmd.exe 控制台窗。
- **原因**：这是**上游问题**——hook 子进程的父进程是 coding agent（Claude Code 或 CodeWhale），不是 Octopus。闪窗来自 agent 自身的 `child_process.spawn` / `std::process::Command` 调用未设置 `CREATE_NO_WINDOW` flag。
  - Claude Code：上游已跟踪多个 issue（[#17230](https://github.com/anthropics/claude-code/issues/17230)、[#14828](https://github.com/anthropics/claude-code/issues/14828)、[#19012](https://github.com/anthropics/claude-code/issues/19012)、[#28138](https://github.com/anthropics/claude-code/issues/28138)、[#54519](https://github.com/anthropics/claude-code/issues/54519)），部分版本已修复。请升级到最新版 Claude Code。
  - CodeWhale：Rust 的 `std::process::Command` 在 Windows 上默认使用 `CREATE_NEW_CONSOLE`（Rust 标准行为），需上游改用 `CommandExt::creation_flags(CREATE_NO_WINDOW)` 才能消除闪窗。这需 CodeWhale 仓库修改。
- **我们的应对**：Octopus 的 hook 命令格式是 `node /path/hook.js event`（非 `cmd /c` 或 PowerShell），这是 [claudefa.st 确认的跨平台最佳实践](https://claudefa.st/blog/tools/hooks/cross-platform-hooks)，本身不创建新控制台。Octopus 直接 spawn 的进程（`findCodeWhale` 的 `execFileSync`）已设置 `windowsHide: true`。但 Octopus 无法控制 Claude Code / CodeWhale 拉起 hook 时的 spawn 选项。
- **临时替代**：升级 Claude Code 到最新版；用 Windows Terminal 启动 coding agent（ConPTY 闪窗更少）；或向 CodeWhale 仓库提交 `CREATE_NO_WINDOW` 修复 PR。

### 4. 托盘图标明暗模式自动适配
- **状态**：⚠️ 部分支持。W5 生成的 `.ico` 在 Windows 任务栏可正常显示，但**不会**像 macOS template image 那样随系统明暗模式自动反色。
- **原因**：macOS `setTemplateImage(true)` 是系统级 API；Windows 无等价物。`.ico` 是彩色位图，系统按原样渲染。
- **影响**：深色任务栏上彩色图标可能不协调，但功能正常。
- **未来改进**：可生成两套 .ico（深/浅），监听 `systemPreferences.on('inverted-color-scheme-changed')` 切换。低优先级。

---

## 四、故障排查

### Q1：桌宠窗口黑底/灰底
- **原因**：Windows + 透明窗口 + GPU 合成 bug（[electron#40515](https://github.com/electron/electron/issues/40515)）。
- **已修复**：W4 在 win32 调用 `app.disableHardwareAcceleration()`。
- **若仍出现**：检查是否被其他代码覆盖。确认 `main.js` 顶部有 `if (process.platform === 'win32') { try { app.disableHardwareAcceleration(); } catch {} }`。

### Q2：点击"启动 Claude Code"无反应
- **排查**：
  1. 确认 Claude Code 已安装：`where claude` 应返回路径。
  2. 确认 Windows Terminal 或 cmd.exe 可用。
  3. 查看 Octopus 日志（`%APPDATA%\octopus\logs\` 或控制台输出）。
- **已知**：W3 已修复 wt.exe App Execution Alias 的 ENOENT 问题（用 `cmd.exe /c wt.exe ...` 包装）。

### Q3：CodeWhale hooks 未注册
- **排查**：
  1. 在面板确认 codewhale provider 已启用（🐋 checkbox 勾选，状态显示"●已注册"）。
  2. 检查 `%USERPROFILE%\.codewhale\config.toml` 是否存在命令中含 `codewhale-hook.js` 的 `[[hooks.hooks]]` 条目（当前实现不写注释 marker）。
  3. 确认 CodeWhale 已安装：`where codewhale`。
  4. 确认 config.toml 路径用正斜杠（W2：`C:/Users/.../codewhale-hook.js`，非反斜杠）。

### Q4：托盘图标不显示
- **排查**：
  1. 首次启动可能用 PNG（.ico 异步生成中），下次启动会用 .ico。
  2. 检查 `%APPDATA%\octopus\tray.ico` 是否生成。
  3. 若生成失败，自动回落到 `assets/tray.png`（graceful）。
  4. 删除 `%APPDATA%\octopus\tray.ico` 强制重新生成。

### Q5：hook 命令在 PowerShell 报错
- **Claude Code hooks**：win32 用 `shell: 'powershell'` + `& "node" "script" event` 格式（原项目既有行为）。若 PowerShell 执行策略限制，运行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
- **CodeWhale hooks**：用 `node /path/script.js event` 格式（无 shell），不受执行策略影响。

---

## 五、平台差异速查表

| 维度 | macOS | Windows | Linux |
|---|---|---|---|
| 透明窗口 | GPU 合成 | 软件渲染（W4） | GPU 合成 |
| 托盘图标 | template PNG | .ico（W5 生成） | PNG |
| 终端启动 | Terminal.app/iTerm2 | wt.exe/cmd.exe（W3） | x-terminal-emulator |
| 二进制定位 | `command -v` | `where`（W1） | `command -v` |
| Hook shell | sh | powershell（Claude）/ 无（CW） | sh |
| Focus tracking | ✅ osascript | ❌ graceful | ❌ graceful |
| Territory | ✅ osascript+swift | ❌ graceful | ❌ graceful |
| Dock 隐藏 | ✅ app.dock.hide() | N/A（无 dock） | N/A |
| 路径分隔符 | `/` | `\`（TOML 中正斜杠化 W2；JSON 自动转义 W8） | `/` |

---

## 六、相关代码索引

| 文件 | Windows 适配点 | Task ID |
|---|---|---|
| `providers/codewhale.js` | W1 findCodeWhale win32 `where` 分支 + 路径候选 | W-impl |
| `providers/codewhale.js` | W2 hookTomlSchema 命令路径正斜杠化 | W-impl |
| `backend/launch.js` | W3 wt.exe 包 cmd.exe /c 包装 | W-impl |
| `main.js` | W4 disableHardwareAcceleration（透明窗口修复） | W-impl |
| `backend/tray-icon.js` | W5 运行时生成多尺寸 .ico | Win-enhance |
| `backend/focus.js` | win32 graceful degradation（focus tracking） | W-research |
| `backend/territory.js` | win32 graceful degradation（territory） | W-research |
| `backend/pidwalk.js` | win32 返回最小信息 | 原项目既有 |
| `backend/transport.js` | resolveWinNode `where node` + ProgramFiles | 原项目既有 |
| `backend/hookinstall.js` | win32 powershell shell（Claude hooks） | 原项目既有 |

---

## 七、测试

Windows 适配单测：`test/windows-adapt.js`（W7）。运行：
```powershell
cd C:\path\to\llmpet-codewhale
npm run test:windows
```
覆盖：W1 findCodeWhale 接口完整性、W2 hookTomlSchema 正斜杠、W3 wt.exe cmd 包装、W4 disableHWAccel 调用、W5 tray-icon 模块接口、路径健壮性、文档存在性。

完整验证建议执行 `npm run test:all`：先跑 18 文件核心套件，再跑 92 项 Windows 适配断言。当前 Linux CI 只能静态验证 win32 分支；发布前仍需在真实 Windows 10/11 上启动 Electron 并验证托盘、透明窗口、hook 闪窗与终端启动。

---

## 八、路径安全审计结论（W8）

2026-07-20 复核路径与 TOML 写入链路。静态检查未发现生产代码硬编码 `~/`；TOML 安装器已改为按完整条目合并并通过安装→重装→卸载字节级往返测试。真实 Windows 文件系统与 Electron 启动仍应作为发布门禁。

### 审计范围
- 所有 `.js` 文件中 `path.join` / 路径拼接的使用
- 路径最终去向：TOML 内容、JSON 内容、环境变量、Shell 命令、文件系统操作

### 审计结论

| 去向 | 风险 | 结论 |
|---|---|---|
| **TOML 文件内容** | 已修 | W2：`hookTomlSchema` 命令路径 `split(path.sep).join('/')` 正斜杠化。toml-hooks.js 中无其他路径写入 TOML |
| **JSON 文件内容** | 无 | `JSON.stringify()` 自动将 `\` 转义为 `\\`，读取时 `JSON.parse()` 自动还原。settings.json / usage*.json / runtime.json / config.json 中的路径均经过安全序列化 |
| **cmd.exe Shell 命令** | 无 | `launch.js` win32 分支中路径在 `"..."` 内，cmd.exe 双引号内反斜杠是字面量 |
| **环境变量** | 无 | `codewhale-hook.js` 通过 env vars 读取（`DEEPSEEK_*`），无路径写入 env |
| **文件系统操作** | 无 | `fs.readFileSync` / `readdirSync` / `accessSync` 原生接受反斜杠 |
| **Electron 内部 API** | 无 | `loadFile` / `createFromPath` / `getPath` 原生接受反斜杠 |

### 关键安全机制
1. **TOML**：唯一需要手动处理的场景（W2），因为 TOML basic string 中 `\` 是转义符
2. **JSON**：`JSON.stringify` 是隐式安全网，所有 JSON 持久化路径自动正确转义
3. **Node.js**：在 Windows 上同时接受 `/` 和 `\` 作为路径分隔符（[Node.js 文档](https://nodejs.org/api/path.html)）
4. **零硬编码 `~`**：全部使用 `os.homedir()`，已有单测守卫
