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
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog, systemPreferences } = require('electron');

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
const { createTerritory, DEFAULT_RIVALS } = require('./backend/territory');
const { launchClaude, launchCodex } = require('./backend/launch');
const { createCodexWatch } = require('./backend/codex-watch');
const transport = require('./backend/transport');

const PRELOAD = path.join(__dirname, 'preload.js');
const BASE_W = 320, BASE_H = 340, TALL_H = 560, BIG_W = 440, BIG_H = 600;

let petWin = null;      // 主宠窗口：single 模式监控全部；duo 模式代表 Claude
let petWinCodex = null; // 双宠模式里的 Codex 宠（single 模式为 null）
let panelWin = null;
let panelH = 0; // 面板当前自适应高度（防抖用）
let tray = null;
let core = null;
let metering = null;
let pricingSync = null;
let permissions = null;
let server = null;
let stopWatcher = null;
let territory = null;
let codexWatch = null;  // Codex rollout 只读监听器
let codexLimits = null; // Codex 5h/周窗口配额（token_count 的 rate_limits）
let petGuided = false; // 领地模式在带宠物走位:期间不把程序性移动当成用户拖拽持久化
let petFrameGuided = false; // CoreGraphics 逐帧拖动期间的同步跟随

// 每个宠物窗口自己的交互状态（webContents.id → 状态）。双宠模式下气泡定高、
// 命中穿透、visualRect、「用户交互中」都是各管各的，混用会互相打架。
const petState = new Map(); // id → { agent, win, customSize, visualRect, uiBusy }
const petStates = () => [...petState.values()].filter((s) => s.win && !s.win.isDestroyed());
const stateOfSender = (sender) => petState.get(sender.id) || null;
const primaryPetState = () => (petWin && !petWin.isDestroyed() ? petState.get(petWin.webContents.id) : null);
const anyUiBusy = () => petStates().some((s) => s.uiBusy);
const primaryVisualRect = () => { const st = primaryPetState(); return st ? st.visualRect : null; };

let lastStats = null;   // 全量快照（面板用；single 模式也是主宠的快照）
let statsTimer = null;
let emitDebounce = null;
const recentOps = []; // ring for the panel "操作流"; newest first, capped

// ── frontend config shape ─────────────────────────────────────────────────────
// agent: 'all'(单宠/面板) | 'claude' | 'codex' —— 双宠模式两只宠形象/位置各一套
function frontendConfig(agent = 'all') {
  const c = config.get();
  return {
    mode: c.mode,
    skin: agent === 'codex' ? c.skinCodex : c.skin,
    petPosition: agent === 'codex' ? c.petPositionCodex : c.petPosition,
    budget5h: c.budget5h,
    muted: c.muted,
    permHook: c.permHook,
    territory: c.territory,
    // 巡视（领地模式）只由主宠负责，Codex 分身菜单里不显示
    territorySupported: process.platform === 'darwin' && agent !== 'codex',
    agent,
    petMode: c.petMode,
  };
}

// ── window geometry ───────────────────────────────────────────────────────────
// customSize is set by the renderer to fit an open popup exactly (dynamic
// height), so a 1-row session list doesn't blow the window up to a fixed 600px.
function targetSize(st) {
  const cs = st && st.customSize;
  if (cs) {
    return { w: Math.min(900, Math.max(BASE_W, cs.w)), h: Math.max(BASE_H, cs.h) };
  }
  return { w: BASE_W, h: BASE_H };
}

function applyPetSize(st) {
  if (!st || !st.win || st.win.isDestroyed()) return;
  const win = st.win;
  const { w } = targetSize(st);
  let { h } = targetSize(st);
  const b = win.getBounds();
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
    win.setBounds({ x, y, width: w, height: h });
  } catch {
    const bottom = b.y + b.height;
    win.setBounds({ x: b.x, y: Math.round(bottom - h), width: w, height: h });
  }
}

// 双宠开关：single 一只宠盯全部后端；duo Claude/Codex 各一只（形象/位置独立）
function createPetWindows() {
  const duo = config.get().petMode === 'duo';
  petWin = makePetWindow(duo ? 'claude' : 'all');
  petWinCodex = duo ? makePetWindow('codex') : null;
  log('main', `pet windows: ${duo ? 'duo (claude+codex)' : 'single (all)'}`);
}

function makePetWindow(agent) {
  const c = config.get();
  const saved = agent === 'codex' ? c.petPositionCodex : c.petPosition;
  let x, y;
  if (saved) { x = saved.x; y = saved.y; }
  else {
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      // Codex 宠默认落在主宠左边，肩并肩不重叠
      const shift = agent === 'codex' ? BASE_W + 36 : 0;
      x = wa.x + wa.width - BASE_W - 24 - shift;
      y = wa.y + wa.height - BASE_H - 24;
    } catch {}
  }

  const win = new BrowserWindow({
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
  win.setAlwaysOnTop(true, 'floating');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  hardenWindow(win);
  // ?agent= 告诉渲染端自己盯谁（名牌/图标/唤起按钮/开场白都按它分流）
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'), { query: { agent } });

  const st = { agent, win, customSize: null, visualRect: null, uiBusy: false };
  petState.set(win.webContents.id, st);
  win.on('closed', () => { petState.delete(win.webContents.id); });

  win.on('moved', () => {
    if (st.customSize) return; // only persist the resting position
    if (win === petWin && (petGuided || petFrameGuided)) return; // 领地走位不算用户拖拽
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    config.save(agent === 'codex'
      ? { petPositionCodex: { x: b.x, y: b.y } }
      : { petPosition: { x: b.x, y: b.y } });
  });
  win.webContents.on('did-finish-load', () => {
    sendWin(win, 'pet:config', frontendConfig(agent));
    if (core) sendWin(win, 'pet:stats', buildStats(agent));
  });
  return win;
}

function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return; }
  panelH = 0; // 每次开面板重置自适应高度基准
  panelWin = new BrowserWindow({
    width: 560,
    height: 720,
    frame: false,
    transparent: false,
    resizable: true,
    skipTaskbar: false,
    show: false, // 先隐藏，首帧按内容定高后再显示，避免闪一下大窗口
    backgroundColor: '#2c1f1a',
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
    // 首帧渲染 + setPanelHeight 已到位后再显示
    setTimeout(() => { try { if (panelWin && !panelWin.isDestroyed()) panelWin.show(); } catch {} }, 90);
  });
  panelWin.on('closed', () => { panelWin = null; });
}

function closePanel() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  panelWin = null;
}

// ── 领地模式(territory) ─────────────────────────────────────────────────────
// 宠物窗口平滑走位原语(驱逐战专用)。petGuided 挡住 moved 持久化;结束后延迟
// 一拍再放开 —— macOS 的 moved 事件可能晚于最后一次 setBounds 才派发。
let petGuideRefs = 0;
function tweenPetTo(x, y, ms) {
  return new Promise((resolve) => {
    if (!petWin || petWin.isDestroyed()) return resolve();
    const from = petWin.getBounds();
    const dur = Math.max(80, ms || 800);
    const t0 = Date.now();
    petGuided = true;
    petGuideRefs++;
    const step = setInterval(() => {
      if (!petWin || petWin.isDestroyed()) return finish();
      const t = Math.min(1, (Date.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      // 宽高取当前值:走位途中气泡可能 fitPopup 改窗口尺寸,别跟它打架
      const b = petWin.getBounds();
      petWin.setBounds({
        x: Math.round(from.x + (x - from.x) * e),
        y: Math.round(from.y + (y - from.y) * e),
        width: b.width, height: b.height,
      });
      if (t >= 1) finish();
    }, 16);
    function finish() {
      clearInterval(step);
      setTimeout(() => { if (--petGuideRefs <= 0) { petGuideRefs = 0; petGuided = false; } }, 300);
      resolve();
    }
  });
}

function getTerritoryPetBounds() {
  // 退出瞬间被 episode 调到时不能抛异常(shouldAbort 随后就会让它撤退)
  if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
  const win = petWin.getBounds();
  const rect = primaryVisualRect();
  if (!rect) return win;
  return {
    x: win.x + rect.x,
    y: win.y + rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function tweenTerritoryPetTo(x, y, ms) {
  // territory 的 x/y 表示「可见身体」左上角；真正移动的是透明窗口。
  const rect = primaryVisualRect();
  return tweenPetTo(
    x - (rect ? rect.x : 0),
    y - (rect ? rect.y : 0),
    ms,
  );
}

function bootTerritory() {
  if (process.platform !== 'darwin') return;
  territory = createTerritory({
    isEnabled: () => !!config.get().territory,
    rivalNames: () => [...DEFAULT_RIVALS, ...(config.get().territoryRivals || [])],
    excludePids: () => [process.pid],
    // 注意:不能拿 customSize 当「用户在交互」—— 气泡的 fitPopup 也会设它,
    // 发现入侵者时自己冒的气泡就把驱逐战吓停了。用渲染端上报的 uiBusy
    // （双宠模式任一只宠开着面板/菜单都算交互中）。
    canScan: () => !!(petWin && !petWin.isDestroyed() && petWin.isVisible() && !anyUiBusy()),
    canMove: () => {
      try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; }
    },
    // 用户来正事了(面板/菜单开着/有待授权)→ 立刻停手回家
    shouldAbort: () => !(petWin && !petWin.isDestroyed() && petWin.isVisible()) || anyUiBusy()
      || !!(permissions && permissions.getPending().length > 0),
    getPetBounds: getTerritoryPetBounds,
    tweenPetTo: tweenTerritoryPetTo,
    setPetFrame: (x, y) => {
      if (!petWin || petWin.isDestroyed()) return;
      petFrameGuided = true;
      const b = petWin.getBounds();
      const rect = primaryVisualRect();
      petWin.setBounds({
        x: Math.round(x - (rect ? rect.x : 0)),
        y: Math.round(y - (rect ? rect.y : 0)),
        width: b.width, height: b.height,
      });
    },
    endPetFrames: () => { setTimeout(() => { petFrameGuided = false; }, 300); },
    setPetClickThrough: (on) => {
      if (!petWin || petWin.isDestroyed()) return;
      // 物理拖拽对手时，最高层的自己必须完全穿透，否则 CGEvent 会点中自己。
      // 结束后也先恢复为透明区穿透；renderer 收到 forwarded mousemove 后会
      // 只在真实宠物内容上重新接管。不能设 false，否则整块透明窗会挡住 Codex 输入。
      petWin.setIgnoreMouseEvents(true, { forward: !on });
    },
    // 猫爪在上定律:对手在场就抬到 screen-saver 层并 moveTop(不抢焦点);
    // 对手走光了降回 floating,不长期骑在系统 UI 头上。
    assertTop: () => {
      if (!petWin || petWin.isDestroyed()) return;
      try { petWin.setAlwaysOnTop(true, 'screen-saver'); petWin.moveTop(); } catch {}
    },
    relaxTop: () => {
      if (!petWin || petWin.isDestroyed()) return;
      try { petWin.setAlwaysOnTop(true, 'floating'); } catch {}
    },
    getWorkArea: (rect) => screen.getDisplayMatching({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.w || 1)),
      height: Math.max(1, Math.round(rect.h || 1)),
    }).workArea,
    emit: (ev) => sendPet('pet:event', ev),
  });
  territory.start();
}

let lastPermDialogAt = 0; // 引导框节流:连点「巡视」不该连环弹窗
function ensureTerritoryPermission() {
  if (process.platform !== 'darwin') return false;
  let trusted = false;
  try { trusted = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
  if (!trusted && Date.now() - lastPermDialogAt > 60 * 1000) {
    lastPermDialogAt = Date.now();
    // 推别人的窗口要走辅助功能 API;prompt=true 弹系统引导框并把本 app 加入列表
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch {}
    dialog.showMessageBox({
      type: 'info',
      message: '巡视桌宠需要「辅助功能」权限',
      detail: '小章鱼需要移动对方的窗口，才能把它顶到屏幕边上。\n' +
        '请在 系统设置 → 隐私与安全性 → 辅助功能 里勾选本应用(octopus/Electron)。\n' +
        '授权后无需重启，重新点击「巡视」即可。',
    }).catch(() => {});
  }
  return trusted;
}

function runTerritoryNow() {
  if (process.platform !== 'darwin' || !territory) return;
  // 没权限也照跑:定律①(进程检测+抬层级)不需要辅助功能,只有推窗需要。
  // 引导框由 ensureTerritoryPermission 弹(带节流);巡视结果先演完再提示缺权限。
  const trusted = ensureTerritoryPermission();
  territory.runNow()
    .then(() => {
      if (!trusted) sendPet('pet:event', { kind: 'territory', phase: 'noperm', ts: Date.now() });
    })
    .catch((e) => log('territory', 'manual scan failed:', e.message));
}

function applyTerritory(on) {
  config.save({ territory: !!on });
  if (on && process.platform === 'darwin') {
    ensureTerritoryPermission();
    // 开启后立刻巡逻一次，不让用户等到下一个轮询周期(定律①无需权限)。
    if (territory) territory.runNow().catch((e) => log('territory', 'initial scan failed:', e.message));
  } else if (!on && territory && territory.dominating) {
    // 关闭后立刻执行一次 disabled tick，把窗口层级恢复为 floating。
    territory.tick().catch(() => {});
  }
  broadcastConfig();
  refreshTrayMenu();
}

// Block any navigation / new-window to external content (hardening).
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

// ── push helpers ──────────────────────────────────────────────────────────────
function sendWin(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
// sendPet = 发给主宠（领地/授权等主宠专属通道沿用它）
function sendPet(channel, payload) { sendWin(petWin, channel, payload); }
function sendPanel(channel, payload) { sendWin(panelWin, channel, payload); }

// 事件按来源 agent 分流：双宠模式 codex 事件归 Codex 宠，其余归主宠。
function sendPetEvent(ev) {
  if (petWinCodex && ev && ev.agent === 'codex') { sendWin(petWinCodex, 'pet:event', ev); return; }
  sendPet('pet:event', ev);
}

// 按 agent 过滤会话快照（'all' 原样透传；active/idleMs 在过滤后的集合里重算）
function filterSnapshot(snap, agent) {
  if (agent === 'all') return snap;
  const sessions = (snap.sessions || []).filter((e) => adapter.agentOf(e) === agent);
  let active = null;
  for (const e of sessions) {
    if (e.headless) continue;
    if (!active || e.updatedAt > active.updatedAt) active = e;
  }
  return {
    sessions,
    active: active
      ? { sessionId: active.id, project: active.cwd, model: active.model, lastActivity: active.updatedAt }
      : null,
    idleMs: active ? active.idleMs : null,
    lastActivityTs: active ? active.updatedAt : 0,
    ts: snap.ts,
  };
}

function buildStats(agent = 'all', snapshot = null) {
  const snap = filterSnapshot(snapshot || core.buildSnapshot(), agent);
  const meter = metering ? metering.getStats() : null;
  // 授权（HTTP 阻塞钩子）只存在于 Claude 路径；Codex 宠不认领
  const pending = agent === 'codex' ? [] : permissions.getPending();
  const ops = (agent === 'all'
    ? recentOps
    : recentOps.filter((o) => (o.agent || 'claude') === agent)).slice(0, 30);
  return adapter.buildPetStats(snap, pending, meter, { lastOps: ops, codexLimits });
}

// Record operation/say events into the ring the panel renders as the op stream.
function recordOp(ev) {
  if (ev.kind === 'operation') {
    recentOps.unshift({ tool: ev.tool, icon: ev.icon, detail: ev.detail, file: ev.file || '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
  } else if (ev.kind === 'say') {
    recentOps.unshift({ tool: 'say', icon: '💬', detail: ev.text, file: '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
  } else return;
  if (recentOps.length > 50) recentOps.length = 50;
}

function emitStats() {
  if (!core) return;
  const snapshot = core.buildSnapshot();
  lastStats = buildStats('all', snapshot);
  for (const st of petStates()) {
    sendWin(st.win, 'pet:stats', st.agent === 'all' ? lastStats : buildStats(st.agent, snapshot));
  }
  sendPanel('panel:stats', lastStats);
}

function scheduleEmit() {
  if (emitDebounce) return;
  emitDebounce = setTimeout(() => { emitDebounce = null; emitStats(); }, 150);
}

function broadcastConfig() {
  for (const st of petStates()) sendWin(st.win, 'pet:config', frontendConfig(st.agent));
  sendPanel('panel:config', frontendConfig('all'));
}

// ── backend wiring ────────────────────────────────────────────────────────────
function bootBackend() {
  core = createCore({
    onActivity: (act) => {
      for (const ev of adapter.activityToEvents(act)) { recordOp(ev); sendPetEvent(ev); }
    },
    onDirty: scheduleEmit,
  });
  core.startStaleCleanup();

  // Codex 后端：只读监听 ~/.codex/sessions 的 rollout（无钩子、零侵入）。
  // OCTOPUS_NO_CODEX=1 关闭（比如只想盯 Claude 的机器）。
  if (process.env.OCTOPUS_NO_CODEX === '1') {
    log('main', 'OCTOPUS_NO_CODEX=1 — Codex watcher disabled');
  } else {
    codexWatch = createCodexWatch({
      core,
      // 开发/E2E 可用 OCTOPUS_CODEX_DIR 指到假目录，不碰真实 ~/.codex
      sessionsDir: process.env.OCTOPUS_CODEX_DIR || undefined,
      onRateLimits: (rl) => { codexLimits = rl; scheduleEmit(); },
    });
    codexWatch.start();
  }

  metering = createMetering();
  metering.start(30000);

  // Pricing sync: fetches LiteLLM's open pricing JSON once on boot + every 24h.
  // metering.loadPricing() now reads ~/.octopus/pricing-cache.json beneath the
  // user override. Public-data only — no credentials, no API calls.
  // On a fresh sync: reload the in-memory price table (so new prices apply this
  // run, not next restart) and push the updated source line to the panel.
  // OCTOPUS_NO_NET=1 keeps the app fully offline (the pricing fetch is the ONLY
  // outbound request Octopus ever makes) — falls back to the built-in price table.
  if (process.env.OCTOPUS_NO_NET === '1') {
    log('main', 'OCTOPUS_NO_NET=1 — pricing sync disabled (fully offline)');
  } else {
    pricingSync = createPricingSync({
      onUpdate: () => {
        if (metering) { try { metering.reloadPricing(); } catch {} }
        if (metering) sendPanel('panel:price', metering.priceInfo());
        scheduleEmit();
      },
    });
    pricingSync.start();
  }

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
      // A parked permission needs the user's eyes. In menubar mode (or if the pet
      // was hidden) the ask panel would render into an invisible window and CC
      // would hang until the park times out — so surface the pet window first.
      try { if (petWin && !petWin.isDestroyed() && !petWin.isVisible()) petWin.show(); } catch {}
      sendPetEvent({ kind, project: choice.project, reason, sessionId: entry.sessionId, choice, agent: 'claude', ts: Date.now() });
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
// 宠物窗口的 IPC 都按「发送方是哪个窗口」定位（双宠模式两只宠各管各的窗口）；
// 面板等非宠物发送方回落到主宠。
function registerIpc() {
  const senderAgent = (e) => { const st = stateOfSender(e.sender); return st ? st.agent : 'all'; };
  const senderPetWin = (e) => {
    const st = stateOfSender(e.sender);
    if (st && st.win && !st.win.isDestroyed()) return st.win;
    return petWin && !petWin.isDestroyed() ? petWin : null;
  };

  ipcMain.handle('get-config', (e) => frontendConfig(senderAgent(e)));
  ipcMain.handle('get-stats', (e) => {
    const agent = senderAgent(e);
    if (agent === 'all') return lastStats || buildStats();
    return buildStats(agent);
  });
  ipcMain.handle('get-win-pos', (e) => {
    const win = senderPetWin(e);
    if (!win) return [0, 0];
    const b = win.getBounds();
    return [b.x, b.y];
  });

  ipcMain.on('set-win-pos', (e, x, y) => {
    const win = senderPetWin(e);
    if (win && Number.isFinite(x) && Number.isFinite(y)) {
      const b = win.getBounds();
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
    }
  });

  ipcMain.on('open-panel', openPanel);
  ipcMain.on('close-panel', closePanel);

  // 详情面板按内容高度自适应：clamp 到屏幕工作区，阈值防抖避免每次 stats 都抖
  ipcMain.on('set-panel-height', (_e, h) => {
    if (!panelWin || panelWin.isDestroyed() || !Number.isFinite(h)) return;
    const b = panelWin.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const clamped = Math.max(320, Math.min(Math.round(h), wa.height - 24));
    if (Math.abs(clamped - panelH) < 6) return;
    panelH = clamped;
    panelWin.setBounds({ x: b.x, y: b.y, width: b.width, height: clamped });
  });

  ipcMain.on('set-mode', (_e, mode) => applyMode(mode));
  // Codex 宠上切形象 → 存 skinCodex；其余（主宠/面板）→ 存主形象
  ipcMain.on('set-skin', (e, skin) => applySkin(skin, senderAgent(e) === 'codex' ? 'codex' : null));
  ipcMain.on('set-budget', (_e, v) => { config.save({ budget5h: Number(v) || 0 }); broadcastConfig(); });
  ipcMain.on('toggle-mute', () => { config.save({ muted: !config.get().muted }); broadcastConfig(); refreshTrayMenu(); });
  ipcMain.on('territory-run-now', runTerritoryNow);
  ipcMain.on('territory-toggle-auto', () => applyTerritory(!config.get().territory));

  ipcMain.on('quit-app', () => app.quit());

  ipcMain.on('launch-claude', () => {
    launchClaude({}).then((r) => {
      if (!r.ok) log('main', 'launch claude failed:', r.message);
    }).catch((e) => log('main', 'launch claude error:', e.message));
  });
  ipcMain.on('launch-codex', () => {
    launchCodex({}).then((r) => {
      if (!r.ok) log('main', 'launch codex failed:', r.message);
    }).catch((e) => log('main', 'launch codex error:', e.message));
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
  ipcMain.on('primary-action', async (e) => {
    const agent = senderAgent(e);
    const all = core
      ? [...core.sessions.values()].filter((s) => agent === 'all' || adapter.agentOf(s) === agent)
      : [];
    // 空场时：Codex 宠唤起 codex CLI，其余唤起 claude
    if (!all.length) { (agent === 'codex' ? launchCodex : launchClaude)({}).catch(() => {}); return; }
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
  ipcMain.on('set-pet-size', (e, w, h) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = (Number(w) > 0 && Number(h) > 0) ? { w: Number(w), h: Number(h) } : null;
    applyPetSize(st);
  });
  // Back-compat coarse toggles (renderer now prefers set-pet-size).
  ipcMain.on('pet-tall', (e, on) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = on ? { w: BASE_W, h: TALL_H } : null;
    applyPetSize(st);
  });
  ipcMain.on('pet-big', (e, on) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = on ? { w: BIG_W, h: BIG_H } : null;
    applyPetSize(st);
  });
  ipcMain.on('pet-focus', (e) => { const w = senderPetWin(e); if (w) { w.setFocusable(true); w.focus(); } });
  ipcMain.on('pet-blur', (e) => { const w = senderPetWin(e); if (w) { w.blur(); } });

  // Click-through: the renderer hit-tests the cursor and toggles this so the
  // transparent parts of the pet window let clicks reach apps behind it.
  // forward:true keeps mousemove flowing to the renderer while ignoring, so it
  // can re-enable clicks the moment the cursor returns to the pet/content.
  ipcMain.on('set-ignore-mouse', (e, ignore) => {
    const w = senderPetWin(e);
    if (w) { try { w.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {} }
  });

  // 渲染端上报「用户正在交互」(领地模式据此避战/撤退,别的场景以后也能用)
  ipcMain.on('ui-busy', (e, on) => {
    const st = stateOfSender(e.sender);
    if (st) st.uiBusy = !!on;
  });
  ipcMain.on('pet-visual-bounds', (e, rect) => {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const st = stateOfSender(e.sender);
    if (!st) return;
    st.visualRect = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  });

  ipcMain.on('open-log', () => { shell.openPath(LOG_PATH); });
  ipcMain.on('pet-log', (_e, tag, msg) => { log('ui:' + String(tag || ''), String(msg || '')); });
}

// ── settings actions (shared by tray menu + panel IPC) ─────────────────────────
function applyMode(mode) {
  config.save({ mode });
  if (mode === 'panel') openPanel();
  else if (mode === 'pet') { for (const st of petStates()) st.win.show(); }
  else if (mode === 'menubar') { for (const st of petStates()) st.win.hide(); }
  broadcastConfig();
  refreshTrayMenu();
}
function applySkin(skin, agent) {
  config.save(agent === 'codex' ? { skinCodex: skin } : { skin });
  broadcastConfig();
  refreshTrayMenu();
}

// 单宠 ⇄ 双宠切换：销毁重建宠物窗口（窗口少、状态简单，重建比原地迁移可靠）
function applyPetMode(petMode) {
  if (config.get().petMode === petMode) return;
  config.save({ petMode });
  for (const st of petStates()) { try { st.win.destroy(); } catch {} }
  petState.clear();
  petWin = null;
  petWinCodex = null;
  createPetWindows();
  if (config.get().mode === 'menubar') { for (const st of petStates()) st.win.hide(); }
  broadcastConfig();
  refreshTrayMenu();
  log('main', `petMode → ${petMode}`);
}
function applyBudget(v) {
  config.save({ budget5h: Number(v) || 0 });
  broadcastConfig();
  refreshTrayMenu();
}

// ── tray ──────────────────────────────────────────────────────────────────────
function buildTray() {
  let img;
  try {
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    if (process.platform === 'darwin') img.setTemplateImage(true);
  } catch {}
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip('Octopus — Claude Code / Codex 桌宠');
  refreshTrayMenu();
  tray.on('click', () => { for (const st of petStates()) st.win.show(); });
}

function refreshTrayMenu() {
  if (!tray) return;
  const cfg = config.get();
  const muted = cfg.muted;
  const skin = cfg.skin || 'mascot';
  const mode = cfg.mode || 'pet';
  const budget = Number(cfg.budget5h) || 0;
  const petMode = cfg.petMode || 'single';
  const skinCodex = cfg.skinCodex || 'cat';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '📊 详情面板', click: openPanel },
    { label: '🐙 显示桌宠', click: () => { for (const st of petStates()) st.win.show(); } },
    { type: 'separator' },
    { label: '⚙️ 设置', enabled: false },
    { label: '　分身', submenu: [
      { label: '单宠 · 一只盯全部后端', type: 'radio', checked: petMode === 'single', click: () => applyPetMode('single') },
      { label: '双宠 · Claude / Codex 各一只', type: 'radio', checked: petMode === 'duo', click: () => applyPetMode('duo') },
    ] },
    { label: petMode === 'duo' ? '　形象（Claude 宠）' : '　形象', submenu: [
      { label: '章鱼', type: 'radio', checked: skin === 'mascot', click: () => applySkin('mascot') },
      { label: '像素怪兽', type: 'radio', checked: skin === 'pixel', click: () => applySkin('pixel') },
      { label: '月薪喵', type: 'radio', checked: skin === 'cat', click: () => applySkin('cat') },
    ] },
    ...(petMode === 'duo' ? [{ label: '　形象（Codex 宠）', submenu: [
      { label: '章鱼', type: 'radio', checked: skinCodex === 'mascot', click: () => applySkin('mascot', 'codex') },
      { label: '像素怪兽', type: 'radio', checked: skinCodex === 'pixel', click: () => applySkin('pixel', 'codex') },
      { label: '月薪喵', type: 'radio', checked: skinCodex === 'cat', click: () => applySkin('cat', 'codex') },
    ] }] : []),
    { label: '　形态', submenu: [
      { label: '浮游桌宠', type: 'radio', checked: mode === 'pet', click: () => applyMode('pet') },
      { label: '角落面板', type: 'radio', checked: mode === 'panel', click: () => applyMode('panel') },
      { label: '菜单栏（隐藏桌宠）', type: 'radio', checked: mode === 'menubar', click: () => applyMode('menubar') },
    ] },
    { label: '　5h 预算', submenu: [
      { label: '关闭', type: 'radio', checked: !budget, click: () => applyBudget(0) },
      { label: '$10', type: 'radio', checked: budget === 10, click: () => applyBudget(10) },
      { label: '$20', type: 'radio', checked: budget === 20, click: () => applyBudget(20) },
      { label: '$30', type: 'radio', checked: budget === 30, click: () => applyBudget(30) },
      { label: '$50', type: 'radio', checked: budget === 50, click: () => applyBudget(50) },
      { label: '$100', type: 'radio', checked: budget === 100, click: () => applyBudget(100) },
    ] },
    ...(process.platform === 'darwin' ? [
      { label: '　🥊 自动巡逻（顶走别的桌宠）', type: 'checkbox', checked: !!cfg.territory,
        click: () => applyTerritory(!config.get().territory) },
      { label: '　🔎 立即巡视一次', click: runTerritoryNow },
    ] : []),
    { label: muted ? '　🔔 取消静音' : '　🔇 静音', click: () => { config.save({ muted: !muted }); broadcastConfig(); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: '🚀 唤起 Claude', click: () => launchClaude({}).catch(() => {}) },
    { label: '🛰️ 唤起 Codex', click: () => launchCodex({}).catch(() => {}) },
    { label: '📄 打开日志', click: () => shell.openPath(LOG_PATH) },
    { type: 'separator' },
    { label: '🧹 卸载 Claude 钩子', click: () => {
      // Stop the settings watcher first — otherwise it sees our hooks vanish and
      // re-registers them within 800ms, silently undoing this uninstall.
      try { if (stopWatcher) { stopWatcher(); stopWatcher = null; } } catch {}
      hooks.uninstall();
    } },
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
// 多实例防护（对齐 clawd-on-desk 的处理）：
//  1) Electron 实例锁：同一份 app 重复启动 → 新实例静默退出；
//  2) 启动探测：候选端口上已有同身份 server 在跑（多为另一份代码副本）→ 提示并退出；
//  3) server.js 里的 runtime 守护：存活期间 runtime.json 被别的副本覆盖 → 抢回。
// 开发需要多开时用 OCTOPUS_ALLOW_MULTI=1 跳过 1/2。
const allowMulti = process.env.OCTOPUS_ALLOW_MULTI === '1';

// 并行探测所有候选端口，找到任一存活的同身份 server 就返回其端口
function findRivalInstance() {
  if (allowMulti) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = transport.PORTS.length;
    let found = null;
    for (const p of transport.PORTS) {
      transport.probe(p, 600, (ok) => {
        if (ok && found === null) found = p;
        if (--pending === 0) resolve(found);
      });
    }
  });
}

const gotTheLock = allowMulti ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  log('main', 'another instance holds the lock — quitting');
  app.quit();
} else {
  app.on('second-instance', () => { try { for (const st of petStates()) st.win.show(); } catch {} });
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    const rival = await findRivalInstance();
    if (rival) {
      log('main', `another octopus server is live on 127.0.0.1:${rival} — quitting (OCTOPUS_ALLOW_MULTI=1 to bypass)`);
      dialog.showErrorBox(
        'Octopus 已在运行',
        `检测到另一个 Octopus 实例正在端口 ${rival} 上服务（可能来自其他代码副本）。\n` +
        '本实例将退出，避免抢占会话事件。\n开发需要多开时：OCTOPUS_ALLOW_MULTI=1'
      );
      app.quit();
      return;
    }
    migrateState();
    registerIpc();
    bootBackend();
    createPetWindows();
    bootTerritory();
    try { buildTray(); } catch (e) { log('main', 'tray unavailable:', e.message); }
    log('main', 'Octopus ready');
  });
}

app.on('window-all-closed', () => { /* tray app: stay alive */ });

app.on('before-quit', () => {
  try { if (territory) territory.stop(); } catch {}
  try { if (codexWatch) codexWatch.stop(); } catch {}
  try { if (stopWatcher) stopWatcher(); } catch {}
  try { if (permissions) permissions.cleanup(); } catch {}
  try { if (server) server.stop(); } catch {}
  try { if (metering) metering.stop(); } catch {}
  try { if (pricingSync) pricingSync.stop(); } catch {}
  try { if (core) core.stopStaleCleanup(); } catch {}
  log('main', 'Octopus quit');
});
