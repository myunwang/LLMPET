'use strict';

// codex-watch 单元测试 — 用临时目录伪造 ~/.codex/sessions 的 rollout JSONL，
// 注入假 core 记录调用：backfill 静默入库、live 事件映射、subagent 过滤、
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-codex-'));
  const dir = todayDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const UUID_A = '019f5103-921c-7ac1-9a8d-c4f8ff8a67aa';
const UUID_B = '019f5103-921c-7ac1-9a8d-c4f8ff8a67bb';
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
  assert.strictEqual(core.updates[5].state, 'attention');
  assert.strictEqual(core.updates[5].fields.assistantLastOutput, '测试全绿 ✅');
  assert.ok(core.updates.every((u) => u.fields.agentId === 'codex'));
  assert.strictEqual(core.ctx.length, 1);
  assert.strictEqual(core.ctx[0].cu.percent, 10);
  assert.strictEqual(limits.usedPercent, 12);
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

console.log('[C4] 过滤与健壮性');
check('thread_source=subagent 整个文件跳过(含 backfill 与 live)', () => {
  const { root, dir } = mkSessions();
  // backfill 路径
  const fp1 = path.join(dir, `rollout-2026-07-11T04-00-00-${UUID_A}.jsonl`);
  fs.writeFileSync(fp1, meta(UUID_A, { thread_source: 'subagent', source: { subagent: { other: 'guardian' } } })
    + line({ type: 'event_msg', payload: { type: 'user_message', message: 'internal' } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  // live 路径
  const fp2 = path.join(dir, `rollout-2026-07-11T05-00-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp2, meta(UUID_B, { thread_source: 'subagent' }));
  w.tick();
  fs.appendFileSync(fp2, line({ type: 'event_msg', payload: { type: 'user_message', message: 'still internal' } }));
  w.tick();
  assert.strictEqual(core.seeds.length, 0);
  assert.strictEqual(core.updates.length, 0);
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

process.exit(failures ? 1 : 0);
