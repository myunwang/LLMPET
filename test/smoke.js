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
  check('greet event emitted', () => assert(events.some((e) => e.kind === 'greet')));

  r = await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: SID, cwd: '/Users/me/proj-x' });
  check('user-turn event emitted', () => assert(events.some((e) => e.kind === 'user-turn')));
  check('session is thinking', () => assert.strictEqual(core.getSession(SID).state, 'thinking'));

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
  const opSid = 'op-label-jjjj';
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: opSid, cwd: '/Users/me/proj-op' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: opSid, cwd: '/Users/me/proj-op' });
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eOp = st.sessions.find((x) => x.sessionId === opSid);
    check('thinking 阶段不显示上一轮的「运行命令」', () => assert.strictEqual(eOp.op, null));
  }

  console.log('\n[13] greet 只对真·新对话（source=startup）');
  const rsSid = 'resume-session-kkkk';
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: rsSid, cwd: '/Users/me/proj-resume', session_source: 'resume' });
  check('resume 进入已有任务不欢迎', () => assert(!events.some((e) => e.kind === 'greet' && e.project === 'proj-resume')));
  const nsSid = 'startup-session-llll';
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: nsSid, cwd: '/Users/me/proj-fresh', session_source: 'startup' });
  check('startup 新对话正常欢迎', () => assert(events.some((e) => e.kind === 'greet' && e.project === 'proj-fresh')));
  check('hook 转发 SessionStart source', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x2', source: 'resume' });
    assert(b && b.session_source === 'resume');
  });

  console.log('\n[14] Thinking some more：工具结束后长间隙 = 推理中');
  const tgSid = 'thinkgap-session-mmmm';
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000; // 工具结束 6s 无事件
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('PostToolUse 后 >5s 无事件 → thinking', () => assert.strictEqual(eTg.state, 'thinking'));
  }
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000; // 工具还在跑 6s
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('PreToolUse 长间隙（工具仍在跑）→ 仍是 working', () => assert.strictEqual(eTg.state, 'working'));
  }

  server.stop();
  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'} — events captured: ${events.length}, dirty fires: ${dirtyCount}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
