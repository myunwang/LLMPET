'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  activateWindowsTerminalTab,
  focusSessionTarget,
  resumeSessionInWindowsTerminal,
  sessionPids,
  WT_SESSION_RE,
  WINDOWS_TERMINAL_HELPER,
} = require('../backend/focus');
const { launchCliInRecentWindowsTerminal } = require('../backend/launch');

const WT_SESSION = '977e6134-10f1-4487-b153-e6845b21716f';
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '22222222-2222-4222-8222-222222222222';

async function main() {
  assert(WT_SESSION_RE.test(WT_SESSION));
  assert.deepStrictEqual(sessionPids({ sourcePid: 30, pidChain: [10, 20, 10] }), [10, 20, 30]);

  let exactCalls = 0;
  let resumeCalls = 0;
  let result = await focusSessionTarget({
    id: CLAUDE_ID,
    sourcePid: 30,
    pidChain: [10, 20],
    wtSession: WT_SESSION,
    state: 'working',
  }, {
    platform: 'win32',
    pidAlive: () => true,
    exactFocus: async (pids) => { exactCalls++; assert.deepStrictEqual(pids, [10, 20, 30]); return { ok: true }; },
    resume: async () => { resumeCalls++; return { ok: true, route: 'resumed-tab' }; },
  });
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-tab' });
  assert.strictEqual(exactCalls, 1);
  assert.strictEqual(resumeCalls, 0, 'exact focus must not create a duplicate tab');

  result = await focusSessionTarget({
    id: CODEX_ID,
    sourcePid: 31,
    wtSession: WT_SESSION,
    state: 'idle',
  }, {
    platform: 'win32',
    pidAlive: () => true,
    exactFocus: async () => ({ ok: false, reason: 'tab-not-found' }),
    resume: async () => ({ ok: true, route: 'resumed-tab' }),
  });
  assert.deepStrictEqual(result, { ok: true, route: 'resumed-tab' });

  let legacyCalls = 0;
  result = await focusSessionTarget({ id: CLAUDE_ID, sourcePid: 40, state: 'idle' }, {
    platform: 'win32',
    pidAlive: () => true,
    legacyFocus: async () => { legacyCalls++; return true; },
    resume: async () => { throw new Error('legacy focus should have succeeded'); },
  });
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-window' });
  assert.strictEqual(legacyCalls, 1);

  result = await focusSessionTarget({ id: CLAUDE_ID, sourcePid: 41, state: 'idle' }, {
    platform: 'win32',
    pidAlive: () => true,
    legacyFocus: async () => false,
    resume: async () => ({ ok: true, route: 'resumed-tab' }),
  });
  assert.deepStrictEqual(result, { ok: true, route: 'resumed-tab' });

  exactCalls = 0;
  result = await focusSessionTarget({
    id: CODEX_ID,
    sourcePid: 50,
    wtSession: WT_SESSION,
    state: 'sleeping',
  }, {
    platform: 'win32',
    pidAlive: () => true,
    exactFocus: async () => { exactCalls++; return { ok: true }; },
    resume: async () => ({ ok: true, route: 'resumed-tab' }),
  });
  assert.deepStrictEqual(result, { ok: true, route: 'resumed-tab' });
  assert.strictEqual(exactCalls, 0, 'sleeping sessions should resume instead of targeting a stale tab');

  result = await focusSessionTarget({ id: CLAUDE_ID, sourcePid: 60, state: 'idle' }, {
    platform: 'win32',
    pidAlive: () => false,
    legacyFocus: async () => { throw new Error('dead process must not use legacy focus'); },
    resume: async () => ({ ok: true, route: 'resumed-tab' }),
  });
  assert.deepStrictEqual(result, { ok: true, route: 'resumed-tab' });

  assert.deepStrictEqual(
    await resumeSessionInWindowsTerminal({ id: 'bad session id', agentId: 'codex' }),
    { ok: false, reason: 'invalid-session-id' }
  );

  const resumeInvocations = [];
  const launcher = async (name, opts) => {
    resumeInvocations.push({ name, opts });
    return { ok: true };
  };
  assert.deepStrictEqual(
    await resumeSessionInWindowsTerminal({ id: CLAUDE_ID, agentId: 'claude-code', cwd: 'C:\\repo' }, { launcher }),
    { ok: true, route: 'resumed-tab' }
  );
  assert.deepStrictEqual(resumeInvocations[0], {
    name: 'claude',
    opts: { cwd: 'C:\\repo', args: ['--resume', CLAUDE_ID] },
  });
  await resumeSessionInWindowsTerminal({ id: CODEX_ID, agentId: 'codex', cwd: 'C:\\repo' }, { launcher });
  assert.deepStrictEqual(resumeInvocations[1], {
    name: 'codex',
    opts: { cwd: 'C:\\repo', args: ['resume', CODEX_ID] },
  });

  let spawned = null;
  result = await launchCliInRecentWindowsTerminal('codex', {
    cwd: 'C:\\repo',
    args: ['resume', CODEX_ID],
  }, {
    platform: 'win32',
    existsSync: () => true,
    findWindowsCli: () => 'C:\\Tools\\codex.cmd',
    trySpawn: async (bin, args, opts) => { spawned = { bin, args, opts }; return true; },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(spawned.bin, 'wt.exe');
  assert.deepStrictEqual(spawned.args, [
    '-w', '0', 'new-tab', '-d', 'C:\\repo', '--',
    'cmd.exe', '/d', '/c', 'C:\\Tools\\codex.cmd', 'resume', CODEX_ID,
  ]);

  result = await launchCliInRecentWindowsTerminal('claude', {}, {
    platform: 'win32',
    findWindowsCli: () => null,
  });
  assert.deepStrictEqual(result, { ok: false, code: 'cli-not-found' });

  let helperArgs = null;
  result = await activateWindowsTerminalTab([12, 34], {
    marker: 'LLMPET-0123456789abcdef0123456789abcdef',
    execFile: (_bin, args, _opts, callback) => {
      helperArgs = args;
      callback(null, '{"ok":true,"reason":"focused","pid":34}\n', '');
    },
  });
  assert.deepStrictEqual(result, { ok: true, pid: 34 });
  assert(helperArgs.includes('-File') && helperArgs.includes(WINDOWS_TERMINAL_HELPER));
  assert(helperArgs.includes('-PidList') && helperArgs.includes('12,34'));

  const helperSource = fs.readFileSync(WINDOWS_TERMINAL_HELPER, 'utf8');
  assert(/finally\s*\{[\s\S]*SetConsoleTitle\(\$originalTitle\)/.test(helperSource),
    'temporary tab title must always be restored');
  assert(helperSource.includes('SelectionItemPattern'), 'helper must select the matching UI Automation tab');
  assert(helperSource.includes("ProcessName -ne 'WindowsTerminal'"), 'helper must reject non-Terminal UI elements');

  if (process.platform === 'win32') {
    const parsed = childProcess.spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_TERMINAL_HELPER,
      '-PidList', 'invalid',
      '-Marker', 'invalid',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.strictEqual(parsed.status, 2, parsed.stderr);
    assert.strictEqual(JSON.parse(parsed.stdout.trim()).reason, 'invalid-arguments');
  }

  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert(preload.includes("ipcRenderer.invoke('focus-session'"));
  assert(mainSource.includes("ipcMain.handle('focus-session'"));

  console.log('session focus checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
