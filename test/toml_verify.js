'use strict';
const fs = require('fs');
const path = require('path');
const codewhale = require('../providers/codewhale');
const tomlHooks = require('../backend/toml-hooks');

const TMPDIR = '/tmp/toml-verify';
fs.mkdirSync(TMPDIR, { recursive: true });

const testFile = path.join(TMPDIR, 'config.toml');
const sample = '# Sample config\nprovider = "deepseek"\n\n[hooks]\nenabled = true\ndefault_timeout_secs = 30\n\n[[hooks.hooks]]\nevent = "message_submit"\ncommand = "echo hello"\ntimeout_secs = 2\ncontinue_on_error = true\n\n[[hooks.hooks]]\nevent = "turn_end"\ncommand = "echo done"\ntimeout_secs = 2\n\n[model]\nname = "test"\n';
fs.writeFileSync(testFile, sample, 'utf8');
codewhale.dirs.settingsFile = testFile;

// Verify input bytes
function countBrackets(filePath) {
  const s = fs.readFileSync(filePath, 'utf8');
  return { d: (s.match(/\[\[/g) || []).length, s: (s.match(/\[(?!\[)/g) || []).length };
}

const bBefore = countBrackets(testFile);
process.stderr.write(`BEFORE: [[=${bBefore.d} [=${bBefore.s}\n`);

const r1 = tomlHooks.registerHooks();
process.stderr.write(`Install: ${JSON.stringify(r1)}\n`);

const bAfter = countBrackets(testFile);
process.stderr.write(`AFTER: [[=${bAfter.d} [=${bAfter.s}\n`);
process.stderr.write(`markerPresent: ${tomlHooks.markerPresent()}\n`);
process.stderr.write(`echo hello preserved: ${fs.readFileSync(testFile,'utf8').includes('echo hello')}\n`);
process.stderr.write(`echo done preserved: ${fs.readFileSync(testFile,'utf8').includes('echo done')}\n`);
process.stderr.write(`model preserved: ${fs.readFileSync(testFile,'utf8').includes('[model]')}\n`);

const ourCount = fs.readFileSync(testFile,'utf8').split('\n').filter(l=>l.includes('codewhale-hook')).length;
process.stderr.write(`Our lines: ${ourCount}\n`);

const r2 = tomlHooks.registerHooks();
process.stderr.write(`Reinstall: ${JSON.stringify(r2)}\n`);
const ourCount2 = fs.readFileSync(testFile,'utf8').split('\n').filter(l=>l.includes('codewhale-hook')).length;
process.stderr.write(`After reinstall our lines: ${ourCount2}\n`);

const r3 = tomlHooks.unregisterHooks({backup:false});
process.stderr.write(`Uninstall: ${JSON.stringify(r3)}\n`);
process.stderr.write(`After uninstall marker: ${tomlHooks.markerPresent()}\n`);
const finalOur = fs.readFileSync(testFile,'utf8').split('\n').filter(l=>l.includes('codewhale-hook')).length;
process.stderr.write(`Final our lines: ${finalOur}\n`);

const bFinal = countBrackets(testFile);
process.stderr.write(`FINAL: [[=${bFinal.d} [=${bFinal.s}\n`);
process.stderr.write(`FINAL echo hello: ${fs.readFileSync(testFile,'utf8').includes('echo hello')}\n`);
process.stderr.write(`FINAL echo done: ${fs.readFileSync(testFile,'utf8').includes('echo done')}\n`);
process.stderr.write(`FINAL model: ${fs.readFileSync(testFile,'utf8').includes('[model]')}\n`);

// Idempotency: after install + uninstall, file should be byte-identical to
// original sample. Verify bracket counts match (bBefore == bFinal) AND user
// content (echo hello/done, [model]) preserved AND our marker fully gone.
const ok = bBefore.d===bFinal.d && bBefore.s===bFinal.s && ourCount===8 && ourCount2===8 && finalOur===0 && !tomlHooks.markerPresent() && fs.readFileSync(testFile,'utf8').includes('echo hello');
process.stderr.write(ok ? '\nALL TESTS PASS\n' : '\nSOME TESTS FAIL\n');

fs.rmSync(TMPDIR, {recursive:true});