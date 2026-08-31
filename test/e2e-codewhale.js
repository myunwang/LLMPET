'use strict';

// E2E 冒烟：真实 HTTP 请求穿过完整链路。
// 不 mock HTTP —— 起真的 server、发真的请求、验证真的响应字节。
// 覆盖：/state 的 codewhale 事件路由与 usage 回调、/codewhale-permission 的
// 挂起/决策/超时/信任边界、pretool-hook 子进程的 stdin→stdout 协议。

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 隔离 HOME：runtime.json / 计量状态都不碰真实用户目录。
// ⚠️ 必须在任何 backend 模块 require 之前 —— transport.js 在模块加载时
// 就把 RUNTIME_PATH 固化为 os.homedir() 的值，晚干 HOME 会让 runtime
// 写到真实用户目录（这本身就是一次真实踩坑的回归记录）。
// ⚠️ Windows 上 os.homedir() 读 USERPROFILE 而非 HOME —— 只覆盖 HOME 的
// 隔离在 Windows CI 上形同虚设：hook 子进程会读到真实用户目录的
// runtime.json，「不可达→ask」用例确定性失败（上游 CI windows-latest
// 全红而 macOS/Linux 全绿的真实事故链）。
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // Windows: os.homedir() 读这个
process.env.OCTOPUS_ALLOW_MULTI = '1';

const { createServer } = require('../backend/server');
const { createCore } = require('../backend/core');

// Node 19+ 的 globalAgent 默认 keepAlive：空闲 socket 会被 server 的
// keepAliveTimeout（5s）关掉，慢 CI 机器上请求间隔超 5s 时复用死 socket
// → ECONNRESET。每请求一条新连接免疫该竞态（smoke.js 同样处理）。
const NO_KEEPALIVE = new http.Agent({ keepAlive: false });

const root = path.join(__dirname, '..');

// ── 起 server + core ─────────────────────────────────────────────────────────
const events = [];
let core;
function makeCore() {
  const c = createCore({
    onActivity: (act) => events.push(act),
    onDirty: () => {},
  });
  c.startStaleCleanup();
  return c;
}
core = makeCore();

const usageTurns = [];
const permissionsDecided = [];
let onAddedEntry = null;

const server = createServer({
  core,
  permissions: { sweepForSessionEvent: () => {}, getPending: () => [] },
  onCodeWhaleUsage: (turn) => usageTurns.push(turn),
  onPermissionChange: () => {},
  onPermissionAdded: (entry) => { onAddedEntry = entry; },
});
server.start();

// 等 server 就绪（端口扫描 + listening 是异步的）
function waitForPort(ms = 3000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (server.getPort()) return resolve(server.getPort());
      if (Date.now() > deadline) return reject(new Error('server never listened'));
      setTimeout(poll, 50);
    })();
  });
}

function request(port, method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: reqPath, method,
      agent: NO_KEEPALIVE,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function runHook(script, args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    // 兜底：钩子最迟 10s 必须退出（正常路径 < 1s）
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000).unref?.();
  });
}

async function main() {
  const port = await waitForPort();
  const token = server.getToken();
  const auth = { 'x-octopus-token': token };
  console.log(`server on :${port}, token ${token ? 'ok' : 'MISSING'}`);

  // ── 1. GET /state 健康检查 + 身份头 ────────────────────────────────────────
  const health = await request(port, 'GET', '/state');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.headers['x-octopus-server'], 'octopus');
  console.log('✓ GET /state 健康检查 + 身份头');

  // ── 2. 无 token 的 /state POST → 403 ──────────────────────────────────────
  const noToken = await request(port, 'POST', '/state', { state: 'idle', event: 'SessionStart', session_id: 's1' });
  assert.strictEqual(noToken.status, 403, `expected 403, got ${noToken.status}`);
  console.log('✓ /state 无 token → 403');

  // ── 3. codewhale 事件路由：agentId 正确入库 ────────────────────────────────
  const ev1 = await request(port, 'POST', '/state', {
    state: 'thinking', event: 'UserPromptSubmit', session_id: 'cw-s1',
    agent_id: 'codewhale', cwd: '/tmp/proj', model: 'deepseek-chat',
  }, auth);
  assert.strictEqual(ev1.status, 200, ev1.body);
  const snap1 = core.buildSnapshot();
  const sess = snap1.sessions.find((s) => s.id === 'cw-s1');
  assert(sess, 'codewhale session missing from snapshot');
  assert.strictEqual(sess.agentId, 'codewhale');
  assert.strictEqual(sess.state, 'thinking');
  // claude 事件不带 agent_id → 仍是 claude-code
  await request(port, 'POST', '/state', { state: 'working', event: 'PreToolUse', session_id: 'cl-s1' }, auth);
  const sessClaude = core.buildSnapshot().sessions.find((s) => s.id === 'cl-s1');
  assert.strictEqual(sessClaude.agentId, 'claude-code');
  console.log('✓ /state agent_id 路由：codewhale/claude-code 各归各位');

  // ── 4. turn_end usage → onCodeWhaleUsage 回调 ──────────────────────────────
  const turnEnd = await request(port, 'POST', '/state', {
    state: 'attention', event: 'Stop', session_id: 'cw-s1', agent_id: 'codewhale',
    model: 'deepseek-chat',
    usage: { input_tokens: 100, output_tokens: 50, prompt_cache_hit_tokens: 20 },
    usage_totals: { input_tokens: 100 },
    turn_id: 'turn-e2e-1', turn_status: 'completed', provider: 'deepseek',
  }, auth);
  assert.strictEqual(turnEnd.status, 200, turnEnd.body);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(usageTurns.length, 1, 'usage callback not fired');
  assert.strictEqual(usageTurns[0].turnId, 'turn-e2e-1');
  assert.strictEqual(usageTurns[0].provider, 'deepseek');
  assert.strictEqual(usageTurns[0].usage.input_tokens, 100);
  // 非 codewhale 的 Stop 不触发回调
  await request(port, 'POST', '/state', { state: 'attention', event: 'Stop', session_id: 'cl-s1' }, auth);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(usageTurns.length, 1);
  console.log('✓ turn_end usage 只走 codewhale 回调，字段完整');

  // ── 5. /codewhale-permission：信任边界 ────────────────────────────────────
  // CodeWhale 的 shell 工具真名是 exec_shell（上游权限规则文档验证）。
  const noTokPerm = await request(port, 'POST', '/codewhale-permission', { session_id: 'cw-s1', tool_name: 'exec_shell', tool_input: { command: 'ls' } });
  assert.strictEqual(noTokPerm.status, 403);
  const badBody = await request(port, 'POST', '/codewhale-permission', { tool_name: 'exec_shell' }, auth);
  assert.strictEqual(badBody.status, 400);
  console.log('✓ /codewhale-permission：无 token 403 / 缺 session_id 400');

  // ── 6. 安全只读命令 → 立即 allow（不挂起）─────────────────────────────────
  const safeReq = await request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'exec_shell', tool_input: { command: 'ls -la /tmp' },
  }, auth);
  assert.strictEqual(safeReq.status, 200);
  assert.strictEqual(JSON.parse(safeReq.body).decision, 'allow');
  // 工具名精确匹配：Claude 时代的 'Bash' 拼写绝不能在 cw 路由上自动放行
  const wrongName = (async () => request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' },
  }, auth))();
  await new Promise((r) => setTimeout(r, 100));
  const wrongPending = server.getCodeWhalePermissions().getPending();
  assert.strictEqual(wrongPending.length, 1, 'claude-era tool name must NOT auto-allow on the cw route');
  server.getCodeWhalePermissions().decide(wrongPending[0].id, 'deny');
  await wrongName;
  console.log('✓ 只读 exec_shell 直接 allow；"Bash" 拼写不误放行（精确匹配）');

  // ── 7. 危险命令 → 挂起 → 用户拒绝 → deny 响应 ────────────────────────────
  const decided = request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'exec_shell', tool_input: { command: 'rm -rf /tmp/important' },
  }, auth);
  await new Promise((r) => setTimeout(r, 100));
  const cwPerms = server.getCodeWhalePermissions();
  const pendingNow = cwPerms.getPending();
  assert.strictEqual(pendingNow.length, 1);
  assert(pendingNow[0].id.startsWith('cw-'));
  assert.strictEqual(pendingNow[0].toolName, 'exec_shell');
  assert.strictEqual(pendingNow[0].agentId, 'codewhale');
  assert(typeof pendingNow[0].expiresAt === 'number' && pendingNow[0].expiresAt > Date.now(), 'expiresAt missing on pending entry');
  assert(onAddedEntry && onAddedEntry.id === pendingNow[0].id, 'onPermissionAdded not fired');
  // 注意：此时响应还没写出 —— 决策后才有
  cwPerms.decide(pendingNow[0].id, 'deny');
  const denied = await decided;
  assert.strictEqual(denied.status, 200);
  assert.strictEqual(denied.headers['x-octopus-server'], 'octopus');
  assert.strictEqual(JSON.parse(denied.body).decision, 'deny');
  assert.ok(JSON.parse(denied.body).reason);
  permissionsDecided.push('deny');
  assert.strictEqual(cwPerms.getPending().length, 0);
  console.log('✓ 挂起→用户拒绝→deny 响应（带身份头）');

  // ── 8. 用户允许 → allow 响应 ──────────────────────────────────────────────
  const allowed = (async () => request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'write_file', tool_input: { path: '/tmp/x', content: 'y' },
  }, auth))();
  await new Promise((r) => setTimeout(r, 100));
  const p2 = server.getCodeWhalePermissions().getPending()[0];
  server.getCodeWhalePermissions().decide(p2.id, 'allow');
  const allowRes = await allowed;
  assert.strictEqual(JSON.parse(allowRes.body).decision, 'allow');
  console.log('✓ 挂起→用户允许→allow 响应');

  // ── 9. 会话结束 → 挂起请求被清扫为 ask ────────────────────────────────────
  const parked = (async () => request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-sweep', tool_name: 'exec_shell', tool_input: { command: 'curl example.com' },
  }, auth))();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(server.getCodeWhalePermissions().getPending().length, 1);
  await request(port, 'POST', '/state', {
    state: 'sleeping', event: 'SessionEnd', session_id: 'cw-sweep', agent_id: 'codewhale',
  }, auth);
  const swept = await parked;
  assert.strictEqual(JSON.parse(swept.body).decision, 'ask', `sweep should answer ask, got ${swept.body}`);
  assert.strictEqual(server.getCodeWhalePermissions().getPending().length, 0);
  console.log('✓ SessionEnd 清扫挂起权限 → ask');

  // ── 10. pretool-hook 子进程：真实 stdin→stdout 协议 ────────────────────────
  const pretool = path.join(root, 'hook', 'pretool-hook.js');
  const safePayload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status --short' } });
  const r1 = await runHook(pretool, [], {}, safePayload);
  assert.strictEqual(r1.code, 0);
  const out1 = JSON.parse(r1.out);
  assert.strictEqual(out1.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out1.hookSpecificOutput.permissionDecision, 'allow');
  assert(typeof out1.hookSpecificOutput.permissionDecisionReason === 'string');
  console.log('✓ pretool-hook：只读命令 → hookSpecificOutput.permissionDecision=allow');

  const dangerPayload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls; rm -rf /' } });
  const r2 = await runHook(pretool, [], {}, dangerPayload);
  assert.strictEqual(r2.code, 0);
  assert.strictEqual(r2.out, '', 'dangerous command must produce NO output (no opinion)');
  console.log('✓ pretool-hook：危险命令 → 空输出（交回正常权限流程）');

  const otherTool = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x' } });
  const r3 = await runHook(pretool, [], {}, otherTool);
  assert.strictEqual(r3.code, 0);
  assert.strictEqual(r3.out, '');
  console.log('✓ pretool-hook：非 Bash 工具 → 不表态');

  const badJson = 'this is not json{{{';
  const r4 = await runHook(pretool, [], {}, badJson);
  assert.strictEqual(r4.code, 0);
  assert.strictEqual(r4.out, '');
  console.log('✓ pretool-hook：畸形 stdin → 安全不表态');

  // ── 11. codewhale-hook 子进程：env 变量 → /state + 权限桥 ─────────────────
  const cwHook = path.join(root, 'hook', 'codewhale-hook.js');
  // 先验证 LLMPET 不可达时（改 HOME 使 runtime.json 不存在）→ ask
  const unreachableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'no-runtime-'));
  const r5 = await runHook(cwHook, ['tool_call_before'], {
    HOME: unreachableHome,
    USERPROFILE: unreachableHome, // Windows: 只改 HOME 子进程仍读真实 USERPROFILE
    DEEPSEEK_SESSION_ID: 'cw-unreach', DEEPSEEK_TOOL_NAME: 'exec_shell', DEEPSEEK_TOOL_ARGS: '{"command":"rm -rf /"}',
  }, '');
  assert.strictEqual(r5.code, 0);
  const decision5 = JSON.parse(r5.out.trim().split('\n').pop());
  assert.strictEqual(decision5.decision, 'ask', `unreachable LLMPET must answer ask, got ${r5.out}`);
  assert(decision5.reason);
  // Windows 删除可见性竞态：unlink 后目录项可能延迟消失，rmSync 会撞
  // ENOTEMPTY（Linux 无此问题）。Node 对 ENOTEMPTY/EBUSY/EPERM 提供
  // maxRetries+retryDelay（线性退避），正是为这个场景设计的。
  fs.rmSync(unreachableHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  console.log('✓ codewhale-hook：LLMPET 不可达 → ask（fail-closed，绝不空输出=allow）');

  // 可达时：写 runtime.json 指向测试 server，危险命令挂起，由我们决定
  // transport 的 RUNTIME_PATH 在 require 时已按 fakeHome 定值 —— hook 子进程同
  // fakeHome，因此 runtime.json 需写到 fakeHome/.octopus/runtime.json
  const { writeRuntimeConfig } = require('../backend/transport');
  assert(writeRuntimeConfig(port, token), 'runtime write failed');

  const bridged = runHook(cwHook, ['tool_call_before'], {
    DEEPSEEK_SESSION_ID: 'cw-bridge', DEEPSEEK_TOOL_NAME: 'exec_shell',
    DEEPSEEK_TOOL_ARGS: '{"command":"curl http://evil.example"}',
    DEEPSEEK_WORKSPACE: '/tmp/proj', DEEPSEEK_MODEL: 'deepseek-chat',
  }, '');
  // 子进程冷启动（node + 两个模块）+ HTTP 往返，给足时间
  let bridgedPending = [];
  for (let i = 0; i < 20 && bridgedPending.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    bridgedPending = server.getCodeWhalePermissions().getPending();
  }
  if (bridgedPending.length === 0) {
    // 诊断：环境、runtime 文件、hook 进程输出
    const { RUNTIME_PATH } = require('../backend/transport');
    console.error('DIAG HOME=', process.env.HOME, 'RUNTIME_PATH=', RUNTIME_PATH);
    console.error('DIAG runtime exists=', fs.existsSync(RUNTIME_PATH), fs.existsSync(RUNTIME_PATH) ? fs.readFileSync(RUNTIME_PATH, 'utf8') : '');
    console.error('DIAG server port/token=', port, token ? 'present' : 'MISSING');
    const diag = await Promise.race([bridged, new Promise((r) => setTimeout(() => r({ timeout: true }), 2000))]);
    console.error('DIAG hook result=', JSON.stringify(diag));
  }
  assert.strictEqual(bridgedPending.length, 1, 'permission not bridged');
  assert.strictEqual(bridgedPending[0].sessionId, 'cw-bridge');
  server.getCodeWhalePermissions().decide(bridgedPending[0].id, 'allow');
  const r6 = await bridged;
  assert.strictEqual(r6.code, 0);
  const decision6 = JSON.parse(r6.out.trim().split('\n').pop());
  assert.strictEqual(decision6.decision, 'allow');
  console.log('✓ codewhale-hook：权限桥全链路（env→HTTP→桌宠决策→stdout）');

  // ── 12. mode_change：状态入库为 attention，事件名不冒充 Notification ──────────
  const mc = await request(port, 'POST', '/state', {
    state: 'attention', event: 'ModeChange', session_id: 'cw-s1', agent_id: 'codewhale',
  }, auth);
  assert.strictEqual(mc.status, 200, mc.body);
  const mcSess = core.buildSnapshot().sessions.find((s) => s.id === 'cw-s1');
  assert.strictEqual(mcSess.state, 'attention');
  assert.strictEqual(mcSess.lastEvent.rawEvent, 'ModeChange');
  console.log('✓ mode_change：attention 状态入库（不触发 Notification 卡片路径）');

  // ── 13. 观察者 hook 性能：stdin 守护定时器不再拖住进程 ─────────────────────
  // 修复前：readStdin 的 300ms 定时器不清理也不 unref，每个观察者事件
  // 的 hook 进程至少存活 300ms；修复后 stdin 关闭即退出（本地实测 ~30ms）。
  // 双口径计时（Windows CI 事故的教训）：
  //   · spawn→exit 含 node 冷启动，Windows 冷启动 100-400ms 无判别力
  //     → 仅在非 win32 断言 <280ms；
  //   · ack→exit（usage 送达 server → 进程退出）剥掉 spawn 成本：
  //     修复后 ~0-50ms，泄漏时 ~250-300ms，跨平台都有判别力 → 断言 <150ms。
  // 两轮取最小：既容忍 CI 抖动（单次偶发慢），又确定性拦截 ≥300ms 的回归。
  const usageBefore = usageTurns.length;
  let elapsed = Infinity;
  let ackToExit = Infinity;
  for (let round = 0; round < 2; round++) {
    const t0 = Date.now();
    let ackAt = null;
    const obs = runHook(cwHook, ['turn_end'], {
      DEEPSEEK_SESSION_ID: `cw-timing-${round}`, DEEPSEEK_WORKSPACE: '/tmp/proj', DEEPSEEK_MODEL: 'deepseek-chat',
    }, JSON.stringify({ event: 'turn_end', session_id: `cw-timing-${round}`, turn_id: `turn-timing-${round}`, status: 'completed', provider: 'deepseek', usage: { input_tokens: 10, output_tokens: 5 } }));
    // 轮询 usage 送达时刻（ack）；5s 兜底防死循环，未送达由末尾断言报告
    const pollDeadline = Date.now() + 5000;
    while (ackAt === null && Date.now() < pollDeadline) {
      if (usageTurns.some((u) => u.turnId === `turn-timing-${round}`)) ackAt = Date.now();
      else await new Promise((r) => setTimeout(r, 5));
    }
    const result = await obs;
    const exitAt = Date.now();
    assert.strictEqual(result.code, 0, result.err);
    if (ackAt !== null) ackToExit = Math.min(ackToExit, Math.max(0, exitAt - ackAt));
    elapsed = Math.min(elapsed, exitAt - t0);
  }
  if (process.platform !== 'win32') {
    assert(elapsed < 280, `observer hook must exit promptly, took ${elapsed}ms (>=300 means the stdin guard timer leaks)`);
  }
  assert(ackToExit < 150, `observer hook must exit within 150ms after usage ack, took ${ackToExit}ms (>=250 means the stdin guard timer leaks)`);
  await new Promise((r) => setTimeout(r, 100));
  assert(usageTurns.length > usageBefore && usageTurns.some((u) => u.turnId === 'turn-timing-0'), 'turn_end usage not delivered through the real hook process');
  console.log(`✓ 观察者 hook 快速退出（ack→exit 两轮最小 ${ackToExit}ms${process.platform !== 'win32' ? `，spawn→exit ${elapsed}ms` : '（win32 只看 ack 口径）'}，修复前 ≥300ms）且 usage 全链路送达`);

  // ── 13b. askPermission 超时分支：永不响应的服务器 → ask + 明确超时 reason ──
  {
    const net = require('net');
    const { PORTS } = require('../backend/transport');
    const tryListen = (p) => new Promise((resolve) => {
      const srv = net.createServer(() => {}); // 接受连接，永不响应
      srv.once('error', () => resolve(null));
      srv.listen(p, '127.0.0.1', () => resolve(srv));
    });
    let silent = null;
    let silentPort = null;
    for (const p of PORTS) {
      if (p === port) continue;
      silent = await tryListen(p);
      if (silent) { silentPort = p; break; }
    }
    assert(silent, 'no free port for the silent server');
    writeRuntimeConfig(silentPort, token);
    const { askPermission } = require('../hook/codewhale-hook');
    const decision = await askPermission(
      { session_id: 'cw-timeout', tool_name: 'exec_shell', tool_input: { command: 'ls' } },
      { timeoutMs: 120 },
    );
    assert.strictEqual(decision.decision, 'ask', `timeout must degrade to ask, got ${JSON.stringify(decision)}`);
    assert(/timed out/i.test(String(decision.reason)), `reason should say timed out, got ${decision.reason}`);
    silent.close();
    // 恢复 runtime 记录指向测试 server，供后续断言使用
    writeRuntimeConfig(port, token);
    console.log('✓ askPermission 超时分支：ask + 区别于「未运行」的超时 reason');
  }

  // ── 14. runtime 守护：伪造陈旧记录 → 被接管；伪造存活记录 → 不抢 ─────────
  // 直接测 claimRuntimeOwnership 的行为：写一个指向死端口的记录
  const { writeRuntimeConfig: writeRuntime, readRuntimeConfig } = require('../backend/transport');
  // 陈旧记录（死端口）—— server 内部 15s 守护会探测并接管；手动触发更快的方式：
  // 直接调用 server 内部不可行（未导出），改为验证「写死端口后短时间内不崩溃」+
  // 等守护周期。这里验证读取侧一致性与 stop() 行为即可；守护逻辑已由
  // pr3-smoke + 代码审查覆盖。
  const staleOk = writeRuntime(port === 41330 ? 41334 : 41330, 'a'.repeat(48));
  assert(staleOk);
  // stop() 只删指向自己的记录
  const otherPort = port === 41330 ? 41331 : 41330;
  writeRuntime(otherPort, 'b'.repeat(48));
  server.stop();
  const after = readRuntimeConfig();
  assert(after && after.port === otherPort, 'stop() must not delete a record pointing elsewhere');
  console.log('✓ runtime：stop() 不误删他人记录（first-live-wins 语义）');

  console.log('\n✅ E2E 冒烟全部通过（14 组断言）');
  // 先关全局 logger 的常开 append 流再删沙箱：Windows 上打开的写句柄让
  // 文件处于 delete-pending，目录永远「非空」，rmSync 重试再多也赢不了
  // （CI windows-latest 三连红的第二个根因）。maxRetries 兕底剩余的可见性竞态。
  await require('../backend/log').shutdown();
  fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E FAILED:', e);
  try { server.stop(); } catch {}
  require('../backend/log').shutdown(); // 尽力而为（无 await：失败路径同步退出）
  try { fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  process.exit(1);
});
