'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RECOVERY_COOLDOWN_MS,
  recoveryExecutable,
  ensureLoginStartup,
  recoverPackagedApp,
} = require('../backend/startup');

assert.strictEqual(
  recoveryExecutable('C:\\Program Files\\LLMPET\\resources\\app\\hook', 'win32'),
  'C:\\Program Files\\LLMPET\\LLMPET.exe'
);
assert.strictEqual(
  recoveryExecutable('/Applications/LLMPET.app/Contents/Resources/app/hook', 'darwin'),
  '/Applications/LLMPET.app/Contents/MacOS/LLMPET'
);
assert.strictEqual(recoveryExecutable('/opt/llmpet/hook', 'linux'), null);

const loginCalls = [];
const packagedApp = {
  isPackaged: true,
  setLoginItemSettings(settings) { loginCalls.push(settings); },
};
assert.strictEqual(ensureLoginStartup(packagedApp, {
  platform: 'win32', executable: 'C:\\Program Files\\LLMPET\\LLMPET.exe',
}), true);
assert.deepStrictEqual(loginCalls[0], {
  openAtLogin: true,
  path: 'C:\\Program Files\\LLMPET\\LLMPET.exe',
  args: ['--autostart'],
});
assert.strictEqual(ensureLoginStartup({ ...packagedApp, isPackaged: false }, { platform: 'win32' }), false);
assert.strictEqual(ensureLoginStartup(packagedApp, { platform: 'linux' }), false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-startup-'));
const stampPath = path.join(tmp, 'hook-recovery.json');
const executable = path.join(tmp, 'LLMPET.exe');
fs.writeFileSync(executable, 'test');
const spawns = [];
const spawn = (command, args, options) => {
  spawns.push({ command, args, options });
  return { unref() {} };
};

const firstAt = Date.now();
assert.strictEqual(recoverPackagedApp({ executable, stampPath, now: firstAt, spawn }), true);
assert.strictEqual(spawns.length, 1);
assert.deepStrictEqual(spawns[0].args, ['--hook-recovery']);
assert.strictEqual(spawns[0].options.detached, true);

assert.strictEqual(recoverPackagedApp({
  executable, stampPath, now: firstAt + RECOVERY_COOLDOWN_MS - 1, spawn,
}), false, 'events inside the cooldown must not spawn another app');
assert.strictEqual(spawns.length, 1);

assert.strictEqual(recoverPackagedApp({
  executable, stampPath, now: firstAt + RECOVERY_COOLDOWN_MS, spawn,
}), true, 'recovery must be allowed again after the cooldown');
assert.strictEqual(spawns.length, 2);
assert.strictEqual(recoverPackagedApp({ executable: path.join(tmp, 'missing.exe'), stampPath, spawn }), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('startup recovery checks passed');
