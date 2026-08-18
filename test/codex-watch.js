'use strict';

// codex-watch 单元测试 — 用临时目录伪造 ~/.codex/sessions 的 rollout JSONL，
// 注入假 core 记录调用：backfill 静默入库、live 事件映射、subagent 过滤、
// 半行攒批、token_count → 上下文% + rate_limits。
// Run: node test/codex-watch.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodexWatch, toContextUsage, toRateLimits, mapTool, parseRequestUserInput } = require('../backend/codex-watch');
const { createCore } = require('../backend/core');
const adapter = require('../backend/adapter');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// 假 core：只记账
function fakeCore() {
  return {
    updates: [], seeds: [], ctx: [], metas: [],
    updateSession(sid, state, event, fields) { this.updates.push({ sid, state, event, fields }); },
    seedSession(s) { this.seeds.push(s); },
    setContextUsage(sid, cu) { this.ctx.push({ sid, cu }); },
    setSessionMeta(sid, fields) { this.metas.push({ sid, fields }); },
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
check('parseRequestUserInput：Codex function_call arguments 保留问题/选项', () => {
  const qs = parseRequestUserInput(JSON.stringify({ questions: [{
    header: '方案', id: 'plan', question: '选哪一个？',
    options: [{ label: 'A', description: '保守' }, { label: 'B', description: '激进' }],
  }] }));
  assert.deepStrictEqual(qs, [{
    header: '方案', id: 'plan', question: '选哪一个？',
    options: [{ label: 'A', description: '保守' }, { label: 'B', description: '激进' }],
    multiSelect: false,
  }]);
  assert.deepStrictEqual(parseRequestUserInput('{bad json'), []);
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
check('Codex session_index 的正式标题覆盖 prompt 猜名', () => {
  const { root, dir } = mkSessions();
  const sessionIndexPath = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(sessionIndexPath, line({
    id: UUID_A, thread_name: '继续 FaceAI 阶段收尾工作', updated_at: new Date().toISOString(),
  }));
  const fp = path.join(dir, `rollout-official-title-${UUID_A}.jsonl`);
  fs.writeFileSync(fp,
    meta(UUID_A) +
    line({ type: 'event_msg', payload: { type: 'user_message', message: '你先告诉我现在是什么状态？' } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, sessionIndexPath, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].sessionTitle, '继续 FaceAI 阶段收尾工作');
});
check('启动时 Codex 已在等选择 → 回填真实选择卡', () => {
  const { root, dir } = mkSessions();
  const fp = path.join(dir, `rollout-pending-choice-${UUID_A}.jsonl`);
  fs.writeFileSync(fp,
    meta(UUID_A) +
    line({ type: 'response_item', payload: {
      type: 'function_call', name: 'request_user_input', call_id: 'call_backfill',
      arguments: JSON.stringify({ questions: [{
        header: '模式', id: 'mode', question: '选哪个模式？',
        options: [{ label: '快速', description: '先出结果' }, { label: '严格', description: '先验证' }],
      }] }),
    } }));
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].state, 'notification');
  assert.strictEqual(core.seeds[0].codexChoice.id, 'call_backfill');
  assert.strictEqual(core.seeds[0].codexChoice.questions[0].question, '选哪个模式？');
});

console.log('[C3] live：运行期间新会话的事件映射');
check('掠夺按历史 mtime 补齐最近三条用户会话，不受 30 分钟 backfill 限制', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const ids = [
    '019f5103-921c-7ac1-9a8d-c4f8ff8a6701',
    '019f5103-921c-7ac1-9a8d-c4f8ff8a6702',
    '019f5103-921c-7ac1-9a8d-c4f8ff8a6703',
    '019f5103-921c-7ac1-9a8d-c4f8ff8a6704',
  ];
  ids.forEach((id, index) => {
    const fp = path.join(dir, `rollout-loot-${id}.jsonl`);
    fs.writeFileSync(fp, meta(id) + line({ type: 'event_msg', payload: { type: 'user_message', message: `历史会话 ${index + 1}` } }));
    const when = new Date(Date.now() - (4 - index) * 86400000);
    fs.utimesSync(fp, when, when);
  });
  const guardian = path.join(dir, 'rollout-loot-guardian.jsonl');
  fs.writeFileSync(guardian, meta(UUID_A, { thread_source: 'subagent', source: { subagent: { other: 'guardian' } } }));
  const newest = new Date();
  fs.utimesSync(guardian, newest, newest);

  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  const selected = w.seedRecent(3);
  assert.deepStrictEqual(selected, ids.slice(1).reverse());
  assert.deepStrictEqual(core.seeds.map((s) => s.sessionTitle), ['历史会话 4', '历史会话 3', '历史会话 2']);
  assert.ok(core.seeds.every((s) => s.agentId === 'codex' && s.headless === false));
});

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

check('运行中新增/重命名的 Codex 正式标题会刷新到现有会话', () => {
  const { root, dir } = mkSessions();
  const sessionIndexPath = path.join(root, 'session_index.jsonl');
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, sessionIndexPath, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-dynamic-title-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B)
    + line({ type: 'event_msg', payload: { type: 'user_message', message: '临时 prompt 标题' } }));
  w.tick();
  fs.writeFileSync(sessionIndexPath, line({ id: UUID_B, thread_name: '正式任务标题' }));
  w.tick();
  assert.deepStrictEqual(core.metas.at(-1), {
    sid: UUID_B, fields: { sessionTitle: '正式任务标题' },
  });
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

check('长寿 rollout 在回合中重复 session_meta 不会把进行中状态重置为 idle', () => {
  const { root, dir } = mkSessions();
  const core = fakeCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-repeated-meta-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B)
    + line({ type: 'event_msg', payload: { type: 'task_started' } })
    + line({ type: 'response_item', payload: { type: 'function_call', name: 'wait_agent' } }));
  w.tick();
  const sessionStartsBefore = core.updates.filter((u) => u.event === 'SessionStart').length;
  fs.appendFileSync(fp, meta(UUID_B, { memory_mode: 'auto' }));
  w.tick();
  assert.strictEqual(core.updates.filter((u) => u.event === 'SessionStart').length, sessionStartsBefore);
  assert.strictEqual(core.updates.at(-1).state, 'working');
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

check('Codex request_user_input 进入 LLMPET 选择卡，原端回答后自动清掉', () => {
  const { root, dir } = mkSessions();
  const core = createCore();
  const w = createCodexWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = path.join(dir, `rollout-2026-07-11T05-40-00-${UUID_B}.jsonl`);
  fs.writeFileSync(fp, meta(UUID_B));
  w.tick();
  fs.appendFileSync(fp, line({
    type: 'response_item',
    payload: {
      type: 'function_call', name: 'request_user_input', call_id: 'call_choice_1',
      arguments: JSON.stringify({ questions: [{
        header: '部署', id: 'deploy', question: '先部署哪个环境？',
        options: [{ label: '测试环境', description: '风险更低' }, { label: '生产环境', description: '立即上线' }],
      }] }),
    },
  }));
  w.tick();

  let stats = adapter.buildPetStats(core.buildSnapshot(), [], null);
  let session = stats.sessions.find((s) => s.sessionId === UUID_B);
  assert.strictEqual(session.state, 'needsinput');
  assert.strictEqual(session.choice.kind, 'codex-ask');
  assert.strictEqual(session.choice.requestId, 'call_choice_1');
  assert.strictEqual(session.choice.externalOnly, true);
  assert.strictEqual(session.choice.question, '先部署哪个环境？');
  assert.deepStrictEqual(session.choice.options, [
    { label: '测试环境', desc: '风险更低' },
    { label: '生产环境', desc: '立即上线' },
  ]);

  fs.appendFileSync(fp, line({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call_choice_1', output: { deploy: { answers: ['测试环境'] } } },
  }));
  w.tick();
  stats = adapter.buildPetStats(core.buildSnapshot(), [], null);
  session = stats.sessions.find((s) => s.sessionId === UUID_B);
  assert.strictEqual(session.state, 'working');
  assert.strictEqual(session.choice, null);
  core.stopStaleCleanup();
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

console.log('[C5] 长寿会话与超长 meta（实测踩坑回归）');
check('Codex 没有 terminal pid 时，rollout 仍在写就不会被 30 分钟清理误删', () => {
  const core = createCore();
  core.updateSession(UUID_A, 'working', 'PreToolUse', { agentId: 'codex', headless: false });
  const session = core.getSession(UUID_A);
  session.updatedAt = Date.now() - 31 * 60 * 1000;
  session.transcriptActiveAt = Date.now() - 1000;
  core.cleanStaleSessions();
  assert.ok(core.getSession(UUID_A), '活跃 rollout 对应的长任务应继续留在桌宠会话框');
  session.transcriptActiveAt = Date.now() - 31 * 60 * 1000;
  core.cleanStaleSessions();
  assert.strictEqual(core.getSession(UUID_A), null, '事件和 rollout 都沉默超时后仍应正常回收');
  core.stopStaleCleanup();
});
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
check('35KB+ 超长 session_meta 行完整解析（cwd / subagent 判定不丢）', () => {
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
