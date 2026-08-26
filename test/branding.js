'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const i18n = require('../shared/i18n');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const main = read('main.js');
const mac = read('scripts/package-mac.sh');
const readme = read('README.md');
const publicFiles = [
  'README.md',
  'docs/介绍.md',
  'STATES.md',
  'main.js',
  'renderer/pet.html',
  'renderer/pet.js',
  'renderer/panel.html',
  'renderer/panel.js',
  'scripts/package-mac.sh',
  '.github/workflows/release.yml',
];

assert.strictEqual(pkg.name, 'llmpet');
assert.strictEqual(pkg.build.productName, 'LLMPET');
assert.strictEqual(pkg.build.win.artifactName, 'LLMPET-${version}-Windows-${arch}.${ext}');
assert(/--publish never(?:\s|$)/.test(pkg.scripts['package:win']), 'Windows packaging must not bypass the unified Release publish job');
assert(/LLMPET \$\{GITHUB_REF_NAME#v\}/.test(read('.github/workflows/release.yml')), 'release title must follow the pushed version tag');
assert.strictEqual(lock.name, 'llmpet');
assert.strictEqual(lock.packages[''].name, 'llmpet');
assert(/APP_NAME = IS_ISOLATED_DEV_APP \? 'LLMPET Dev' : 'LLMPET'/.test(main), 'Electron app name must isolate ordinary development builds');
assert(/app\.setName\(APP_NAME\)/.test(main), 'Electron app must apply the selected public/development identity');
assert(/app\.setPath\('userData'.*APP_NAME/.test(main), 'development app must not share canonical user data');
// The tooltip moved into the i18n dictionary — assert the string itself in every
// locale rather than one hard-coded literal in main.js.
assert(/tray\.setToolTip\(t\('tray\.tooltip'\)\)/.test(main), 'tray tooltip must come from the i18n dictionary');
for (const lang of i18n.LANGS) {
  const tip = i18n.DICT[lang]['tray.tooltip'];
  assert(/LLMPET/.test(tip) && /Claude Code/.test(tip) && /Codex/.test(tip),
    `${lang} tray tooltip must use LLMPET and name both supported backends`);
}
assert(/<title>LLMPET · 详情<\/title>/.test(read('renderer/panel.html')), 'detail window title must use LLMPET');
assert(/LLMPET_NO_CODEX/.test(main) && /LLMPET_CODEX_DIR/.test(main), 'new Codex controls must use the LLMPET namespace');
assert(!/OCTOPUS_(?:NO_CODEX|CODEX_DIR)/.test(main), 'new Codex controls must not reintroduce the retired namespace');
assert(/APP="\$DIST\/LLMPET\.app"/.test(mac), 'canonical macOS app bundle must be named LLMPET.app');
assert(/APP="\$DIST\/LLMPET Dev\.app"/.test(mac), 'local development app must use an isolated bundle name');
assert(/BUNDLE_ID="com\.octopus\.pet\.dev"/.test(mac), 'local development app must use an isolated bundle id');
assert(/LLMPET-\$VERSION-mac-\$ARCH\.zip/.test(mac), 'macOS archive must use the LLMPET brand');
assert(/BUNDLE_ID="com\.octopus\.pet"/.test(mac), 'canonical bundle id must remain stable for upgrade permissions');
assert(/requirements .*BUNDLE_ID/s.test(mac), 'designated requirement must follow the selected isolated bundle id');
assert(/产品名称和所有对外发布物统一使用 \*\*LLMPET\*\*/.test(readme), 'README must explain the compatibility namespace');

for (const file of publicFiles) {
  assert(!/\bOctopus\b/.test(read(file)), `${file} still exposes the retired public brand Octopus`);
}

console.log('branding checks passed');
