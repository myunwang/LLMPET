'use strict';

// Headless end-to-end smoke test of the backend spine (no Electron):
//   hook POST /state  → core → adapter (events + stats)
//   CC   POST /permission (held open) → decidePermission → byte-exact response
// Run: node test/smoke.js

const http = require('http');
const assert = require('assert');
const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');
const adapter = require('../backend/adapter');

const events = [];
let dirtyCount = 0;

const core = createCore({
  onActivity: (act) => { for (const ev of adapter.activityToEvents(act)) events.push(ev); },
  onDirty: () => { dirtyCount++; },
});
const permissions = createPermissions({
  onAdded: (entry) => { events.push({ kind: 'waiting', permId: entry.id, sessionId: entry.sessionId }); },
  onChange: () => {},
});
const server = createServer({ core, permissions, shouldDropForDnd: () => false });

function post(pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: server.getPort(), path: pathName, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function get(pathName) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.getPort(), path: pathName }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = 'test-session-aaaa';
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

async function main() {
  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  assert(server.getPort(), 'server failed to bind a port');
  console.log('server on', server.getPort());

  console.log('\n[1] health');
  const health = await get('/state');
  check('GET /state returns ok', () => {
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).app, 'octopus');
    assert.strictEqual(health.headers['x-octopus-server'], 'octopus');
  });

  console.log('\n[2] session lifecycle via /state');
  let r = await post('/state', { state: 'idle', event: 'SessionStart', session_id: SID, cwd: '/Users/me/proj-x' });
  check('SessionStart accepted', () => { assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['x-octopus-server'], 'octopus'); });

  r = await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: SID, cwd: '/Users/me/proj-x' });
  check('greet emitted on first prompt（欢迎延迟到首条输入）', () => assert(events.some((e) => e.kind === 'greet')));
  check('session is thinking', () => assert.strictEqual(core.getSession(SID).state, 'thinking'));

  r = await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: SID, cwd: '/Users/me/proj-x' });
  check('user-turn event emitted（第二条起）', () => assert(events.some((e) => e.kind === 'user-turn')));

  r = await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: SID, cwd: '/Users/me/proj-x' });
  check('operation event for Bash', () => assert(events.some((e) => e.kind === 'operation' && e.tool === 'Bash')));

  r = await post('/state', {
    state: 'attention', event: 'Stop', session_id: SID, cwd: '/Users/me/proj-x',
    assistant_last_output: '我已经修好了那个 bug，并跑通了测试。',
  });
  check('turn-done event emitted', () => assert(events.some((e) => e.kind === 'turn-done')));
  check('say event carries Claude message', () => assert(events.some((e) => e.kind === 'say' && /修好/.test(e.text))));
  check('session requiresCompletionAck after Stop', () => assert.strictEqual(core.getSession(SID).requiresCompletionAck, true));

  console.log('\n[3] unknown state rejected');
  r = await post('/state', { state: 'bogus', event: 'X', session_id: SID });
  check('unknown state → 400', () => assert.strictEqual(r.status, 400));

  console.log('\n[4] permission hold-open → decide allow (byte-exact)');
  const permSid = 'perm-session-bbbb';
  // create the session first so the choice gets a project name
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: permSid, cwd: '/Users/me/proj-y' });
  const permRespP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, session_id: permSid });
  await sleep(80);
  check('permission is pending', () => assert.strictEqual(permissions.getPending().length, 1));
  const pend = permissions.getPending()[0];
  check('waiting event emitted with permId', () => assert(events.some((e) => e.kind === 'waiting' && e.permId === pend.id)));

  // build the stats the frontend would receive and verify the waiting overlay + choice
  const stats = adapter.buildPetStats(core.buildSnapshot(), permissions.getPending(), null);
  check('stats waitingCount = 1', () => assert.strictEqual(stats.waitingCount, 1));
  check('waiting session has perm choice', () => {
    const ws = stats.sessions.find((s) => s.state === 'waiting');
    assert(ws && ws.choice && ws.choice.kind === 'perm' && ws.choice.permId === pend.id);
    assert(/rm -rf build/.test(ws.choice.question));
  });

  permissions.decide(pend.id, 'allow');
  const permResp = await permRespP;
  check('permission response is byte-exact allow', () => {
    assert.strictEqual(permResp.status, 200);
    assert.strictEqual(permResp.headers['x-octopus-server'], 'octopus');
    assert.deepStrictEqual(JSON.parse(permResp.body), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
  check('no pending after decide', () => assert.strictEqual(permissions.getPending().length, 0));

  console.log('\n[5] permission deny carries message');
  const denySid = 'deny-session-cccc';
  const denyP = post('/permission', { tool_name: 'Write', tool_input: { file_path: '/etc/hosts' }, session_id: denySid });
  await sleep(60);
  const dpend = permissions.getPending()[0];
  permissions.decide(dpend.id, 'deny');
  const denyResp = await denyP;
  check('deny response shape', () => {
    const j = JSON.parse(denyResp.body);
    assert.strictEqual(j.hookSpecificOutput.decision.behavior, 'deny');
  });

  console.log('\n[6] passthrough tool auto-allowed (not held)');
  const ptResp = await post('/permission', { tool_name: 'TaskCreate', tool_input: {}, session_id: 'pt' });
  check('TaskCreate auto-allow', () => assert.strictEqual(JSON.parse(ptResp.body).hookSpecificOutput.decision.behavior, 'allow'));

  console.log('\n[7] stale permission swept when user answers in terminal');
  const sweepSid = 'sweep-session-dddd';
  const sweepP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: sweepSid });
  await sleep(60);
  check('one pending before sweep', () => assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === sweepSid).length, 1));
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: sweepSid });
  const sweepResp = await sweepP;
  check('swept perm got deny', () => assert.strictEqual(JSON.parse(sweepResp.body).hookSpecificOutput.decision.behavior, 'deny'));

  console.log('\n[8] juggling/sweeping 透传（皮肤素材可达）+ 计数');
  const jSid = 'juggle-session-eeee';
  await post('/state', { state: 'juggling', event: 'SubagentStart', session_id: jSid, cwd: '/Users/me/proj-j' });
  const sSid = 'sweep-session-ffff';
  await post('/state', { state: 'sweeping', event: 'PreCompact', session_id: sSid, cwd: '/Users/me/proj-s' });
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const js = st.sessions.find((x) => x.sessionId === jSid);
    const ss = st.sessions.find((x) => x.sessionId === sSid);
    check('juggling 不再折叠成 working', () => assert.strictEqual(js.state, 'juggling'));
    check('sweeping 不再折叠成 working', () => assert.strictEqual(ss.state, 'sweeping'));
    check('jugglingCount/sweepingCount 计数', () => {
      assert(st.jugglingCount >= 1 && st.sweepingCount >= 1);
    });
  }

  console.log('\n[9] Stop 完成门：被抑制的 Stop 不显示 done 徽标');
  const supSid = 'suppressed-stop-gggg';
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: supSid, cwd: '/Users/me/proj-sup' });
  await post('/state', { state: 'attention', event: 'Stop', session_id: supSid, cwd: '/Users/me/proj-sup', background_tasks_count: 2 });
  {
    const s9 = core.getSession(supSid);
    check('抑制的 Stop 不置 requiresCompletionAck', () => assert.strictEqual(!!s9.requiresCompletionAck, false));
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const e9 = st.sessions.find((x) => x.sessionId === supSid);
    check('徽标为 idle 而非 done（deriveBadge 不再被 Stop 事件击穿）', () => assert.strictEqual(e9.badge, 'idle'));
    check('无 turn-done 庆祝事件', () => assert(!events.some((e) => e.kind === 'turn-done' && e.project === 'proj-sup')));
  }

  console.log('\n[10] oneshot 衰减：error/sweeping 不再永久卡死');
  const errSid = 'stuck-error-hhhh';
  await post('/state', { state: 'error', event: 'StopFailure', session_id: errSid, cwd: '/Users/me/proj-err' });
  check('StopFailure 后会话进入 error', () => assert.strictEqual(core.getSession(errSid).state, 'error'));
  core.sessions.get(errSid).updatedAt = Date.now() - 46 * 1000; // 越过 45s TTL
  core.cleanStaleSessions();
  check('error 45s 后衰减为 idle（不再钉死全局瘫倒）', () => assert.strictEqual(core.getSession(errSid).state, 'idle'));

  console.log('\n[11] /clear 幽灵会话：sweeping 衰减 + ended 回收');
  const clrSid = 'cleared-session-iiii';
  await post('/state', { state: 'sweeping', event: 'SessionEnd', session_id: clrSid, cwd: '/Users/me/proj-clr' });
  check('SessionEnd(clear) 标记 ended', () => assert.strictEqual(core.getSession(clrSid).ended, true));
  core.sessions.get(clrSid).updatedAt = Date.now() - 21 * 1000; // 越过 sweeping 20s TTL
  core.cleanStaleSessions();
  check('清理表情 20s 后衰减为 idle', () => assert.strictEqual(core.getSession(clrSid).state, 'idle'));
  core.sessions.get(clrSid).updatedAt = Date.now() - 31 * 60 * 1000; // 越过 30min
  core.cleanStaleSessions();
  check('ended 会话 30min 后被回收（终端 pid 存活也不豁免）', () => assert.strictEqual(core.getSession(clrSid), null));

  console.log('\n[12] hook 契约：无 session_id 丢弃 + op 标签不陈旧');
  const hook = require('../hook/octopus-hook');
  check('空 payload（stdin 超时）不再伪造 default 会话', () => assert.strictEqual(hook.buildBody('UserPromptSubmit', {}), null));
  check('正常 payload 正确出状态', () => {
    const b = hook.buildBody('UserPromptSubmit', { session_id: 'x1', prompt: 'hi' });
    assert(b && b.state === 'thinking' && b.session_id === 'x1');
  });
  check('表情包原生续聊不伪装成 headless，也不覆盖原窗口路由', () => {
    const prev = process.env.LLMPET_MEME_RESUME;
    process.env.LLMPET_MEME_RESUME = '1';
    try {
      const b = hook.buildBody('UserPromptSubmit', { session_id: 'x1-resume', prompt: 'hi' });
      assert(b && b.headless === false && b.external_resume === true);
      assert.strictEqual(b.source_pid, undefined);
    } finally {
      if (prev === undefined) delete process.env.LLMPET_MEME_RESUME;
      else process.env.LLMPET_MEME_RESUME = prev;
    }
  });
  const extSid = 'external-resume-session';
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: extSid, cwd: '/Users/me/proj-ext', external_resume: true });
  await post('/state', { state: 'sweeping', event: 'SessionEnd', session_id: extSid, cwd: '/Users/me/proj-ext', external_resume: true });
  check('原生续聊进程退出不把原 session 标记为 ended', () => assert.strictEqual(core.getSession(extSid).ended, false));
  const opSid = 'op-label-jjjj';
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: opSid, cwd: '/Users/me/proj-op' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: opSid, cwd: '/Users/me/proj-op' });
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eOp = st.sessions.find((x) => x.sessionId === opSid);
    check('thinking 阶段不显示上一轮的「运行命令」', () => assert.strictEqual(eOp.op, null));
  }

  console.log('\n[13] greet 延迟到第一条 prompt：入口会话静默、真对话欢迎');
  // 用户定义情形 b：看板上没有的会话被 resume 进入 = 新对话，说话后欢迎
  const rsSid = 'resume-session-kkkk';
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: rsSid, cwd: '/Users/me/proj-resume', session_source: 'resume' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: rsSid, cwd: '/Users/me/proj-resume' });
  check('看板外会话 resume 进入 + 说话 → 欢迎', () => assert(events.some((e) => e.kind === 'greet' && e.project === 'proj-resume')));
  const nsSid = 'startup-session-llll';
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: nsSid, cwd: '/Users/me/proj-fresh', session_source: 'startup' });
  check('SessionStart 本身不欢迎（等第一条 prompt）', () => assert(!events.some((e) => e.kind === 'greet' && e.project === 'proj-fresh')));
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: nsSid, cwd: '/Users/me/proj-fresh' });
  check('新对话第一条 prompt → 欢迎', () => assert(events.some((e) => e.kind === 'greet' && e.project === 'proj-fresh')));
  check('欢迎时不叠 user-turn（短暂态不互抢）', () =>
    assert(!events.some((e) => e.kind === 'user-turn' && e.project === 'proj-fresh')));
  check('hook 转发 SessionStart source', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x2', source: 'resume' });
    assert(b && b.session_source === 'resume');
  });

  console.log('\n[14] 工具结束后长间隙 = 摸鱼（loafing），不硬说思考');
  const tgSid = 'loafgap-session-mmmm';
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000; // 工具结束 6s 无事件
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('PostToolUse 后 >5s 无事件 → loafing 摸鱼', () => assert.strictEqual(eTg.state, 'loafing'));
    check('loafingCount 计数', () => assert(st.loafingCount >= 1));
  }
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000; // 工具还在跑 6s
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('PreToolUse 长间隙（工具仍在跑）→ 仍是 working', () => assert.strictEqual(eTg.state, 'working'));
  }
  // 重连/流式输出场景：事件间隙里 transcript 还在长 → 干活，不是摸鱼
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000;
  core.sessions.get(tgSid).transcriptActiveAt = Date.now() - 3000; // 3s 前还在写
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('间隙但 transcript 在长（模型产出中）→ working', () => assert.strictEqual(eTg.state, 'working'));
  }
  core.sessions.get(tgSid).transcriptActiveAt = Date.now() - 200 * 1000; // 文件 3 分多钟没动
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('间隙且 transcript 长时间不动 → loafing 摸鱼', () => assert.strictEqual(eTg.state, 'loafing'));
  }
  const codexGapSid = 'codex-gap-session-rrrr';
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: codexGapSid, cwd: '/Users/me/proj-codex' });
  core.sessions.get(codexGapSid).agentId = 'codex'; // Codex watcher 直连 core；HTTP hook 固定是 Claude
  core.sessions.get(codexGapSid).updatedAt = Date.now() - 6000;
  core.sessions.get(codexGapSid).transcriptActiveAt = Date.now() - 6000;
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eCodex = st.sessions.find((x) => x.sessionId === codexGapSid);
    check('Codex PostToolUse 长间隙仍是 working（等明确 task_complete）', () => assert.strictEqual(eCodex.state, 'working'));
  }
  // 慢长任务（17m 一轮、token 缓涨）：事件 6 分钟没来但文件半分钟前还在写 → 不被卡死兜底打成 idle
  core.sessions.get(tgSid).updatedAt = Date.now() - 6 * 60 * 1000;
  core.sessions.get(tgSid).transcriptActiveAt = Date.now() - 30 * 1000;
  core.cleanStaleSessions();
  check('慢长任务不被 WORKING_STALE 打成 idle', () => assert.strictEqual(core.getSession(tgSid).state, 'working'));

  console.log('\n[15] SessionStart 无 source 时用 transcript 历史兜底');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-test-'));
  const histFile = path.join(tmpDir, 'hist.jsonl');
  fs.writeFileSync(histFile, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '之前聊过' }] } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }) + '\n');
  check('有历史对话 + 无 source → 标记 resume（诊断用）', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x3', transcript_path: histFile });
    assert.strictEqual(b.session_source, 'resume');
  });
  check('无 transcript + 无 source → 标记 startup', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x4', transcript_path: path.join(tmpDir, 'nope.jsonl') });
    assert.strictEqual(b.session_source, 'startup');
  });
  check('显式 source 优先', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x5', source: 'compact', transcript_path: histFile });
    assert.strictEqual(b.session_source, 'compact');
  });

  console.log('\n[17] 同 cwd 已有活跃会话 → 说话也不欢迎（进入执行中任务兜底）');
  const busyCwd = '/Users/me/proj-busy-x';
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: 'busy-owner-oooo', cwd: busyCwd });
  // ccd 点进该任务：fork 新 id + 无 source + 空 transcript（最恶劣组合）
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'fork-entry-pppp', cwd: busyCwd, session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'fork-entry-pppp', cwd: busyCwd });
  check('同 cwd 忙碌中，进入后说话也不欢迎', () =>
    assert(!events.some((e) => e.kind === 'greet' && e.project === 'proj-busy-x')));
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'fresh-proj-qqqq', cwd: '/Users/me/proj-brand-new', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'fresh-proj-qqqq', cwd: '/Users/me/proj-brand-new' });
  check('全新项目的新对话仍正常欢迎', () =>
    assert(events.some((e) => e.kind === 'greet' && e.project === 'proj-brand-new')));

  console.log('\n[19] 工具拉起的一次性目录会话 + 同项目欢迎频控');
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'toolspawn-ssss', cwd: '/Users/me/.someapp/sessions/ab12cd34', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'toolspawn-ssss', cwd: '/Users/me/.someapp/sessions/ab12cd34' });
  check('隐藏目录 cwd（工具拉起）说话也不欢迎', () =>
    assert(!events.some((e) => e.kind === 'greet' && e.project === 'ab12cd34')));
  // 同项目名 30 分钟频控：第一次欢迎后，另一个同名项目的新对话不再欢迎
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'debounce-a-tttt', cwd: '/Users/me/proj-debounce', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'debounce-a-tttt', cwd: '/Users/me/proj-debounce' });
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'debounce-c-vvvv', cwd: '/tmp/other/proj-debounce', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'debounce-c-vvvv', cwd: '/tmp/other/proj-debounce' });
  check('同项目 30 分钟内只欢迎一次', () =>
    assert.strictEqual(events.filter((e) => e.kind === 'greet' && e.project === 'proj-debounce').length, 1));

  console.log('\n[16] ESC 中断检测（transcript 发现，10s 巡检放下忙碌态）');
  const intSid = 'interrupt-session-nnnn';
  // 像真实 hook 那样直接带 transcript_path（server 存 s.transcriptPath，core 直接读），
  // 不再靠 cwd 反推编码目录 —— 也不再往用户真实的 ~/.claude/projects 写测试文件。
  const intDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-int-'));
  const intFile = path.join(intDir, `${intSid}.jsonl`);
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: intSid, cwd: '/Users/me/octo-int', transcript_path: intFile });
  await sleep(30);
  fs.writeFileSync(intFile,
    JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
  core.cleanStaleSessions();
  check('中断后忙碌态被放下（不再等 5 分钟）', () => assert.strictEqual(core.getSession(intSid).state, 'idle'));
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eInt = st.sessions.find((x) => x.sessionId === intSid);
    check('徽标显示中断', () => assert.strictEqual(eInt.badge, 'interrupted'));
  }
  // 新事件到达（用户继续）→ lastEvent 晚于中断标记 → 不再触发
  await sleep(30);
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: intSid, cwd: '/Users/me/octo-int', transcript_path: intFile });
  core.cleanStaleSessions();
  check('中断后继续对话不误判', () => assert.strictEqual(core.getSession(intSid).state, 'working'));
  fs.rmSync(intDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n[18] 网络重试检测：API 错误间隙不再误判成思考中');
  const netSid = 'netretry-session-rrrr';
  const netDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-net-'));
  const netFile = path.join(netDir, `${netSid}.jsonl`);
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: netSid, cwd: '/Users/me/octo-net', transcript_path: netFile });
  await sleep(30);
  fs.writeFileSync(netFile,
    JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', sessionId: netSid, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }] } }) + '\n');
  core.cleanStaleSessions();
  check('重试失败间隙 → error 而非 thinking', () => assert.strictEqual(core.getSession(netSid).state, 'error'));
  check('错误类型被记录', () => assert.strictEqual(core.getSession(netSid).errorType, 'server_error'));
  // 重试成功：错误条目之后出现正常消息 → 恢复干活
  fs.appendFileSync(netFile,
    JSON.stringify({ type: 'assistant', sessionId: netSid, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '恢复了，继续。' }] } }) + '\n');
  core.cleanStaleSessions();
  check('重试成功后自动恢复 working', () => assert.strictEqual(core.getSession(netSid).state, 'working'));
  fs.rmSync(netDir, { recursive: true, force: true });

  server.stop();
  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'} — events captured: ${events.length}, dirty fires: ${dirtyCount}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
