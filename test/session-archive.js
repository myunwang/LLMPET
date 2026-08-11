'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionArchive } = require('../backend/session-archive');
const config = require('../backend/config');

function jsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-session-archive-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const codexRoot = path.join(root, '.codex', 'sessions');
  const codexArchivedRoot = path.join(root, '.codex', 'archived_sessions');
  const stateDir = path.join(root, '.octopus');
  const claudeDesktop = path.join(claudeRoot, '-tmp-project', 'claude-desktop.jsonl');
  const claudeCli = path.join(claudeRoot, '-tmp-cli', 'claude-cli.jsonl');
  jsonl(claudeDesktop, [
    { type: 'user', sessionId: 'claude-desktop', entrypoint: 'claude-desktop', cwd: '/tmp/project', timestamp: '2026-08-10T10:00:00Z', message: { content: 'Desktop session prompt' } },
    { type: 'custom-title', sessionId: 'claude-desktop', customTitle: 'Desktop custom title', timestamp: '2026-08-10T10:01:00Z' },
  ]);
  jsonl(claudeCli, [
    { type: 'user', sessionId: 'claude-cli', entrypoint: 'cli', cwd: '/tmp/cli', timestamp: '2026-08-09T10:00:00Z', message: { content: [{ type: 'text', text: 'CLI prompt' }] } },
  ]);
  jsonl(path.join(claudeRoot, '-tmp-project', 'claude-desktop', 'subagents', 'agent.jsonl'), [
    { type: 'user', sessionId: 'agent', entrypoint: 'cli', cwd: '/tmp/project', message: { content: 'internal' } },
  ]);

  const codexDesktop = path.join(codexRoot, '2026', '08', '10', 'rollout-2026-08-10-codex-desktop.jsonl');
  const codexCli = path.join(codexRoot, '2026', '08', '09', 'rollout-2026-08-09-codex-cli.jsonl');
  jsonl(codexDesktop, [
    { timestamp: '2026-08-10T11:00:00Z', type: 'session_meta', payload: { id: 'codex-desktop', cwd: '/tmp/codex-desktop', originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' } },
    { timestamp: '2026-08-10T11:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Codex desktop prompt' } },
  ]);
  jsonl(codexCli, [
    { timestamp: '2026-08-09T11:00:00Z', type: 'session_meta', payload: { id: 'codex-cli', cwd: '/tmp/codex-cli', originator: 'codex-tui', source: 'cli', thread_source: 'user' } },
    { timestamp: '2026-08-09T11:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Codex cli prompt' } },
  ]);
  jsonl(path.join(codexRoot, '2026', '08', '10', 'rollout-subagent.jsonl'), [
    { timestamp: '2026-08-10T12:00:00Z', type: 'session_meta', payload: { id: 'subagent', cwd: '/tmp/internal', originator: 'Codex Desktop', source: { subagent: { other: 'guardian' } }, thread_source: 'subagent' } },
  ]);

  const events = [];
  const archive = createSessionArchive({
    homeDir: root, stateDir, claudeRoot, codexRoot, codexArchivedRoot,
    getSettings: () => ({ backupEnabled: false, backupIntervalHours: 24 }),
    onChange: (event) => events.push(event.type),
  });
  await archive.start();
  const all = archive.list({ pageSize: 50 });
  assert.strictEqual(all.total, 4, 'only four user sessions should enter the archive');
  assert.strictEqual(all.summary.claude, 2);
  assert.strictEqual(all.summary.codex, 2);
  assert.strictEqual(all.summary.desktop, 2);
  assert.strictEqual(all.summary.cli, 2);
  assert.strictEqual(archive.list({ provider: 'codex' }).total, 2);
  assert.strictEqual(archive.list({ origin: 'desktop' }).total, 2);
  assert.strictEqual(archive.list({ search: 'custom title' }).sessions[0].id, 'claude-desktop');

  const backup = await archive.backupNow();
  assert.strictEqual(backup.ok, true);
  assert.strictEqual(backup.copied, 4);
  assert.strictEqual(archive.summary().backedUp, 4);
  assert.ok(fs.existsSync(path.join(stateDir, 'session-vault', 'claude', 'claude-desktop.jsonl')));
  assert.ok(events.includes('backup-progress'));

  fs.unlinkSync(claudeDesktop);
  await archive.refresh();
  const missing = archive.get('claude:claude-desktop');
  assert.strictEqual(missing.sourceAvailable, false, 'metadata survives provider transcript deletion');
  assert.strictEqual(missing.backupAvailable, true, 'backup remains available after source deletion');
  assert.strictEqual(archive.list({ backup: 'backed-up' }).total, 4);
  const restored = await archive.restore('claude:claude-desktop');
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.code, 'restored');
  assert.ok(fs.existsSync(claudeDesktop), 'restore recreates the missing provider transcript');
  const preserved = fs.readFileSync(claudeDesktop, 'utf8');
  const secondRestore = await archive.restore('claude:claude-desktop');
  assert.strictEqual(secondRestore.code, 'already-present', 'restore never overwrites an existing transcript');
  assert.strictEqual(fs.readFileSync(claudeDesktop, 'utf8'), preserved);
  archive.stop();

  const sanitized = config.sanitize({ sessionArchive: { backupEnabled: true, backupIntervalHours: 72 } });
  assert.deepStrictEqual(sanitized.sessionArchive, { backupEnabled: true, backupIntervalHours: 72 });
  const invalid = config.sanitize({ sessionArchive: { backupEnabled: 'yes', backupIntervalHours: 13 } });
  assert.deepStrictEqual(invalid.sessionArchive, { backupEnabled: false, backupIntervalHours: 24 });

  fs.rmSync(root, { recursive: true, force: true });
  console.log('session archive tests passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
