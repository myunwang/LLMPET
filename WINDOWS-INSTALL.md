# Octopus 桌面宠物 — Windows 安装/配置/卸载指南

> 适用版本：Octopus 0.1.0（LLMPET → CodeWhale 适配版）
> Windows 适配状态：**核心功能全平台可用**（W1-W10 完成，91 项适配测试通过）
> 已知限制：focus tracking（"去回复"按钮）、领地模式仅 macOS；hook 闪窗为上游问题

---

## 一、Windows 适配确认

### 已支持的 Windows 功能（11 项 ✅）

| 功能 | 实现位置 | 说明 |
|---|---|---|
| **状态机感知** | hook/codewhale-hook.js | Claude Code / CodeWhale 生命周期 hook → 桌宠表情 |
| **权限桥** | backend/codewhale-permission.js | 一键允许/拒绝授权气泡 |
| **Token 计量** | backend/metering-codewhale.js | 读 transcript 算 token & 花费 |
| **会话列表** | backend/pidwalk.js | win32 返回最小信息（graceful） |
| **终端启动** | backend/launch.js W3 | `cmd.exe /c wt.exe` 包装，避免 App Execution Alias ENOENT |
| **CodeWhale 发现** | providers/codewhale.js W1 | `where codewhale` + 3 处 Windows 路径候选 |
| **TOML hook 安全** | providers/codewhale.js W2 | 命令路径正斜杠化（TOML basic string 安全） |
| **透明窗口修复** | main.js W4 | `app.disableHardwareAcceleration()` 修黑底 |
| **托盘 .ico 生成** | backend/tray-icon.js W5 | 运行时从 tray@2x.png 生成多尺寸 .ico |
| **Hook 安装/卸载** | backend/toml-hooks.js | merge-safe，支持 idempotent 重装/卸载 |
| **三款皮肤** | renderer/ | 章鱼 / 像素怪兽 / 月薪喵 |

### 已知 Windows 限制（4 项，均 graceful degradation）

| 限制 | 原因 | 影响 |
|---|---|---|
| **focus tracking** | 无纯 JS 获取前台窗口 PID | "去回复"按钮在 Windows 不可用 |
| **领地模式** | 全 macOS 实现（osascript/swift/AXPosition） | 巡视/拔河不启动，面板已隐藏控件 |
| **hook 闪窗** | 上游 Claude Code/CodeWhale spawn 未设 windowsHide | 偶发控制台闪窗，升级上游可解决 |
| **tray 明暗模式** | .ico 是彩色位图，无 macOS template image 等价 | 任务栏不自动反色 |

---

## 二、下载文件

从 `dist/` 目录获取（已构建完成）：

| 文件 | 大小 | 用途 |
|---|---|---|
| `Octopus-0.1.0-win-x64-portable.zip` | 113 MB | **Windows 绿色版**（解压即用，推荐） |
| `Octopus-0.1.0-src.zip` | 2.5 MB | 源码包（需自行 `npm install` 后运行） |
| `Octopus-0.1.0.AppImage` | 106 MB | Linux AppImage（单文件可执行） |
| `octopus-0.1.0.tar.gz` | 80 MB | Linux tar.gz |

> **注意**：NSIS 安装包（.exe installer）因沙箱无 Wine 无法签名生成。Windows 用户请用 portable zip（功能完全一致，只是无安装向导）。

---

## 三、Windows 安装方法

### 方式 A：Portable 绿色版（推荐，无需安装）

1. **下载** `Octopus-0.1.0-win-x64-portable.zip`（113 MB）
2. **解压**到任意目录，例如 `C:\Tools\Octopus\`
3. **运行** `C:\Tools\Octopus\win-unpacked\Octopus.exe`
4. 首次启动会：
   - 在 `%APPDATA%\Octopus\` 生成 `tray.ico`（从内置 PNG 自动转换）
   - 注册 Claude Code hook 到 `%USERPROFILE%\.claude\settings.json`（合并写入，可逆）

### 方式 B：源码运行（开发者）

1. **前置条件**：
   - Windows 10/11
   - [Node.js ≥ 18](https://nodejs.org/)（含 npm）
   - 已安装 [Claude Code](https://claude.com/claude-code) 或 [CodeWhale](https://github.com/Hmbown/CodeWhale)

2. **下载源码** `Octopus-0.1.0-src.zip`（2.5 MB）并解压

3. **安装依赖**：
   ```powershell
   cd Octopus-0.1.0-src
   npm install
   # 国内网络慢可加：$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
   ```

4. **启动**：
   ```powershell
   npm start
   ```

### 方式 C：自行打包 Windows .exe（需 Windows 真机）

在 Windows 上：
```powershell
git clone <repo>
cd llmpet-codewhale
npm install
npm run dist:win
# 产物：dist/Octopus Setup 0.1.0.exe（NSIS 安装包）+ dist/Octopus 0.1.0.exe（portable）
```

---

## 四、配置

### 4.1 Claude Code Hook 配置

首次启动自动注册到 `%USERPROFILE%\.claude\settings.json`（**合并写入，不覆盖已有钩子**）。

**手动安装/卸载**：
```powershell
npm run install:hooks      # 安装
npm run uninstall:hooks    # 卸载（先备份）
```

### 4.2 CodeWhale Hook 配置

CodeWhale 的 hook 写入 `%USERPROFILE%\.codewhale\config.toml`。

**切换 provider 到 CodeWhale**：
- 右键桌宠 → 菜单 → 切换 provider
- 或编辑 `%APPDATA%\Octopus\config.json`（首次启动后生成）

### 4.3 桌宠自身配置

配置文件：`%APPDATA%\Octopus\config.json`

```json
{
  "provider": "claude",
  "skin": "octopus",
  "silent": false,
  "budgetHours": 5,
  "territoryRivals": []
}
```

### 4.4 环境变量开关

| 变量 | 作用 |
|---|---|
| `OCTOPUS_NO_HOOKS=1` | 启动但不修改 `settings.json`（只验证界面） |
| `OCTOPUS_ALLOW_MULTI=1` | 跳过多实例防护 |
| `OCTOPUS_NO_NET=1` | 完全离线（关掉 LiteLLM 价目表同步） |
| `OCTOPUS_DEBUG=1` | 开放 `GET /debug`（仅本机回环） |

PowerShell 设置示例：
```powershell
$env:OCTOPUS_NO_NET=1; npm start
```

---

## 五、卸载

### 卸载步骤（顺序重要）

1. **先卸载 hook**（避免退出后 Claude Code 每次事件 spawn 钩子）：
   ```powershell
   # 方式 1：托盘菜单
   右键托盘图标 → 🧹 卸载 Claude 钩子

   # 方式 2：命令行（源码运行时）
   npm run uninstall:hooks
   ```

2. **退出桌宠**：右键托盘 → 退出

3. **删除程序**：
   - Portable：删除解压目录（如 `C:\Tools\Octopus\`）
   - 源码：删除源码目录

4. **清理残留数据**（可选）：
   ```powershell
   Remove-Item -Recurse -Force "$env:APPDATA\Octopus"
   Remove-Item -Recurse -Force "$env:USERPROFILE\.octopus"
   ```
   - `%APPDATA%\Octopus\` — 桌宠配置 + 生成的 tray.ico
   - `%USERPROFILE%\.octopus\` — 用量数据 + 日志

### 验证卸载干净

```powershell
# 检查 Claude settings.json 是否还有 octopus 钩子
Select-String -Path "$env:USERPROFILE\.claude\settings.json" -Pattern "octopus"

# 检查 CodeWhale config.toml 是否还有 codewhale-hook
Select-String -Path "$env:USERPROFILE\.codewhale\config.toml" -Pattern "codewhale-hook"
```

两个命令应无输出（hook 已清除）。

---

## 六、故障排查

### Q1: 启动后桌宠不显示

**检查透明窗口**：Windows 某些 GPU 上透明窗口黑底。已用 `disableHardwareAcceleration()` 修复（W4）。若仍黑底，尝试更新显卡驱动。

**检查端口占用**：桌宠用 `127.0.0.1:41330+` 起本地 server。查看日志：
```powershell
Get-Content "$env:USERPROFILE\.octopus\octopus.log" -Tail 30
```

### Q2: Claude Code 会话不被感知

**确认 hook 已注册**：
```powershell
Get-Content "$env:USERPROFILE\.claude\settings.json" | Select-String "octopus"
```

**重新注册**：
```powershell
npm run install:hooks
```

**新开会话**：桌宠只感知启动**之后**新开的 claude 会话。已开着的会话从下一个事件起出现。

### Q3: CodeWhale 会话不被感知

**确认 codewhale 已安装**：
```powershell
where codewhale
```

**确认 config.toml 有 hook**：
```powershell
Get-Content "$env:USERPROFILE\.codewhale\config.toml" | Select-String "codewhale-hook"
```

**切换 provider**：右键桌宠 → 切换到 CodeWhale。

### Q4: 终端启动失败（Windows Terminal）

W3 已修复：用 `cmd.exe /c wt.exe` 包装避免 App Execution Alias ENOENT。若仍失败，检查是否安装了 Windows Terminal：
```powershell
where wt.exe
```

### Q5: hook 执行时闪控制台窗

这是上游 Claude Code / CodeWhale 的问题（spawn 未设 `windowsHide`），非桌宠可控制。升级上游版本可解决。详见 [WINDOWS.md](WINDOWS.md) §3。

### Q6: 托盘图标模糊

当前 `tray@2x.png` 是 36x36，运行时生成的 .ico 在 256 尺寸可能模糊。若需更清晰图标，替换 `assets/tray@2x.png` 为 256x256 高分辨率源图后重新运行。

---

## 七、代码索引（Windows 适配相关）

| 文件 | Windows 适配点 |
|---|---|
| `providers/codewhale.js` | W1 findCodeWhale win32（`where` + 路径候选）、W2 hookTomlSchema 正斜杠 |
| `backend/launch.js` | W3 wt.exe `cmd.exe /c` 包装 |
| `main.js` | W4 `disableHardwareAcceleration`、app.dock darwin 守卫、skipTaskbar |
| `backend/tray-icon.js` | W5 运行时 .ico 生成（png-to-ico，ESM 互操作修复） |
| `backend/toml-hooks.js` | TOML hook merge-safe 安装/卸载（idempotency 已修复） |
| `backend/pidwalk.js` | win32 返回最小信息（graceful） |
| `backend/focus.js` | `platform !== 'darwin'` 守卫，提前返回 |
| `backend/territory.js` | `platform !== 'darwin'` 守卫，不启动 |

---

## 八、测试验证

Windows 适配测试（91 项）：
```powershell
npm run test:windows
```

预期输出：`✅ ALL PASS — W1-W10 Windows adaptation: 91 passed, 0 failed`

完整测试套件（8 套）：
```powershell
npm test                    # smoke + state-smoke + pricing + territory
npm run test:windows        # Windows 适配 91 项
node test/toml_verify.js    # TOML idempotency
node test/toml-roundtrip.js # TOML round-trip
node test/toml_v2.js        # TOML v2
```
