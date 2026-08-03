'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  activateWindowsTerminalTab,
  focusSessionTarget,
  normalizeWindowHandle,
  normalizeRuntimeId,
  WINDOWS_TERMINAL_HELPER,
} = require('../backend/focus');
const {
  captureWindowsTerminalTabRoute,
  enrichWindowsTabRoute,
  hasWtTabRoute,
  normalizeWtTabRuntimeId,
  WT_TAB_CAPTURE_HELPER,
} = require('../backend/pidwalk');

const WT_SESSION = '977e6134-10f1-4487-b153-e6845b21716f';
const SESSION = {
  id: '22222222-2222-4222-8222-222222222222',
  agentId: 'codex',
  state: 'idle',
  wtSession: WT_SESSION,
  wtHwnd: '123456',
  wtTabRuntimeId: [42, -7, 9001],
};

async function main() {
  assert.strictEqual(normalizeWindowHandle('123456'), '123456');
  assert.strictEqual(normalizeWindowHandle('0'), null);
  assert.deepStrictEqual(normalizeRuntimeId([42, -7, 9001]), [42, -7, 9001]);
  assert.strictEqual(normalizeRuntimeId([]), null);
  assert.deepStrictEqual(normalizeWtTabRuntimeId([1, -2, 3]), [1, -2, 3]);
  assert(hasWtTabRoute(SESSION));

  let exactCalls = 0;
  let result = await focusSessionTarget(SESSION, {
    platform: 'win32',
    exactFocus: async (target) => {
      exactCalls++;
      assert.strictEqual(target, SESSION);
      return { ok: true };
    },
  });
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-tab' });
  assert.strictEqual(exactCalls, 1);

  result = await focusSessionTarget({ ...SESSION, state: 'sleeping' }, {
    platform: 'win32',
    exactFocus: async () => ({ ok: true }),
  });
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-tab' },
    'an inactive but still-open tab must remain focusable');

  result = await focusSessionTarget({ ...SESSION, wtTabRuntimeId: null }, {
    platform: 'win32',
    exactFocus: async () => { throw new Error('missing routes must not invoke the helper'); },
    legacyFocus: async () => { throw new Error('Windows must not focus a possibly wrong window'); },
  });
  assert.deepStrictEqual(result, { ok: false, route: 'failed', reason: 'route-missing' });

  result = await focusSessionTarget(SESSION, {
    platform: 'win32',
    exactFocus: async () => ({ ok: false, reason: 'tab-closed' }),
    legacyFocus: async () => { throw new Error('failure must not use window-level fallback'); },
  });
  assert.deepStrictEqual(result, { ok: false, route: 'failed', reason: 'tab-closed' });

  result = await focusSessionTarget(SESSION, {
    platform: 'darwin',
    legacyFocus: async () => true,
  });
  assert.deepStrictEqual(result, { ok: true, route: 'terminal-window' },
    'non-Windows focus behavior must remain compatible');

  let focusArgs = null;
  result = await activateWindowsTerminalTab(SESSION, {
    execFile: (_bin, args, _options, callback) => {
      focusArgs = args;
      callback(null, '{"ok":true,"reason":"focused"}\n', '');
    },
  });
  assert.deepStrictEqual(result, { ok: true });
  assert(focusArgs.includes('-WindowHandle') && focusArgs.includes('123456'));
  assert(focusArgs.includes('-RuntimeId') && focusArgs.includes('42,-7,9001'));
  assert(!focusArgs.includes('-PidList') && !focusArgs.includes('-Marker'));

  let captureOptions = null;
  const captured = captureWindowsTerminalTabRoute({
    marker: 'LLMPET-0123456789abcdef0123456789abcdef',
    execFileSync: (_bin, args, options) => {
      captureOptions = { args, options };
      return '{"ok":true,"reason":"captured","hwnd":"123456","runtimeId":[42,-7,9001]}\n';
    },
  });
  assert.deepStrictEqual(captured, { wtHwnd: '123456', wtTabRuntimeId: [42, -7, 9001] });
  assert(captureOptions.args.includes('-File') && captureOptions.args.includes(WT_TAB_CAPTURE_HELPER));
  assert.strictEqual(captureOptions.options.windowsHide, false,
    'capture helper must inherit the hook ConPTY instead of creating a detached console');

  let captures = 0;
  const existing = enrichWindowsTabRoute(SESSION, {
    wtSession: WT_SESSION,
    capture: () => { captures++; return null; },
    now: 100000,
  });
  assert.strictEqual(existing.changed, false);
  assert.strictEqual(captures, 0, 'a cached exact route should be reused within the turn');

  const missing = enrichWindowsTabRoute({ wtTabCaptureAttemptedAt: 100000 }, {
    wtSession: WT_SESSION,
    capture: () => { captures++; return null; },
    now: 100500,
  });
  assert.strictEqual(missing.changed, false);
  assert.strictEqual(captures, 0, 'PreToolUse must not retry a failed capture for every tool');

  const refreshed = enrichWindowsTabRoute(SESSION, {
    wtSession: WT_SESSION,
    refresh: true,
    capture: () => {
      captures++;
      return { wtHwnd: '654321', wtTabRuntimeId: [99, 1] };
    },
    now: 200000,
  });
  assert.strictEqual(refreshed.changed, true);
  assert.strictEqual(captures, 1);
  assert.strictEqual(refreshed.result.wtHwnd, '654321');
  assert.deepStrictEqual(refreshed.result.wtTabRuntimeId, [99, 1]);

  const captureSource = fs.readFileSync(WT_TAB_CAPTURE_HELPER, 'utf8');
  const focusSource = fs.readFileSync(WINDOWS_TERMINAL_HELPER, 'utf8');
  assert(/finally\s*\{[\s\S]*SetConsoleTitle\(\$originalTitle\)/.test(captureSource),
    'temporary capture title must always be restored');
  assert(captureSource.includes('GetRuntimeId()'));
  assert(focusSource.includes('SelectionItemPattern'));
  assert(focusSource.includes('Test-RuntimeIdEqual'));
  assert(!focusSource.includes('AttachConsole') && !focusSource.includes('SetConsoleTitle'),
    'click-time focus must not attach to or rename a console');

  if (process.platform === 'win32') {
    for (const [helper, args] of [
      [WT_TAB_CAPTURE_HELPER, ['-Marker', 'invalid']],
      [WINDOWS_TERMINAL_HELPER, ['-WindowHandle', 'invalid', '-RuntimeId', 'invalid']],
    ]) {
      const parsed = childProcess.spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args,
      ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      assert.strictEqual(parsed.status, 2, parsed.stderr);
      assert.strictEqual(JSON.parse(parsed.stdout.trim()).reason, 'invalid-arguments');
    }
  }

  const backendFocusSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'focus.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert(!/resumeSession|resumed-tab|launchCliInRecentWindowsTerminal|wt\.exe/.test(backendFocusSource),
    'session click path must never resume a CLI or launch Windows Terminal');
  assert(preloadSource.includes("ipcRenderer.invoke('focus-session'"));
  assert(mainSource.includes("ipcMain.handle('focus-session'"));

  console.log('session focus checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
