'use strict';

// Real desktop regression for runtime upgrades. Run separately from the
// headless suite: npm run test:electron (requires a graphical session).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-runtime-'));
const originalHomedir = os.homedir;
os.homedir = () => root;
app.setPath('userData', path.join(root, 'electron'));
app.setPath('sessionData', path.join(root, 'electron'));
process.env.OCTOPUS_NO_HOOKS = '1';
process.env.OCTOPUS_NO_NET = '1';
process.env.OCTOPUS_ALLOW_MULTI = '1';
process.env.LLMPET_NO_CODEX = '1';
process.env.LLMPET_NO_DSH = '1';
fs.mkdirSync(path.join(root, '.octopus'), { recursive: true });
fs.writeFileSync(path.join(root, '.octopus', 'config.json'), JSON.stringify({
  muted: true,
  agentStartup: { claude: false, codex: false, dsh: false },
}));
const failures = [];
const output = process.env.LLMPET_SMOKE_OUTPUT;
if (output) fs.mkdirSync(output, { recursive: true });

app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => failures.push(error.message));
  contents.on('render-process-gone', (_event, details) => failures.push(`renderer: ${details.reason}`));
  contents.on('console-message', (details) => {
    if (details.level === 'error') failures.push(`${details.sourceId}:${details.lineNumber}: ${details.message}`);
  });
  contents.on('did-fail-load', (_event, code, description) => failures.push(`load ${code}: ${description}`));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function windowFor(file) {
  return until(async () => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(`/${file}`));
    if (!win || win.webContents.isLoadingMainFrame()) return null;
    return await win.webContents.executeJavaScript('document.readyState === "complete" && !!window.pet') ? win : null;
  }, `${file} and preload`);
}

function request(runtime, route, body, authenticated = true) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: runtime.port, path: route,
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(authenticated ? { 'x-octopus-token': runtime.token } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(15000, () => req.destroy(new Error(`HTTP timeout: ${route.split('?')[0]}`)));
    req.on('error', reject);
    req.end(payload);
  });
}

async function capture(win, name) {
  const screenshot = await until(async () => {
    try { return await win.webContents.capturePage(); } catch (error) {
      if (error.message !== 'UnknownVizError') throw error;
      return null; // The compositor may not have submitted its first frame yet.
    }
  }, `${name} compositor frame`);
  assert(!screenshot.isEmpty(), `${name} must render pixels`);
  if (output) fs.writeFileSync(path.join(output, `${name}.png`), screenshot.toPNG());
  return screenshot;
}

require('../main');

const watchdog = setTimeout(() => {
  console.error('Electron runtime smoke test exceeded 60 seconds');
  app.exit(1);
}, 60000);

async function run() {
  await app.whenReady();
  const pet = await windowFor('pet.html');
  const transport = require('../backend/transport');
  const runtime = await until(() => transport.readRuntimeConfig(), 'local server');
  assert.strictEqual((await request(runtime, '/state')).status, 200);
  assert(pet.isVisible(), 'pet is visible');
  assert(pet.isAlwaysOnTop(), 'pet stays above other windows');
  assert.strictEqual(await pet.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.strictEqual((await pet.webContents.executeJavaScript('window.pet.getConfig()')).lang, 'zh');
  assert.strictEqual((await pet.webContents.executeJavaScript('window.pet.getConfig()')).skin, 'deepseek-maid');
  await until(() => pet.webContents.executeJavaScript(`
    document.body.classList.contains('skin-deepseek-maid') &&
    document.getElementById('cat-img').src.includes('/assets/deepseek-maid/') &&
    document.getElementById('cat-img').naturalWidth === 360
  `), 'default DeepSeek maid image decoded');
  const sessionId = 'electron-runtime-smoke';
  const state = (extra) => ({ session_id: sessionId, cwd: root, ...extra });
  assert.strictEqual((await request(runtime, '/state', state({ state: 'working', event: 'PreToolUse' }), false)).status, 403);
  assert.strictEqual((await request(runtime, '/state', state({ state: 'working', event: 'PreToolUse', tool_name: 'Read' }))).status, 200);
  await until(async () => (await pet.webContents.executeJavaScript('window.pet.getStats()')).sessions
    .some((s) => s.sessionId === sessionId && s.state === 'working'), 'HTTP state through IPC');

  for (const behavior of ['allow', 'deny']) {
    const decision = request(runtime, `/permission?token=${runtime.token}`, {
      session_id: sessionId, tool_name: 'Read', tool_input: { file_path: path.join(root, 'fixture.txt') },
    });
    // Attach a rejection handler immediately while the blocking request waits.
    decision.catch(() => {});
    const choice = await until(async () => {
      const stats = await pet.webContents.executeJavaScript('window.pet.getStats()');
      return stats.sessions.find((s) => s.sessionId === sessionId)?.choice;
    }, `${behavior} permission card`);
    await until(() => pet.webContents.executeJavaScript('!document.getElementById("ask").classList.contains("hidden")'), 'visible permission UI');
    if (behavior === 'allow') await capture(pet, 'permission');
    await pet.webContents.executeJavaScript(`window.pet.decidePermission(${JSON.stringify(choice.permId)}, ${JSON.stringify(behavior)})`);
    const reply = await decision;
    assert.strictEqual(reply.status, 200);
    assert.strictEqual(JSON.parse(reply.body).hookSpecificOutput.decision.behavior, behavior);
    await until(async () => !(await pet.webContents.executeJavaScript('window.pet.getStats()')).sessions
      .find((s) => s.sessionId === sessionId)?.choice, 'permission removed');
  }

  await request(runtime, '/state', state({ state: 'attention', event: 'Stop', assistant_last_output: 'Electron runtime smoke passed' }));
  await until(() => pet.webContents.executeJavaScript('document.getElementById("bubble-text").textContent.includes("Electron runtime smoke passed")'), 'completion bubble');
  const pixels = (await capture(pet, 'pet')).toBitmap();
  assert(pixels.some((value, index) => index % 4 === 3 && value === 0), 'pet retains transparent pixels');
  await pet.webContents.executeJavaScript('window.pet.openPanel()');
  const panel = await windowFor('panel.html');
  assert(Array.isArray((await panel.webContents.executeJavaScript('window.pet.getStats()')).sessions));
  await capture(panel, 'panel');
  await pet.webContents.executeJavaScript('window.pet.openSessionArchive()');
  const archive = await windowFor('archive.html');
  assert(Array.isArray((await archive.webContents.executeJavaScript('window.pet.getSessionArchive({})')).sessions));
  // The detail pane replaces its initial markup after loading. Subsequent
  // config pushes and sidebar toggles must still relabel it without null refs.
  await until(() => archive.webContents.executeJavaScript('loadedOnce'), 'archive initial scan');
  archive.webContents.send('archive:config', { lang: 'en' });
  await until(() => archive.webContents.executeJavaScript('document.documentElement.lang === "en"'), 'archive language update');
  await archive.webContents.executeJavaScript('document.getElementById("sidebar-toggle").click()');
  archive.webContents.send('archive:config', { lang: 'zh' });
  await until(() => archive.webContents.executeJavaScript('document.documentElement.lang === "zh-CN"'), 'archive language restored');
  await capture(archive, 'archive');
  assert.deepStrictEqual(failures, [], 'no renderer, preload or load errors');
  const report = {
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch,
    checks: ['default DeepSeek maid', 'transparent pet', 'preload/IPC', 'HTTP authentication', 'allow/deny round-trip', 'completion bubble', 'panel', 'archive'],
  };
  if (output) fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify(report, null, 2));
  console.log('Electron runtime smoke passed:', JSON.stringify(report));
}

run().then(() => finish(0), (error) => { console.error(error); finish(1); });

function finish(code) {
  clearTimeout(watchdog);
  process.exitCode = code;
  app.once('will-quit', () => {
    os.homedir = originalHomedir;
    // Only remove the mkdtemp directory created above. Windows can retain
    // Chromium handles briefly; cleanup failure must not hide test failures.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    app.exit(code);
  });
  app.quit();
}
