'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const roots = ['backend', 'hook', 'providers', 'renderer', 'shared', 'test'];
const files = ['main.js', 'preload.js'];
for (const dir of roots) {
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, dir));
}
for (const file of files.sort()) {
  const r = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${file}: ${r.stderr || r.stdout}`);
}
console.log(`syntax: ok (${files.length} files)`);
