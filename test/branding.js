'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
  'scripts/package-mac.sh',
  '.github/workflows/release.yml',
];

assert.strictEqual(pkg.name, 'llmpet');
assert.strictEqual(pkg.build.productName, 'LLMPET');
assert.strictEqual(pkg.build.win.artifactName, 'LLMPET-${version}-Windows-${arch}.${ext}');
assert.strictEqual(lock.name, 'llmpet');
assert.strictEqual(lock.packages[''].name, 'llmpet');
assert(/app\.setName\('LLMPET'\)/.test(main), 'Electron app name must use the public brand');
assert(/tray\.setToolTip\('LLMPET — Claude Code 桌宠'\)/.test(main), 'tray tooltip must use LLMPET');
assert(/APP="\$DIST\/LLMPET\.app"/.test(mac), 'macOS app bundle must be named LLMPET.app');
assert(/LLMPET-\$VERSION-mac-\$ARCH\.zip/.test(mac), 'macOS archive must use the LLMPET brand');
assert(/identifier "com\.octopus\.pet"/.test(mac), 'stable designated requirement must remain for upgrade permissions');
assert(/产品名称和所有对外发布物统一使用 \*\*LLMPET\*\*/.test(readme), 'README must explain the compatibility namespace');

for (const file of publicFiles) {
  assert(!/\bOctopus\b/.test(read(file)), `${file} still exposes the retired public brand Octopus`);
}

console.log('branding checks passed');
