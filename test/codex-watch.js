'use strict';

// codex-watch 单元测试 — 用临时目录伪造 ~/.codex/sessions 的 rollout JSONL，
// 注入假 core 记录调用：backfill 静默聚合、live 事件映射、subagent 父会话归并、
// 半行攒批、token_count → 上下文% + rate_limits。
// Run: node test/codex-watch.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodexWatch, toContextUsage, toRateLimits, mapTool } = require('../backend/codex-watch');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// 假 core：只记账
function fakeCore() {
  return {
    updates: [], seeds: [], ctx: [],
    updateSession(sid, state, event, fields) { this.updates.push({ sid, state, event, fields }); },
    seedSession(s) { this.seeds.push(s); },
    setContextUsage(sid, cu) { this.ctx.push({ sid, cu }); },
  };
}

// 当天日期目录（watcher 只扫今天/昨天）
function todayDir(root) {
  const d = new Date();
  return path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
}

function mkSessions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-codex-'));
  const dir = todayDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const UUID_A = '019f5103-921c-7ac1-9a8d-c4f8ff8a67aa';
const UUID_B = '019f5103-921c-7ac1-9a8d-c4f8ff8a67bb';
const UUID_C = '019f5103-921c-7ac1-9a8d-c4f8ff8a67cc';
const line = (o) => JSON.stringify(o) + '\n';
const meta = (id, extra = {}) => line({ type: 'session_meta', payload: { id, session_id: id, cwd: '/tmp/proj', originator: 'codex-tui', thread_source: 'user', ...extra } });

console.log('[C1] 纯函数：payload 形状转换');
check('toContextUsage：last_token_usage/total ÷ window → percent(source=codex)', () => {
  const cu = toContextUsage({ last_token_usage: { total_tokens: 274209 }, model_context_window: 353400 });
  assert.strictEqual(cu.used, 274209);
  assert.strictEqual(cu.limit, 353400);
  assert.strictEqual(cu.percent, 78);
  assert.strictEqual(cu.source, 'codex');
});
check('toContextUsage：没有用量 → null', () => {
  assert.strictEqual(toContextUsage({}), null);
  assert.strictEqual(toContextUsage(null), null);
});
check('toRateLimits：primary/secondary/plan 归一化(resets_at 秒→毫秒)', () => {
  const rl = toRateLimits({ primary: { used_percent: 54, window_minutes: 300, resets_at: 1783779520 }, secondary: { used_percent: 8, window_minutes: 10080 }, plan_type: 'plus' });
  assert.strictEqual(rl.usedPercent, 54);
  assert.strictEqual(rl.resetsAt, 1783779520000);
  assert.strictEqual(rl.secondaryUsedPercent, 8);
  assert.strictEqual(rl.planType, 'plus');
  assert.strictEqual(toRateLimits({}), null);
});
check('mapTool：codex 工具名 → 既有词汇', () => {
  assert.strictEqual(mapTool('exec_command'), 'Bash');
  assert.strictEqual(mapTool('exec'), 'Bash');
  assert.strictEqual(mapTool('apply_patch'), 'Edit');
  assert.strictEqual(mapTool('js'), 'Js');
  assert.strictEqual(mapTool('unknown_tool'), 'unknown_tool');
});

console.log('[C2] backfill：启动时已有的会话静默入库');
check('meta+尾部 user_message/token_count → seedSession(不发事件)', () => {
  const { root, dir } = mkSessions();
  const fp = path.join(dir, `rollout-2026-07-11T04-50-16-${UUID_A}.jsonl`);
  fs.writeFileSync(fp,
    meta(UUID_A) +
    line({ type: 'event_msg', payload: { type: 'user_message', message: '帮我修个 bug' } }) +
    line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 10000 } } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].id, UUID_A);
  assert.strictEqual(core.seeds[0].agentId, 'codex');
  assert.strictEqual(core.seeds[0].cwd, '/tmp/proj');
  assert.strictEqual(core.seeds[0].sessionTitle, '帮我修个 bug');
  assert.strictEqual(core.seeds[0].contextUsage.percent, 10);
  assert.strictEqual(core.seeds[0].state, 'thinking', '重启后应从尾部恢复正在执行的状态');
  assert.strictEqual(core.updates.length, 0, 'backfill 不应发 updateSession');
});

console.log('[C3] live：运行期间新会话的事件映射');
check('SessionStart→prompt→tool→complete 全链路', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  let limits = null;
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999, onRateLimits: (rl) => { limits = rl; } });
  w.tick(); // 空场启动 → booted
  const fp = path.join(dir, `rollout-2026-07-11T05-00-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B));
  w.tick();
  fs.appendFileSync(fp,
    line({ type: 'event_msg', payload: { type: 'user_message', message: '跑一下测试' } }) +
    line({ type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}' } }) +
    line({ type: 'response_item', payload: { type: 'function_call_output' } }) +
    line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 500 }, model_context_window: 5000 }, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1783779520 } } } }) +
    line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '测试全绿 ✅' } }));
  w.tick();

  const evs = core.updates.map((u) => u.event);
  assert.deepStrictEqual(evs, ['SessionStart', 'UserPromptSubmit', 'TaskStarted', 'PreToolUse', 'PostToolUse', 'Stop']);
  const bySid = core.updates.every((u) => u.sid === UUID_B);
  assert.ok(bySid, '全部事件应归属同一会话');
  assert.strictEqual(core.updates[1].state, 'thinking');
  assert.strictEqual(core.updates[3].state, 'working');
  assert.strictEqual(core.updates[3].fields.toolName, 'Bash');
  // 工具结果只结束一个动作，整轮任务仍在执行 → working 保持到 task_complete
  assert.strictEqual(core.updates[4].state, 'working');
  assert.strictEqual(core.updates[5].state, 'attention');
  assert.strictEqual(core.updates[5].fields.assistantLastOutput, '测试全绿 ✅');
  assert.ok(core.updates.every((u) => u.fields.agentId === 'codex'));
  assert.strictEqual(core.ctx.length, 1);
  assert.strictEqual(core.ctx[0].cu.percent, 10);
  assert.strictEqual(limits.usedPercent, 12);
});

check('回合生命周期：首个工具前 thinking；开工后 output/reasoning 都保持 working', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-2026-07-11T05-30-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B));
  fs.appendFileSync(fp,
    line({ type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ type: 'response_item', payload: { type: 'reasoning' } }) +
    line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }) +
    line({ type: 'response_item', payload: { type: 'function_call_output' } }) +
    line({ type: 'event_msg', payload: { type: 'agent_reasoning', text: '想一想…' } }) +
    line({ type: 'response_item', payload: { type: 'reasoning' } }) +
    line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }));
  w.tick();
  const states = core.updates.slice(1).map((u) => u.state); // 掐掉 SessionStart
  assert.deepStrictEqual(states, ['thinking', 'thinking', 'working', 'working', 'working', 'working', 'working']);
});

check('新一轮会重置开工锁：上一轮用过工具不污染下一轮初始 thinking', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-2026-07-11T05-31-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B));
  fs.appendFileSync(fp,
    line({ type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }) +
    line({ type: 'event_msg', payload: { type: 'task_complete' } }) +
    line({ type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ type: 'response_item', payload: { type: 'reasoning' } }));
  w.tick();
  const tail = core.updates.slice(-2).map((u) => `${u.event}:${u.state}`);
  assert.deepStrictEqual(tail, ['TaskStarted:thinking', 'Reasoning:thinking']);
});

check('turn_aborted → TurnAborted(idle)；approval → Notification', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-2026-07-11T05-00-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B));
  fs.appendFileSync(fp,
    line({ type: 'event_msg', payload: { type: 'exec_approval_request' } }) +
    line({ type: 'event_msg', payload: { type: 'turn_aborted' } }));
  w.tick();
  const evs = core.updates.map((u) => `${u.event}:${u.state}`);
  assert.deepStrictEqual(evs, ['SessionStart:idle', 'Notification:notification', 'TurnAborted:idle']);
});

console.log('[C4] 子代理聚合与健壮性');
check('backfill：活跃 subagent 静默归并到父 session_id，不生成子会话', () => {
  const { root, dir } = mkSessions();
  const parent = path.join(dir, `rollout-2026-07-11T04-00-00-${UUID_A}.jsonl`);
  const child = path.join(dir, `rollout-2026-07-11T04-01-00-${UUID_B}.jsonl`);
  fs.writeFileSync(parent, meta(UUID_A)
    + line({ timestamp: '2026-07-11T04:00:10Z', type: 'event_msg', payload: { type: 'turn_aborted' } }));
  fs.writeFileSync(child, meta(UUID_B, {
    session_id: UUID_A,
    parent_thread_id: UUID_A,
    thread_source: 'subagent',
    source: { subagent: { other: 'worker' } },
  }) + line({ timestamp: '2026-07-11T04:01:10Z', type: 'event_msg', payload: { type: 'task_started' } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].id, UUID_A);
  assert.strictEqual(core.seeds[0].state, 'juggling');
  assert.strictEqual(core.seeds[0].lastEvent.rawEvent, 'SubagentStart');
  assert.strictEqual(core.seeds[0].transcriptPath, parent, '会话身份应保留父 rollout');
  assert.strictEqual(core.updates.length, 0, '启动聚合仍然不能回放事件');
});

check('live：并行 subagent 归并父会话；一个先结束不释放整体 working', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const parent = path.join(dir, `rollout-parent-${UUID_A}.jsonl`);
  const child1 = path.join(dir, `rollout-child-${UUID_B}.jsonl`);
  const child2 = path.join(dir, `rollout-child-${UUID_C}.jsonl`);
  fs.writeFileSync(parent, meta(UUID_A));
  w.tick();
  const childMeta = (id) => meta(id, {
    session_id: UUID_A,
    parent_thread_id: UUID_A,
    thread_source: 'subagent',
    source: { subagent: { other: 'worker' } },
  });
  fs.writeFileSync(child1, childMeta(UUID_B));
  fs.writeFileSync(child2, childMeta(UUID_C));
  w.tick();
  assert.strictEqual(core.updates.filter((u) => u.event === 'SessionStart').length, 1, '子 rollout 不建独立会话');

  fs.appendFileSync(child1, line({ type: 'event_msg', payload: { type: 'task_started' } }));
  fs.appendFileSync(child2, line({ type: 'event_msg', payload: { type: 'task_started' } }));
  w.tick();
  const starts = core.updates.filter((u) => u.event === 'SubagentStart');
  assert.strictEqual(starts.length, 2);
  assert.ok(starts.every((u) => u.sid === UUID_A && u.state === 'juggling'));

  fs.appendFileSync(child1, line({ type: 'event_msg', payload: { type: 'task_complete' } }));
  w.tick();
  assert.strictEqual(core.updates.at(-1).sid, UUID_A);
  assert.strictEqual(core.updates.at(-1).state, 'juggling', '仍有另一个子代理活跃时必须保持 juggling');
  assert.strictEqual(core.updates.at(-1).event, 'SubagentStop');

  fs.appendFileSync(child2, line({ type: 'event_msg', payload: { type: 'task_complete' } }));
  w.tick();
  assert.strictEqual(core.updates.at(-1).sid, UUID_A);
  assert.strictEqual(core.updates.at(-1).state, 'working');
  assert.strictEqual(core.updates.at(-1).event, 'SubagentStop');
});

check('半行写入攒到下一轮，不丢不重', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-2026-07-11T05-00-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B));
  w.tick();
  const full = line({ type: 'event_msg', payload: { type: 'user_message', message: '半截消息也不能丢' } });
  fs.appendFileSync(fp, full.slice(0, 20)); // 故意只写半行
  w.tick();
  assert.strictEqual(core.updates.filter((u) => u.event === 'UserPromptSubmit').length, 0);
  fs.appendFileSync(fp, full.slice(20));
  w.tick();
  const prompts = core.updates.filter((u) => u.event === 'UserPromptSubmit');
  assert.strictEqual(prompts.length, 1);
});

check('坏 JSON 行 / 空目录 / 目录不存在都不炸', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-2026-07-11T05-00-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B));
  fs.appendFileSync(fp, 'NOT JSON AT ALL\n' + line({ type: 'event_msg', payload: { type: 'task_started' } }));
  w.tick();
  assert.ok(core.updates.some((u) => u.event === 'TaskStarted'));
  const w2 = createCodexWatch({ core: fakeCore(), sessionsDir: path.join(root, 'nope'), pollMs: 999999 });
  w2.tick(); // 不抛即可
});

console.log('[C5] 长寿会话与超长 meta（实测踩坑回归）');
check('几天前日期目录里的活跃文件：启动即入库，之后每轮都能跟进增量', () => {
  const { root } = mkSessions();
  // 会话 5 天前开始 → rollout 在 5 天前的日期目录里，但 mtime 是现在（还在写）
  const d = new Date(Date.now() - 5 * 86400000);
  const oldDir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(oldDir, { recursive: true });
  const fp = path.join(oldDir, `rollout-old-${UUID_A}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_A) + line({ type: 'event_msg', payload: { type: 'user_message', message: '几天前开的长寿会话' } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick(); // 启动轮 = 全量扫描
  assert.strictEqual(core.seeds.length, 1, '旧日期目录的活跃文件应在启动时入库');
  assert.strictEqual(core.seeds[0].sessionTitle, '几天前开的长寿会话');
  fs.appendFileSync(fp, line({ type: 'event_msg', payload: { type: 'task_started' } }));
  w.tick(); // 第二轮不是全量轮：tracker 直连 stat 也必须泵到
  assert.ok(core.updates.some((u) => u.event === 'TaskStarted'), '非全量轮也要跟进旧目录文件的增量');
});

check('Windows LastWriteTime 不变时，文件大小增长仍判定为活动', () => {
  const { root, dir } = mkSessions();
  const fp = path.join(dir, `rollout-stale-mtime-${UUID_B}.jsonl`);
  const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(fp, meta(UUID_B)
    + line({ timestamp: oldTimestamp, type: 'event_msg', payload: { type: 'task_complete' } }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(fp, old, old);
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(w._trackers.has(fp), false, '旧事件且无增长时应保持沉睡');

  fs.appendFileSync(fp, line({ type: 'event_msg', payload: { type: 'task_started' } }));
  fs.utimesSync(fp, old, old); // 模拟 Windows 未推进 LastWriteTime
  w.tick();
  assert.strictEqual(w._trackers.has(fp), true, '字节增长必须重新激活 tracker');
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['TaskStarted']);
});

check('启动扫描按最后事件时间识别活动，不依赖 LastWriteTime', () => {
  const { root, dir } = mkSessions();
  const fp = path.join(dir, `rollout-recent-event-${UUID_C}.jsonl`);
  const eventTime = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(fp, meta(UUID_C)
    + line({ timestamp: eventTime, type: 'event_msg', payload: { type: 'task_started' } }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(fp, old, old);
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1, '近期事件必须进入启动会话列表');
  assert.strictEqual(core.seeds[0].id, UUID_C);
  assert.ok(Math.abs(core.seeds[0].updatedAt - Date.parse(eventTime)) < 10);
});

check('35KB+ 超长 session_meta 行完整解析（cwd / 父会话判定不丢）', () => {
  const { root, dir } = mkSessions();
  const fp = path.join(dir, `rollout-2026-07-11T06-00-00-${UUID_B}.jsonl`);
  const big = {
    type: 'session_meta',
    payload: { id: UUID_B, session_id: UUID_B, cwd: '/tmp/bigmeta', originator: 'Codex Desktop', thread_source: 'user', base_instructions: { text: 'x'.repeat(35000) } },
  };
  fs.writeFileSync(fp, JSON.stringify(big) + '\n'
    + line({ type: 'event_msg', payload: { type: 'user_message', message: '超长 meta 也要认识我' } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].cwd, '/tmp/bigmeta', 'meta 截断会丢 cwd');
});

console.log('[C6] 长会话恢复：只接增量，绝不重放历史');
check('启动时已沉睡的旧 rollout 再活跃：从启动快照 EOF 接续', () => {
  const { root, dir } = mkSessions();
  const fp = path.join(dir, `rollout-old-sleeping-${UUID_A}.jsonl`);
  fs.writeFileSync(fp,
    meta(UUID_A) +
    line({ type: 'event_msg', payload: { type: 'user_message', message: '旧任务' } }) +
    line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '旧完成' } }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(fp, old, old);
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 0, '沉睡文件不应进入启动列表');
  assert.strictEqual(core.updates.length, 0, '启动不应回放沉睡文件');

  fs.appendFileSync(fp,
    line({ type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ type: 'event_msg', payload: { type: 'user_message', message: '当前任务' } }));
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['TaskStarted', 'UserPromptSubmit']);
  assert.ok(core.updates.every((u) => u.state === 'thinking'));
  assert.ok(!core.updates.some((u) => u.event === 'Stop' || u.event === 'SessionStart'));
});

check('已跟踪 rollout 静默退场再恢复：保留退场游标，不重放旧完成事件', () => {
  const { root, dir } = mkSessions();
  const fp = path.join(dir, `rollout-paused-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B) + line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '历史' } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.updates.length, 0);

  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(fp, old, old);
  w.tick();
  assert.strictEqual(w._trackers.has(fp), false, '静默 tracker 应退场');

  fs.appendFileSync(fp, line({ type: 'event_msg', payload: { type: 'task_started' } }));
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['TaskStarted']);
  assert.ok(!core.updates.some((u) => u.event === 'Stop' || u.event === 'SessionStart'));
});

process.exit(failures ? 1 : 0);
