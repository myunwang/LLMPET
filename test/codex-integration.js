'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const main = read('main.js');
const preload = read('preload.js');
const config = read('backend/config.js');
const server = read('backend/server.js');
const hook = read('hook/octopus-hook.js');
const readme = read('README.md');

assert(fs.existsSync(path.join(root, 'backend/codex-watch.js')), 'Codex watcher must ship with the app');
assert(fs.existsSync(path.join(root, 'backend/codex-hookinstall.js')), 'Codex hook installer must ship with the app');
assert(fs.existsSync(path.join(root, 'backend/codex-rate-limits.js')), 'Codex App Server quota reader must ship with the app');
assert(fs.existsSync(path.join(root, 'test/codex-watch.js')), 'Codex watcher regression tests must remain in the suite');
assert(/require\('\.\/backend\/codex-watch'\)/.test(main), 'main process must load the Codex watcher');
assert(/codexWatch\s*=\s*createCodexWatch\(/.test(main), 'main process must create the Codex watcher');
assert(/codexWatch\.start\(\)/.test(main), 'main process must start the Codex watcher');
assert(/codexRateLimitClient\.start\(\)/.test(main), 'main process must start the Codex quota reader');
assert(/if \(codexWatch\) codexWatch\.stop\(\)/.test(main), 'app shutdown must stop the Codex watcher');
assert(/data\.agent_id === 'codex' \? 'codex' : 'claude-code'/.test(server), 'Codex hook events must retain their agent identity');
assert(/body\.event_source = 'codex-hook'/.test(hook), 'Codex hook events must identify their source for deduplication');
assert(/function sendPetEvent\(ev\)/.test(main) && /ev\.agent === 'codex'/.test(main), 'Codex events must route to the Codex pet in duo mode');
assert(/function createPetWindows\(\)/.test(main) && /makePetWindow\('codex'\)/.test(main), 'duo mode must create an independent Codex pet');
assert(/petMode: 'single'/.test(config) && /skinCodex: 'cat'/.test(config), 'Codex pet settings must have safe defaults');
assert(/codexChipMode: 'usage'/.test(config), 'Codex brown stats box must preserve the existing default');
assert(/launchCodex: \(\) => ipcRenderer\.send\('launch-codex'\)/.test(preload), 'renderer must be able to launch Codex');
assert(/closePet: \(\) => ipcRenderer\.send\('close-pet'\)/.test(preload), 'a duo pet must be independently closable');
assert(/Claude Code \/ Codex/.test(readme) && /Codex 后端/.test(readme), 'public documentation must describe Codex support');
assert(pkg.scripts.test.includes('test/codex-watch.js'), 'npm test must execute Codex watcher tests');
assert(pkg.scripts.test.includes('test/codex-hooks.js'), 'npm test must execute Codex hook tests');
assert(pkg.scripts.test.includes('test/codex-rate-limits.js'), 'npm test must execute Codex rate-limit tests');
assert(pkg.scripts.test.includes('test/codex-integration.js'), 'npm test must execute the Codex integration contract');

console.log('codex integration checks passed');
