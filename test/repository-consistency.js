'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const rootLock = lock.packages && lock.packages[''];
assert(rootLock, 'package-lock root package missing');
assert.deepStrictEqual(rootLock.dependencies || {}, pkg.dependencies || {}, 'dependencies differ from package-lock');
assert.deepStrictEqual(rootLock.devDependencies || {}, pkg.devDependencies || {}, 'devDependencies differ from package-lock');

for (const script of ['package:mac', 'package:linux', 'package:win', 'dist:linux', 'dist:win', 'dist:mac', 'test:core', 'test:windows']) {
  assert.strictEqual(typeof pkg.scripts[script], 'string', `missing npm script ${script}`);
}
for (const asset of ['assets/icon-256.png', 'assets/mascot-icon.png', 'WINDOWS.md', 'CODEWHALE.md']) {
  assert(fs.existsSync(path.join(ROOT, asset)), `missing ${asset}`);
}
for (const script of ['scripts/package-mac.sh', 'scripts/package-linux.sh', 'scripts/package-win.sh']) {
  const r = spawnSync('bash', ['-n', script], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${script}: ${r.stderr}`);
}
const macPack = fs.readFileSync(path.join(ROOT, 'scripts/package-mac.sh'), 'utf8');
const linuxPack = fs.readFileSync(path.join(ROOT, 'scripts/package-linux.sh'), 'utf8');
const winPack = fs.readFileSync(path.join(ROOT, 'scripts/package-win.sh'), 'utf8');
for (const [name, src] of [['mac', macPack], ['linux', linuxPack], ['win', winPack]]) {
  assert(/for item in [^\n]*providers/.test(src), `${name} package manifest omits providers/`);
}
assert(winPack.includes('package-lock.json'), 'Windows package omits package-lock.json');
assert(/npm ci --omit=dev[^\n]*--prefix/.test(winPack), 'Windows package omits production npm dependencies');
assert(!/start "" Octopus\.exe --no-sandbox/.test(winPack), 'Windows launcher disables sandbox by default');
assert(!/exec "\$DIR\/electron" --no-sandbox/.test(linuxPack), 'Linux launcher disables sandbox by default');
assert(winPack.includes('OCTOPUS_DISABLE_CHROMIUM_SANDBOX'), 'Windows package lacks explicit sandbox diagnostic opt-out');
assert(linuxPack.includes('OCTOPUS_DISABLE_CHROMIUM_SANDBOX'), 'Linux package lacks explicit sandbox diagnostic opt-out');
assert(winPack.includes('ELECTRON_RUN_AS_NODE=1'), 'Windows hook uninstaller does not execute in Node mode');
for (const doc of ['SECURITY.md', 'AUDIT_REPORT.md', 'DEEP_AUDIT_REPORT.md', 'WINDOWS-INSTALL.md']) {
  // These are generated as part of the audited source release.
  if (fs.existsSync(path.join(ROOT, doc))) assert(fs.statSync(path.join(ROOT, doc)).size > 0, `${doc} is empty`);
}
console.log('repository-consistency: ok');
