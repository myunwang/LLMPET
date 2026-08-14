'use strict';

// dsh-watch 单元测试 —— 用临时目录伪造 ~/.dsh/sessions 的会话日志布局
// （<root>/--项目--/<会话目录>/session.jsonl[.zstd]），注入假 core 记录调用：
// backfill 静默入库、live 事件映射、子 agent 过滤、注入上下文不当成用户发言、
// 半行攒批、zstd 分帧增量、标题/模型/上下文用量。
// Run: node test/dsh-watch.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDshWatch, mapTool, messageText, isHumanPrompt, toContextUsage,
  decodeSegment, readLogEntries,
} = require('../backend/dsh-watch');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// 假 core：只记账
function fakeCore() {
  return {
    updates: [], seeds: [], ctx: [], meta: [],
    updateSession(sid, state, event, fields) { this.updates.push({ sid, state, event, fields }); },
    seedSession(s) { this.seeds.push(s); },
    setContextUsage(sid, cu) { this.ctx.push({ sid, cu }); },
    setSessionMeta(sid, fields) { this.meta.push({ sid, fields }); },
    events() { return this.updates.map((u) => u.event); },
  };
}

const L = (o) => JSON.stringify(o) + '\n';
const header = (id, extra = {}) => L({
  type: 'session', version: 0, id, createdAt: Date.now(), cwd: '/tmp/dproj', delegationDepth: 0, ...extra,
});
const userMsg = (text, seq = 1, source = { kind: 'user' }) => L({
  type: 'user/message', seq, time: Date.now(),
  data: { role: 'user', source, content: [{ type: 'text', text }] }, surfaceOp: 'append',
});

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-dsh-'));
}
// 建一个会话目录并返回日志路径（不写内容）
function sessionPath(root, id, { project = '--tmp-dproj--', zstd = false } = {}) {
  const dir = path.join(root, project, id);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, zstd ? 'session.jsonl.zstd' : 'session.jsonl');
}

// 生成不压缩（raw blocks）的合法 zstd frame，避免测试依赖 Node 版本是否内置
// zstd compressor。单块按规范限制为 128KiB。
function rawZstdFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const parts = [];
  const headerBuf = Buffer.alloc(9);
  headerBuf.writeUInt32LE(0xFD2FB528, 0);
  headerBuf[4] = 0xA0; // single segment + 4-byte frame content size
  headerBuf.writeUInt32LE(body.length, 5);
  parts.push(headerBuf);
  let offset = 0;
  while (offset < body.length) {
    const n = Math.min(128 * 1024, body.length - offset);
    const blockHeader = Buffer.alloc(3);
    blockHeader.writeUIntLE((n << 3) | (offset + n === body.length ? 1 : 0), 0, 3);
    parts.push(blockHeader, body.subarray(offset, offset + n));
    offset += n;
  }
  return Buffer.concat(parts);
}

const ID_A = 'ses_01JABCDEF0123456789';
const ID_B = 'ses_01JZZZZZZ9876543210';

console.log('[D1] 纯函数：形状转换与过滤判定');
check('mapTool：dsh 工具名 → 既有词汇（认不出的原样透传）', () => {
  assert.strictEqual(mapTool('bash'), 'Bash');
  assert.strictEqual(mapTool('str_replace_editor'), 'Edit');
  assert.strictEqual(mapTool('fs_read'), 'Read');
  assert.strictEqual(mapTool('web_search'), 'WebSearch');
  assert.strictEqual(mapTool('run_code'), 'Js');
  assert.strictEqual(mapTool('subagent_spawn'), 'Task');
  assert.strictEqual(mapTool('grep_files'), 'Grep');   // 形状规则兜底
  assert.strictEqual(mapTool('quantum_thing'), 'quantum_thing');
});
check('messageText：ContentBlock[] / 字符串两种形状都取得到正文', () => {
  assert.strictEqual(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'thinking' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.strictEqual(messageText({ content: '直接是字符串' }), '直接是字符串');
  assert.strictEqual(messageText(null), '');
});
check('isHumanPrompt：只有 source.kind==="user" 算用户说话', () => {
  assert.strictEqual(isHumanPrompt({ source: { kind: 'user' } }), true);
  assert.strictEqual(isHumanPrompt({}), true); // 早期日志没有 source
  assert.strictEqual(isHumanPrompt({ source: { kind: 'plugin', plugin: 'skill' } }), false);
});
check('toContextUsage：input+cache+output 近似占用，有窗口才算百分比', () => {
  const cu = toContextUsage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 }, 10000);
  assert.strictEqual(cu.used, 2000);
  assert.strictEqual(cu.limit, 10000);
  assert.strictEqual(cu.percent, 20);
  assert.strictEqual(cu.source, 'dsh');
  assert.strictEqual(toContextUsage({ inputTokens: 5 }, null).percent, undefined);
  assert.strictEqual(toContextUsage(null), null);
});
check('decodeSegment：会话目录名 ~XXXX 转义可还原', () => {
  assert.strictEqual(decodeSegment('ses~005Fabc'), 'ses_abc');
  assert.strictEqual(decodeSegment('plain-id.1'), 'plain-id.1');
});

console.log('[D2] backfill：启动时已有的会话静默入库');
check('header + 标题 + 用量 → seedSession（不发任何事件）', () => {
  const root = mkRoot();
  const fp = sessionPath(root, ID_A);
  fs.writeFileSync(fp,
    header(ID_A)
    + userMsg('帮我把测试跑绿')
    + L({ type: 'request/context', seq: 2, time: Date.now(), data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 128000 } })
    + L({ type: 'assistant/message', seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 12000, outputTokens: 800 } } })
    + L({ type: 'session/title', seq: 4, time: Date.now(), data: { title: '修复测试套件', messageSeqs: [1], source: 'provider' } }));
  const core = fakeCore();
  createDshWatch({ core, sessionsDir: root, pollMs: 999999 }).tick();
  assert.strictEqual(core.seeds.length, 1);
  const s = core.seeds[0];
  assert.strictEqual(s.id, ID_A);
  assert.strictEqual(s.agentId, 'dsh');
  assert.strictEqual(s.cwd, '/tmp/dproj');
  assert.strictEqual(s.sessionTitle, '修复测试套件', 'session/title 优先于首条 prompt');
  assert.strictEqual(s.model, 'deepseek-chat');
  assert.strictEqual(s.contextUsage.used, 12800);
  assert.strictEqual(s.contextUsage.percent, 10);
  assert.strictEqual(core.updates.length, 0, 'backfill 不应发 updateSession');
});
check('没有 session/title 时用首条真人 prompt 兜底标题', () => {
  const root = mkRoot();
  fs.writeFileSync(sessionPath(root, ID_A), header(ID_A) + userMsg('给我加个缓存层'));
  const core = fakeCore();
  createDshWatch({ core, sessionsDir: root, pollMs: 999999 }).tick();
  assert.strictEqual(core.seeds[0].sessionTitle, '给我加个缓存层');
});
check('未答复的 approval → 入库即「等你回复」', () => {
  const root = mkRoot();
  fs.writeFileSync(sessionPath(root, ID_A),
    header(ID_A) + userMsg('删掉这个目录')
    + L({ type: 'approval/asked', seq: 2, time: Date.now(), data: { id: 'ap1', toolName: 'bash' } }));
  const core = fakeCore();
  createDshWatch({ core, sessionsDir: root, pollMs: 999999 }).tick();
  assert.strictEqual(core.seeds[0].state, 'notification');
});
check('backfill 停在 tool/call → 恢复为 working，不误报空闲', () => {
  const root = mkRoot();
  fs.writeFileSync(sessionPath(root, ID_A),
    header(ID_A)
    + L({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    + L({ type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'bash' } }));
  const core = fakeCore();
  createDshWatch({ core, sessionsDir: root, pollMs: 999999 }).tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].state, 'working');
  assert.strictEqual(core.updates.length, 0, 'backfill 仍需保持静默');
});
check('未知 session 日志版本 fail closed，不猜测解析', () => {
  const root = mkRoot();
  fs.writeFileSync(sessionPath(root, ID_A), header(ID_A, { version: 99 }) + userMsg('未来协议'));
  const core = fakeCore();
  createDshWatch({ core, sessionsDir: root, pollMs: 999999 }).tick();
  assert.strictEqual(core.seeds.length, 0);
  assert.strictEqual(core.updates.length, 0);
});

console.log('[D3] live：运行期间新会话的事件映射');
check('turn/start → prompt → 工具 → 完成 全链路', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick(); // 空场启动 → booted
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  w.tick();
  fs.appendFileSync(fp,
    L({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    + userMsg('跑一下测试', 2)
    + L({ type: 'step/start', seq: 3, time: Date.now(), data: { turn: 1, step: 1 } })
    + L({ type: 'tool/call', seq: 4, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"npm test"}' } })
    + L({ type: 'tool/result', seq: 5, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'tool', content: 'all pass' } }, surfaceOp: 'append' })
    + L({ type: 'assistant/message', seq: 6, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '测试全绿 ✅' }] }, usage: { inputTokens: 100, outputTokens: 20 } }, surfaceOp: 'append' })
    + L({ type: 'turn/end', seq: 7, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }));
  w.tick();

  assert.deepStrictEqual(core.events(), [
    'SessionStart', 'TaskStarted', 'UserPromptSubmit', 'Reasoning', 'PreToolUse', 'PostToolUse', 'Stop',
  ]);
  assert.ok(core.updates.every((u) => u.sid === ID_B), '全部事件应归属同一会话');
  assert.ok(core.updates.every((u) => u.fields.agentId === 'dsh'));
  assert.strictEqual(core.updates[2].state, 'thinking');       // UserPromptSubmit
  assert.strictEqual(core.updates[3].state, 'thinking');       // 首个工具前的 step/start
  assert.strictEqual(core.updates[4].state, 'working');
  assert.strictEqual(core.updates[4].fields.toolName, 'Bash');
  assert.strictEqual(core.updates[5].state, 'working');        // 工具结果 = 任务仍在执行
  assert.strictEqual(core.updates[6].state, 'attention');
  assert.strictEqual(core.updates[6].fields.assistantLastOutput, '测试全绿 ✅');
  assert.strictEqual(core.ctx.length, 1);
});

check('工具后的 step/start 保持 working（不掉回 thinking）', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  fs.appendFileSync(fp,
    L({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    + L({ type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'bash' } })
    + L({ type: 'step/start', seq: 3, time: Date.now(), data: { turn: 1, step: 2 } }));
  w.tick();
  const states = core.updates.map((u) => u.state);
  assert.deepStrictEqual(states, ['idle', 'thinking', 'working', 'working']);
});

check('工具失败 → PostToolUseFailure(error)', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  fs.appendFileSync(fp,
    L({ type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'str_replace_editor' } })
    + L({ type: 'tool/result', seq: 2, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'tool', content: 'boom' }, error: { name: 'FsError', code: 'ENOENT' } }, surfaceOp: 'append' }));
  w.tick();
  const last = core.updates[core.updates.length - 1];
  assert.strictEqual(last.event, 'PostToolUseFailure');
  assert.strictEqual(last.state, 'error');
  assert.strictEqual(last.fields.toolName, 'Edit');
});

check('turn/end 只有 completed 庆祝，其他已知/未知原因都不误报完成', () => {
  const cases = [
    [{ kind: 'aborted', reason: { kind: 'legacy' } }, 'TurnAborted', 'idle'],
    [{ kind: 'blocked' }, 'TurnAborted', 'idle'],
    [{ kind: 'interrupted' }, 'TurnAborted', 'idle'],
    [{ kind: 'max-tokens' }, 'TurnAborted', 'idle'],
    [{ kind: 'future-reason' }, 'TurnAborted', 'idle'],
    [null, 'TurnAborted', 'idle'],
    [{ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, 'ApiError', 'error'],
    [{ kind: 'completed' }, 'Stop', 'attention'],
  ];
  for (const [reason, event, state] of cases) {
    const root = mkRoot();
    const core = fakeCore();
    const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
    w.tick();
    const fp = sessionPath(root, ID_B);
    fs.writeFileSync(fp, header(ID_B));
    fs.appendFileSync(fp, L({ type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason } }));
    w.tick();
    const last = core.updates[core.updates.length - 1];
    assert.strictEqual(last.event, event, `${reason && reason.kind || 'missing'} → ${event}`);
    assert.strictEqual(last.state, state);
  }
});

check('approval：asked → 等你回复；decided(allowed-once) → 回到执行', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  fs.appendFileSync(fp,
    L({ type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'bash' } })
    + L({ type: 'approval/asked', seq: 2, time: Date.now(), data: { id: 'ap1', toolName: 'bash', callId: 'c1' } })
    + L({ type: 'approval/decided', seq: 3, time: Date.now(), data: { id: 'ap1', outcome: 'allowed-once' } }));
  w.tick();
  const tail = core.updates.slice(-2);
  assert.deepStrictEqual(tail.map((u) => `${u.event}:${u.state}`), ['Notification:notification', 'ApprovalDecided:working']);
});

check('compaction → sweeping；llm/retry → ApiError', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  fs.appendFileSync(fp,
    L({ type: 'compaction/start', seq: 1, time: Date.now(), data: { compactionId: 'k1', turn: 1 } })
    + L({ type: 'compaction/end', seq: 2, time: Date.now(), data: { compactionId: 'k1', turn: 1 } })
    + L({ type: 'llm/retry', seq: 3, time: Date.now(), data: { attempt: 1 } }));
  w.tick();
  assert.deepStrictEqual(core.updates.slice(1).map((u) => `${u.event}:${u.state}`),
    ['PreCompact:sweeping', 'Reasoning:thinking', 'ApiError:error']);
});

check('session/title 与 request/header 只更新展示字段，不进状态机', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  fs.appendFileSync(fp,
    L({ type: 'session/title', seq: 1, time: Date.now(), data: { title: '给缓存层加测试', messageSeqs: [0], source: 'provider' } })
    + L({ type: 'request/header', seq: 2, time: Date.now(), data: { header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } }, reason: 'initial' } }));
  w.tick();
  assert.deepStrictEqual(core.meta.map((m) => m.fields), [
    { sessionTitle: '给缓存层加测试' }, { model: 'deepseek-reasoner' },
  ]);
  assert.strictEqual(core.events().filter((e) => e !== 'SessionStart').length, 0);
});

console.log('[D4] 过滤：子 agent、注入上下文、打包行');
check('origin=subagent / delegationDepth>0 的日志整份跳过', () => {
  for (const extra of [{ origin: 'subagent' }, { delegationDepth: 2 }]) {
    const root = mkRoot();
    const core = fakeCore();
    // backfill 路径
    fs.writeFileSync(sessionPath(root, ID_A), header(ID_A, extra) + userMsg('内部线程'));
    const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
    w.tick();
    // live 路径
    const fp = sessionPath(root, ID_B);
    fs.writeFileSync(fp, header(ID_B, extra));
    w.tick();
    fs.appendFileSync(fp, userMsg('还是内部线程', 1));
    w.tick();
    assert.strictEqual(core.seeds.length, 0, JSON.stringify(extra));
    assert.strictEqual(core.updates.length, 0, JSON.stringify(extra));
  }
});
check('注入的上下文（source.kind=plugin）不算用户提问；打包行忽略', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  fs.appendFileSync(fp,
    userMsg('AGENTS.md 的内容……', 1, { kind: 'plugin', plugin: 'agent-instructions' })
    + L({ type: 'text-chunks', seq0: 2, time0: Date.now(), items: [] })
    + userMsg('这才是我说的话', 3));
  w.tick();
  assert.deepStrictEqual(core.events(), ['SessionStart', 'UserPromptSubmit']);
  assert.strictEqual(core.updates[1].fields.sessionTitle, '这才是我说的话');
});

console.log('[D5] 健壮性：半行、坏 JSON、目录缺失');
check('半行写入攒到下一轮，不丢不重', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  w.tick();
  const full = userMsg('半截消息也不能丢', 1);
  fs.appendFileSync(fp, full.slice(0, 30));
  w.tick();
  assert.strictEqual(core.events().filter((e) => e === 'UserPromptSubmit').length, 0);
  fs.appendFileSync(fp, full.slice(30));
  w.tick();
  assert.strictEqual(core.events().filter((e) => e === 'UserPromptSubmit').length, 1);
});
check('坏 JSON 行 / 目录不存在都不炸', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  const fp = sessionPath(root, ID_B);
  fs.writeFileSync(fp, header(ID_B));
  fs.appendFileSync(fp, 'NOT JSON AT ALL\n' + L({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }));
  w.tick();
  assert.ok(core.events().includes('TaskStarted'));
  createDshWatch({ core: fakeCore(), sessionsDir: path.join(root, 'nope'), pollMs: 999999 }).tick(); // 不抛即可
});

console.log('[D6] zstd 日志：压缩形态同样可读、可增量');
// 与 test/zstd.js 同一份 fixture（三帧：header / turn+prompt / tool+assistant+turn-end）
const ZSTD_FIXTURE = Buffer.from('KLUv/SSMjQMAMscXG4C5OYB3hMXKciOetJLoPQZiQ0ZMxkpjKksAJ4CGn00Zea9/hWVfErPuBNbWpuWHp9GG9lxzOMQeCmVEFEUQSJB3kN/0p4xOTq425zCaRs5lRNB7wmjWlurVyHeLNSMFAGxBXFWBjMtRKPvaliY2F77kKLUv/WQAAN0FACKKJSuAqenInQF27OPmsDhFqpD7YMvX2nI3blqGZqxJ87BIAHmlNuhaQtGF1Q0WyXzj+L32/Wsw0yBQxq/5mDc4oCSJCcKhKmCoFB4opIlpQaIaIioQEqbvALdj347bQczXbJwDwAyUUAAEGeNIi5EfBXKUyZxsH+1bt+ZLVZmq6rIwFmzPj9Nfuhfg+PWGraPioOzv+RH0ow0AKgEwC0Mcyt8hIuJQqyK8BhiYYAB34JkShCKhoNZL7QGCue+jKLUv/WTdANUIACYQNi6ARUkHAI1RlAYBGDjGzKk2hlK2FIL2lqRN0vYlN2L4Aw1SQvQNtdbIo2gGhWToKAAmAC0AC34h14/w2ck8KaUeSiklkRAMLHh9mn564BuUn+44uRwOY328tod+FBFCIDpJZn0cvdncMGfjvb/oeO7Vx02gfDqFc+G5T1/W8UxB0+anC9KOPRY8r1YYQru2zSN0T0/hHWICIyDCIqNCAsAFRYCjg3YCvld72Xq6w6AHjffeGW112sO2qSzjVCgScSzk+sxqa3l8M9CVDJDjp/eUEmBSD5SyMhkAfStDZIICysFkv+X2ZmkLaBxNvbS5xE0Mi2cBxYionO2xw4/lQayg/VBEIAA0B5Mt2AP2oRgIoyDYOtiWKGD4gP0=', 'base64');
const ZSTD_ID = 'dsh-sess-zstd-1';

check('.jsonl.zstd 也能 backfill（整读三帧拿到标题与用量）', () => {
  const root = mkRoot();
  fs.writeFileSync(sessionPath(root, ZSTD_ID, { zstd: true }), ZSTD_FIXTURE);
  const core = fakeCore();
  createDshWatch({ core, sessionsDir: root, pollMs: 999999 }).tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].id, ZSTD_ID);
  assert.strictEqual(core.seeds[0].cwd, '/tmp/zproj');
  assert.strictEqual(core.seeds[0].sessionTitle, '压缩日志也要读得懂');
  assert.strictEqual(core.seeds[0].contextUsage.used, 2000);
});

check('运行中新增帧：整帧才处理，半帧等下一轮', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick(); // 空场启动
  const fp = sessionPath(root, ZSTD_ID, { zstd: true });
  const { scanFrames } = require('../backend/zstd');
  const frames = scanFrames(ZSTD_FIXTURE).frames;
  fs.writeFileSync(fp, ZSTD_FIXTURE.subarray(0, frames[0].end)); // 只有 header 帧
  w.tick();
  assert.deepStrictEqual(core.events(), ['SessionStart']);

  // 第二帧只写一半 → 这一轮什么都不该冒出来
  const half = frames[1].start + Math.floor((frames[1].end - frames[1].start) / 2);
  fs.appendFileSync(fp, ZSTD_FIXTURE.subarray(frames[0].end, half));
  w.tick();
  assert.deepStrictEqual(core.events(), ['SessionStart']);

  // 补齐后续全部字节 → 两帧的事件一次性按序到位
  fs.appendFileSync(fp, ZSTD_FIXTURE.subarray(half));
  w.tick();
  assert.deepStrictEqual(core.events(), [
    'SessionStart', 'TaskStarted', 'UserPromptSubmit', 'PreToolUse', 'Stop',
  ]);
  assert.strictEqual(core.updates[core.updates.length - 1].fields.assistantLastOutput, '读到了 ✅');
});

check('启动时撞上 zstd 半帧：补齐后从完整帧边界继续，不永久丢事件', () => {
  const root = mkRoot();
  const core = fakeCore();
  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  const fp = sessionPath(root, ZSTD_ID, { zstd: true });
  const { scanFrames } = require('../backend/zstd');
  const frames = scanFrames(ZSTD_FIXTURE).frames;
  const half = frames[1].start + Math.floor((frames[1].end - frames[1].start) / 2);

  // 首轮 backfill 时：header 完整，第二帧只写了一半。
  fs.writeFileSync(fp, ZSTD_FIXTURE.subarray(0, half));
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.updates.length, 0);

  // dsh 补完同一个帧并继续写。游标必须还在第一帧末尾，而不是半帧 EOF。
  fs.appendFileSync(fp, ZSTD_FIXTURE.subarray(half));
  w.tick();
  assert.deepStrictEqual(core.events(), [
    'TaskStarted', 'UserPromptSubmit', 'PreToolUse', 'Stop',
  ]);
  assert.strictEqual(core.updates[core.updates.length - 1].fields.assistantLastOutput, '读到了 ✅');
});

check('沉睡旧会话的初始 cursor 也停在完整帧边界', () => {
  const root = mkRoot();
  const core = fakeCore();
  const fp = sessionPath(root, ZSTD_ID, { zstd: true });
  const { scanFrames } = require('../backend/zstd');
  const frames = scanFrames(ZSTD_FIXTURE).frames;
  const half = frames[1].start + Math.floor((frames[1].end - frames[1].start) / 2);
  fs.writeFileSync(fp, ZSTD_FIXTURE.subarray(0, half));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(fp, old, old);

  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 0, '旧会话不应进入活跃列表');
  assert.strictEqual(w._cursors.get(fp).offset, frames[0].end, 'cursor 不能落在半帧 EOF');
});

check('>16MiB 日志撞上 >8MiB 半写帧：补齐后不 broken，继续消费后续事件', () => {
  const root = mkRoot();
  const core = fakeCore();
  const fp = sessionPath(root, ZSTD_ID, { zstd: true });
  const { scanFrames } = require('../backend/zstd');
  const first = scanFrames(ZSTD_FIXTURE).frames[0];
  const headerFrame = ZSTD_FIXTURE.subarray(first.start, first.end);
  const hugePayload = Buffer.alloc(17 * 1024 * 1024, 0x78); // 一整行无意义增量
  hugePayload[hugePayload.length - 1] = 0x0A; // 换行，不能污染下一帧的 JSON 行
  const hugeFrame = rawZstdFrame(hugePayload);
  const tailFrame = rawZstdFrame(Buffer.from(
    L({ type: 'turn/start', seq: 90, time: Date.now(), data: { turn: 9 } })
    + userMsg('大帧之后仍然要收到我', 91),
  ));
  const cut = hugeFrame.length - 100;
  fs.writeFileSync(fp, Buffer.concat([headerFrame, hugeFrame.subarray(0, cut)]));

  const w = createDshWatch({ core, sessionsDir: root, pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(w._trackers.get(fp).offset, headerFrame.length,
    '超大半帧的启动 cursor 必须停在 header 完整帧末尾');

  fs.appendFileSync(fp, Buffer.concat([hugeFrame.subarray(cut), tailFrame]));
  for (let i = 0; i < 5; i++) w.tick(); // 512KiB → 2MiB → 8MiB → 整帧 → tail
  assert.deepStrictEqual(core.events(), ['TaskStarted', 'UserPromptSubmit']);
  assert.strictEqual(w._trackers.get(fp).broken, false);
  assert.strictEqual(w._trackers.get(fp).offset, fs.statSync(fp).size);
});

console.log('[D7] 会话交接读取：readLogEntries 两种形态都能拿到对话');
check('明文与 zstd 日志都能解析出事件行', () => {
  const root = mkRoot();
  const plain = sessionPath(root, ID_A);
  fs.writeFileSync(plain, header(ID_A) + userMsg('交接给 Claude'));
  const zst = sessionPath(root, ZSTD_ID, { zstd: true });
  fs.writeFileSync(zst, ZSTD_FIXTURE);
  assert.deepStrictEqual(readLogEntries(plain).map((e) => e.type), ['session', 'user/message']);
  assert.ok(readLogEntries(zst).some((e) => e.type === 'assistant/message'));
  assert.deepStrictEqual(readLogEntries(path.join(root, 'nope', 'session.jsonl')), []);
});

process.exit(failures ? 1 : 0);
