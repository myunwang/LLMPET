'use strict';

// Octopus — Electron main process.
//
// Boot order: core (session state) → metering (cost) → permissions → HTTP
// server → install Claude Code hooks (using the bound port) → start watcher.
// Wiring: core/permission activity → adapter → pet:event / pet:stats pushed to
// the renderer over the preload IPC contract.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell } = require('electron');

// Give the dev app a distinct identity ("octopus") so it isn't shown as a generic
// "Electron" window and can never be confused with the abandoned "Claude小章鱼" build.
try { app.setName('octopus'); } catch {}
try { app.setAppUserModelId('com.octopus.pet'); } catch {}

const config = require('./backend/config');
const { log, LOG_PATH } = require('./backend/log');
const { createCore } = require('./backend/core');
const { createMetering } = require('./backend/metering');
const { createPricingSync } = require('./backend/pricing-sync');
const { createPermissions } = require('./backend/permission');
const { createServer } = require('./backend/server');
const adapter = require('./backend/adapter');
const hooks = require('./backend/hooks');
const { focusSession } = require('./backend/focus');
const { launchClaude } = require('./backend/launch');

const PRELOAD = path.join(__dirname, 'preload.js');
const BASE_W = 320, BASE_H = 340, TALL_H = 560, BIG_W = 440, BIG_H = 600;

let petWin = null;
let panelWin = null;
let tray = null;
let core = null;
let metering = null;
let pricingSync = null;
let permissions = null;
let server = null;
let stopWatcher = null;

let lastStats = null;
let customSize = null; // {w,h} when a popup wants the window sized to fit it
let statsTimer = null;
let emitDebounce = null;
const recentOps = []; // ring for the panel "操作流"; newest first, capped

// ── frontend config shape ─────────────────────────────────────────────────────
function frontendConfig() {
  const c = config.get();
  return {
    mode: c.mode,
    skin: c.skin,
    petPosition: c.petPosition,
    budget5h: c.budget5h,
    muted: c.muted,
    permHook: c.permHook,
  };
}

// ── window geometry ───────────────────────────────────────────────────────────
// customSize is set by the renderer to fit an open popup exactly (dynamic
// height), so a 1-row session list doesn't blow the window up to a fixed 600px.
function targetSize() {
  if (customSize) {
    return { w: Math.min(900, Math.max(BASE_W, customSize.w)), h: Math.max(BASE_H, customSize.h) };
  }
  return { w: BASE_W, h: BASE_H };
}

function applyPetSize() {
  if (!petWin || petWin.isDestroyed()) return;
  const { w } = targetSize();
  let { h } = targetSize();
  const b = petWin.getBounds();
  // Cap the window to the screen's work area so a tall popup can NEVER push the
  // pet / footer buttons off-screen — the popup scrolls internally instead.
  try {
    const wa = screen.getDisplayMatching(b).workArea;
    h = Math.min(h, wa.height);
    const cx = b.x + b.width / 2;
    const bottom = b.y + b.height;
    let x = Math.round(cx - w / 2);
    let y = Math.round(bottom - h);
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - w);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
    petWin.setBounds({ x, y, width: w, height: h });
  } catch {
    const bottom = b.y + b.height;
    petWin.setBounds({ x: b.x, y: Math.round(bottom - h), width: w, height: h });
  }
}

function createPetWindow() {
  const saved = config.get().petPosition;
  let x, y;
  if (saved) { x = saved.x; y = saved.y; }
  else {
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      x = wa.x + wa.width - BASE_W - 24;
      y = wa.y + wa.height - BASE_H - 24;
    } catch {}
  }

  petWin = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    x, y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  petWin.setAlwaysOnTop(true, 'floating');
  try { petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  hardenWindow(petWin);
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'));

  petWin.on('moved', () => {
    if (!petWin || customSize) return; // only persist the resting position (not while a popup is open)
    const b = petWin.getBounds();
    config.save({ petPosition: { x: b.x, y: b.y } });
  });
  petWin.webContents.on('did-finish-load', () => {
    sendPet('pet:config', frontendConfig());
    if (lastStats) sendPet('pet:stats', lastStats);
  });
}

function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return; }
  panelWin = new BrowserWindow({
    width: 400,
    height: 700,
    frame: false,
    transparent: false,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  hardenWindow(panelWin);
  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panelWin.webContents.on('did-finish-load', () => {
    sendPanel('panel:config', frontendConfig());
    if (lastStats) sendPanel('panel:stats', lastStats);
    if (metering) sendPanel('panel:price', metering.priceInfo());
  });
  panelWin.on('closed', () => { panelWin = null; });
}

function closePanel() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  panelWin = null;
}

// Block any navigation / new-window to external content (hardening).
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

// ── push helpers ──────────────────────────────────────────────────────────────
function sendPet(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload);
}
function sendPanel(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(channel, payload);
}

function buildStats() {
  const snapshot = core.buildSnapshot();
  const meter = metering ? metering.getStats() : null;
  return adapter.buildPetStats(snapshot, permissions.getPending(), meter, { lastOps: recentOps.slice(0, 30) });
}

// Record operation/say events into the ring the panel renders as the op stream.
function recordOp(ev) {
  if (ev.kind === 'operation') {
    recentOps.unshift({ tool: ev.tool, icon: ev.icon, detail: ev.detail, file: ev.file || '', project: ev.project || '', ts: ev.ts });
  } else if (ev.kind === 'say') {
    recentOps.unshift({ tool: 'say', icon: '💬', detail: ev.text, file: '', project: ev.project || '', ts: ev.ts });
  } else return;
  if (recentOps.length > 50) recentOps.length = 50;
}

function emitStats() {
  if (!core) return;
  lastStats = buildStats();
  sendPet('pet:stats', lastStats);
  sendPanel('panel:stats', lastStats);
}

function scheduleEmit() {
  if (emitDebounce) return;
  emitDebounce = setTimeout(() => { emitDebounce = null; emitStats(); }, 150);
}

function broadcastConfig() {
  sendPet('pet:config', frontendConfig());
  sendPanel('panel:config', frontendConfig());
}

// ── backend wiring ────────────────────────────────────────────────────────────
function bootBackend() {
  core = createCore({
    onActivity: (act) => {
      for (const ev of adapter.activityToEvents(act)) { recordOp(ev); sendPet('pet:event', ev); }
    },
    onDirty: scheduleEmit,
  });
  core.startStaleCleanup();

  metering = createMetering();
  metering.start(30000);

  // Pricing sync: fetches LiteLLM's open pricing JSON once on boot + every 24h.
  // metering.loadPricing() now reads ~/.octopus/pricing-cache.json beneath the
  // user override. Public-data only — no credentials, no API calls.
  pricingSync = createPricingSync({ onUpdate: scheduleEmit });
  pricingSync.start();

  permissions = createPermissions({
    // muted only silences sound (renderer-side); it is NOT do-not-disturb, so we
    // never auto-drop permission requests here.
    shouldDrop: () => false,
    onAdded: (entry) => {
      const lite = (() => { const s = core.getSession(entry.sessionId); return s ? toEntryLite(s) : null; })();
      let choice, kind, reason;
      if (entry.isElicitation) {
        choice = adapter.buildElicitationChoice(
          { id: entry.id, sessionId: entry.sessionId, questions: entry.questions }, lite);
        kind = 'needsinput'; reason = '回复';
      } else if (entry.toolName === 'ExitPlanMode') {
        choice = adapter.buildPlanChoice(
          { id: entry.id, sessionId: entry.sessionId, toolInput: entry.toolInput }, lite);
        kind = 'needsinput'; reason = '审方案';
      } else {
        choice = adapter.buildPermChoice(
          { id: entry.id, sessionId: entry.sessionId, toolName: entry.toolName, toolInput: entry.toolInput, suggestions: entry.suggestions }, lite);
        kind = 'waiting'; reason = '授权';
      }
      sendPet('pet:event', { kind, project: choice.project, reason, sessionId: entry.sessionId, choice, ts: Date.now() });
      scheduleEmit();
    },
    onChange: scheduleEmit,
  });

  server = createServer({
    core,
    permissions,
    shouldDropForDnd: () => false,
  });
  server.start();

  // Install hooks once the server has a port (defer so listen wins the race).
  // OCTOPUS_NO_HOOKS=1 skips touching ~/.claude/settings.json (dev/verify mode).
  setTimeout(() => {
    if (process.env.OCTOPUS_NO_HOOKS === '1') {
      log('main', 'OCTOPUS_NO_HOOKS=1 — skipping Claude Code hook install');
      return;
    }
    const port = server.getPort();
    if (port) {
      hooks.install(port);
      stopWatcher = hooks.startWatcher(() => server.getPort());
    } else {
      log('main', 'server has no port — hooks not installed (ports busy?)');
    }
  }, 400);

  // Periodic refresh so idle→sleeping transitions + cost updates reach the UI.
  statsTimer = setInterval(emitStats, 4000);
  if (statsTimer.unref) statsTimer.unref();
}

// minimal entry shape for adapter.projectName()
function toEntryLite(s) {
  return { id: s.id, cwd: s.cwd, sessionTitle: s.sessionTitle };
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('get-config', () => frontendConfig());
  ipcMain.handle('get-stats', () => lastStats || buildStats());
  ipcMain.handle('get-win-pos', () => {
    if (!petWin || petWin.isDestroyed()) return [0, 0];
    const b = petWin.getBounds();
    return [b.x, b.y];
  });

  ipcMain.on('set-win-pos', (_e, x, y) => {
    if (petWin && !petWin.isDestroyed() && Number.isFinite(x) && Number.isFinite(y)) {
      const b = petWin.getBounds();
      petWin.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
    }
  });

  ipcMain.on('open-panel', openPanel);
  ipcMain.on('close-panel', closePanel);

  ipcMain.on('set-mode', (_e, mode) => {
    config.save({ mode });
    if (mode === 'panel') openPanel();
    else if (mode === 'pet' && petWin) petWin.show();
    else if (mode === 'menubar' && petWin) petWin.hide();
    broadcastConfig();
  });
  ipcMain.on('set-skin', (_e, skin) => { config.save({ skin }); broadcastConfig(); });
  ipcMain.on('set-budget', (_e, v) => { config.save({ budget5h: Number(v) || 0 }); broadcastConfig(); });
  ipcMain.on('toggle-mute', () => { config.save({ muted: !config.get().muted }); broadcastConfig(); refreshTrayMenu(); });

  ipcMain.on('quit-app', () => app.quit());

  ipcMain.on('launch-claude', () => {
    launchClaude({}).then((r) => {
      if (!r.ok) log('main', 'launch claude failed:', r.message);
    }).catch((e) => log('main', 'launch claude error:', e.message));
  });

  ipcMain.on('permission-decide', (_e, permId, behavior) => {
    permissions.decide(permId, behavior);
  });
  ipcMain.on('focus-session', (_e, sessionId) => {
    focusSession(core.getSession(sessionId));
  });

  // Left-click primary action for the NON-pending case (pending is decided in
  // the renderer, which tracks what the user already answered). Backend owns
  // this because only it knows pid liveness / headless / platform:
  //   • a focusable session exists  → focus the most relevant one
  //   • sessions exist but none focusable (no pid / closed / non-mac) → open panel
  //   • no sessions at all → launch a fresh CLI
  ipcMain.on('primary-action', async () => {
    const all = core ? [...core.sessions.values()] : [];
    if (!all.length) { launchClaude({}).catch(() => {}); return; }
    const focusables = all
      .filter((s) => !s.headless && s.sourcePid)
      .sort((a, b) => {
        const sa = a.state === 'sleeping' ? 1 : 0;
        const sb = b.state === 'sleeping' ? 1 : 0;
        if (sa !== sb) return sa - sb;            // awake sessions first
        return (b.updatedAt || 0) - (a.updatedAt || 0); // then most recent
      });
    for (const s of focusables) {
      // eslint-disable-next-line no-await-in-loop
      if (await focusSession(s)) return;          // focused a real window → done
    }
    openPanel();                                  // have sessions but can't focus → panel
  });

  // Dynamic sizing: renderer measures the open popup and asks for an exact fit.
  // w/h <= 0 resets to the base pet size.
  ipcMain.on('set-pet-size', (_e, w, h) => {
    customSize = (Number(w) > 0 && Number(h) > 0) ? { w: Number(w), h: Number(h) } : null;
    applyPetSize();
  });
  // Back-compat coarse toggles (renderer now prefers set-pet-size).
  ipcMain.on('pet-tall', (_e, on) => { customSize = on ? { w: BASE_W, h: TALL_H } : null; applyPetSize(); });
  ipcMain.on('pet-big', (_e, on) => { customSize = on ? { w: BIG_W, h: BIG_H } : null; applyPetSize(); });
  ipcMain.on('pet-focus', () => { if (petWin) { petWin.setFocusable(true); petWin.focus(); } });
  ipcMain.on('pet-blur', () => { if (petWin) { petWin.blur(); } });

  // Click-through: the renderer hit-tests the cursor and toggles this so the
  // transparent parts of the pet window let clicks reach apps behind it.
  // forward:true keeps mousemove flowing to the renderer while ignoring, so it
  // can re-enable clicks the moment the cursor returns to the pet/content.
  ipcMain.on('set-ignore-mouse', (_e, ignore) => {
    if (petWin && !petWin.isDestroyed()) {
      try { petWin.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {}
    }
  });

  ipcMain.on('open-log', () => { shell.openPath(LOG_PATH); });
  ipcMain.on('pet-log', (_e, tag, msg) => { log('ui:' + String(tag || ''), String(msg || '')); });
}

// ── tray ──────────────────────────────────────────────────────────────────────
function buildTray() {
  let img;
  try {
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    if (process.platform === 'darwin') img.setTemplateImage(true);
  } catch {}
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip('Octopus — Claude Code 桌宠');
  refreshTrayMenu();
  tray.on('click', () => { if (petWin) petWin.isVisible() ? petWin.show() : petWin.show(); });
}

function refreshTrayMenu() {
  if (!tray) return;
  const muted = config.get().muted;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '📊 详情面板', click: openPanel },
    { label: '🐙 显示桌宠', click: () => petWin && petWin.show() },
    { type: 'separator' },
    { label: muted ? '🔔 取消静音' : '🔇 静音', click: () => { config.save({ muted: !muted }); broadcastConfig(); refreshTrayMenu(); } },
    { label: '🚀 唤起 Claude', click: () => launchClaude({}).catch(() => {}) },
    { label: '📄 打开日志', click: () => shell.openPath(LOG_PATH) },
    { type: 'separator' },
    { label: '🧹 卸载 Claude 钩子', click: () => hooks.uninstall() },
    { label: '⏻ 退出', click: () => app.quit() },
  ]));
}

// One-time migration from the app's earlier name: move ~/.llmpet → ~/.octopus
// (preserves usage history + config). Octopus lives entirely under ~/.octopus.
function migrateState() {
  try {
    const oct = path.join(os.homedir(), '.octopus');
    const old = path.join(os.homedir(), '.llmpet');
    if (!fs.existsSync(oct) && fs.existsSync(old)) {
      fs.renameSync(old, oct);
      log('main', 'migrated ~/.llmpet → ~/.octopus');
    }
  } catch (e) { log('main', 'state migrate skipped:', e.message); }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  migrateState();
  registerIpc();
  bootBackend();
  createPetWindow();
  try { buildTray(); } catch (e) { log('main', 'tray unavailable:', e.message); }
  log('main', 'Octopus ready');
});

app.on('window-all-closed', () => { /* tray app: stay alive */ });

app.on('before-quit', () => {
  try { if (stopWatcher) stopWatcher(); } catch {}
  try { if (permissions) permissions.cleanup(); } catch {}
  try { if (server) server.stop(); } catch {}
  try { if (metering) metering.stop(); } catch {}
  try { if (pricingSync) pricingSync.stop(); } catch {}
  try { if (core) core.stopStaleCleanup(); } catch {}
  log('main', 'Octopus quit');
});
