'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  registerCodexHooks,
  unregisterCodexHooks,
  codexHooksCurrent,
  CODEX_EVENTS,
} = require('../backend/codex-hookinstall');
const { buildBody } = require('../hook/octopus-hook');
const { createCore } = require('../backend/core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-codex-hooks-'));
const hooksPath = path.join(tmp, 'hooks.json');
const nodeBin = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node';
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const otherCommand = '"C:\\Tools\\OtherPet.Hook.exe"';

fs.writeFileSync(hooksPath, JSON.stringify({
  description: 'User lifecycle hooks.',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: otherCommand, timeout: 1 }] }],
  },
}, null, 2));

const first = registerCodexHooks({ hooksPath, nodeBin, platform });
assert.strictEqual(first.added, CODEX_EVENTS.length);
let config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
assert.strictEqual(config.description, 'User lifecycle hooks.');
assert(config.hooks.SessionStart.some((group) =>
  group.hooks.some((hook) => hook.command === otherCommand)), 'unrelated Codex hooks must be preserved');
for (const event of CODEX_EVENTS) {
  const ours = config.hooks[event].flatMap((group) => group.hooks || [])
    .filter((hook) => String(hook.command || '').includes('octopus-hook.js'));
  assert.strictEqual(ours.length, 1, `${event} must contain exactly one LLMPET hook`);
  assert(ours[0].command.endsWith(`${event} codex`), `${event} must identify Codex as the source`);
  if (platform === 'win32') {
    assert.strictEqual(ours[0].commandWindows, `& ${ours[0].command}`);
    assert(ours[0].commandWindows.startsWith('& "C:\\Program Files\\nodejs\\node.exe"'),
      'PowerShell commandWindows must invoke a quoted executable with the call operator');
  }
}

const installed = fs.readFileSync(hooksPath, 'utf8');
const second = registerCodexHooks({ hooksPath, nodeBin, platform });
assert.strictEqual(second.skipped, CODEX_EVENTS.length, 'a current config must not churn hook trust hashes');
assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), installed, 'idempotent install must not rewrite hooks.json');
assert.strictEqual(codexHooksCurrent({ hooksPath, nodeBin, platform }), true);

const prompt = buildBody('UserPromptSubmit', {
  session_id: 'codex-session',
  cwd: 'C:\\work\\repo',
  prompt: 'Fix the watcher',
  model: 'gpt-test',
}, 'codex');
assert.strictEqual(prompt.agent_id, 'codex');
assert.strictEqual(prompt.event_source, 'codex-hook');
assert.strictEqual(prompt.state, 'thinking');
assert.strictEqual(prompt.session_title, 'Fix the watcher');

const tool = buildBody('PreToolUse', {
  session_id: 'codex-session',
  tool_name: 'apply_patch',
}, 'codex');
assert.strictEqual(tool.tool_name, 'Edit');

const stop = buildBody('Stop', {
  session_id: 'codex-session',
  last_assistant_message: 'Implemented and tested.',
}, 'codex');
assert.strictEqual(stop.assistant_last_output, 'Implemented and tested.');

const permission = buildBody('PermissionRequest', { session_id: 'codex-session' }, 'codex');
assert.strictEqual(permission.state, 'notification');

const activities = [];
const core = createCore({ onActivity: (activity) => activities.push(activity) });
core.updateSession('dedupe', 'working', 'PreToolUse', {
  agentId: 'codex', eventSource: 'codex-hook', toolName: 'Bash',
});
core.updateSession('dedupe', 'working', 'PreToolUse', {
  agentId: 'codex', eventSource: 'codex-rollout', toolName: 'Bash',
});
assert.strictEqual(activities.length, 1, 'hook + rollout copies must emit one activity');
core.updateSession('dedupe', 'working', 'PreToolUse', {
  agentId: 'codex', eventSource: 'codex-hook', toolName: 'Bash',
});
assert.strictEqual(activities.length, 2, 'a repeated event from one source must remain visible');

const removed = unregisterCodexHooks({ hooksPath, backup: true });
assert.strictEqual(removed.removed, CODEX_EVENTS.length);
assert(removed.backupPath && fs.existsSync(removed.backupPath), 'uninstall must back up hooks.json');
config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
assert(config.hooks.SessionStart.some((group) =>
  group.hooks.some((hook) => hook.command === otherCommand)), 'uninstall must retain unrelated hooks');
assert.strictEqual(codexHooksCurrent({ hooksPath, nodeBin, platform }), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('codex hook checks passed');
