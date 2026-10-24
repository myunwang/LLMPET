'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Exercise the command without installing or launching Electron. Keep fixtures
// outside the checkout so require() cannot fall back to its real node_modules.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-electron-'));
const project = path.join(root, 'project with spaces');
const scripts = path.join(project, 'scripts');
const electron = path.join(project, 'node_modules', 'electron');
const binary = path.join(electron, 'dist', 'electron.exe');
const command = path.join(scripts, 'check-electron.js');

function check(expectedStatus, expectedMessage) {
  const result = spawnSync(process.execPath, [command], { cwd: project, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.strictEqual(result.status, expectedStatus, result.stderr);
  assert.match(result.stdout + result.stderr, expectedMessage);
  if (expectedStatus !== 0) {
    assert.match(result.stderr, /npm ci --foreground-scripts/);
    assert.match(result.stderr, /npm run install:electron/);
  }
}

try {
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'check-electron.js'), command);
  check(1, /Cannot find module 'electron\/package.json'/);

  fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '44.9.3', main: 'index.js' }));
  // Loading the newer package can download files. No diagnostic path may run it.
  fs.writeFileSync(path.join(electron, 'index.js'),
    'throw new Error("Diagnostic must not execute the Electron entry point");');
  check(1, /installation record.*missing/);

  // npm's ignore-scripts setting also skips prestart hooks. The diagnostic must
  // live in start itself so users with that setting still get recovery steps.
  if (process.env.npm_execpath) {
    const pkg = require('../package.json');
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
      name: 'llmpet-install-fixture',
      version: '1.0.0',
      scripts: { start: pkg.scripts.start },
    }));
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'start', '--ignore-scripts'], {
      cwd: project, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Electron installation is incomplete/);
    assert.match(result.stderr, /npm ci --foreground-scripts/);
  }

  fs.writeFileSync(path.join(electron, 'path.txt'), 'electron.exe');
  check(1, /ENOENT/);

  fs.mkdirSync(binary, { recursive: true });
  check(1, /not a file/);
  fs.rmdirSync(binary);

  fs.writeFileSync(binary, 'fake executable: the check must never launch this file');
  fs.writeFileSync(path.join(electron, 'dist', 'version'), '33.4.11');
  check(1, /version mismatch/);
  fs.writeFileSync(path.join(electron, 'dist', 'version'), '44.9.3');
  check(0, /Electron runtime found:/);
  console.log('Electron installation diagnostics passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
