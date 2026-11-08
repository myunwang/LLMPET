'use strict';

// Claude 大小姐 skin: every mapped state/pool file exists, the dedicated sorry/loved
// poses are used, all three pet roles and all languages expose it, and config accepts it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadRenderer } = require('./dom-stub');
const { sanitize } = require('../backend/config');
const i18n = require('../shared/i18n');
const root = path.join(__dirname, '..');
const assetDir = path.join(root, 'assets', 'claude-ojou');

const files = fs.readdirSync(assetDir).filter((f) => f.endsWith('.gif')).sort();
for (const f of files) {
  const b = fs.readFileSync(path.join(assetDir, f));
  assert.strictEqual(b.subarray(0, 6).toString('ascii'), 'GIF89a', `${f} is a GIF89a`);
  assert.strictEqual(b.readUInt16LE(6), 360, `${f} is 360 px wide like the maid pack`);
  assert.strictEqual(b.readUInt16LE(8), 360, `${f} is 360 px tall like the maid pack`);
}

const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'renderer/pet.js']);
const pack = vm.runInContext("MEME_PACKS['claude-ojou']", w.sandbox);
assert(pack && pack.dir === 'claude-ojou');
const mapped = new Set([...Object.values(pack.states), ...Object.values(pack.pools).flat()]);
for (const f of mapped) assert(files.includes(f), `${f} is mapped but missing from assets/claude-ojou`);
assert.deepStrictEqual([...mapped].sort(), files, 'every shipped animation is reachable and nothing extra ships');
assert.strictEqual(pack.states.sorry, 'claude-ojou-sorry.gif');
assert.strictEqual(pack.states.loved, 'claude-ojou-loved.gif');

vm.runInContext("applySkin('claude-ojou'); poolIdx = 0; updateCat('sorry')", w.sandbox);
assert.strictEqual(w.elements('cat-img').getAttribute('src'), '../assets/claude-ojou/claude-ojou-sorry.gif');
assert(w.document.body.classList.contains('skin-claude-ojou'));
assert(w.document.body.classList.contains('skin-cat'), 'renders through the shared meme branch');

for (const role of ['skin', 'skinCodex', 'skinDsh']) {
  assert.strictEqual(sanitize({ [role]: 'claude-ojou' })[role], 'claude-ojou');
}
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
for (const suffix of ['', ", 'codex'", ", 'dsh'"]) {
  assert(main.includes(`applySkin('claude-ojou'${suffix})`), 'tray exposes the skin to every pet role');
}
for (const lang of Object.keys(i18n.DICT)) {
  assert(Object.hasOwn(i18n.DICT[lang], 'skin.claude-ojou'), `${lang} needs its own label`);
}
const css = fs.readFileSync(path.join(root, 'renderer', 'pet.css'), 'utf8');
assert(css.includes('body.skin-claude-ojou #cat { width: 180px; height: 180px; }'), 'shown at the same size as the maid pack');

console.log(`claude-ojou: ${files.length} animations, every state/pool mapped, sorry/loved poses, three roles, all languages passed`);
process.exit(0);
