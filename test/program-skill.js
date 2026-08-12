'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { installProgramSkill } = require('../backend/program-skill');

const root = path.join(__dirname, '..');
const codex = fs.readFileSync(path.join(root, '.agents', 'skills', 'register-generated-program', 'SKILL.md'), 'utf8');
const claude = fs.readFileSync(path.join(root, '.claude', 'skills', 'register-generated-program', 'SKILL.md'), 'utf8');
assert.strictEqual(claude, codex, 'Codex and Claude Code must share the same registration protocol');
assert.ok(codex.includes('Never pass `--verified` before a real launch succeeds.'));
assert.ok(codex.includes('$HOME/.octopus/bin/register-generated-program.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-program-skill-'));
const installed = installProgramSkill({ root, home });
for (const target of installed.targets) {
  assert.strictEqual(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), codex);
}
assert.ok(fs.existsSync(installed.registrar));
assert.ok(fs.existsSync(path.join(home, '.octopus', 'lib', 'program-registry.js')));
assert.strictEqual(fs.statSync(installed.registrar).mode & 0o777, 0o700);
fs.rmSync(home, { recursive: true, force: true });
console.log('program skill: ok');
