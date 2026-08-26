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
- Node.js 18 或更高版本（项目 CI 使用 Node.js 20）；
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
npm test
npm start
```

- `npm ci` 按 `package-lock.json` 安装锁定版本，适合可复现部署；
- `npm test` 运行项目的无头回归测试；
- `npm start` 以前台进程启动桌宠，关闭该终端会结束应用。

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
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
```

## 制作本地安装包

先执行：

```bash
npm ci
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
