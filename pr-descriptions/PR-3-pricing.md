## 这是什么（写给普通用户）

桌宠现在能**算出 CodeWhale 花了多少钱**：按 models.dev 的公开价格表给每个回合计价，日/周/终身花费一目了然，面板上的拆分行也变成三家的了。

**你会在意的变化：**

- 💰 CodeWhale 的 token 用量自动入账（按模型单价计价，含缓存读写差异计价）
- 🌐 价格表来自 models.dev 公开数据，24 小时刷新一次，**失败不影响启动**（离线也能用上次缓存）
- 📊 面板拆分行：`Claude $x · Codex $y · CodeWhale $z`（没有 CodeWhale 花费的机器保持原样，不多噪音）
- 🔢 合计与拆分之和永远一致（修掉了「合计 > 拆分之和」的矛盾显示）
- ⏱️ 重试投递不会重复计费（按 turn_id 去重）

**测试：** `npm test` exit 0（新增 pr3-smoke：特殊 key、数值边界、去重、缓存计价数学、TOML 幂等+旧格式升级）。变更规模：9 个文件，+848/−27。

**堆叠说明：** 本 PR 是 4 个堆叠 PR 的第 3 个（`pr/1-security-hardening` → `pr/2-codewhale-provider` → `pr/3-models-dev-pricing` → `pr/4-build-docs-gui`）。依赖第 2 个（台账消费 provider PR 转发的 turn_end usage）。

---

<details>
<summary><b>📐 技术附录（写给审阅者 / agent，点击展开）</b></summary>

### 1. models.dev 目录的形状（实测验证）

`models.dev/catalog.json` = `{models, providers}` 顶层两对象——**只有 `providers` 带价格**；362 行的顶层 `models` 是与 provider 无关的元数据。两个易错点：

- 目录**合法地**包含 `__proto__`/`constructor` 这类 key 作为 provider/model id → 缓存全部用 null-prototype 字典构建，危险 key 直接拒收（原型污染防护，变异测试验证过 `Object.create(null)` 被删掉时测试会红）
- 未知路径返回 **200 + SPA HTML**（不是 404）→ 非 JSON 解析失败按刷新错误处理，不会把 HTML 存进缓存

### 2. 数值与网络边界

- 所有数字过界检查：NaN/Infinity/负数/离谱值 → null（宁缺毋错）
- 64 MiB 响应上限、15s 超时、原子 0600 写入、24h TTL
- **按需惰性刷新，无定时任务**（读取时检查 TTL，后台静默更新；网络失败永不阻塞启动）
- 缓存路径跟随 `LLMPET_CODEWHALE_HOME`（与台账一致；测试里 env 指向**不同**目录才是真覆盖——同目录是假覆盖，曾因此修过测试）

### 3. 计量语义（DeepSeek 特有的坑）

- `input_tokens` **已包含** cache 命中部分 → 缓存读按 cache-read 价计、绝不双重计费
- `reasoning_replay_tokens` 上游定价语义不明 → 计入诊断、**故意不计费**
- 未知模型按诚实的 $0 计价并进诊断，不猜测价格
- `turn_id` 去重：钩子重试投递不会双计（有界去重窗口）
- 性能：`seenTurns` 修剪 O(1) 常态路径 + 半量批量丢弃；20k 回合灌入 < 5s（曾是 O(n²) 全排序，20k 要 20s）

### 4. 面板三向拆分

`combineUsage` 增加 CodeWhale 泳道（machine 总额 + 主宠计费视图，byModel/todayByProvider 标记 `codewhale`；`machineGrowth` 总额含它）。拆分行规则：三家有量三向拼、两量两拼、单量不显示（单 agent 机器不该看到 `Codex $0.000` 噪音——上游原规则保留）。Claude/Codex/CodeWhale 是专有名词，三语言不翻译。

### 5. pr3-smoke 覆盖清单

特殊 key 拒收、数值边界、turn_id 去重、缓存感知计价数学、TOML 幂等 + **旧格式升级**（块重写无重复、用户内容保留）、env 真覆盖、事件名对真实 CodeWhale 词表校验、20k 灌入 < 5s。

</details>
