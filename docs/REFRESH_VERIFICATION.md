# CodeWhale 翻新验证报告

> 分支：`codewhale-refresh-v2`（自最新 main `81d18d4` 重建）
> 方法：先自查三个上传物差异 → Web 交叉验证上游协议 → 按用户建议的 4 个 PR 边界重做 →
> superpowers 技能二次返工（verification-before-completion + 系统化调试 + 红绿变异验证）

## 一、半成品（refreshed.zip）中被 Web 验证推翻的关键错误

| 半成品的行为 | 上游真实情况 | 后果（若未修复） |
|:---|:---|:---|
| 注册 `turn_start` 事件 | **不存在**（CodeWhale `ALL_HOOK_EVENTS` 共 11 个，无此名） | 事件静默不触发，权限门可能失灵 |
| 注册 `error` 事件 | **不存在**（正确名 `on_error`） | 同上 |
| 漏注册 `message_submit`/`subagent_spawn`/`subagent_complete` | 真实存在且携带 stdin 载荷 | 思考态/子代理态丢失 |
| 读取 `CODEWHALE_TOOL_NAME`/`CODEWHALE_TOOL_ARGS` 回退 | **不存在**（只有 `DEEPSEEK_` 前缀） | 工具输入读不到 |
| `session_start → state:'greet'` | `greet` 不在 `VALID_STATES` | 服务器 400 拒绝或静默转 idle |
| 超时回答 `ask` | 上游对无响应 hook 默认 **allow**（fail-open） | 挂机 10 分钟后命令被意外放行 |
| 删除 runtime 守护 | 最新 main 的守护是防旧副本劫持的 | 陈旧记录无人接管，hook 流量指向死端口 |
| 自带 test 全绿 | 测试断言的是自己发明的协议 | **全绿≠正确**（用户警告被证实） |

## 二、六个问题的处理与证据

1. **Bash 自动授权前缀绕过** → `backend/command-safety.js` 全命令 fail-closed 识别器。
   31 条拒绝用例各对应一个真实旁路（`env CMD`、`git branch -D`、`git remote add`、
   `git diff --output/--ext-diff`、`rg --pre`、`fd -x/-X`、`date -s`、shell 语法链接/替换/重定向）。
   变异证据：把 `env` 加回白名单 → `test/command-safety.js` 立即失败。
2. **package-lock 内部镜像** → 最新 main 的 lockfile 实测 320 个 resolved URL 全部为
   npmjs.org/github.com；新增 `test/lockfile-hygiene.js` 进 npm test + CI 注释守护回归。
   反向验证：注入 `mirrors.internal.company.com` → 测试拦截（exit 1）。
3. **PreToolUse 返回结构** → `hook/pretool-hook.js` 使用当前官方
   `hookSpecificOutput.permissionDecision`（v1.0.59+；平铺顶层字段会被 CC 静默忽略——
   issue #48760）。变异证据：改成平铺结构 → E2E 立即失败。
4. **项目名/版本回退** → 从最新 main 重建，`llmpet 1.1.1` 从未被动过；
   `test/branding.js`（既有）断言 name/lockfile/工作流/托盘全部 LLMPET 身份。
5. **models.dev 特殊 key** → null-prototype 字典 + `__proto__`/`prototype`/`constructor`
   拒收 + 数值边界 + 64MiB 上限 + 原子 0600 写入。变异证据：去掉 null-proto →
   pr3-smoke 断言 `entries not null-proto` 失败。
6. **多实例争抢 runtime** → 探测式 first-live-wins 守护（替换每 15s 无条件抢回）：
   存活对手在场不抢写；陈旧记录（端口死/同端口旧 token）才接管。
   `test/runtime-ownership.js` 四场景。变异证据：恢复无条件抢写 →
   `存活对手在场时不得抢写` 失败（该盲区正是变异测试首次跑出来的）。

## 三、提交结构（对应建议的 4 个 PR 边界）

| 提交 | 对应 PR | 内容 |
|:---|:---|:---|
| `f5e9fa5` | 1. Electron 与本地 HTTP 安全加固 | sandbox:true、deny-by-default CSP、command-safety、PreToolUse 门、probe 式 runtime 守护 |
| `811b04f` | 2. CodeWhale provider 与权限桥 | 10 个验证过的事件、TOML 安装器（strict gate）、权限池（8 分钟 deny、64 上限）、agent 路由 |
| `ce65cc0` | 3. models.dev 价格同步 | 价格缓存 + CodeWhale 计量台账（turn_id 去重、DeepSeek 缓存计费语义） |
| `5869d31` | 4. Windows/Linux 打包与文档 | Linux release job、lockfile 守护、CODEWHALE.md、README |
| `08fa68f` `0fd4bb7` | 测试加强（可并入上述 PR） | E2E + 变异验证套件、stdin 延迟修复 |

## 四、最终验证证据（全部新鲜运行）

- `npm test` 完整套件 **exit 0**（30+ 既有套件 + 5 个新测试文件）
- `node --check` 全部改动文件通过
- E2E（真实 HTTP + 子进程）：16 组断言全过
- 变异测试：6/6 注入 bug 全部被相应测试捕获
- lockfile：320 URL 全公开源

## 五、诚实声明的限制（未宣称完成的部分）

- 本容器无 Electron/GUI：`sandbox:true` 与 CSP 的**渲染效果**未在真实窗口中目视验证
  （preload 仅用 contextBridge/ipcRenderer、renderer 零 node API、三个 HTML 零内联
  脚本/样式/事件——静态审查通过；真实窗口验证依赖 release CI 的三平台 job）。
- CodeWhale 双向冒烟用的是验证过的协议形状模拟（env 变量 + stdin JSON），
  未对真实 CodeWhale TUI 二进制做联调（容器内无 codewhale 可执行文件）。
- models.dev 实网拉取未在容器内执行（出网策略）；transform 用真实 catalog 结构的
  精确子集测试，refresh 的网络路径为常规 https + 15s 超时 + 优雅降级。

## 六、第二轮审核（交互 / UX / 性能，`421f7fd` + `ca7b9e2`）

> 方法：三维审核 → Web 重新核对上游 HOOKS.md + config.example.toml（gitee raw）→
> superpowers code-review 子代理独立评审（发现 3 项 Important，全部修复）→ 变异抽查 → 全量回归

### 修复清单（每项都有测试或文档证据）

| # | 问题 | 维度 | 修复与证据 |
|:--|:---|:---|:---|
| 1 | 观察者 hook 前台运行：上游文档确认前台 observer 会在 worker 里按配置顺序被 await，状态同步骑在回合关键路径上 | 性能 | TOML 观察者条目显式 `background = true`（同 env+stdin、不被等待、stdout 弃置——我们本来就不打印）；门保持前台。pr3-smoke 断言 gate/observer 的 background 值 |
| 2 | readStdin 的 300ms 守护定时器不清理不 unref：每个观察者 hook 进程至少多活 300ms | 性能 | clearTimeout + unref；e2e 计时断言两轮最小值 < 280ms（本地实测 39ms；变异回退后 333ms 被确定性捕获） |
| 3 | 自动放行认 `'Bash'`——CodeWhale 的 shell 工具真名是 `exec_shell`，原检查是死代码，只读命令每次弹窗 | 交互 | 认 `exec_shell`（权限规则文档验证：exec_shell→command 字段）；e2e 同时断言 `'Bash'` 拼写**不**误放行 |
| 4 | `mode_change` 映射 `Notification`：adapter 会把 Notification 变成「需要输入」卡片，用户切模式就弹卡 | 交互 | 合成 `ModeChange` 事件 + `attention`（15s oneshot）；pr3-smoke 断言 EVENT_MAP + activityToEvents 无卡片 |
| 5 | 权限卡不显示是哪个 agent 在问（`who` 算了没用）；CodeWhale 卡不告知 8 分钟自动拒绝 | UX | 非 Claude 卡头 `CodeWhale · exec_shell`；`perm.autoDenyHint` 三语言提示（从 entry 的 createdAt/expiresAt 推导，快照路径与首推一致） |
| 6 | humanizeTool 不认 CodeWhale 工具名，卡片显示生涩的 `exec_shell 需要授权` | UX | exec_shell/write_file/edit_file/apply_patch/fim_edit/read_file 映射到既有文案（字段名经权限规则文档验证） |
| 7 | 面板合计计入 CodeWhale 但拆分行只认 Claude/Codex：「合计 > 拆分之和」 | UX | renderSplit 三向动态拼接；无 CodeWhale 花费时保持上游模板字节级不变；panel-render 覆盖 4 种组合 |
| 8 | pretool-hook 逐 chunk 字符串解码：CJK 跨 chunk 变 U+FFFD（server.js 同类 bug 已修，此处漏网） | 正确性 | Buffer 拼接一次解码。**PR 披露**：此文件属 Claude 路径，是 CJK 解码加固而非行为变更——allow 决策对 CJK 损坏不敏感（前缀匹配 ASCII），行为级测试不可构造，故以文档披露代替伪测试 |
| 9 | postState 每次调用同步读两次 runtime.json | 性能 | 复用已读端口（getPortCandidates(knownPort) 向后兼容） |
| 10 | pruneSeen 达上限后每条记录 O(n) keys + O(n log n) 排序 | 性能 | 批量修剪 + 尺寸计数器 O(1) 守卫：20k 条灌入从 20.7s → 39ms（pr3-smoke 断言 < 5s） |
| 11 | `autoDenyMs` 测试选项被实现忽略：权限池测试独自真实等待 8 分钟，全量 488s | 性能(DX) | 实现该选项（边界 0/负/Infinity/NaN 回退 8 分钟）；全量 **488s → 9s**，期间还新增 8 组测试 |
| 12 | models.dev 缓存路径不认 `LLMPET_CODEWHALE_HOME`（与台账不一致，测试隔离失效） | 一致性 | 跟随 env；pr3-smoke 改用与 HOME 推导**不同**的目录钉住该行为（原同目录是伪覆盖） |

### 二次返工（superpowers code-review 子代理发现，`ca7b9e2` 修复）

- **快照路径 hint 断链**：卡片有两条渲染路径（首推 / stats 快照重建），只有首推带提示 → 改为从
  pending entry 自身时间戳推导，两条路径必然一致；pr3-smoke 增加「只有 createdAt/expiresAt」形状断言。
- **onPermissionAdded 身份回退竞态**：session 尚未入库时 `who` 退化为 'Claude' → 回退到 entry 自带
  的 agentId。
- **askPermission 超时分支不可测**：加 timeoutMs 测试缝；e2e 用「接受连接但永不响应」的服务器
  覆盖超时 → ask + 区别于「未运行」的 reason。
- **e2e 计时断言 flake 风险**：改为两轮取最小值（单次偶发慢不误报；旧代码两次都 ≥300ms 仍确定性拦截）。
- **TOML 旧格式升级**：补「无 background 行的旧块 → install() 整体重写、无重复、用户内容保留」测试。

### 变异抽查（第二轮，全部被捕获）

M1 exec_shell→Bash 回退（e2e 超时失败）· M2 移除 background（pr3-smoke 断言失败）·
M3 mode_change→Notification（pr3-smoke 断言失败）· M4 定时器泄漏回归（e2e 333ms 拦截）·
M5 renderSplit 回退（panel-render 三向断言失败）· M6 移除身份前缀（pr3-smoke 断言失败）

### 最终验证（新鲜运行）

- `npm test` **exit 0 · 9s · 414 项 ✓**（第二轮起点：488s / 406 项）
- 诚实限制沿用第五节；另注：`background = true` 的 stdin 送达语义基于上游文档原文
  （"it receives the same environment variables and the same stdin JSON payload as the
  foreground form"），容器内无 codewhale 二进制，未做真实 TUI 联调——若上游行为与文档不符，
  表现为账本少行（best-effort 遥测的可接受取舍），真实联调仍列为发布前事项。

## 七、第三轮审核（GUI 缺陷专项 + 测试项目重制，`a1ca278`）

> 方法：逐行通读渲染层（pet.js 4474 行 / panel.js / archive.js / icons.js / 三个 HTML /
> preload + main 窗口接线）→ Web 交叉验证（CC AskUserQuestion 原生自带 "Other" 自由输入，
> LLMPET 的 Other 卡是本应用侧镜像、本地化安全；Electron 透明窗点击穿透与 setFocusable
> 用法与现行一致）→ 修复 → 新增 `test/gui-defects.js`（22 项断言驱动真实渲染代码）→
> 变异验证 → 全量回归

### 修复清单

| # | 缺陷 | 维度 | 修复与证据 |
|:--|:---|:---|:---|
| 1 | ask 卡片标签 `askLabel = 'Needs Input'` 两处硬编码，绕过 i18n 字典 | i18n | 走 `t('ask.needsInput')`；ja UI 由英文混排恢复为「入力が必要」（G1） |
| 2 | 提交按钮 `'Submit Answer' / 'Next ›'` 硬编码 | i18n | 新键 `ask.next`（zh/en 沿用英文、ja「次へ ›」，与既有 ask.back/submit 惯例一致）；G1 |
| 3 | elicitation 的「Other」选项卡硬编码 | i18n | 新键 `ask.other`（ja「その他」）；Web 验证：CC 原生 AskUserQuestion 自带 Other 自由输入，本卡为应用侧镜像，本地化不碰协议；G1 |
| 4 | 方案卡的「打回意见」placeholder 泄漏到下一张 elicitation 卡的输入框 | UX | `clearAskBody` 复位 placeholder 并清掉 warnEmptyInput 的 dataset.ph 缓存；G2 |
| 5 | `updateRadialBadge` 用未过滤的 MENU 下标对齐过滤后的 DOM 子节点——徽标挂哪全靠条件项恰好排在徽标项之后 | 健壮性 | 徽标种别与引用直接挂在节点上（`_badgeKind`/`_badgeEl`），与过滤顺序解耦；G3 |
| 6 | 离开 cat/whale 皮肤后 60s 姿态轮换 interval 不清除，空转到应用退出 | 性能 | `applySkin` 离开 meme 皮肤即 clearInterval（并按 updateCat 同语义推进 poolIdx）；G5 断言 `poolRot` 引用本身 |
| 7 | 会话列表空态不区分「暂无会话」与「搜索/筛选无匹配」 | UX | 新键 `sess.noMatch` 三语言；搜索、来源筛选、归档开关三种触发均覆盖；G4 |
| 8 | panel.js `timeStr` 硬编码 zh-CN，违背自身「日期跟 UI 语言走」的注释 | 一致性 | 走 `LOCALE_TAG`。**诚实披露**：该修复首轮曾因变异恢复时的 `git checkout` 意外丢失（提交信息宣称已修但 panel.js 无 diff），被独立评审子代理抓回后补上。三个受支持 locale 在 `hour12:false` 下输出目前相同，不可行为级断言（panel-render 两种实现都绿），属防漂移修复 |

### 测试项目重制

- `test/gui-defects.js` 新套件入库并接进 `npm test`：G1 卡片 i18n（ja/zh 双语）、G2
  placeholder 泄漏、G3 徽标节点打标 + 增删数字 + 脱离 DOM、G4 空态分流（搜索/来源筛选/
  归档开关三种触发 + 真空态文案）、G5 定时器清理——全部驱动**真实 renderer/pet.js**
  （dom-stub 无头环境），非静态正则。评审后按发现补了徽标脱离断言与归档/空态两条。
- `test/i18n.js` 的 SHARED_VERBATIM 集合按新键维护（ask.next / ask.other 与
  ask.back/submit/needsInput 同类：zh 原本就是英文文案）。

### 变异验证（第三轮）

M1 标签回退硬编码（G1 失败）· M2 删 placeholder 复位（G2 失败）· M3 徽标回退下标对齐
（G3 三项失败）· M4 空态回退 sess.empty（G4 两项失败）· M5 删定时器清理（G5 两项失败）·
M6 timeStr 回退 zh-CN（**未捕获**——输出对三 locale 当前相同，已在表中如实标注）·
M7 删 `_badgeEl.remove()` 只留置 null（首轮**逃逸**——`children.includes(null)` 恒真；
被独立评审子代理发现，断言改为先捕获引用再判断后已确定性捕获）

### 二次返工（superpowers code-review 子代理发现，本轮修复）

- **Critical**：timeStr 的 LOCALE_TAG 修复在变异恢复时被 `git checkout` 连带还原，
  提交与报告双重宣称已修但代码未落地——已补回，并在此如实披露事故链。
- **Important**：G3「移除徽标」断言一半恒真（`children.includes(null)` 恒 false），
  删掉 `remove()` 的变异逃逸——改为先捕获引用再断言，逃逸已封堵。
- **Important**：报告宣称 G4「三种触发均覆盖」实测只有两种——补归档开关空态断言与
  真空态 sess.empty 文案断言，首个 check 更名为名副其实的「有会话时渲染会话行」。
- Minor：报告数字逐项核对修正；删除「进程退出即证明」的误导表述；applySkin 清理路径
  补 poolIdx++ 与 updateCat 语义对齐；i18n 测试注明三元调用位对字面量扫描的盲区。

### 最终验证（新鲜运行）

- `npm test` **exit 0**（GUI 套件断言数以当次输出为准）
- 第五节的诚实限制全部沿用：容器无 GUI，渲染效果仍依赖 release CI 三平台首跑。
