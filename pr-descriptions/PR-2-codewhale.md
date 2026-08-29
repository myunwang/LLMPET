## 这是什么（写给普通用户）

让 LLMPET 支持 **CodeWhale**（DeepSeek 系 agent CLI）：桌宠能显示它的会话状态，它的工具调用会走 LLMPET 的授权弹窗，装好即用。

**你会在意的变化：**

- 🐋 检测到 `~/.codewhale`（或设置 `LLMPET_ENABLE_CODEWHALE=1`）时自动安装钩子配置，卸载/重装都保留你在标记块之外的 TOML 内容
- 🔐 **CodeWhale 的命令执行会先问过你**——通过桌宠气泡卡授权/拒绝，和 Claude 的体验一致
- ⏱️ 弹卡 8 分钟无响应自动**拒绝**（CodeWhale 上游超时默认放行，这是安全底线；卡片上会写明这个窗口）
- 🏷️ 权限卡会标明发起方（如 `CodeWhale · exec_shell`），不再一律显示 "Claude"
- ⚡ 状态同步在后台进行，不拖慢 CodeWhale 的回合

**测试：** `npm test` exit 0，含 e2e 套件（真实 HTTP 服务 + 真实钩子子进程，14 组断言）。变更规模：11 个文件，+1104/−19。

**堆叠说明：** 本 PR 是 4 个堆叠 PR 的第 2 个（`pr/1-security-hardening` → `pr/2-codewhale-provider` → `pr/3-models-dev-pricing` → `pr/4-build-docs-gui`）。请按顺序合并；前序 PR 合并后，本 PR 的 diff 会自动收敛到自己的提交。

---

<details>
<summary><b>📐 技术附录（写给审阅者 / agent，点击展开）</b></summary>

### 1. 事件契约：逐字段对过上游源码

以 CodeWhale 上游（commit `7d942bd` 的 `docs/HOOKS.md` + executor 源码）为准注册 **10 个真实生命周期事件**：

```
session_start / session_end / message_submit / tool_call_before /
tool_call_after / turn_end / subagent_spawn / subagent_complete /
on_error / mode_change
```

上游**不存在** `turn_start` / `error`（早期半成品适配发明了这两个名字并自建测试断言它们——全绿但全错）。`tool_call_before` 的载荷从 `DEEPSEEK_*` 环境变量读取（上游没有 `CODEWHALE_TOOL_NAME`）；观察者事件合并 stdin JSON。

### 2. fail-closed 的理由（本 PR 最重要的安全决策）

CodeWhale 对**无响应**的钩子默认 **ALLOW**（超时放行）。因此桥接层的每个失败路径都必须收敛到 `{decision:"deny"}` 而不是放行或弃权：

- LLMPET 不可达/未信任 → deny
- 权限池挂起 8 分钟无人响应 → 主动 deny（绝不 ask：ask 会被上游超时放行）
- 权限池 64 上限溢出 → 立即 ask（此时上游仍在等待，ask 会走 CodeWhale 自己的确认 UI）
- 权限门配置为严格门（`continue_on_error=false`、timeout 600s）——桌宠无响应时 CodeWhale 收到 deny 而非默认放行

e2e 有专门断言：杀掉 LLMPET 后钩子输出必须是 ask 而非空（空输出=放行）。

### 3. exec_shell：真名对齐

CodeWhale 的 shell 工具真名是 `exec_shell`（上游权限规则文档双重验证：`command` 字段；文件类工具是 `write_file`/`edit_file`/`apply_patch`/`fim_edit`/`read_file`，`path` 字段）。Claude 时代的 `Bash` 拼写在这条路径上永远不出现——旧适配给 `Bash` 加自动放行等于死代码，实际效果是**每条只读命令都弹卡**（授权疲劳）。

### 4. 观察者后台化

上游文档确认：background 钩子收到相同的 env+stdin，只是不被等待、stdout 丢弃；前台钩子会被 worker 依 config 顺序 await——旧实现把每个状态同步都放在回合关键路径上。本 PR：观察者全部 `background=true`，只有 `tool_call_before` 权限门保持前台。`readStdin` 的 300ms 守护定时器清理+unref（钩子进程 ~30ms 退出而非空转 300ms，e2e 断言 < 280ms）。

**诚实披露：** background 钩子在真实 TUI 下的 stdin 送达未做二进制联调（容器无 codewhale），依据是上游文档原文；账本少记一行是可接受取舍，详见 PR4 的验证报告。

### 5. 权限桥细节

- `codewhale-permission.js`：有界权限池（64 上限、8 分钟 auto-deny、连接断开清理、会话结束清扫）；`autoDenyMs` 选项按上游文档生效（0/负/Infinity/NaN 一律回退 8 分钟窗口——有边界断言）
- 卡片身份：`CodeWhale · exec_shell` 前缀；自动拒绝提示从挂起条目自身的 `createdAt/expiresAt` 推导（首推与快照重建两条渲染路径一致——曾因此产生过 hint 断链 bug）
- `onPermissionAdded` 在会话尚未入库时回退到条目自身的 agent 身份（`tool_call_before` 可能早于 `session_start`）
- `mode_change` 映射为合成 ModeChange 事件 + `attention` 一次性状态（adapter 把 Notification 变成待输入卡，对用户主动切换 Plan/Work/Operate 是错的）
- `/codewhale-permission` 端点在 `/state` 同款回环/Host/Origin/每启动 token 信任边界之后
- 权限卡挂起列表合并到主宠（CodeWhale 暂无专属桌宠，见验证报告「下一步」）

### 6. 已知陷阱（用户文档已覆盖，详见 PR4 的 CODEWHALE.md）

`[hooks].default_timeout_secs` 会覆盖权限门的 600s 超时——用户设了较短的值会让 fail-closed 窗口同步变短（行为仍安全，但提示语义变化）。CODEWHALE.md 有专门提醒。

</details>
