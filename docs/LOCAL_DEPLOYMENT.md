# 将 LLMPET 部署到用户本地

本文说明如何从源码启动、测试 LLMPET，并制作仅供本地开发验证的安装包。

## 支持范围

| 平台 | 从源码运行 | 备注 |
| --- | --- | --- |
| macOS Apple Silicon | 支持 | “巡视”功能仅 macOS 可用 |
| Windows x64 | 支持 | 会话聚焦支持 Windows Terminal / cmd / VS Code 等 |
| Linux | 未正式支持 | 当前没有完成窗口定位适配 |

LLMPET 至少需要用户安装并使用过以下一个 agent：

- [Claude Code](https://claude.com/claude-code)
- [OpenAI Codex](https://github.com/openai/codex)

## 首次启动后

- LLMPET 会把 Claude Code hooks **合并**进 `~/.claude/settings.json`，不会覆盖已有 hooks；
- Codex 不安装 hooks，只读监听 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`；
- 新开的 Claude Code / Codex 会话会出现在桌宠的会话列表中；
- 配置、位置、语言和用量历史保存在 `~/.octopus/`；
- 日志位于 `~/.octopus/octopus.log`。

如果只使用 Codex，不希望安装 Claude hooks，可以使用下方“从源码运行”的 `OCTOPUS_NO_HOOKS=1 npm start`。

## 从源码部署

### 准备环境

- macOS 或 Windows；
- [Git](https://git-scm.com/)；
- 推荐 Node.js 22（22.12.0 或更新的 22.x；`.nvmrc`、Electron 安装验证和发布打包使用 22）；
- Claude Code 和/或 OpenAI Codex。

检查环境：

```bash
git --version
node --version
npm --version
```

### 获取依赖并启动

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm ci
npm run install:electron
npm test
npm start
```

- `npm ci` 按 `package-lock.json` 安装锁定版本，适合可复现部署；
- `npm run install:electron` 显式下载锁定的桌面运行时；
- `npm test` 运行项目的无头回归测试；
- `npm run test:electron` 在图形会话中验证真实窗口、IPC、授权与消息气泡；
- `npm start` 以前台进程启动桌宠，关闭该终端会结束应用。

### 运行时维护（#31）

项目锁定 Electron **44.9.3** 和 electron-builder **26.18.0**，源码安装要求 Node.js ≥22.12.0。Electron 自带的 Node 与命令行中的 Node 是两个独立运行时；应用启动日志会记录实际 Electron、Chromium 和内嵌 Node 版本，便于核对重新构建的包。

截至 2026-10-24，Electron 44 属于[官方支持分支](https://releases.electronjs.org/)。升级时应重新查询[支持策略](https://www.electronjs.org/docs/latest/tutorial/electron-timelines#version-support-policy)，同时更新锁文件，运行 `npm audit`、`npm test` 和 `npm run test:electron`，再构建平台安装包；不能用 `npm audit --omit=dev` 排除桌面运行时。桌面测试使用临时数据，覆盖透明窗口、preload/IPC、本地服务、允许/拒绝授权、完成气泡、详情面板及工作台配置刷新。设置 `LLMPET_SMOKE_OUTPUT` 可保存截图和实际运行时版本。

需要将 Windows 下载和临时文件放到 D: 时，在安装前设置：

```powershell
$env:TEMP='D:\CodexData\Temp'
$env:TMP=$env:TEMP
$env:npm_config_cache='D:\CodexData\Cache\npm'
$env:electron_config_cache='D:\CodexData\Cache\electron'
$env:ELECTRON_CACHE=$env:electron_config_cache
$env:ELECTRON_BUILDER_CACHE='D:\CodexData\Cache\electron-builder'
New-Item -ItemType Directory -Force -Path $env:TEMP,$env:npm_config_cache,$env:electron_config_cache,$env:ELECTRON_BUILDER_CACHE | Out-Null
```

只验证界面、不修改 `~/.claude/settings.json`：

```bash
OCTOPUS_NO_HOOKS=1 npm start
```

完全禁止可选的价格表联网请求：

```bash
OCTOPUS_NO_NET=1 npm start
```

Windows PowerShell 中设置临时环境变量：

```powershell
$env:OCTOPUS_NO_HOOKS='1'
npm start
```

### 网络较慢时

macOS shell：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run install:electron
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
npm run install:electron
```

### Electron 安装不完整或无法启动

Windows + Node.js 26 的启动失败见 [#28](https://github.com/myunwang/LLMPET/issues/28)。报告者切换到 Node.js 20 后恢复，但当前锁定的 `@electron/rebuild` 打包依赖要求 Node.js ≥22.12.0，因此统一推荐 22.x。当前 CI 使用 Node.js 22/24，并在 macOS、Windows 上单独运行 Electron 安装与桌面测试。

`Electron failed to install correctly` 在 Electron 33 找不到安装生成的 `path.txt` 时出现。下载失败、禁用安装脚本或设置了 `ELECTRON_SKIP_BINARY_DOWNLOAD` 都可能留下这种状态，不能仅凭这条消息归因于 Node.js 26。

1. 切换到 Node.js 22（22.12.0+），在新终端运行 `node --version` 确认。使用 nvm（macOS/Linux）时，可在仓库内执行 `nvm install`、`nvm use` 读取 `.nvmrc`；Windows 使用自己的 Node 版本管理器切换。
2. 在项目目录重新安装并检查（`npm ci` 会重新创建依赖目录，保留锁文件）：

   ```bash
   npm ci --foreground-scripts
   npm run install:electron
   npm run check:electron
   npm start
   ```

3. 当前 Electron 44 使用按需下载；仅执行 `npm ci` 不会安装二进制。请显式运行下方安装命令，网络失败时可重复执行，不需要删除锁文件。诊断命令刻意不加载 Electron 入口，避免检查时发生隐式下载：

   ```bash
   npm run install:electron
   npm run check:electron
   ```

4. 下载超时或连接失败时，按上方“网络较慢时”设置镜像后重试，保留安装日志以便排查。

`npm start` 会先执行同样的检查，缺包、缺少安装记录或二进制丢失时输出恢复步骤。检查本身不会下载文件，也不会启动桌宠或修改 Agent 设置。

## 制作本地安装包

先执行：

```bash
npm ci
npm run install:electron
npm test
```

### macOS 本地开发包

```bash
npm run package:mac:dev
```

产物：

```text
dist/LLMPET Dev.app
dist/LLMPET-<version>-mac-<arch>-dev-unsigned.zip
```

`package:mac:dev` 使用 ad-hoc 签名，只供本机开发验证，不作为公开分发包。它会使用独立的 `LLMPET Dev` 名称和 `com.octopus.pet.dev` bundle id，避免开发分支构建物覆盖正式的 `/Applications/LLMPET.app`。正式 App 只能通过三件套的受检路径更新。

不要把 `npm run package:mac` 当成本地普通打包命令。它是正式发布路径，会在缺少 Apple Developer ID 证书或公证凭据时主动失败，详见 [macOS 正式签名与公证](MACOS_RELEASE.md)。

### Windows 安装包

在 Windows x64 环境中运行：

```powershell
npm run package:win
```

产物位于 `dist/`，包括 NSIS `.exe` 安装包和 `.zip` 免安装包。

## 卸载

先从 LLMPET 托盘选择“卸载 Claude 钩子”，或在源码目录运行：

```bash
npm run uninstall:hooks
```

然后退出 LLMPET。`~/.octopus/` 是用户配置、用量历史和日志目录；只有在确认不再需要这些数据时才手动删除。

## 常见问题

### “巡视”不能移动其他桌宠

请在“系统设置 → 隐私与安全性 → 辅助功能”中允许当前启动 LLMPET 的 Electron 应用，然后重启 LLMPET。

### 桌宠没有显示会话

1. 确认 Claude Code 或 Codex 至少运行过一次；
2. 启动 LLMPET 后新建一个 agent 会话；
3. 查看 `~/.octopus/octopus.log`；
4. Claude Code 用户可退出并重新打开 LLMPET，让 hooks 重新对账；
5. Codex 用户确认 `~/.codex/sessions/` 下存在当前会话的 rollout 文件。
