'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RECOVERY_COOLDOWN_MS,
  recoveryExecutable,
  ensureLoginStartup,
  startupRecoveryEnabled,
  recoveryAllowed,
  recordIntentionalQuit,
  clearIntentionalQuit,
  recoverPackagedApp,
} = require('../backend/startup');
const {
  enqueueHookEvent,
  drainPendingHookEvents,
  pendingFiles,
} = require('../backend/hook-queue');
const { deliverStateWithRecovery } = require('../hook/octopus-hook');

assert.strictEqual(
  recoveryExecutable('C:\\Program Files\\LLMPET\\resources\\app\\hook', 'win32'),
  'C:\\Program Files\\LLMPET\\LLMPET.exe',
);
assert.strictEqual(
  recoveryExecutable('/Applications/LLMPET.app/Contents/Resources/app/hook', 'darwin'),
  '/Applications/LLMPET.app/Contents/MacOS/LLMPET',
);
assert.strictEqual(recoveryExecutable('/opt/llmpet/hook', 'linux'), null);

const loginCalls = [];
const packagedApp = {
  isPackaged: true,
  setLoginItemSettings(settings) { loginCalls.push(settings); },
};
assert.strictEqual(ensureLoginStartup(packagedApp, {
  platform: 'win32', executable: 'C:\\Program Files\\LLMPET\\LLMPET.exe', enabled: true,
}), true);
assert.deepStrictEqual(loginCalls[0], {
  openAtLogin: true,
  path: 'C:\\Program Files\\LLMPET\\LLMPET.exe',
  args: ['--autostart'],
});
assert.strictEqual(ensureLoginStartup(packagedApp, {
  platform: 'win32', executable: 'C:\\Program Files\\LLMPET\\LLMPET.exe', enabled: false,
}), true);
assert.strictEqual(loginCalls[1].openAtLogin, false, 'disabled preference must remove stale login startup');
assert.strictEqual(ensureLoginStartup({ ...packagedApp, isPackaged: false }, { platform: 'win32' }), false);
assert.strictEqual(ensureLoginStartup(packagedApp, { platform: 'linux' }), false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-startup-'));
const configPath = path.join(tmp, 'config.json');
const quitPath = path.join(tmp, 'intentional-quit.json');
const stampPath = path.join(tmp, 'hook-recovery.json');
const pendingDir = path.join(tmp, 'pending-hooks');
const executable = path.join(tmp, 'LLMPET.exe');
fs.writeFileSync(executable, 'test');

fs.writeFileSync(configPath, JSON.stringify({ startupRecovery: false }));
assert.strictEqual(startupRecoveryEnabled({ configPath }), false);
assert.strictEqual(recoveryAllowed({ configPath, quitPath }), false);

const spawns = [];
const spawn = (command, args, options) => {
  spawns.push({ command, args, options });
  return { unref() {} };
};
assert.strictEqual(recoverPackagedApp({ executable, configPath, quitPath, stampPath, spawn }), false,
  'hooks must not launch the app before the user opts in');

fs.writeFileSync(configPath, JSON.stringify({ startupRecovery: true }));
assert.strictEqual(startupRecoveryEnabled({ configPath }), true);
assert.strictEqual(recoveryAllowed({ configPath, quitPath }), true);

const firstAt = Date.now();
assert.strictEqual(recoverPackagedApp({ executable, configPath, quitPath, stampPath, now: firstAt, spawn }), true);
assert.strictEqual(spawns.length, 1);
assert.deepStrictEqual(spawns[0].args, ['--hook-recovery']);
assert.strictEqual(spawns[0].options.detached, true);
assert.strictEqual(recoverPackagedApp({
  executable, configPath, quitPath, stampPath, now: firstAt + RECOVERY_COOLDOWN_MS - 1, spawn,
}), false, 'events inside the cooldown must not spawn another app');

assert.strictEqual(recordIntentionalQuit({ quitPath, now: firstAt + 1 }), true);
assert.strictEqual(recoveryAllowed({ configPath, quitPath }), false);
assert.strictEqual(recoverPackagedApp({
  executable, configPath, quitPath, stampPath, now: firstAt + RECOVERY_COOLDOWN_MS, spawn,
}), false, 'an intentional Quit must suppress hook resurrection');
assert.strictEqual(clearIntentionalQuit({ quitPath }), true);
assert.strictEqual(recoveryAllowed({ configPath, quitPath }), true);
assert.strictEqual(recoverPackagedApp({
  executable, configPath, quitPath, stampPath, now: firstAt + RECOVERY_COOLDOWN_MS, spawn,
}), true, 'recovery must resume after an explicit app launch clears the quit marker');
assert.strictEqual(spawns.length, 2);
assert.strictEqual(recoverPackagedApp({
  executable: path.join(tmp, 'missing.exe'), configPath, quitPath, stampPath, spawn,
}), false);

// Regression: the exact event that finds a stopped app is persisted, then
// delivered after the recovered server is healthy. Merely spawning is not
// enough; the queue must empty only after postState confirms success.
const failedBody = {
  state: 'attention', event: 'Stop', session_id: 'session-replay', agent_id: 'codex',
};
let recoveries = 0;
let initialDelivery = null;
deliverStateWithRecovery(failedBody, {
  postState: (_body, cb) => cb(false),
  canRecover: () => true,
  enqueue: (body) => enqueueHookEvent(body, { directory: pendingDir, now: firstAt, id: 'regression' }),
  recover: () => { recoveries++; return true; },
  finish: (ok) => { initialDelivery = ok; },
});
assert.strictEqual(initialDelivery, false);
assert.strictEqual(recoveries, 1);
assert.strictEqual(pendingFiles(pendingDir).length, 1, 'failed event must survive the hook process');

const replayed = [];
let drainResult = null;
drainPendingHookEvents({
  directory: pendingDir,
  postState: (body, cb) => { replayed.push(body); cb(true); },
}, (result) => { drainResult = result; });
assert.deepStrictEqual(replayed, [failedBody], 'recovered server must receive the original failed event');
assert.deepStrictEqual(drainResult, { delivered: 1, failed: null, remaining: 0 });
assert.strictEqual(pendingFiles(pendingDir).length, 0, 'successful replay must remove its durable queue entry');

enqueueHookEvent(failedBody, { directory: pendingDir, now: firstAt + 1, id: 'retain-on-failure' });
drainPendingHookEvents({ directory: pendingDir, postState: (_body, cb) => cb(false) }, () => {});
assert.strictEqual(pendingFiles(pendingDir).length, 1, 'a failed replay must remain queued for another attempt');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert(/onListening: \(\) => schedulePendingHookDrain\(\)/.test(main),
  'pending hooks must drain only after the local server starts listening');
assert(/hookDrainPollTimer = setInterval/.test(main),
  'a healthy long-running server must also discover events queued after startup');
assert(/recordIntentionalQuit\(\)/.test(main) && /quitAppIntentionally/.test(main),
  'user-triggered Quit must record intent before the app exits');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('startup recovery checks passed');
