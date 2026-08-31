'use strict';

// runtime.json 所有权语义：first-live-wins + 陈旧记录接管。
// 这是对「多实例反复争抢 runtime 配置」的回归测试——旧守护每 15 秒无条件
// 抢回，两个存活实例会永远翻转文件。变异测试曾证明无条件抢写能逃过
// e2e-codewhale.js，这个文件专门堵住该盲区。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠️ HOME 覆盖必须在 transport require 之前（transport 在模块加载时固化
// RUNTIME_PATH —— e2e 测试开发时踩过的真实坑）
// ⚠️ Windows 上 os.homedir() 读 USERPROFILE 而非 HOME，必须两个都覆盖
// （上游 CI windows-latest 全红的真实事故链，详见 e2e-codewhale.js 头注释）
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.OCTOPUS_ALLOW_MULTI = '1';

const { createServer } = require('../backend/server');
const { createCore } = require('../backend/core');
const { RUNTIME_PATH, readRuntimeConfig } = require('../backend/transport');

function makeServer() {
  const core = createCore({ onActivity: () => {}, onDirty: () => {} });
  const server = createServer({
    core,
    permissions: { sweepForSessionEvent: () => {}, getPending: () => [] },
    onCodeWhaleUsage: () => {},
    onPermissionChange: () => {},
    onPermissionAdded: () => {},
    runtimeGuardMs: 120, // 快速守护便于测试
  });
  server.start();
  return server;
}

function waitFor(ms, cond, label) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      let v = null;
      try { v = cond(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(poll, 30);
    })();
  });
}

const servers = [];

async function main() {
  const keepAlive = setInterval(() => {}, 20);
  try {
    // ── 场景 1：两个存活实例 → 先到者赢，后者不抢写 ──────────────────────
    const a = makeServer();
    servers.push(a);
    const portA = await waitFor(2000, () => a.getPort(), 'A listening');
    await waitFor(1000, () => readRuntimeConfig() && readRuntimeConfig().port === portA, 'A owns runtime');

    const b = makeServer();
    servers.push(b);
    // 注意返回端口数值本身 —— waitFor 用条件值作为 resolve 值，返回布尔会
    // 把 portB 变成 true（开发本测试时踩到的坑）。
    const portB = await waitFor(2000, () => {
      const p = b.getPort();
      return p && p !== portA ? p : null;
    }, 'B listening on other port');
    assert.notStrictEqual(portB, portA, 'B must land on a different port (A holds the recorded one)');
    // 等待 B 的 listen 申领 + 至少一轮守护（120ms 间隔，等 600ms 足够）
    await new Promise((r) => setTimeout(r, 600));
    const after = readRuntimeConfig();
    assert(after, 'runtime record vanished');
    assert.strictEqual(after.port, portA, `存活对手在场时不得抢写: 期望 A:${portA}，实际 ${after && after.port}`);

    // ── 场景 2：A 退出（记录变陈旧）→ B 接管 ─────────────────────────────
    a.stop();
    await waitFor(1500, () => {
      const rt = readRuntimeConfig();
      return rt && rt.port === portB;
    }, 'B takes over stale record');
    const taken = readRuntimeConfig();
    assert.strictEqual(taken.port, portB, 'B should own the record after A exits');

    // ── 场景 3：同端口不同 token（自己崩溃重启的残留）→ 立即重写 ────────
    // 写一个指向 B 端口但 token 错误的记录（模拟旧 token）
    fs.writeFileSync(RUNTIME_PATH, JSON.stringify({ app: 'octopus', port: portB, token: 'f'.repeat(64) }), { mode: 0o600 });
    await waitFor(1500, () => {
      const rt = readRuntimeConfig();
      return rt && rt.port === portB && rt.token === b.getToken();
    }, 'stale same-port token healed');

    // ── 场景 4：stop() 不误删指向他人的记录 ──────────────────────────────
    fs.writeFileSync(RUNTIME_PATH, JSON.stringify({ app: 'octopus', port: 41334, token: 'e'.repeat(64) }), { mode: 0o600 });
    b.stop();
    const final = readRuntimeConfig();
    assert(final && final.port === 41334, 'stop() must not delete a record pointing elsewhere');

    console.log('✓ runtime 所有权：first-live-wins（不抢存活对手的记录）');
    console.log('✓ runtime 所有权：陈旧记录被接管');
    console.log('✓ runtime 所有权：同端口旧 token 立即修复');
    console.log('✓ runtime 所有权：stop() 不误删他人记录');
    console.log('\n✅ runtime 所有权测试全部通过');
  } finally {
    clearInterval(keepAlive);
    for (const s of servers) { try { s.stop(); } catch {} }
    // 先关 logger 常开流再删沙箱（Windows delete-pending 会永阻 rmSync，
    // 详见 backend/log.js 的 shutdown 注释）
    await require('../backend/log').shutdown();
    try { fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
    // 不用 process.exit()：管道 stdout 是异步的，立即退出会截断未刷盘的
    // 输出（开发本测试时真实踩到的坑）。exitCode + 自然退出让缓冲刷完。
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error('runtime ownership FAILED:', e.message);
  for (const s of servers) { try { s.stop(); } catch {} }
  require('../backend/log').shutdown(); // 尽力而为（无 await：失败路径同步退出）
  try { fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  process.exitCode = 1;
});
