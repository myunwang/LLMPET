# Windows 快速安装

完整说明见 [`WINDOWS.md`](WINDOWS.md)。

```powershell
git clone https://github.com/purrfecto114-lgtm/LLMPET.git
cd LLMPET
npm ci
npm run test:all
npm start
```

首次启动会注册 Claude Code hooks。CodeWhale 需在详情面板的 Provider 区块勾选后再安装 hooks；可在 `%USERPROFILE%\.codewhale\config.toml` 中搜索 `codewhale-hook.js` 验证。

发布前建议在 Windows 10/11 实机验证透明窗口、系统托盘、Windows Terminal 启动和 hook 控制台闪窗。当前「去回复」聚焦与领地模式仅 macOS 可用。
