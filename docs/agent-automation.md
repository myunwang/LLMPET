# 多 Agent 任务自动化

入口：工作台 → **任务自动化**。先选择来源 Agent，再从「已发现会话」选择会话，配置触发条件与动作并启用。规则默认关闭。

| 能力 | Codex | Claude Code | DeepSeek Harness (DSH) |
|---|---|---|---|
| 正常结束、中断、结束或中断 | rollout 回合事件 | 原生 hook，保留 Stop 完成门 | 原生 turn/start、turn/end 日志 |
| 已确认失败的原因 | 日志提供明确终止信息时可分类 | 原生 StopFailure、Stop 的最终错误、自动 CLI 的 result；API 重试不冒充终止 | turn/end 的原因；llm/retry 不冒充终止 |
| 继续原会话 | codex exec resume | claude --print --resume | dsh --profile headless --session-id |
| 新任务 | 支持 | 支持 | 支持，需安装兼容 headless 的 CLI |
| 关机 | 支持 | 支持 | 支持 |
| 查询并确认额度恢复 | 已接入 ChatGPT 官方账号查询，受提供商归属限制 | 尚无已验证查询接口 | 尚无已验证查询接口 |

正常完成不算中断。「任务结束或中断」包括正常完成、主动中断、额度耗尽及其他明确终止。等待回复、内部重连、工具执行失败、日志暂时没有新内容都不算任务结束。

Claude 的 Stop 若仍有后台任务、cron 或 stop-hook 续跑，不触发正常完成。DSH 只有明确的 completed 原因算成功，未知原因不算成功。DSH 继续能力使用其 headless 接口，不假设用户已经安装 TUI；CLI 不存在或版本不支持时，动作显示失败，不声称已提交。

## 动作与限制

- **继续 / 重试**：在原生 session ID 中发送继续指令。指令为空时发送默认指令，仍会产生新消息。
- **开始新任务**：填写必需的任务内容，可指定工作目录；默认使用来源会话目录。
- **等待额度后继续**：目前仅向 Codex 提供。需要新的、归属正确的主次额度窗口数据；到达预计重置时间不会直接恢复。自定义提供商的数据若无法确认归属则保持挂起。
- **关机**：至少 60 秒倒计时，可取消。默认等待已观察到的运行中及待回复会话结束。关机不强制关闭未保存的程序。

Claude / DSH 可以配置额度耗尽后关机；界面隐藏尚不支持的自动恢复选项。组合条件「任务结束或中断」若遇到这两者额度耗尽并打算继续或新建任务，会保持挂起并说明缺少恢复接口，避免无效重试。

表单按 Agent、条件、动作显示相关输入。次数在排队时累计，取消也计入上限。默认继续最多 3 次，新任务和关机最多 1 次，可主动重置。重试会增加等待时间；不绕过审批或沙箱；必须同时取得成功的最终事件和退出码才报告执行成功。

Agent 与 session ID 共同决定身份，相同 ID 不会跨 Agent 触发规则。历史回填不执行动作，用户开始新回合会取消旧待执行动作。停用、编辑或删除规则会取消其待执行动作。重启不重放可能已执行的动作；等待额度的请求可保留。

## 会话没有显示时

本机已经发现 Codex 分页历史日志可能继续追加内容，却保留旧的文件修改时间。旧版 LLMPET 会据此把仍在工作的会话当作陈旧记录排除。

现在会同时检查日志尾部事件时间与文件大小变化。启动恢复和后续增量扫描都支持这种情况，心跳也不会被旧 mtime 覆盖。它不把所有旧会话伪装成活跃；历史记录会单独标注「未确认运行」。

1. 重启 LLMPET，使主进程载入新代码；仅关闭再打开工作台不等于重启。
2. 在任务自动化页点击「重新扫描会话」，并确认选择了正确的 Agent。
3. 查看「扫描诊断」中的应用目录、配置文件路径、启动时间、各 Agent 的扫描目录和跟踪数量。安装版 EXE 不会自动使用另一个源码目录的新代码。

Codex 监听与历史列表使用相同路径，支持 `CODEX_HOME`、`LLMPET_CODEX_DIR`；Claude 会话支持 `CLAUDE_CONFIG_DIR`；DSH 支持 `DSH_HOME`、`LLMPET_DSH_DIR`。不存在的目录与被关闭的监听会明确显示。不会为解决可见性问题删除配置、归档或日志。

## 兼容与验证

为兼容已有规则，状态文件仍为 `~/.octopus/codex-automation.json`，旧规则自动归属 Codex。文件名保留不代表在读取旧版本配置。`LLMPET_AUTOMATION_STATE` 可指定独立状态文件。

`LLMPET_NO_CODEX=1`、`LLMPET_NO_DSH=1` 只停用对应 Agent；`OCTOPUS_NO_NET=1` 禁止自动模型任务和额度查询联网，本地关机动作仍可使用。

`npm test` 包含多 Agent 状态、身份隔离、旧规则兼容、mtime 固定时的会话发现，以及 CLI 输出与退出码测试。`npm run test:automation-ui` 启动真实 Electron，以隔离数据验证三种 Agent 的发现、选择、规则保存、hook / 日志触发、取消、动态表单和诊断面板；不实际执行关机或模型任务。

协议来源：[Claude Code 程序化运行](https://code.claude.com/docs/en/headless)、[DSH headless 官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)。Codex 的额度和执行细节见 [Codex 说明](codex-automation.md)。
