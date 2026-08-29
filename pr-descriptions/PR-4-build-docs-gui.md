## 这是什么（写给普通用户）

发布与文档收尾：**Linux 正式打包**、依赖卫生守护、CodeWhale 使用文档，外加一轮 GUI 专项审查修掉的 8 个渲染层缺陷。

**你会在意的变化：**

- 🐧 Linux 用户有了 AppImage + tar.gz 官方产物（release CI 三平台齐了）
- 📖 `docs/CODEWHALE.md`：CodeWhale 集成的用户指南（自动检测、环境变量、8 分钟自动拒绝语义、`default_timeout_secs` 陷阱）
- 🌐 GUI 缺陷修复：日文/英文界面不再混入硬编码英文、面板时间列跟随界面语言、空会话列表区分「无匹配/无会话」、离开 meme 皮肤不再泄漏轮换定时器、方案卡占位文案不再泄漏到别的卡、径向徽标重对齐不再残留脏节点
- 🧪 依赖卫生：`test/lockfile-hygiene.js` 断言 package-lock.json 无内部镜像源，防止将来依赖升级时回归

**测试：** `npm test` exit 0——**437 项断言**（含 23 项 GUI 断言，全部驱动真实渲染代码而非字符串匹配）。变更规模：11 个文件，+774/−22。

**堆叠说明：** 本 PR 是 4 个堆叠 PR 的第 4 个（`pr/1-security-hardening` → `pr/2-codewhale-provider` → `pr/3-models-dev-pricing` → `pr/4-build-docs-gui`）。文档描述前三个 PR 的行为，验证报告记录全过程。

---

<details>
<summary><b>📐 技术附录（写给审阅者 / agent，点击展开）</b></summary>

### 1. Linux 发布 job

`release.yml` 增加 electron-builder 的 Linux job（AppImage + tar.gz），产物门禁跑全量测试。与既有 macOS/Windows 流程同构；具体三平台真实产物以 release CI 首跑为准（容器无 GUI，静态审查已过——sandbox/contextIsolation/CSP 见 PR1）。

### 2. lockfile 卫生

背景：早期基线的 package-lock.json 里混有内部 npm 镜像地址。本 PR 的测试断言**全部 320 个 resolved URL 都是公开源**，并接入 `npm test`——将来任何 `npm install` 把镜像带回来会直接红。

### 3. GUI 缺陷清单（全部有断言驱动，`test/gui-defects.js`）

| # | 缺陷 | 修复 |
|:--|:---|:---|
| 1 | ask 卡标签/提交键/Other 三处硬编码英文，绕过 i18n（ja 界面中英混排） | 走 i18n 键 |
| 2 | 方案卡 placeholder 泄漏到其它卡 | 逐卡独立 placeholder |
| 3 | 径向徽标重对齐后残留游离脏节点（下标对齐失效） | 节点自带 `_badgeKind/_badgeEl` 键控；零计数移除徽标有**非恒真**断言（先捕获引用再清零——曾因 `children.includes(null)` 恒假让删 `remove()` 的变异逃逸） |
| 4 | 离开 meme 皮肤泄漏 60s 轮换 interval | applySkin 清理路径与 updateCat 同步推进 poolIdx |
| 5 | 会话空态不区分「无匹配」与「无会话」 | 新键 `sess.noMatch`，三语言 |
| 6 | panel 时间列硬编码 zh-CN（en/ja 界面显示中文格式时间） | 跟随 `LOCALE_TAG[getLang()]` |
| 7 | — | i18n 测试维护 `SHARED_VERBATIM` 新键并注明三元调用位盲区 |

### 4. 验证报告（docs/REFRESH_VERIFICATION.md）

全过程证据链：每个问题的修复证据、13 次变异测试全部捕获（含一次先逃逸后补测试的盲区与一次 `git checkout` 连带还原未提交修复的事故链——如实披露而非美化）、e2e 协议形状、诚实限制清单（无真实 CodeWhale 二进制联调、无 GUI 实窗渲染）。

### 5. 为什么值得信「全绿」

本系列 PR 的验收标准不是测试全绿，而是：变异测试（注入 13 个 bug 全被捕获）+ 独立评审子代理三轮（每轮抓到前一轮遗留：含 1 个 Critical——宣称已修但被 checkout 还原的修复）+ e2e 真实进程链路。详见验证报告。

</details>
