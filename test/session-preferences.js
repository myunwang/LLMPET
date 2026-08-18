'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sanitize } = require('../backend/config');

const cfg = sanitize({
  pinnedSessions: ['a', 'a', '', null, ' b '],
  archivedSessions: ['b', 'c', 'c', 42],
});
assert.deepStrictEqual(cfg.pinnedSessions, ['a', 'b'], 'pins are trimmed and deduplicated');
assert.deepStrictEqual(cfg.archivedSessions, ['c'], 'a pinned session cannot remain archived');

const now = Date.now();
const lootCfg = sanitize({
  lootCapturedSessions: [
    { sessionId: 'loot-a', project: 'A', agent: 'claude', state: 'working', expiresAt: now + 60_000 },
    { sessionId: 'loot-a', project: 'duplicate', expiresAt: now + 60_000 },
    { sessionId: 'expired', project: 'old', expiresAt: now - 1 },
  ],
});
assert.strictEqual(lootCfg.lootCapturedSessions.length, 1,
  'loot snapshots are deduplicated and expired entries are discarded');
assert.strictEqual(lootCfg.lootCapturedSessions[0].agent, 'codex',
  'loot snapshots are always Codex sessions');
assert.strictEqual(lootCfg.lootCapturedSessions[0].project, 'A');

const whaleCfg = sanitize({ skin: 'whale', skinCodex: 'whale', skinDsh: 'whale' });
assert.deepStrictEqual(
  [whaleCfg.skin, whaleCfg.skinCodex, whaleCfg.skinDsh],
  ['whale', 'whale', 'whale'],
  'the whale skin must survive config sanitization for every pet role',
);
assert.strictEqual(sanitize({ skin: 'unknown-skin' }).skin, 'mascot',
  'unknown skins must still fail closed to the default');

const root = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'pet.js'), 'utf8');
const markup = fs.readFileSync(path.join(root, 'renderer', 'pet.html'), 'utf8');

assert(preload.includes("ipcRenderer.send('set-session-prefs'"), 'preload must expose session preference writes');
assert(main.includes("ipcMain.on('set-session-prefs'"), 'main must persist session preferences');
for (const id of ['sl-search', 'sl-filters', 'sl-archived-toggle']) {
  assert(markup.includes(`id="${id}"`), `session manager is missing ${id}`);
}
assert(renderer.includes('pinnedSessionIds') && renderer.includes('archivedSessionIds'));
assert(main.includes('30 * 60 * 1000') && main.includes('lootCapturedSessions'),
  'captured sessions must be stored structurally for thirty minutes');
assert(main.includes("ev.phase === 'sessionCaptured'")
  && main.includes('codexWatch.seedRecent(12)')
  && main.includes('recentCodexSessions(12)'),
  'only explicitly animated real sessions may be persisted, from a bounded twelve-session queue');

console.log('session preference checks passed');
