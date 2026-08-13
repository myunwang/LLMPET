'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createProgramSkillManager } = require('../backend/program-skill');

const root = path.join(__dirname, '..');
const codex = fs.readFileSync(path.join(root, '.agents', 'skills', 'register-generated-program', 'SKILL.md'), 'utf8');
const claude = fs.readFileSync(path.join(root, '.claude', 'skills', 'register-generated-program', 'SKILL.md'), 'utf8');
assert.notStrictEqual(claude, codex, 'each provider must have a dedicated skill');
assert.match(codex, /--provider codex/);
assert.doesNotMatch(codex, /--provider claude/);
assert.match(claude, /--provider claude/);
assert.doesNotMatch(claude, /--provider codex/);
assert.ok(codex.includes('Never pass `--verified` before a real launch succeeds.'));
assert.ok(claude.includes('Never pass `--verified` before a real launch succeeds.'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-program-skill-'));
const manager = createProgramSkillManager({ root, home });
assert.deepStrictEqual(manager.status().map((x) => x.state), ['not-installed', 'not-installed']);
assert.ok(!fs.existsSync(path.join(home, '.agents')), 'status checks must not mutate the user home');

const codexInstall = manager.install('codex');
assert.strictEqual(codexInstall.ok, true);
assert.strictEqual(manager.statusFor('codex').state, 'installed');
assert.strictEqual(manager.statusFor('claude').state, 'not-installed');
assert.strictEqual(fs.readFileSync(path.join(home, '.agents', 'skills', 'register-generated-program', 'SKILL.md'), 'utf8'), codex);
assert.ok(!fs.existsSync(path.join(home, '.claude')), 'granting Codex must not grant Claude Code');
assert.ok(fs.existsSync(codexInstall.registrar));
// Windows reports synthetic POSIX mode bits (commonly 0666) even after chmod;
// executable owner-only permissions are meaningful and observable only on
// POSIX filesystems. The existence/content checks above still cover Windows.
if (process.platform !== 'win32') {
  assert.strictEqual(fs.statSync(codexInstall.registrar).mode & 0o777, 0o700);
}

const claudeInstall = manager.install('claude');
assert.strictEqual(claudeInstall.ok, true);
assert.strictEqual(fs.readFileSync(path.join(home, '.claude', 'skills', 'register-generated-program', 'SKILL.md'), 'utf8'), claude);

assert.strictEqual(manager.remove('codex').ok, true);
assert.strictEqual(manager.statusFor('codex').state, 'not-installed');
assert.strictEqual(manager.statusFor('claude').state, 'installed');

const customHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-program-skill-conflict-'));
const customTarget = path.join(customHome, '.agents', 'skills', 'register-generated-program', 'SKILL.md');
fs.mkdirSync(path.dirname(customTarget), { recursive: true });
fs.writeFileSync(customTarget, 'user-owned skill\n');
const customManager = createProgramSkillManager({ root, home: customHome });
assert.strictEqual(customManager.statusFor('codex').state, 'conflict');
assert.deepStrictEqual(customManager.install('codex').ok, false);
assert.strictEqual(customManager.remove('codex').ok, false);
assert.strictEqual(fs.readFileSync(customTarget, 'utf8'), 'user-owned skill\n', 'foreign skill must never be overwritten or removed');

const metadataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-program-skill-metadata-'));
const metadataTarget = path.join(metadataHome, '.agents', 'skills', 'register-generated-program');
fs.mkdirSync(path.join(metadataTarget, 'agents'), { recursive: true });
fs.writeFileSync(path.join(metadataTarget, 'SKILL.md'), codex);
fs.writeFileSync(path.join(metadataTarget, 'agents', 'openai.yaml'), 'user-owned metadata\n');
const metadataManager = createProgramSkillManager({ root, home: metadataHome });
assert.strictEqual(metadataManager.statusFor('codex').state, 'conflict');
assert.strictEqual(metadataManager.install('codex').ok, false);
assert.strictEqual(fs.readFileSync(path.join(metadataTarget, 'agents', 'openai.yaml'), 'utf8'), 'user-owned metadata\n');

const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-program-skill-legacy-'));
// A fixture matching the exact old managed bytes exercises the upgrade path
// without granting ownership of arbitrary same-name skills.
const legacyBody = `---\nname: register-generated-program\ndescription: Register a project in LLMPET's generated-program launcher after Codex or Claude Code has created or modified something the user can run. Use when a website, app, demo, server, CLI, or other executable deliverable has passed a real launch check. Do not register source-only libraries, incomplete scaffolds, build-only outputs, or anything that has not actually launched successfully.\n---\n\n# Register Generated Program\n\nAdd a shortcut to LLMPET only after proving the deliverable really runs.\n\n## Workflow\n\n1. Identify the user-facing launch path. Prefer the same command or file a user should run later.\n2. Run it in the real target environment. A compile, lint, or unit test alone is not a launch check.\n3. Confirm observable startup success. If startup fails or remains unverified, do not register it.\n4. Run exactly one registration form using LLMPET's user-level registrar (LLMPET installs it on startup):\n\n\`\`\`sh\nnode \"$HOME/.octopus/bin/register-generated-program.js\" --verified \\\n  --name \"Program name\" \\\n  --description \"What the shortcut opens\" \\\n  --cwd \"/absolute/project/path\" \\\n  --command \"npm\" --arg \"run\" --arg \"dev\" \\\n  --provider codex\n\`\`\`\n\nFor an app bundle or directly openable file:\n\n\`\`\`sh\nnode \"$HOME/.octopus/bin/register-generated-program.js\" --verified \\\n  --name \"Program name\" \\\n  --cwd \"/absolute/project/path\" \\\n  --open \"/absolute/project/path/Program.app\" \\\n  --provider claude\n\`\`\`\n\n5. Use \`codex\` or \`claude\` for \`--provider\` according to the agent that produced the runnable result. Add \`--icon /absolute/path\` only when a suitable local icon already exists.\n6. Check that the command prints JSON with \`\"ok\": true\`. Report the shortcut as registered only after that output.\n\n## Boundaries\n\n- Use absolute paths.\n- If the registrar is missing, start LLMPET once. Do not recreate its registry format manually.\n- Pass executable arguments as repeated \`--arg\` values. Do not join a shell pipeline into \`--command\`.\n- Register the canonical project once; rerunning with the same path and launch command updates the existing shortcut.\n- Never pass \`--verified\` before a real launch succeeds.\n- Registration changes only LLMPET's local shortcut index. It does not copy, deploy, publish, or delete the project.\n`;
for (const base of ['.agents', '.claude']) {
  const target = path.join(legacyHome, base, 'skills', 'register-generated-program', 'SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, legacyBody);
}
const legacyManager = createProgramSkillManager({ root, home: legacyHome });
assert.deepStrictEqual(legacyManager.status().map((x) => x.state), ['update-available', 'update-available']);
assert.strictEqual(legacyManager.install('codex').code, 'updated');
assert.strictEqual(legacyManager.install('claude').code, 'updated');
assert.deepStrictEqual(legacyManager.status().map((x) => x.state), ['installed', 'installed']);

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(customHome, { recursive: true, force: true });
fs.rmSync(metadataHome, { recursive: true, force: true });
fs.rmSync(legacyHome, { recursive: true, force: true });
console.log('program skill consent: ok');
