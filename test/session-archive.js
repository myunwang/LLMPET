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

function rawZstdFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const parts = [];
  const head = Buffer.alloc(9);
  head.writeUInt32LE(0xFD2FB528, 0);
  head[4] = 0xA0;
  head.writeUInt32LE(body.length, 5);
  parts.push(head);
  for (let offset = 0; offset < body.length;) {
    const n = Math.min(128 * 1024, body.length - offset);
    const block = Buffer.alloc(3);
    block.writeUIntLE((n << 3) | (offset + n === body.length ? 1 : 0), 0, 3);
    parts.push(block, body.subarray(offset, offset + n));
    offset += n;
  }
  return Buffer.concat(parts);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-session-archive-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const codexRoot = path.join(root, '.codex', 'sessions');
  const codexArchivedRoot = path.join(root, '.codex', 'archived_sessions');
  const dshRoot = path.join(root, '.dsh', 'sessions');
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
  jsonl(path.join(root, '.codex', 'session_index.jsonl'), [
    { id: 'codex-desktop', thread_name: '继续 FaceAI 阶段收尾工作', updated_at: '2026-08-10T11:02:00Z' },
  ]);
  jsonl(path.join(codexRoot, '2026', '08', '10', 'rollout-subagent.jsonl'), [
    { timestamp: '2026-08-10T12:00:00Z', type: 'session_meta', payload: { id: 'subagent', cwd: '/tmp/internal', originator: 'Codex Desktop', source: { subagent: { other: 'guardian' } }, thread_source: 'subagent' } },
  ]);

  const dshSession = path.join(dshRoot, '--tmp-dsh--', 'session-dsh-one', 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(dshSession), { recursive: true });
  const dshHeader = { type: 'session', version: 0, id: 'session-dsh-one', cwd: '/tmp/dsh', createdAt: Date.parse('2026-08-10T12:00:00Z'), delegationDepth: 0 };
  const dshEvents = [
    { type: 'user/message', seq: 0, time: Date.parse('2026-08-10T12:01:00Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Harness prompt' }] } },
    { type: 'session/title', seq: 1, time: Date.parse('2026-08-10T12:02:00Z'), data: { title: 'DeepSeek Harness session' } },
  ];
  fs.writeFileSync(dshSession, Buffer.concat([
    rawZstdFrame(`${JSON.stringify(dshHeader)}\n`),
    rawZstdFrame(`${dshEvents.map((row) => JSON.stringify(row)).join('\n')}\n`),
  ]));
  const originalDshBytes = fs.readFileSync(dshSession);
  jsonl(path.join(dshRoot, '--tmp-dsh--', 'future-version', 'session.jsonl'), [
    { type: 'session', version: 99, id: 'future-version', cwd: '/tmp/dsh', createdAt: Date.now(), delegationDepth: 0 },
  ]);

  const events = [];
  const archive = createSessionArchive({
    homeDir: root, stateDir, claudeRoot, codexRoot, codexArchivedRoot, dshRoot,
    getSettings: () => ({ backupEnabled: false, backupIntervalHours: 24 }),
    onChange: (event) => events.push(event.type),
  });
  await archive.start();
  const all = archive.list({ pageSize: 50 });
  assert.strictEqual(all.total, 5, 'Claude, Codex, and supported DSH user sessions enter the archive');
  assert.strictEqual(all.summary.claude, 2);
  assert.strictEqual(all.summary.codex, 2);
  assert.strictEqual(all.summary.dsh, 1);
  assert.strictEqual(all.summary.desktop, 2);
  assert.strictEqual(all.summary.cli, 2);
  assert.strictEqual(all.summary.harness, 1);
  assert.strictEqual(archive.list({ provider: 'codex' }).total, 2);
  assert.strictEqual(archive.list({ provider: 'dsh' }).total, 1);
  const titledCodex = archive.list({ search: '继续 FaceAI 阶段收尾工作' }).sessions[0];
  assert.strictEqual(titledCodex.id, 'codex-desktop',
    'Codex 正式任务名进入档案搜索，而不是被最后一条 prompt 覆盖');
  assert.strictEqual(titledCodex.cwd, '/tmp/codex-desktop', '正式标题不能挤掉档案 cwd');
  assert.strictEqual(archive.list({ origin: 'harness' }).total, 1);
  assert.strictEqual(archive.list({ search: 'DeepSeek Harness' }).sessions[0].id, 'session-dsh-one');
  assert.strictEqual(archive.list({ origin: 'desktop' }).total, 2);
  assert.strictEqual(archive.list({ search: 'custom title' }).sessions[0].id, 'claude-desktop');

  const backup = await archive.backupNow();
  assert.strictEqual(backup.ok, true);
  assert.strictEqual(backup.copied, 5);
  assert.strictEqual(archive.summary().backedUp, 5);
  assert.ok(fs.existsSync(path.join(stateDir, 'session-vault', 'claude', 'claude-desktop.jsonl')));
  assert.ok(fs.existsSync(path.join(stateDir, 'session-vault', 'dsh', 'session-dsh-one.jsonl.zstd')));
  assert.ok(events.includes('backup-progress'));

  fs.unlinkSync(claudeDesktop);
  await archive.refresh();
  const missing = archive.get('claude:claude-desktop');
  assert.strictEqual(missing.sourceAvailable, false, 'metadata survives provider transcript deletion');
  assert.strictEqual(missing.backupAvailable, true, 'backup remains available after source deletion');
  assert.strictEqual(archive.list({ backup: 'backed-up' }).total, 5);
  const restored = await archive.restore('claude:claude-desktop');
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.code, 'restored');
  assert.ok(fs.existsSync(claudeDesktop), 'restore recreates the missing provider transcript');
  const preserved = fs.readFileSync(claudeDesktop, 'utf8');
  const secondRestore = await archive.restore('claude:claude-desktop');
  assert.strictEqual(secondRestore.code, 'already-present', 'restore never overwrites an existing transcript');
  assert.strictEqual(fs.readFileSync(claudeDesktop, 'utf8'), preserved);

  fs.unlinkSync(dshSession);
  await archive.refresh();
  const missingDsh = archive.get('dsh:session-dsh-one');
  assert.strictEqual(missingDsh.sourceAvailable, false);
  assert.strictEqual(missingDsh.backupAvailable, true);
  const restoredDsh = await archive.restore('dsh:session-dsh-one');
  assert.strictEqual(restoredDsh.code, 'restored');
  assert.deepStrictEqual(fs.readFileSync(dshSession), originalDshBytes,
    'compressed DSH transcript restores byte-for-byte with its .jsonl.zstd suffix');
  archive.stop();

  const sanitized = config.sanitize({ sessionArchive: { backupEnabled: true, backupIntervalHours: 72 } });
  assert.deepStrictEqual(sanitized.sessionArchive, { backupEnabled: true, backupIntervalHours: 72 });
  const invalid = config.sanitize({ sessionArchive: { backupEnabled: 'yes', backupIntervalHours: 13 } });
  assert.deepStrictEqual(invalid.sessionArchive, { backupEnabled: false, backupIntervalHours: 24 });

  const archiveRenderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archive.js'), 'utf8');
  const archiveMarkup = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archive.html'), 'utf8');
  for (const id of ['usage-provider-grid', 'usage-calendar', 'usage-token-breakdown', 'usage-diagnostics']) {
    assert.ok(archiveMarkup.includes(`id="${id}"`), `detailed workbench usage view keeps ${id}`);
  }
  for (const id of ['dashboard-todos', 'dashboard-ops', 'runtime-session-list', 'runtime-session-bg-list', 'runtime-process-list']) {
    assert.ok(archiveMarkup.includes(`id="${id}"`), `workbench preserves the old panel block ${id}`);
  }
  for (const id of ['program-skill-list', 'skill-consent-title', 'skill-privacy-note', 'program-list-count']) {
    assert.ok(archiveMarkup.includes(`id="${id}"`), `Launcher consent UI keeps ${id}`);
  }
  for (const field of ['lastOps', 'todos', 'backgroundTasksCount', 'sessionCronsCount', 'bg.items']) {
    assert.ok(archiveRenderer.includes(field), `workbench preserves old panel data ${field}`);
  }
  for (const field of ['todayByProvider', 'lifetimeByProvider', 'cacheWrite5m', 'cachedInput', 'reasoningOutput', 'codexDiagnostics']) {
    assert.ok(archiveRenderer.includes(field), `detailed usage renderer keeps ${field}`);
  }
  assert.ok(archiveRenderer.includes("data-usage-view"), 'usage dashboard can switch between 24h and calendar views');
  assert.ok(!archiveMarkup.includes('id="usage-quotas"'), 'the old 5h quota block is removed from the desktop dashboard');
  assert.ok(!archiveMarkup.includes('id="usage-budget"'), 'the old 5h budget input is removed from the desktop dashboard');
  assert.ok(!archiveRenderer.includes('window.pet.setBudget'), 'the desktop dashboard no longer writes a 5h budget');
  assert.ok(archiveRenderer.includes('window.pet.installProgramSkill'), 'Launcher installs a provider skill only after a UI action');
  assert.ok(archiveRenderer.includes('window.pet.removeProgramSkill'), 'Launcher can remove its managed provider skill');
  assert.ok(archiveMarkup.includes('data-provider="dsh"'), 'session archive exposes the DeepSeek Harness filter');
  assert.ok(archiveMarkup.includes('data-origin="harness"'), 'session archive exposes the Harness source filter');
  assert.ok(archiveRenderer.includes("dsh:'../assets/agents/dsh.svg'"), 'archive rows use the DSH asset');
  assert.ok(archiveRenderer.includes("unknownProvider: 'Unknown'"), 'unknown providers keep a neutral label');
  assert.ok(!archiveRenderer.includes("value==='codex'?'codex':'claude'"), 'unknown providers never fall back to the Claude icon');
  const dshIcon = fs.readFileSync(path.join(__dirname, '..', 'assets', 'agents', 'dsh.svg'), 'utf8');
  assert.ok(dshIcon.includes('<svg') && dshIcon.includes('#4D6BFE'), 'DSH icon is the attributed official blue SVG');
  for (const [provider, file, signature] of [['Claude', 'claude.webp', 'WEBP'], ['Codex', 'codex.png', 'PNG']]) {
    const assetPath = path.join(__dirname, '..', 'assets', 'agents', file);
    const asset = fs.readFileSync(assetPath);
    assert.ok(archiveRenderer.includes(`../assets/agents/${file}`), `archive rows use the supplied ${provider} icon`);
    if (signature === 'WEBP') {
      assert.strictEqual(asset.subarray(0, 4).toString('ascii'), 'RIFF', `${provider} icon is a WebP RIFF file`);
      assert.strictEqual(asset.subarray(8, 12).toString('ascii'), 'WEBP', `${provider} icon has a WebP signature`);
    } else {
      assert.deepStrictEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${provider} icon has a PNG signature`);
      assert.strictEqual(asset.readUInt32BE(16), 256, `${provider} icon is tightly resized to 256px`);
      assert.strictEqual(asset.readUInt32BE(20), 256, `${provider} icon is square`);
      assert.strictEqual(asset[25], 6, `${provider} icon uses RGBA rather than a baked background`);
    }
  }
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(mainSource.includes("app.on('activate', openArchive)"), 'Dock activation opens the archive');
  assert.ok(!mainSource.includes('app.dock.hide()'), 'the desktop archive remains available from the Dock');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('session archive tests passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
