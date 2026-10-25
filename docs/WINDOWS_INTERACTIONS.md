# Windows 桌宠互动

从最新源码运行 `npm ci`、`npm run install:electron`、`npm start` 即可使用。无需安装额外的 Python、编译器或鼠标控制工具；原生助手使用 Windows 自带的 PowerShell、.NET 和 user32。

## 使用

- **巡视**：右键 LLMPET → 巡视。支持的桌宠会被推到所在显示器工作区的水平边缘，LLMPET 随后回到原位。
- **自动巡逻**：托盘开启，默认关闭。仅在用户输入空闲两秒以上时开始；操作 LLMPET 面板或出现待授权事项会中止动作。
- **掠夺**：先打开 Codex 桌宠，再右键 LLMPET → 掠夺。显示真实历史会话的入场动画，踢到边缘后关闭目标桌宠窗口。收录的是 LLMPET 的置顶/归档索引，不删除或改写 Codex 原始会话。
- **表情包**：选择 Claude/Codex 会话与表情包，播放 GIF 和语音，同时按 session ID 调用 CLI 续聊。Windows 不依赖当前终端标签或当前输入焦点；本地需有对应 CLI 和登录状态。`.cmd` 包装器中的配置环境变量会保留，中文、多行和长文本通过 stdin 原样传入。启动进程与指令已写入会话记录是两个不同状态，只有后者才显示发送成功。

## 窗口识别与限制

Windows 使用 HWND + PID + 进程名 + 窗口标题 + 类名反复核验目标；每步移动后读取真实位置。普通桌宠按照保守的已知进程名列表匹配；可在 `territoryRivals` 增加独立桌宠进程名。

ChatGPT/Codex 属于同进程多窗口应用，额外检查无标题栏/透明窗口样式，以及可访问性树里唯一的 `Codex pet` / `ChatGPT pet` 图片。新版透明表面可能和屏幕一样高，站位与贴边按照图片的可见边界计算。保留已知旧版专用桌宠标题兼容路径；普通聊天窗口、通知和设置页不按尺寸猜测。

原生助手只读取窗口信息与角色图片几何，不读取聊天正文、文档值或输入框内容。坐标经 Electron 的物理像素/DIP 转换，适配 Windows 显示缩放与负坐标显示器；同一轮推挤以目标原显示器为准。

`SetWindowPos` 不调整大小、层级或焦点；“巡视”不关闭窗口。“掠夺”只在目标实际到边缘后发送 `WM_CLOSE` 并确认窗口消失，不终止宿主进程。不支持的版本、拒绝移动的桌宠、Windows 完整性级别隔离（例如目标以管理员身份运行）会失败退出，不自动提权。

## 验证

```powershell
npm test
npm run test:electron
npm run test:windows
```

`test:windows` 只移动和关闭测试自己创建的窗口，同时确认同进程主窗口不变。单元测试覆盖大透明表面识别、DPI/负坐标、目标身份变化、动作取消、移动抵抗、关闭失败，以及超过 Windows 命令行长度的 Unicode 输入。Electron 测试会实际解码全部表情包 GIF/音频。

本地另用 Codex 26.1021.3705.0 的真实 Windows 桌宠验证了移动与复位、完整巡视、会话收录和关闭桌宠；其他第三方桌宠仍取决于其窗口实现。

原生接口参考：[SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)、[UI Automation 控件模式](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview)、[Electron screen 坐标转换](https://www.electronjs.org/docs/latest/api/screen)。
