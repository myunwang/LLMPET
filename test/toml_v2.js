'use strict';
const fs = require('fs');
const path = require('path');
const codewhale = require('../providers/codewhale');
const tomlHooks = require('../backend/toml-hooks');

const TMPDIR = '/tmp/toml-v2-' + process.pid;
fs.mkdirSync(TMPDIR, { recursive: true });

const testFile = path.join(TMPDIR, 'config.toml');
const sample = '# Sample config\nprovider = "deepseek"\n\n[hooks]\nenabled = true\ndefault_timeout_secs = 30\n\n[[hooks.hooks]]\nevent = "message_submit"\ncommand = "echo hello"\ntimeout_secs = 2\ncontinue_on_error = true\n\n[[hooks.hooks]]\nevent = "turn_end"\ncommand = "echo done"\ntimeout_secs = 2\n\n[model]\nname = "test"\n';
fs.writeFileSync(testFile, sample, 'utf8');
codewhale.dirs.settingsFile = testFile;

function countBrackets(filePath) {
  const s = fs.readFileSync(filePath, 'utf8');
  return { d: (s.match(/\[\[/g) || []).length, s: (s.match(/\[(?!\[)/g) || []).length };
}

const b0 = countBrackets(testFile);
process.stderr.write('BEFORE: [[' + b0.d + '] [' + b0.s + ']\n');

const r1 = tomlHooks.registerHooks();
process.stderr.write('Install: ' + JSON.stringify(r1) + '\n');

const b1 = countBrackets(testFile);
const our1 = fs.readFileSync(testFile,'utf8').split('\n').filter(l=>l.includes('codewhale-hook')).length;
process.stderr.write('AFTER: [[' + b1.d + '] [' + b1.s + '] ourLines=' + our1 + ' marker=' + tomlHooks.markerPresent() + '\n');
process.stderr.write('  echo hello preserved: ' + fs.readFileSync(testFile,'utf8').includes('echo hello') + '\n');
process.stderr.write('  echo done preserved: ' + fs.readFileSync(testFile,'utf8').includes('echo done') + '\n');
process.stderr.write('  [model] preserved: ' + fs.readFileSync(testFile,'utf8').includes('[model]') + '\n');

const r2 = tomlHooks.registerHooks();
const our2 = fs.readFileSync(testFile,'utf8').split('\n').filter(l=>l.includes('codewhale-hook')).length;
process.stderr.write('Reinstall: ' + JSON.stringify(r2) + ' ourLines=' + our2 + '\n');

const r3 = tomlHooks.unregisterHooks({backup:false});
const our3 = fs.readFileSync(testFile,'utf8').split('\n').filter(l=>l.includes('codewhale-hook')).length;
const bF = countBrackets(testFile);
process.stderr.write('Uninstall: ' + JSON.stringify(r3) + ' ourLines=' + our3 + ' [[' + bF.d + '] [' + bF.s + ']\n');
process.stderr.write('  marker=' + tomlHooks.markerPresent() + '\n');
process.stderr.write('  echo hello: ' + fs.readFileSync(testFile,'utf8').includes('echo hello') + '\n');
process.stderr.write('  echo done: ' + fs.readFileSync(testFile,'utf8').includes('echo done') + '\n');
process.stderr.write('  [model]: ' + fs.readFileSync(testFile,'utf8').includes('[model]') + '\n');

// Idempotency: bracket counts restored after install+uninstall, our lines
// stable across reinstalls (8), fully removed after uninstall.
const ok = b0.d===bF.d && b0.s===bF.s && our1===8 && our2===8 && our3===0 && !tomlHooks.markerPresent();
process.stderr.write(ok ? '\nALL TESTS PASS\n' : '\nFAIL\n');

fs.rmSync(TMPDIR, {recursive:true});
