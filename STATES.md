# octopus — 状态机 & 形象生成规范

桌宠「octopus」(Claude Code 等编码 agent 的桌面宠物)的全部状态、触发逻辑,以及每个状态的**图片生成 prompt**。依据本项目自身的状态机整理。把第 4 节的英文 prompt 交给生成模型即可。

---

## 1. 角色设定(每张图共用,务必一致)

一只可爱的卡通**橙色小章鱼**:圆顶大脑袋/身体、大眼睛、腮红、六条短触手当四肢、奶油色肚皮。

| 元素 | 取值 |
|---|---|
| 身体(上→下) | `#F2A98C` → `#DE7E5D` → `#C15B3B` |
| 肚皮 | `#FCE0CE` / 高光 `#F6C3A4` |
| 腮红 | `#EF9C92` |
| 眼睛/线条 | 深棕 `#3D2A20`,眼内有白色小高光 |
| 嘴/触手描边 | `#9A4B33` |
| 错误牌等强调红 | `#E5484D`(描边 `#7A1F22`) |

**BASE prompt(每条形象前都拼上这段):**
> A cute kawaii cartoon octopus mascot, the desktop pet for a coding AI agent. Round dome-shaped head-body in warm coral-orange (top highlight #F2A98C, mid #DE7E5D, base #C15B3B), soft cream belly patch (#FCE0CE), two round rosy cheek blushes (#EF9C92), large friendly round eyes with dark brown pupils (#3D2A20) and tiny white glints, a small simple mouth, six short rounded tentacles used as arms and legs. Flat clean vector style, soft cel shading, smooth thick outlines, no harsh gradients. Front view with a slight 3/4 angle, full body, centered, small soft oval ground shadow. Transparent background, 512×512.

**STYLE 锁定(一致性,务必加):**
> Keep the exact same character design, proportions, palette, line weight and camera angle across every pose. Only the pose, facial expression and held props change. No text unless explicitly asked; when text is needed, draw it as part of the art (never an emoji glyph).

---

## 2. 通用交付要求

1. 同一只角色、同一画风、同一视角,silhouette 尽量稳定 —— 只换姿态/表情/道具。
2. **透明背景 PNG**,512×512,主体居中、底部留影子位。
3. 每个状态先出 **1 张静帧**;动效(呼吸、上下浮动、抖动、彩带)由前端 CSS 做。要帧动画再每状态出 2–3 帧。
4. 配色锁第 1 节那套,别漂移。**所有文字都画进图里**(如 ERROR 牌),不要用 emoji 字符。
5. 命名 `octo-<state>.png`,state 用第 4 节的 id。

---

## 3. 状态机

### 事件 → 状态
| Claude Code 事件 | 状态 |
|---|---|
| SessionStart | `greet` → `idle` |
| UserPromptSubmit | `thinking` |
| say(Claude 正在回复/输出文本) | `talking`(transient,2–6s,随文本长度) |
| PreToolUse / PostToolUse | `working` |
| PreToolUse(Task) / SubagentStart | `juggling` |
| SubagentStop | `working` |
| PreCompact / SessionEnd(/clear) | `sweeping` |
| PostCompact | `thinking`(自动)/ `idle`(手动) |
| Stop | `attention` → 落定 `idle` + **done 角标**(+ `happy` 庆祝) |
| StopFailure / PostToolUseFailure / ApiError | `error` |
| Notification / Elicitation | `needsinput` |
| PermissionRequest(阻塞 HTTP hook) | `waiting`(授权)/ `needsinput`(elicitation·方案评审) |
| SessionEnd | 入睡序列 → `sleeping` |
| 长时间无活动 | `roam` → 入睡序列 |

### 优先级(多会话时,主形象取最高的那个)
`error 8 > notification 7 > sweeping 6 > attention 5 > carrying 4 = juggling 4 > working 3 > thinking 2 > idle 1 = roam 1 > sleeping 0`

> 前端额外的「短暂态」(transient,2–6s 自动衰减,优先级高于聚合):`talking / happy / greet / interrupted` —— 在持续态之上盖一层显示,过期后让聚合规则接管。

> headless 后台会话(`claude -p`)不计入主形象;每个会话各自状态显示在头顶小圆点。

### 生命周期
- **持续态**:working / thinking / juggling / idle / roam / sleeping —— 待在该状态直到下个事件。
- **一次性态 (oneshot,触发后衰减)**:attention / error / sweeping / notification / carrying。
  衰减兜底已实现(core.js `ONESHOT_TTL_MS`):attention/carrying 15s、sweeping 20s、error 45s 内无后续事件自动落回 idle;notification 例外(语义是「等你回复」,须等用户行动)。
- **序列态(入睡)**:`yawning → dozing → collapsing → sleeping`,醒来 `waking`。(词汇保留,当前无生产者)
- **会话回收**:SessionEnd(含 /clear → sweeping)会标记 `ended`,30 分钟后回收——终端 pid 存活也不豁免,避免 /clear 留下幽灵会话。

---

## 4. 形象清单(每条 = 一张图,prompt 已就绪)

> 用法:`BASE + STYLE + 下面的 Pose`。

### A. 干活类

**`working` — 专注干活**
`Pose:` the octopus leaning slightly forward, focused happy expression, two tentacles working on a small laptop/keyboard in front of it, sleeves-rolled-up busy vibe.

**`thinking` — 思考**
`Pose:` one tentacle on its chin, head tilted up, eyes looking upward, a small white drawn thought bubble above its head with three dots inside (dots animate in CSS).

**`talking` — 正在回应你(打字输出中)**
`Pose:` mouth slightly open mid-speech, friendly engaged expression, head tilted slightly forward, two small wavy speech-wave lines drawn beside the mouth (waves animate in CSS). Triggered when Claude is streaming its reply text.

**`juggling` — 并行子任务**
`Pose:` cheerful but busy, juggling three small glowing orbs with several tentacles at once, eyes wide and excited, a little motion.

**`carrying` — 搬运**
`Pose:` walking on tip-tentacles while hugging a tall stack of papers/boxes that it can barely see over, determined look.

**`sweeping` — 压缩/清理上下文**
`Pose:` holding a small broom, sweeping glowing dust/fragments into a dustpan, tidy and content expression, sparkles of cleared dust.

### B. 等你类(需要你出手 → 醒目)

**`waiting` — 等你授权**
`Pose:` one tentacle raised high in a polite "stop / may I?" gesture, expectant hopeful eyes looking straight at the viewer, a small drawn shield/lock icon floating beside it.

**`needsinput` — 等你回复**
`Pose:` head tilted, holding up a small blank sign/placard, looking at the viewer waiting for an answer, a drawn "?" or speech-bubble mark above.

### C. 完成 / 情绪(短暂态)

**`happy` — 庆祝(任务完成)**
`Pose:` jumping up with tentacles thrown high, big joyful open-mouth cheer, confetti and sparkles around it, a drawn green checkmark.

**`greet` — 打招呼(新会话)**
`Pose:` waving one tentacle, warm friendly smile, slight bow, a small drawn "hi" spark.

### D. 休息类

**`idle` — 待命**
`Pose:` standing relaxed, calm soft smile, gently breathing, blinking — neutral resting default.

**`roam` — 闲逛**
`Pose:` strolling slowly mid-step, looking around curiously, relaxed wandering.

**`yawning` — 困了**
`Pose:` big yawn with mouth open, one tentacle rubbing an eye, droopy sleepy eyes.

**`dozing` — 打盹**
`Pose:` sitting down, head nodding forward, half-closed eyes, about to fall asleep.

**`collapsing` — 瘫软入睡**
`Pose:` slumping/melting down onto the ground, very drowsy, eyes nearly shut.

**`sleeping` — 睡着**
`Pose:` curled up on the ground, eyes closed peacefully, small "Zzz" drawn above, gentle smile.

**`waking` — 醒来**
`Pose:` stretching with tentacles up, rubbing eyes, slightly dazed just-woke-up expression.

### E. 出错

**`error` — 出错瘫倒**(已实现的基准画风)
`Pose:` collapsed flat on the ground, eyes turned into two "X" crosses, a wavy limp mouth, body slightly desaturated, a wide spread-out shadow underneath, and a small hand-drawn red sign on a little pole stuck above its head reading "ERROR" in white bold monospace letters (the sign tilted slightly). Draw the word "ERROR" as part of the art, not an emoji.

---

## 5. 叠加层(贴在主形象上,不是独立角色)

> 这些可以单独出小图(透明 PNG,128×128 左右),前端叠到身体一角/头顶。

- **`badge-done`** — 小绿色对勾圆徽(任务完成)
- **`badge-interrupted`** — 小琥珀/红色感叹号徽(中断)
- **`icon-tool-*`** — working 时随当前工具变的小图标(Bash 终端 / Edit 笔 / Read 书…)
- **`fx-zzz`** — 飘起的 "Zzz"(睡眠)
- **`fx-sparkle`** / **`fx-confetti`** — 庆祝时的星光/彩带

---

## 6. 前端接入现状(给生成完之后接图用)

- **现在已渲染**:`idle / working / juggling / sweeping / thinking / waiting / needsinput / happy / greet / talking / sleeping / error` + 情绪短暂态 `loved / sad / sorry / excited / puzzled`(月薪喵皮肤有独立素材;章鱼/像素回落到就近表情)。
- **状态机里有、但前端还没接独立形象**:`carrying / attention / roam / yawning / dozing / collapsing / waking`(attention 被 Stop 完成门改写为 idle+徽标;roam/入睡序列暂无生产者)。
- 前端聚合梯子与本文件第 3 节优先级表一致:`waiting > 短暂态 > error > needsinput > sweeping > juggling > working > thinking > loafing > idle > sleeping`(见 `renderer/pet.js` applyStats)。
- **loafing(摸鱼)**:adapter 合成态——工具结束(PostToolUse/SubagentStop)后 >5s 无事件的间隙。间隙里模型可能在推理/流式输出/事件丢失,不硬标注为「思考」;真思考走 UserPromptSubmit → thinking 事件通道。网络重试间隙由 transcript 巡检识别为 error,ESC 中断识别为 idle+中断徽标。
- 状态机回归测试:`npm test`(`test/smoke.js` 后端链路 + `test/state-smoke.js` 渲染端,后者用 `test/dom-stub.js` 把真实 `pet.js` 跑在 Node 里)。

---

_状态词表单一来源:**`shared/states.js`**(STATE_PRIORITY / ONESHOT / SLEEP_SEQUENCE / BUSY / VALID_STATES / RENDER_STATE_WORDS)—— 主进程 `require`、渲染端 `<script>` 注入 `window.OctoStates`、测试 `require` 同一份，`test/state-smoke.js` 的 [R0] 断言渲染端词表 ⊇ 后端 VALID_STATES。事件→状态映射在 `hook/octopus-hook.js`(EVENT_STATE),合成态在 `backend/adapter.js`(mapState),聚合梯子在 `renderer/pet.js`(applyStats)。_
