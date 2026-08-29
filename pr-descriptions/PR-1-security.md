## 这是什么（写给普通用户）

给桌面端和本地服务补上安全边界，**不改变任何日常使用习惯**。

**你会在意的变化：**

- 🛡️ **Bash 自动授权不再能被组合命令绕过**：旧实现只看命令前缀，`ls; rm -rf /`、`git status && curl …`、`env rm -rf /`、`git diff --output=…` 这类命令会借只读前缀混过自动放行；现在改为整条命令识别（31 条攻击用例全部拒绝）
- 🖥️ **同时开两个 LLMPET 不打架了**：两个实例不再互相覆盖 runtime 配置（旧实现每 15 秒无条件重写，互相作废对方的令牌）
- 🔌 **Claude Code 的 PreToolUse 钩子真正生效**：输出结构对齐官方现行协议（v1.0.59+ 会静默忽略旧平铺字段）
- 🔒 渲染窗口启用 sandbox + 默认拒绝的 CSP

**行为不变的部分：** `ls`、`cat`、`git status`、`git log` 等 39 类常用只读命令依旧免打扰自动放行，可用性没有被过度牺牲。

**测试：** `npm test` exit 0（含 31 拒绝 / 39 放行旁路矩阵 + runtime 所有权四场景）。变更规模：11 个文件，+420/−23。


**堆叠说明：** 本 PR 是 4 个堆叠 PR 的第 1 个（`pr/1-security-hardening` → `pr/2-codewhale-provider` → `pr/3-models-dev-pricing` → `pr/4-build-docs-gui`），可独立合并；后续 PR 依赖本 PR。

> 注：#10 是同一工作的旧基线版本（基于 111 个提交之前），本系列 PR 在最新 main 上重建，可取代之。

---

<details>
<summary><b>📐 技术附录（写给审阅者 / agent，点击展开）</b></summary>

### 1. command-safety：fail-closed 全命令识别器

替代旧的「前缀匹配」检查。识别器对整条命令做词法分析，覆盖的真实绕过面：

| 类别 | 用例（节选） |
|:---|:---|
| shell 语法 | `ls; rm -rf /`（链接）、`pwd \| sh`（管道进 shell）、``echo $(touch …)``（替换）、`cat f > /tmp/x`（重定向写）、`ls\nrm -rf /`（换行分命令）、`` ls`touch` ``（反引号）、`<(curl …)`（进程替换）、`${IFS:+-p}`（参数展开） |
| 执行类工具/选项 | `env rm -rf …`（**旧检查最著名的旁路**：`env ls` 前缀合法但第一个参数才是真命令）、`rg --pre /bin/sh`、`fd -x rm`、`fd -X rm -rf`、`xargs rm` |
| git 可变子命令 | `git branch -D/-d/-m/newbranch`、`git remote add/remove/set-url`、`git diff --output=/tmp/x`、`git diff --ext-diff`（执行 gitconfig 外部 diff）、`git show --output=…` |
| 其它 | `date -s`（改系统时钟）、5000 字符超长命令、空串、非字符串（null/undefined/42） |

设计原则：**fail-closed**——不在已知放行清单里的，一律交回正常权限流程询问用户，而不是自动放行。

### 2. PreToolUse 协议对齐

官方现行结构（CC ≥ v1.0.59）：

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "…" } }
```

旧的平铺顶层字段（`{"permissionDecision": "allow"}`）会被 Claude Code **静默忽略**——即钩子以为自己放行了只读命令，实际决策从未生效（用户多被弹一次卡，无害但失效）。本 PR 让输出回到官方结构；对危险命令输出空（不表态），交回正常权限流程。

**诚实披露：** pretool-hook 的 stdin 改为一次性 buffer 拼接，修复 CJK 载荷跨 chunk 边界被截断的解码损坏。这是 Claude 路径的加固而非行为变更——allow 决策本身对 CJK 损坏不敏感，行为级测试不可构造，故以披露代替伪测试。

### 3. runtime 所有权：first-live-wins + 陈旧记录治愈

- 旧的 15 秒无条件重写（`claimRuntimeOwnership` 定时器）会让两个存活实例交替翻转 runtime.json，每次覆盖都作废对方在途的 token → 拒绝服务对方
- 新语义：**存活的对手不抢**（探测端口+token）、**陈旧记录接管**（对手已死）、**同端口旧 token 立即修复**、`stop()` 永不误删存活对手的记录
- 守护间隔可经 `runtimeGuardMs` 注入（测试缝）

四场景由 `test/runtime-ownership.js` 断言（存活对手不抢 / 陈旧接管 / 同端口治愈 / stop 不误删）。

### 4. Electron 加固

- 所有渲染窗口 `sandbox: true`；preload 白名单审查通过（仅 contextBridge + ipcRenderer，renderer JS 零 node API 使用）
- pet/panel/archive 三页注入默认拒绝 CSP（`connect-src none`——全部通信走 IPC）
- 静态审查通过；真实窗口渲染效果依赖 release CI 三平台首跑确认（容器无 GUI，已在验证报告中如实标注）

### 5. 验证方式（摘要）

- 旁路矩阵：31 拒绝 + 39 放行 + 类型边界，全部断言
- 变异测试：对识别器注入 6 类 bug（env 回归 SAFE_PLAIN、平铺输出、超时改 ask 等）全部被测试捕获；完整变异日志见 PR4 的 `docs/REFRESH_VERIFICATION.md`
- 已知限制：真实 CodeWhale 二进制联调、GUI 实窗渲染不在本 PR 验证范围内

</details>
