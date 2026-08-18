'use strict';

// LLMPET — Electron main process.
//
// Boot order: core (session state) → metering (cost) → permissions → HTTP
// server → install Claude Code hooks (using the bound port) → start watcher.
// Wiring: core/permission activity → adapter → pet:event / pet:stats pushed to
// the renderer over the preload IPC contract.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog, systemPreferences, clipboard } = require('electron');

// Give the dev app the public LLMPET identity so it isn't shown as a generic
// "Electron" window and can never be confused with the abandoned "Claude小章鱼" build.
try { app.setName('LLMPET'); } catch {}
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
const { launchClaude, launchCodex, launchDsh, ensureDshWeb, launchExecutable, findCli } = require('./backend/launch');
const { createAgentStartup } = require('./backend/agent-startup');
const { createCodexWatch } = require('./backend/codex-watch');
const { createDshWatch } = require('./backend/dsh-watch');
const { createCodexMetering } = require('./backend/codex-metering');
const { createTravelManager } = require('./backend/travel');
const { machineGrowth } = require('./backend/growth');
const { publicCatalog, getMeme, watchCatalog } = require('./backend/meme-catalog');
const { createCommandDispatcher, routeForSession } = require('./backend/command-dispatch');
const { createSessionTakeover } = require('./backend/session-handoff');
const { createSessionArchive } = require('./backend/session-archive');
const { createProgramRegistry } = require('./backend/program-registry');
const { createProgramSkillManager } = require('./backend/program-skill');
const { createRuntimeMonitor } = require('./backend/runtime-monitor');
const transport = require('./backend/transport');
const i18n = require('./shared/i18n');

const t = i18n.t;
// Main-process strings (tray, dialogs, adapter-built labels) are localized at
// build time, so the language must be live before the first menu or event.
i18n.setLang(config.get().lang);

const PRELOAD = path.join(__dirname, 'preload.js');
const BASE_W = 320, BASE_H = 340, TALL_H = 560, BIG_W = 440, BIG_H = 600;
// `dsh web` 的默认落点（apps/web 的 webserver 行：127.0.0.1:3080）。
// 用户改过端口就用 LLMPET_DSH_WEB 覆盖。
const DSH_WEB_URL = process.env.LLMPET_DSH_WEB || 'http://127.0.0.1:3080';

let petWin = null;      // 主宠窗口：single 模式监控全部；duo 模式代表 Claude
let petWinCodex = null; // 双宠模式里的 Codex 宠（single 模式为 null）
let petWinDsh = null;   // dsh（DeepSeek Harness）宠，独立开关（关掉时为 null）
let panelWin = null;
let archiveWin = null;
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
let codexMetering = null; // Codex rollout 累计 token 台账（与状态 watcher 解耦）
let dshWatch = null;    // DeepSeek Harness 会话日志只读监听器
let travelManager = null; // 独立只读旅行任务 + 明信片/成长台账
let commandDispatcher = null;
let sessionTakeover = null;
let sessionArchive = null;
let programRegistry = null;
let programSkillManager = null;
let runtimeMonitor = null;
let agentStartup = null;
let stopMemeWatcher = null;
let petGuided = false; // 领地模式在带宠物走位:期间不把程序性移动当成用户拖拽持久化
let petFrameGuided = false; // CoreGraphics 逐帧拖动期间的同步跟随
// 巡视拖拽期间主宠强制穿透，renderer 不得抢回鼠标（uiBusy / visualRect /
// 渲染端期望的穿透状态 mouseIgnoring 都已并入下面按窗口的 petState）
let territoryClickThrough = false;

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

// 分身宠：被单独分出去的后端。主宠（'all'）要把它们从自己的快照里剔掉，
// 否则同一个会话会在两只宠身上各显示一份。
function splitAgents() {
  const c = config.get();
  const out = [];
  if (c.petMode === 'duo') out.push('codex');
  if (c.dshPet) out.push('dsh');
  return out;
}

// ── frontend config shape ─────────────────────────────────────────────────────
// agent: 'all'(单宠/面板) | 'claude' | 'codex' | 'dsh' —— 每只宠形象/位置各一套
function frontendConfig(agent = 'all') {
  const c = config.get();
  const skinByAgent = { codex: c.skinCodex, dsh: c.skinDsh };
  const positionByAgent = { codex: c.petPositionCodex, dsh: c.petPositionDsh };
  const clone = agent === 'codex' || agent === 'dsh';
  return {
    mode: c.mode,
    skin: skinByAgent[agent] || c.skin,
    petPosition: positionByAgent[agent] || (clone ? null : c.petPosition),
    muted: c.muted,
    permHook: c.permHook,
    territory: c.territory,
    // 巡视（领地模式）只由主宠负责，分身菜单里不显示
    territorySupported: process.platform === 'darwin' && !clone,
    lootSupported: process.platform === 'darwin' && !clone,
    agent,
    petMode: c.petMode,
    dshPet: c.dshPet,
    lang: c.lang,
    pinnedSessions: c.pinnedSessions,
    archivedSessions: c.archivedSessions,
    lootCapturedSessions: (c.lootCapturedSessions || [])
      .filter((session) => session.expiresAt > Date.now()),
    sessionArchive: c.sessionArchive,
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

function validPetAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const numeric = ['screenX', 'screenY', 'width', 'height', 'xOffset', 'yOffset'];
  if (!numeric.every((key) => Number.isFinite(anchor[key]))) return null;
  if (!(anchor.width > 0) || !(anchor.height > 0)) return null;
  if (!['left', 'center', 'right'].includes(anchor.xAlign)) return null;
  if (!['top', 'bottom'].includes(anchor.yAlign)) return null;
  return anchor;
}

function anchoredPetOrigin(anchor, width, height) {
  let localX;
  if (anchor.xAlign === 'left') localX = anchor.xOffset;
  else if (anchor.xAlign === 'right') localX = width - anchor.xOffset - anchor.width;
  else localX = width / 2 + anchor.xOffset - anchor.width / 2;

  const localY = anchor.yAlign === 'top'
    ? anchor.yOffset
    : height - anchor.yOffset - anchor.height;
  return {
    x: Math.round(anchor.screenX - localX),
    y: Math.round(anchor.screenY - localY),
  };
}

function applyPetSize(st, requestedAnchor) {
  if (!st || !st.win || st.win.isDestroyed()) return;
  const win = st.win;
  const { w } = targetSize(st);
  let { h } = targetSize(st);
  const b = win.getBounds();
  // Cap the window to the screen's work area so a tall popup can NEVER push the
  // pet / footer buttons off-screen — the popup scrolls internally instead.
  try {
    const wa = screen.getDisplayMatching(b).workArea;
    const width = Math.min(w, wa.width);
    h = Math.min(h, wa.height);
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, width, h) : null;
    const cx = b.x + b.width / 2;
    const bottom = b.y + b.height;
    let x = anchored ? anchored.x : Math.round(cx - width / 2);
    let y = anchored ? anchored.y : Math.round(bottom - h);
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
    win.setBounds({ x, y, width, height: h });
  } catch {
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, w, h) : null;
    const bottom = b.y + b.height;
    win.setBounds({ x: anchored ? anchored.x : b.x, y: anchored ? anchored.y : Math.round(bottom - h), width: w, height: h });
  }
}

// 分身开关：主宠始终在（single 模式盯全部后端；有分身时盯「剩下的」），
// Codex 宠由 petMode='duo' 决定，dsh 宠由 dshPet 决定，两者互不影响。
function createPetWindows() {
  const duo = config.get().petMode === 'duo';
  const dsh = config.get().dshPet === true;
  petWin = makePetWindow(duo ? 'claude' : 'all');
  petWinCodex = duo ? makePetWindow('codex') : null;
  petWinDsh = dsh ? makePetWindow('dsh') : null;
  log('main', `pet windows: ${[duo ? 'claude' : 'all', duo ? 'codex' : '', dsh ? 'dsh' : ''].filter(Boolean).join('+')}`);
}

// 分身宠默认落脚点：按出场次序依次往主宠左边错开，肩并肩不重叠
const CLONE_SHIFT = { codex: 1, dsh: 2 };

function makePetWindow(agent) {
  const c = config.get();
  const savedByAgent = { codex: c.petPositionCodex, dsh: c.petPositionDsh };
  const saved = savedByAgent[agent] || (CLONE_SHIFT[agent] ? null : c.petPosition);
  let x, y;
  if (saved) { x = saved.x; y = saved.y; }
  else {
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      const shift = (CLONE_SHIFT[agent] || 0) * (BASE_W + 36);
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

  // mouseIgnoring=true：透明窗启动即穿透，renderer 命中测试后再接管（pet.js 同款默认）
  const st = { agent, win, customSize: null, visualRect: null, uiBusy: false, mouseIgnoring: true };
  // 'closed' 之后绝不能再碰 win.webContents（抛 "Object has been destroyed"，主进程
  // 未捕获直接崩）——id 在创建时取好。收起一只宠是独立事件，只清自己的状态。
  const wcId = win.webContents.id;
  petState.set(wcId, st);
  win.on('closed', () => {
    petState.delete(wcId);
    if (petWin === win) petWin = null;
    if (petWinCodex === win) petWinCodex = null;
    if (petWinDsh === win) petWinDsh = null;
  });

  // 注意读 st.agent 而非闭包 agent：单宠⇄双宠切换时主宠原地重载、身份会变
  win.on('moved', () => {
    if (st.customSize) return; // only persist the resting position
    if (win === petWin && (petGuided || petFrameGuided)) return; // 领地走位不算用户拖拽
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const at = { x: b.x, y: b.y };
    if (st.agent === 'codex') config.save({ petPositionCodex: at });
    else if (st.agent === 'dsh') config.save({ petPositionDsh: at });
    else config.save({ petPosition: at });
  });
  win.webContents.on('did-finish-load', () => {
    sendWin(win, 'pet:config', frontendConfig(st.agent));
    if (core) sendWin(win, 'pet:stats', petStats(st.agent));
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

// The archive renderer is now LLMPET's unified desktop workbench. Its session
// manager keeps the archive contract; the other pages share live stats and the
// local generated-program registry.
function openArchive() {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.icns'));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
  if (archiveWin && !archiveWin.isDestroyed()) {
    archiveWin.show();
    archiveWin.focus();
    if (sessionArchive) sessionArchive.refresh().catch((e) => log('archive', 'refresh failed:', e.message));
    return;
  }
  archiveWin = new BrowserWindow({
    width: 1220,
    height: 790,
    minWidth: 920,
    minHeight: 620,
    frame: false,
    transparent: false,
    resizable: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#18171d',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  hardenWindow(archiveWin);
  archiveWin.loadFile(path.join(__dirname, 'renderer', 'archive.html'));
  archiveWin.webContents.on('did-finish-load', () => {
    sendWin(archiveWin, 'archive:config', frontendConfig());
    // Usage ledgers scan independently from the activity core. Always build a
    // fresh payload when the workbench opens; a cached startup snapshot may
    // still contain Codex 0 while rollout scanning has already advanced.
    if (core) sendWin(archiveWin, 'workbench:stats', buildStats('all'));
    if (metering) sendWin(archiveWin, 'workbench:price', metering.priceInfo());
    setTimeout(() => {
      try { if (archiveWin && !archiveWin.isDestroyed()) { archiveWin.show(); archiveWin.focus(); } } catch {}
    }, 50);
    if (sessionArchive) sessionArchive.refresh().catch((e) => log('archive', 'refresh failed:', e.message));
  });
  archiveWin.on('closed', () => { archiveWin = null; });
}

function closeArchive() {
  if (archiveWin && !archiveWin.isDestroyed()) archiveWin.close();
  archiveWin = null;
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
  // 掠夺接近会同时冒气泡、打开会话面板，透明窗口尺寸与可见身体在窗口内
  // 的 rect.x/rect.y 会在补间途中改变。旧实现只在起点换算一次偏移，导致
  // 窗口本身向左走、猫主体却被扩展后的布局锚到右边。每一帧都按最新
  // visualRect 反算窗口原点，才能让用户看到的身体沿同一条轨迹移动。
  return new Promise((resolve) => {
    if (!petWin || petWin.isDestroyed()) return resolve();
    const from = getTerritoryPetBounds();
    const dur = Math.max(80, ms || 800);
    const t0 = Date.now();
    petGuided = true;
    petGuideRefs++;
    const step = setInterval(() => {
      if (!petWin || petWin.isDestroyed()) return finish();
      const t = Math.min(1, (Date.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const visibleX = Math.round(from.x + (x - from.x) * e);
      const visibleY = Math.round(from.y + (y - from.y) * e);
      const rect = primaryVisualRect();
      const b = petWin.getBounds();
      petWin.setBounds({
        x: visibleX - (rect ? rect.x : 0),
        y: visibleY - (rect ? rect.y : 0),
        width: b.width,
        height: b.height,
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
    // 用户来正事了(面板/菜单开着/有待授权)→ 立刻停手回家
    shouldAbort: () => !(petWin && !petWin.isDestroyed() && petWin.isVisible()) || anyUiBusy()
      || !!(permissions && permissions.getPending().length > 0),
    // 掠夺自己会打开会话面板，不能把演出产生的 uiBusy 反过来当成用户打断。
    shouldAbortLoot: () => !(petWin && !petWin.isDestroyed() && petWin.isVisible())
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
      // 巡视移动对手时，最高层的自己必须完全穿透，避免遮住目标与软件指针。
      // 结束后也先恢复为透明区穿透；renderer 收到 forwarded mousemove 后会
      // 只在真实宠物内容上重新接管。不能设 false，否则整块透明窗会挡住 Codex 输入。
      try {
        territoryClickThrough = !!on;
        // 结束时恢复主宠 renderer 期望的穿透状态；拿不到状态就保持穿透(安全侧)
        const st = primaryPetState();
        petWin.setIgnoreMouseEvents(territoryClickThrough || !st || st.mouseIgnoring, { forward: true });
        if (on) {
          // Electron 的 click-through 与最高层命中更新并非同一原子操作。
          // 拖拽期间短暂降到普通层，确保 ChatGPT 的 layer-3 overlay 真正接到事件；
          // 独立巡视指针仍在 screen-saver 层，动作结束马上恢复猫爪在上。
          petWin.setAlwaysOnTop(false);
        } else {
          petWin.setAlwaysOnTop(true, 'screen-saver');
          petWin.moveTop();
        }
      } catch {}
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
    emit: (ev) => {
      // 只在某条真实 Session 的入场事件发生时持久化它。未找到桌宠、
      // native 预检失败或还没轮到的历史会话，都不能被伪装成已掠夺。
      if (ev && ev.kind === 'loot' && ev.phase === 'sessionCaptured' && ev.session) {
        captureCodexSessions([ev.session]);
      }
      sendPet('pet:event', ev);
    },
  });
  territory.start();
}

let lastPermDialogAt = 0; // 引导框节流:授权缓存未刷新时也不能反复骚扰
let axGrantWatchTimer = null; // 引导用户去设置后轮询复检授权,到位即自动开跑
const AX_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

function isAxTrusted() {
  if (process.platform !== 'darwin') return false;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; }
}

// 引导用户点开「辅助功能」设置后,不再让他「退出重开」——轮询复检,一旦授权到位
// 就自动巡视一次并给出成功反馈。限时 90s / 已授权即停,避免常驻定时器。
function startAxGrantWatch() {
  if (axGrantWatchTimer) return;
  const deadline = Date.now() + 90 * 1000;
  axGrantWatchTimer = setInterval(() => {
    if (isAxTrusted()) {
      clearInterval(axGrantWatchTimer);
      axGrantWatchTimer = null;
      log('territory', 'accessibility granted — auto patrol');
      sendPet('pet:event', { kind: 'territory', phase: 'granted', ts: Date.now() });
      if (territory) territory.runNow().catch((e) => log('territory', 'post-grant scan failed:', e.message));
    } else if (Date.now() > deadline) {
      clearInterval(axGrantWatchTimer);
      axGrantWatchTimer = null;
    }
  }, 1500);
  if (axGrantWatchTimer.unref) axGrantWatchTimer.unref();
}

function ensureTerritoryPermission() {
  if (process.platform !== 'darwin') return false;
  const trusted = isAxTrusted();
  log('territory', `accessibility preflight trusted=${trusted}`);
  if (trusted) return true;
  if (Date.now() - lastPermDialogAt <= 15 * 60 * 1000) return false;
  lastPermDialogAt = Date.now();
  // prompt=true 让系统把本 app 加入「辅助功能」列表(即便还没勾选),用户到设置里
  // 才有可勾的条目。
  try { systemPreferences.isTrustedAccessibilityClient(true); } catch {}
  dialog.showMessageBox({
    type: 'info',
    message: t('dlg.axTitle'),
    detail: t('dlg.axBody') + t('dlg.axHint'),
    buttons: [t('dlg.axOpen'), t('dlg.later')],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      shell.openExternal(AX_SETTINGS_URL).catch(() => {});
      startAxGrantWatch();
    }
  }).catch(() => {});
  return false;
}

function runTerritoryNow() {
  if (process.platform !== 'darwin' || !territory) return;
  // 没权限也照跑:定律①(进程检测+抬层级)不需要辅助功能,只有推窗需要。
  // 权限提醒以实际 osascript/AX 操作结果为准，不能捕获点击瞬间的旧值并在
  // 用户中途完成授权后仍强制冒 noperm。
  const trustedBefore = ensureTerritoryPermission();
  territory.runNow()
    .then((result) => {
      let trustedAfter = false;
      try { trustedAfter = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
      log('territory', `manual patrol result=${result} trustedBefore=${trustedBefore} trustedAfter=${trustedAfter}`);
    })
    .catch((e) => log('territory', 'manual scan failed:', e.message));
}

function recentCodexSessions(limit = 3) {
  if (!core) return [];
  const stats = buildStats('all');
  return (stats.sessions || [])
    .filter((session) => session && session.agent === 'codex'
      && !session.headless && session.sessionRole !== 'travel')
    .sort((a, b) => {
      const updated = (b.updatedAt || 0) - (a.updatedAt || 0);
      return updated || (a.idleMs || 0) - (b.idleMs || 0);
    })
    .slice(0, Math.max(0, limit))
    .map((session) => ({ ...session }));
}

function captureCodexSessions(sessions) {
  const captured = (Array.isArray(sessions) ? sessions : []).slice(0, 12);
  const ids = captured
    .map((session) => String(session && session.sessionId || ''))
    .filter(Boolean);
  if (!ids.length) return;
  const current = config.get();
  const now = Date.now();
  const expiresAt = now + 30 * 60 * 1000;
  const snapshots = captured.map((session) => ({
    sessionId: String(session.sessionId || ''),
    project: session.project || '',
    cwd: session.cwd || '',
    agent: 'codex',
    state: session.state || 'idle',
    badge: session.badge || '',
    op: session.op || '',
    reason: session.reason || '',
    contextPercent: session.contextPercent,
    idleMs: session.idleMs,
    updatedAt: session.updatedAt,
    capturedAt: now,
    expiresAt,
  }));
  config.save({
    // 不永久篡改用户的手动置顶；使用单独的结构化快照在普通列表顶部保留 30 分钟。
    lootCapturedSessions: [
      ...snapshots,
      ...(current.lootCapturedSessions || [])
        .filter((session) => session.expiresAt > now && !ids.includes(String(session.sessionId))),
    ],
    archivedSessions: (current.archivedSessions || []).filter((id) => !ids.includes(String(id))),
  });
  broadcastConfig();
}

function runLootNow() {
  if (process.platform !== 'darwin' || !territory) return;
  ensureTerritoryPermission();
  // watcher 的常驻列表只保留活跃会话；掠夺要在 native ready 之前每秒
  // 拿一条真实历史，因此点击时只读补齐最近 12 条作为有界队列。
  if (codexWatch && typeof codexWatch.seedRecent === 'function') codexWatch.seedRecent(12);
  const sessions = recentCodexSessions(12);
  // 传递的是真实 Codex 会话，不复制假条目；真正捕获到目标桌宠后，
  // capture 事件才会解除归档并置顶，渲染端逐条“吸入”。
  territory.runLoot(sessions)
    .then((result) => log('loot', `manual loot result=${result} sessions=${sessions.length}`))
    .catch((e) => log('loot', 'manual loot failed:', e.message));
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
// 任一存活的宠物窗口：主宠被单独收起后，授权卡等重要消息兜底投递到还活着的那只
function firstAlivePetWin() {
  if (petWin && !petWin.isDestroyed()) return petWin;
  if (petWinCodex && !petWinCodex.isDestroyed()) return petWinCodex;
  if (petWinDsh && !petWinDsh.isDestroyed()) return petWinDsh;
  return null;
}
// sendPet = 发给主宠（领地/授权等主宠专属通道沿用它）；主宠不在则兜底
function sendPet(channel, payload) { sendWin(firstAlivePetWin(), channel, payload); }
function sendPanel(channel, payload) { sendWin(panelWin, channel, payload); }
function sendArchive(channel, payload) { sendWin(archiveWin, channel, payload); }

// 事件按来源 agent 分流：分身宠在场就归它（不在了兜底主路），其余归主宠。
function sendPetEvent(ev) {
  const cloneWin = ev && ev.agent === 'codex' ? petWinCodex
    : ev && ev.agent === 'dsh' ? petWinDsh
    : null;
  if (cloneWin && !cloneWin.isDestroyed()) {
    sendWin(cloneWin, 'pet:event', ev);
    return;
  }
  sendPet('pet:event', ev);
}

// 按 agent 过滤会话快照（active/idleMs 在过滤后的集合里重算）。
// 'all' 是主宠/面板：面板要全量，主宠要「减去已分身出去的后端」——差别由
// excludes 决定，避免同一个会话在两只宠身上各显示一份。
function filterSnapshot(snap, agent, excludes = []) {
  if (agent === 'all' && !excludes.length) return snap;
  const sessions = (snap.sessions || []).filter((e) => {
    const a = adapter.agentOf(e);
    return agent === 'all' ? !excludes.includes(a) : a === agent;
  });
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

function buildStats(agent = 'all', snapshot = null, excludes = []) {
  if (travelManager && core) {
    for (const session of core.sessions.values()) {
      travelManager.decorateSession(session, adapter.agentOf(session));
    }
  }
  const rawSnapshot = snapshot || core.buildSnapshot();
  if (travelManager && rawSnapshot && Array.isArray(rawSnapshot.sessions)) {
    for (const session of rawSnapshot.sessions) {
      travelManager.decorateSession(session, adapter.agentOf(session));
    }
  }
  const snap = filterSnapshot(rawSnapshot, agent, excludes);
  const meter = metering ? metering.getStats() : null;
  const codexUsage = codexMetering ? codexMetering.getStats() : null;
  // 授权（HTTP 阻塞钩子）只存在于 Claude 路径；Codex / dsh 宠不认领
  const pending = agent === 'codex' || agent === 'dsh' ? [] : permissions.getPending();
  const ops = (agent === 'all'
    ? recentOps.filter((o) => !excludes.includes(o.agent || 'claude'))
    : recentOps.filter((o) => (o.agent || 'claude') === agent)).slice(0, 30);
  const stats = adapter.buildPetStats(snap, pending, meter, {
    lastOps: ops,
    codexUsage,
    // Shared pet/panel/archive must combine both ledgers. Mapping `all` to
    // `claude` made the headline omit Codex while the Codex detail card still
    // showed its own cost, producing contradictory totals in the real UI.
    usageProvider: agent,
    runtime: runtimeMonitor ? runtimeMonitor.snapshot() : null,
  });
  // Travel sessions are already present in the Claude/Codex ledgers, so the
  // machine total is the two provider lifetimes only—never travel + providers.
  stats.machineGrowth = machineGrowth(meter, codexUsage);
  stats.travel = travelManager ? travelManager.publicState(i18n.getLang()) : null;
  return stats;
}

// 桌宠窗口要的快照：主宠（'all'）得减掉已经分身出去的后端；面板/档案馆用
// buildStats('all') 拿全量，不走这里。
function petStats(agent, snapshot = null) {
  return buildStats(agent, snapshot, agent === 'all' ? splitAgents() : []);
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
  lastStats = buildStats('all', snapshot); // 面板/档案馆永远要全量
  const splits = splitAgents();
  for (const st of petStates()) {
    const full = st.agent === 'all' && !splits.length;
    sendWin(st.win, 'pet:stats', full ? lastStats : petStats(st.agent, snapshot));
  }
  sendPanel('panel:stats', lastStats);
  sendArchive('workbench:stats', lastStats);
}

function scheduleEmit() {
  if (emitDebounce) return;
  emitDebounce = setTimeout(() => { emitDebounce = null; emitStats(); }, 150);
}

function broadcastConfig() {
  for (const st of petStates()) sendWin(st.win, 'pet:config', frontendConfig(st.agent));
  sendPanel('panel:config', frontendConfig('all'));
}

function startMemeWatcher() {
  if (stopMemeWatcher) return;
  stopMemeWatcher = watchCatalog({
    onChange: (catalog) => {
      log('meme', `resources hot-reloaded revision=${catalog.revision}`);
      for (const st of petStates()) {
        sendWin(st.win, 'pet:meme-catalog-changed', { revision: catalog.revision });
      }
    },
    onError: (err) => log('meme', `resource reload rejected; keeping last good catalog: ${err.message}`),
  });
  log('meme', 'resource watcher started');
}

// ── backend wiring ────────────────────────────────────────────────────────────
function bootBackend() {
  core = createCore({
    onActivity: (act) => {
      const claimedByTravel = travelManager && travelManager.observeActivity({
        ...act,
        agent: adapter.agentOf(act.session),
      });
      if (claimedByTravel) return;
      for (const ev of adapter.activityToEvents(act)) { recordOp(ev); sendPetEvent(ev); }
    },
    onDirty: scheduleEmit,
  });
  core.startStaleCleanup();
  travelManager = createTravelManager({
    onChange: (event) => {
      const tripAgent = event && event.trip && event.trip.agent;
      for (const st of petStates()) {
        if (!tripAgent || st.agent === 'all' || st.agent === tripAgent) {
          sendWin(st.win, 'pet:travel', event);
        }
      }
      scheduleEmit();
    },
  });
  commandDispatcher = createCommandDispatcher({
    copyText: (text) => clipboard.writeText(text),
    focusSession,
    openCodexThread: (sessionId) => shell.openExternal(`codex://threads/${encodeURIComponent(sessionId)}`),
    // Claude's web hand-off uses /code/, but Claude Desktop 1.24012 opens that
    // route in an empty auxiliary "Code" window. Local desktop sessions live in
    // the main Epitaxy view; this route focuses its real prompt editor.
    openClaudeThread: (sessionId) => shell.openExternal(`claude://claude.ai/epitaxy/${encodeURIComponent(sessionId)}`),
  });
  sessionTakeover = createSessionTakeover();
  sessionArchive = createSessionArchive({
    getSettings: () => config.get().sessionArchive,
    onChange: (event) => sendArchive('archive:changed', event),
    // Keep archive discovery on the same injected root as the live watcher in
    // development/E2E; production still defaults to $DSH_HOME|~/.dsh/sessions.
    dshRoot: process.env.LLMPET_DSH_DIR || undefined,
  });
  sessionArchive.start().catch((e) => log('archive', 'startup scan failed:', e.message));
  // Read-only until the user grants one provider from the Launcher page.
  // Starting LLMPET must never silently write into an agent's user skill tree.
  programSkillManager = createProgramSkillManager();
  programRegistry = createProgramRegistry({
    statePath: process.env.LLMPET_PROGRAM_REGISTRY || undefined,
    onChange: (event) => sendArchive('programs:changed', event),
    openPath: (target) => shell.openPath(target),
    revealPath: (target) => shell.showItemInFolder(target),
    launchCommand: (record) => launchExecutable(record.launch.command, {
      cwd: record.cwd,
      args: record.launch.args,
      keepOpen: true,
      terminalTitle: `LLMPET · ${record.name}`,
    }),
  });
  programRegistry.start();
  runtimeMonitor = createRuntimeMonitor({
    selfPid: process.pid,
    onChange: () => scheduleEmit(),
  });
  runtimeMonitor.start();

  // Codex 后端：只读监听 ~/.codex/sessions 的 rollout（无钩子、零侵入）。
  // LLMPET_NO_CODEX=1 关闭（比如只想盯 Claude 的机器）。
  if (process.env.LLMPET_NO_CODEX === '1') {
    log('main', 'LLMPET_NO_CODEX=1 — Codex watcher disabled');
  } else {
    codexMetering = createCodexMetering({
      sessionsDir: process.env.LLMPET_CODEX_DIR || undefined,
      onChange: scheduleEmit,
    });
    codexMetering.start(30000);
    codexWatch = createCodexWatch({
      core,
      // 开发/E2E 可用 LLMPET_CODEX_DIR 指到假目录，不碰真实 ~/.codex
      sessionsDir: process.env.LLMPET_CODEX_DIR || undefined,
    });
    codexWatch.start();
  }

  // DeepSeek Harness 后端：只读监听 $DSH_HOME|~/.dsh/sessions 的会话日志
  // （同样无钩子、零侵入；不装 dsh 的机器上 watcher 只是空转）。
  // LLMPET_NO_DSH=1 关闭；LLMPET_DSH_DIR 可指到假目录做开发/E2E。
  if (process.env.LLMPET_NO_DSH === '1') {
    log('main', 'LLMPET_NO_DSH=1 — dsh watcher disabled');
  } else {
    dshWatch = createDshWatch({
      core,
      sessionsDir: process.env.LLMPET_DSH_DIR || undefined,
    });
    dshWatch.start();
  }

  metering = createMetering();
  metering.start(30000);

  // Pricing sync: fetches LiteLLM's open pricing JSON once on boot + every 24h.
  // metering.loadPricing() now reads ~/.octopus/pricing-cache.json beneath the
  // user override. Public-data only — no credentials, no API calls.
  // On a fresh sync: reload the in-memory price table (so new prices apply this
  // run, not next restart) and push the updated source line to the panel.
  // OCTOPUS_NO_NET=1 keeps the app fully offline (the pricing fetch is the ONLY
  // outbound request LLMPET ever makes) — falls back to the built-in price table.
  if (process.env.OCTOPUS_NO_NET === '1') {
    log('main', 'OCTOPUS_NO_NET=1 — pricing sync disabled (fully offline)');
  } else {
    pricingSync = createPricingSync({
      onUpdate: () => {
        if (metering) { try { metering.reloadPricing(); } catch {} }
        // Codex reprices from its own per-model token ledger — without this the
        // Codex half of the panel would keep the boot-time (built-in) rates.
        if (codexMetering) { try { codexMetering.reloadPricing(); } catch {} }
        if (metering) {
          const priceInfo = metering.priceInfo();
          sendPanel('panel:price', priceInfo);
          sendArchive('workbench:price', priceInfo);
        }
        scheduleEmit();
      },
    });
    pricingSync.start();
  }

  permissions = createPermissions({
    // muted only silences sound (renderer-side); it is NOT do-not-disturb.
    // Travel requests intentionally remain here: their dedicated conversation
    // is a normal pet card and renders a stable "travel letter" approval.
    shouldDrop: () => false,
    onAdded: (entry) => {
      let lite = (() => { const s = core.getSession(entry.sessionId); return s ? toEntryLite(s) : null; })();
      if (lite && travelManager) travelManager.decorateSession(lite, adapter.agentOf(lite));
      const travel = !!(travelManager && travelManager.claimsSession(entry.sessionId));
      if (!lite && travel) {
        lite = {
          id: entry.sessionId,
          agentId: 'claude-code',
          sessionRole: 'travel',
          travelAgent: 'claude',
        };
      }
      let choice, kind, reason;
      if (entry.isElicitation) {
        choice = adapter.buildElicitationChoice(
          { id: entry.id, sessionId: entry.sessionId, questions: entry.questions }, lite);
        kind = 'needsinput'; reason = 'reply';
      } else if (entry.toolName === 'ExitPlanMode') {
        choice = adapter.buildPlanChoice(
          { id: entry.id, sessionId: entry.sessionId, toolInput: entry.toolInput }, lite);
        kind = 'needsinput'; reason = 'plan';
      } else {
        choice = adapter.buildPermChoice(
          {
            id: entry.id,
            sessionId: entry.sessionId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            suggestions: entry.suggestions,
            travel,
          },
          lite,
        );
        kind = 'waiting'; reason = 'perm';
      }
      // A parked permission needs the user's eyes. In menubar mode (or if the pet
      // was hidden) the ask panel would render into an invisible window and CC
      // would hang until the park times out — so surface the pet window first.
      try { const w = firstAlivePetWin(); if (w && !w.isVisible()) w.show(); } catch {}
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
      hooks.install(port, server.getToken());
      stopWatcher = hooks.startWatcher(() => ({ port: server.getPort(), token: server.getToken() }));
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
  return {
    id: s.id,
    cwd: s.cwd,
    sessionTitle: s.sessionTitle,
    agentId: s.agentId,
    sessionRole: s.sessionRole,
    travelAgent: s.travelAgent,
  };
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
    // Do not return a stale cached price/token snapshot to a newly opened
    // dashboard. buildStats is read-only and reflects the latest ledger scan.
    // 桌宠窗口（stateOfSender 有值）走 petStats：主宠要减掉已分身的后端；
    // 面板/档案馆不是桌宠窗口，拿全量。
    const st = stateOfSender(e.sender);
    return st ? petStats(st.agent) : buildStats('all');
  });
  ipcMain.handle('get-win-pos', (e) => {
    const win = senderPetWin(e);
    if (!win) return [0, 0];
    const b = win.getBounds();
    return [b.x, b.y];
  });
  ipcMain.handle('get-window-metrics', (e) => {
    const win = senderPetWin(e);
    if (!win) return null;
    const windowBounds = win.getBounds();
    let workArea = null;
    try { workArea = screen.getDisplayMatching(windowBounds).workArea; } catch {}
    return { window: windowBounds, workArea };
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
  ipcMain.on('open-session-archive', openArchive);
  ipcMain.on('close-session-archive', closeArchive);
  ipcMain.handle('session-archive-list', async (_e, query) => {
    if (!sessionArchive) return { sessions: [], total: 0, page: 1, pageSize: 100, summary: null };
    const archiveSummary = sessionArchive.summary();
    if (!archiveSummary.lastScanAt || Date.now() - archiveSummary.lastScanAt > 30000) {
      await sessionArchive.refresh();
    }
    const activeIds = core ? [...core.sessions.keys()] : [];
    return sessionArchive.list({ ...(query || {}), activeIds });
  });
  ipcMain.handle('session-archive-settings', async (_e, partial) => {
    const current = config.get().sessionArchive || {};
    const next = {
      backupEnabled: partial && partial.backupEnabled !== undefined
        ? partial.backupEnabled === true : current.backupEnabled === true,
      backupIntervalHours: partial && partial.backupIntervalHours !== undefined
        ? Number(partial.backupIntervalHours) : current.backupIntervalHours,
    };
    config.save({ sessionArchive: next });
    if (sessionArchive) {
      if (next.backupEnabled && !current.backupEnabled) {
        sessionArchive.backupNow()
          .catch((e) => log('archive', 'initial backup failed:', e.message))
          .finally(() => sessionArchive.schedule());
      } else sessionArchive.schedule();
    }
    return config.get().sessionArchive;
  });
  ipcMain.handle('session-archive-backup-now', async () => {
    if (!sessionArchive) return { ok: false, code: 'not-ready' };
    return sessionArchive.backupNow();
  });
  ipcMain.handle('session-archive-resume', async (_e, key, targetAgent) => {
    if (!sessionArchive || !sessionTakeover) return { ok: false, code: 'not-ready' };
    const archived = sessionArchive.get(key);
    const target = targetAgent === 'codex' ? 'codex' : targetAgent === 'claude' ? 'claude' : '';
    if (!archived || !archived.sourceAvailable) return { ok: false, code: 'source-missing' };
    if (!target) return { ok: false, code: 'invalid-provider' };
    const session = {
      id: archived.id,
      agentId: archived.provider,
      cwd: archived.cwd,
      transcriptPath: archived.sourcePath,
      sessionTitle: archived.title,
      state: 'idle',
      sourcePid: null,
      headless: false,
    };
    const result = await sessionTakeover.takeOver(session, target, { locale: i18n.getLang() });
    log('archive', `resume ${archived.key} → ${target} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('session-archive-restore', async (_e, key) => {
    if (!sessionArchive) return { ok: false, code: 'not-ready' };
    const result = await sessionArchive.restore(key);
    log('archive', `restore ${String(key || '')} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('session-archive-reveal', async (_e, key) => {
    if (!sessionArchive) return false;
    const archived = sessionArchive.get(key);
    const target = archived && (archived.sourceAvailable ? archived.sourcePath : archived.backupPath);
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.on('session-archive-open-backup', () => {
    if (!sessionArchive) return;
    try { fs.mkdirSync(sessionArchive.backupRoot, { recursive: true, mode: 0o700 }); }
    catch (e) { log('archive', 'create backup folder failed:', e.message); return; }
    shell.openPath(sessionArchive.backupRoot)
      .then((error) => { if (error) log('archive', 'open backup folder failed:', error); });
  });
  ipcMain.handle('generated-programs-list', () => programRegistry ? programRegistry.list() : []);
  ipcMain.handle('generated-program-launch', async (_e, id) => {
    const result = programRegistry ? await programRegistry.launch(id) : { ok: false, code: 'not-ready' };
    log('programs', `launch ${String(id || '')} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('generated-program-reveal', (_e, id) => programRegistry ? programRegistry.reveal(id) : false);
  ipcMain.handle('generated-program-remove', (_e, id) => programRegistry ? programRegistry.remove(id) : false);
  ipcMain.handle('program-skills-status', () => programSkillManager ? programSkillManager.status() : []);
  ipcMain.handle('program-skill-install', (_e, provider) => {
    try {
      const result = programSkillManager ? programSkillManager.install(provider) : { ok: false, code: 'not-ready' };
      log('programs', `skill install provider=${String(provider || '')} ok=${!!result.ok} code=${result.code || '-'}`);
      sendArchive('program-skills:changed', programSkillManager ? programSkillManager.status() : []);
      return result;
    } catch (error) {
      log('programs', `skill install provider=${String(provider || '')} failed:`, error.message);
      return { ok: false, code: 'install-failed', message: error.message };
    }
  });
  ipcMain.handle('program-skill-remove', (_e, provider) => {
    try {
      const result = programSkillManager ? programSkillManager.remove(provider) : { ok: false, code: 'not-ready' };
      log('programs', `skill remove provider=${String(provider || '')} ok=${!!result.ok} code=${result.code || '-'}`);
      sendArchive('program-skills:changed', programSkillManager ? programSkillManager.status() : []);
      return result;
    } catch (error) {
      log('programs', `skill remove provider=${String(provider || '')} failed:`, error.message);
      return { ok: false, code: 'remove-failed', message: error.message };
    }
  });

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
  // 分身宠上切形象 → 存各自的皮肤位；其余（主宠/面板）→ 存主形象
  ipcMain.on('set-skin', (e, skin) => {
    const agent = senderAgent(e);
    applySkin(skin, agent === 'codex' || agent === 'dsh' ? agent : null);
  });
  ipcMain.on('toggle-mute', () => { config.save({ muted: !config.get().muted }); broadcastConfig(); refreshTrayMenu(); });
  ipcMain.on('set-session-prefs', (_e, pinnedSessions, archivedSessions) => {
    config.save({ pinnedSessions, archivedSessions });
    broadcastConfig();
  });
  ipcMain.on('territory-run-now', runTerritoryNow);
  ipcMain.on('loot-codex-pet', runLootNow);
  ipcMain.on('territory-toggle-auto', () => applyTerritory(!config.get().territory));

  ipcMain.on('quit-app', () => app.quit());
  // 双宠模式：收起自己这只（独立事件——另一只和 app 都不受影响）；
  // 托盘「显示桌宠」或勾选「Codex 桌宠」随时找回来。
  ipcMain.on('close-pet', (e) => {
    const st = stateOfSender(e.sender);
    if (st && st.win && !st.win.isDestroyed()) st.win.close();
  });

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
  // dsh 起的是本地 web 界面（默认 127.0.0.1:3080），终端窗口留着看日志
  ipcMain.on('launch-dsh', () => {
    launchDsh({}).then((r) => {
      if (!r.ok) log('main', 'launch dsh failed:', r.message);
    }).catch((e) => log('main', 'launch dsh error:', e.message));
  });

  ipcMain.on('permission-decide', (_e, permId, behavior) => {
    if (behavior === 'travel:always-web') {
      const pending = permissions.getPending().find((entry) => entry.id === permId);
      if (pending && travelManager) travelManager.trustWebForSession(pending.sessionId);
      permissions.decide(permId, 'allow');
      return;
    }
    permissions.decide(permId, behavior);
  });
  ipcMain.on('focus-session', (_e, sessionId) => {
    const session = core.getSession(sessionId);
    // Codex rollout 没有终端 pid；Desktop 会话必须通过官方
    // codex:// thread deep link 定位。否则“去 Codex 选择”按钮只会
    // 调用一个注定失败的 pid focus，看起来完全没反应。
    if (session && session.agentId === 'codex') {
      shell.openExternal(`codex://threads/${encodeURIComponent(session.id)}`)
        .catch((err) => log('main', 'open Codex thread failed:', err.message));
      return;
    }
    // dsh 同样没有可依赖的终端 pid。这里只能打开通用 Web 界面，不能精确
    // focus 某条历史会话；而 headless/TUI 进程也不等于 Web 已启动，所以先
    // 确认/补开 `dsh web` 并等 HTTP 就绪，再交给系统浏览器。
    if (session && session.agentId === 'dsh') {
      ensureDshWeb({ url: DSH_WEB_URL, terminalTitle: 'LLMPET · dsh' }).then((result) => {
        if (!result.ok) {
          log('main', `open dsh web failed: ${result.status || '-'} ${result.message || ''}`);
          return;
        }
        shell.openExternal(DSH_WEB_URL)
          .catch((err) => log('main', 'open dsh web failed:', err.message));
      }).catch((err) => log('main', 'ensure dsh web failed:', err.message));
      return;
    }
    focusSession(session);
  });
  // 面板复制会话 id（跨 session 协作：把 id 贴给另一个 agent 去 resume）。
  // 桌宠列表会在 watcher 释放后短暂保留掠夺/最近会话，所以不再强制要求
  // core.getSession() 当下仍然存在；只允许安全的 session-id 字符集。
  ipcMain.handle('copy-session-id', (_e, sessionId) => {
    const id = String(sessionId || '').trim();
    if (id.length < 8 || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) return false;
    clipboard.writeText(id);
    return true;
  });
  ipcMain.handle('session-takeover', async (_e, sessionId, targetAgent) => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const target = targetAgent === 'codex' ? 'codex' : targetAgent === 'claude' ? 'claude' : '';
    const session = id && core ? core.getSession(id) : null;
    if (!sessionTakeover || !session || session.headless || session.sessionRole === 'travel') {
      return { ok: false, code: 'invalid-target' };
    }
    if (!target) return { ok: false, code: 'invalid-provider' };
    const result = await sessionTakeover.takeOver(session, target, { locale: i18n.getLang() });
    log(
      'takeover',
      `${String(session.id).slice(-8)} ${adapter.agentOf(session)}→${target} ` +
        `ok=${!!result.ok} mode=${result.mode || '-'} code=${result.code || '-'}`,
    );
    return result;
  });
  ipcMain.handle('meme-catalog', () => publicCatalog(i18n.getLang()));
  ipcMain.handle('travel-get', () => (
    travelManager ? travelManager.publicState(i18n.getLang()) : null
  ));
  ipcMain.handle('travel-postcards', () => (
    travelManager ? travelManager.publicPostcards(30) : []
  ));
  ipcMain.handle('travel-start', async (e, sessionId, templateId, mission) => {
    if (!travelManager || !core || typeof sessionId !== 'string') {
      return { ok: false, code: 'not-ready' };
    }
    const session = core.getSession(sessionId);
    if (!session || session.headless || session.ended || !session.cwd) {
      return { ok: false, code: 'invalid-target', state: travelManager.publicState(i18n.getLang()) };
    }
    const senderState = stateOfSender(e.sender);
    const agent = adapter.agentOf(session);
    if (agent !== 'claude' && agent !== 'codex') {
      return { ok: false, code: 'invalid-target', state: travelManager.publicState(i18n.getLang()) };
    }
    if (!senderState || (senderState.agent !== 'all' && senderState.agent !== agent)) {
      return { ok: false, code: 'foreign-target', state: travelManager.publicState(i18n.getLang()) };
    }
    return travelManager.start({
      agent,
      cwd: session.cwd,
      project: session.sessionTitle || path.basename(session.cwd) || String(session.id).slice(-6),
      templateId,
      mission,
      locale: i18n.getLang(),
    });
  });
  ipcMain.handle('travel-wander', async (e) => {
    if (!travelManager) return { ok: false, code: 'not-ready' };
    const senderState = stateOfSender(e.sender);
    if (!senderState) return { ok: false, code: 'foreign-target' };

    // Free wander never receives a session, cwd, project name, or transcript.
    // A split pet uses its own provider. A combined pet alternates between the
    // locally installed providers, independently of every monitored session.
    let agent = senderState.agent;
    if (agent === 'all') {
      const history = travelManager.publicState(i18n.getLang()).history || [];
      const lastWander = history.find((trip) => trip && trip.mode === 'wander');
      const order = lastWander && lastWander.agent === 'claude'
        ? ['codex', 'claude']
        : ['claude', 'codex'];
      agent = order.find((name) => {
        const cli = findCli(name);
        return path.isAbsolute(cli) && fs.existsSync(cli);
      }) || null;
    }
    if (!agent) return { ok: false, code: 'not-ready' };
    return travelManager.start({
      agent,
      mode: 'wander',
      templateId: 'free-roam',
      locale: i18n.getLang(),
    });
  });
  ipcMain.handle('travel-cancel', (e) => {
    if (!travelManager) return { ok: false, code: 'not-ready' };
    const current = travelManager.publicState(i18n.getLang()).active;
    const senderState = stateOfSender(e.sender);
    if (
      current &&
      senderState &&
      senderState.agent !== 'all' &&
      senderState.agent !== current.agent
    ) {
      return { ok: false, code: 'foreign-target', state: travelManager.publicState(i18n.getLang()) };
    }
    return travelManager.cancel();
  });
  ipcMain.handle('meme-trigger', async (e, sessionId, memeId) => {
    // The prompt itself is localized too: an English UI that fires a Chinese
    // prompt would drag the whole session into Chinese.
    const meme = getMeme(memeId, i18n.getLang());
    if (!meme) return { ok: false, submitted: false, message: t('meme.unknown') };
    const session = typeof sessionId === 'string' && core ? core.getSession(sessionId) : null;
    if (!session || session.headless || session.ended || session.state === 'sleeping') {
      return { ok: false, submitted: false, message: t('meme.targetOffline') };
    }
    const senderState = stateOfSender(e.sender);
    if (!senderState || (senderState.agent !== 'all' && adapter.agentOf(session) !== senderState.agent)) {
      return { ok: false, submitted: false, message: t('meme.targetForeign') };
    }
    const publicMeme = publicCatalog(i18n.getLang()).items.find((item) => item.id === meme.id);
    sendWin(senderState.win, 'pet:meme', {
      ...publicMeme,
      sessionId: session.id,
      project: session.sessionTitle || path.basename(session.cwd || '') || String(session.id).slice(-6),
      ts: Date.now(),
    });
    if (!commandDispatcher) return { ok: false, submitted: false, message: t('meme.noDispatcher') };
    const result = await commandDispatcher.dispatch(session, meme.prompt.text);
    log(
      'meme',
      `${meme.id} → ${String(session.id).slice(-6)} agent=${adapter.agentOf(session)} ` +
        `route=${result.route || '-'} submitted=${!!result.submitted} inputSent=${!!result.inputSent} ` +
        `detail=${result.message || '-'}`,
    );
    return {
      ...result,
      memeId: meme.id,
      sessionId: session.id,
      routeInfo: routeForSession(session),
    };
  });

  // Left-click primary action for the NON-pending case (pending is decided in
  // the renderer, which tracks what the user already answered). Backend owns
  // this because only it knows pid liveness / headless / platform:
  //   • a focusable session exists  → focus the most relevant one
  //   • sessions exist but none focusable (no pid / closed / non-mac) → open panel
  //   • no sessions at all → launch a fresh CLI
  ipcMain.on('primary-action', async (e) => {
    const agent = senderAgent(e);
    const splits = splitAgents();
    const all = core
      ? [...core.sessions.values()].filter((s) => {
        const a = adapter.agentOf(s);
        return agent === 'all' ? !splits.includes(a) : a === agent;
      })
      : [];
    // 空场时各唤各的：Codex 宠拉 codex，dsh 宠拉 `dsh web`，其余拉 claude
    if (!all.length) {
      const launcher = agent === 'codex' ? launchCodex : agent === 'dsh' ? launchDsh : launchClaude;
      launcher({}).catch(() => {});
      return;
    }
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
  ipcMain.on('set-pet-size', (e, w, h, anchor) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = (Number(w) > 0 && Number(h) > 0) ? { w: Number(w), h: Number(h) } : null;
    applyPetSize(st, anchor);
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
    const st = stateOfSender(e.sender);
    const w = st && st.win && !st.win.isDestroyed() ? st.win : null;
    if (!w) return;
    st.mouseIgnoring = !!ignore; // 记录 renderer 期望的穿透状态(巡视结束后恢复用)
    // 巡视拖拽期间主宠强制穿透：renderer 只能更新“结束后想要的状态”，
    // 不能把最高层章鱼重新变成可点击并挡住目标。Codex 分身不受巡视约束。
    if (territoryClickThrough && w === petWin) return;
    try { w.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {}
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
  if (agent === 'codex') config.save({ skinCodex: skin });
  else if (agent === 'dsh') config.save({ skinDsh: skin });
  else config.save({ skin });
  broadcastConfig();
  refreshTrayMenu();
}

// 补齐当前设置应有的窗口（被单独收起的宠从托盘找回来）。主宠身份变化
// (all⇄claude)时原地重载渲染器——不销毁窗口，位置不动、分身不闪。
function ensurePetWindows() {
  const duo = config.get().petMode === 'duo';
  const primaryAgent = duo ? 'claude' : 'all';
  if (!petWin || petWin.isDestroyed()) {
    petWin = makePetWindow(primaryAgent);
  } else {
    const st = petState.get(petWin.webContents.id);
    if (st && st.agent !== primaryAgent) {
      st.agent = primaryAgent;
      st.customSize = null; st.visualRect = null; st.uiBusy = false; st.mouseIgnoring = true;
      petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'), { query: { agent: primaryAgent } });
      applyPetSize(st);
    }
  }
  if (duo) {
    if (!petWinCodex || petWinCodex.isDestroyed()) petWinCodex = makePetWindow('codex');
  } else if (petWinCodex) {
    const gone = petWinCodex;
    petWinCodex = null;
    try { if (!gone.isDestroyed()) gone.destroy(); } catch {}
  }
  if (config.get().dshPet === true) {
    if (!petWinDsh || petWinDsh.isDestroyed()) petWinDsh = makePetWindow('dsh');
  } else if (petWinDsh) {
    const gone = petWinDsh;
    petWinDsh = null;
    try { if (!gone.isDestroyed()) gone.destroy(); } catch {}
  }
}

// 单宠 ⇄ 双宠切换（托盘复选「Codex 桌宠」）：勾选出现、取消隐藏
function applyPetMode(petMode) {
  if (config.get().petMode === petMode) return;
  config.save({ petMode });
  ensurePetWindows();
  if (config.get().mode === 'menubar') { for (const st of petStates()) st.win.hide(); }
  broadcastConfig();
  refreshTrayMenu();
  emitStats(); // 主宠的会话集合跟着变（分出去/收回来），立刻重推一次
  log('main', `petMode → ${petMode}`);
}

// dsh 宠开关（托盘复选「dsh 桌宠」）：与 Codex 宠互不影响
function applyDshPet(enabled) {
  const want = enabled === true;
  if (config.get().dshPet === want) return;
  config.save({ dshPet: want });
  ensurePetWindows();
  if (config.get().mode === 'menubar') { for (const st of petStates()) st.win.hide(); }
  broadcastConfig();
  refreshTrayMenu();
  emitStats();
  log('main', `dshPet → ${want}`);
}
// Language switch (tray → Settings → Language). Main-process copy is baked into
// the strings the adapter already pushed, so a plain re-broadcast would leave
// stale labels on screen until the next session event — force a fresh stats
// emit so every list, badge and bubble re-renders in the new language at once.
function applyLang(lang) {
  if (config.get().lang === lang) return;
  config.save({ lang });
  i18n.setLang(lang);
  broadcastConfig();
  emitStats();
  refreshTrayMenu();
  log('main', `lang → ${lang}`);
}

// ── tray ──────────────────────────────────────────────────────────────────────
function buildTray() {
  let img;
  try {
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    if (process.platform === 'darwin') img.setTemplateImage(true);
  } catch {}
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip(t('tray.tooltip'));
  refreshTrayMenu();
  tray.on('click', () => { ensurePetWindows(); for (const st of petStates()) st.win.show(); });
}

function refreshTrayMenu() {
  if (!tray) return;
  const cfg = config.get();
  const muted = cfg.muted;
  const skin = cfg.skin || 'mascot';
  const mode = cfg.mode || 'pet';
  const petMode = cfg.petMode || 'single';
  const skinCodex = cfg.skinCodex || 'cat';
  const dshPet = cfg.dshPet === true;
  const skinDsh = cfg.skinDsh || 'pixel';
  const lang = cfg.lang || 'zh';
  tray.setToolTip(t('tray.tooltip'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.panel'), click: openPanel },
    { label: t('tray.archive'), click: openArchive },
    { label: t('tray.showPet'), click: () => { ensurePetWindows(); for (const st of petStates()) st.win.show(); } },
    // 复选开关：勾上 = 双宠（Codex 分身出现），取消 = 单宠（一只盯全部后端）
    { label: t('tray.codexPet'), type: 'checkbox', checked: petMode === 'duo',
      click: () => applyPetMode(config.get().petMode === 'duo' ? 'single' : 'duo') },
    // dsh（DeepSeek Harness）宠：独立开关，和 Codex 宠可同开
    { label: t('tray.dshPet'), type: 'checkbox', checked: dshPet,
      click: () => applyDshPet(config.get().dshPet !== true) },
    { type: 'separator' },
    { label: t('tray.settings'), enabled: false },
    { label: t('tray.language'), submenu: i18n.LANGS.map((code) => ({
      label: t('lang.' + code), type: 'radio', checked: lang === code, click: () => applyLang(code),
    })) },
    { label: t('tray.agentStartup'), submenu: [
      { label: t('tray.agentStartupClaude'), type: 'checkbox', checked: cfg.agentStartup.claude === true,
        click: () => setAgentStartup('claude', config.get().agentStartup.claude !== true) },
      { label: t('tray.agentStartupCodex'), type: 'checkbox', checked: cfg.agentStartup.codex === true,
        click: () => setAgentStartup('codex', config.get().agentStartup.codex !== true) },
      { label: t('tray.agentStartupDsh'), type: 'checkbox', checked: cfg.agentStartup.dsh === true,
        click: () => setAgentStartup('dsh', config.get().agentStartup.dsh !== true) },
      { type: 'separator' },
      { label: t('tray.agentStartupNow'), click: () => runAgentStartup() },
    ] },
    { label: petMode === 'duo' || dshPet ? t('tray.skinClaude') : t('tray.skin'), submenu: [
      { label: t('skin.mascot'), type: 'radio', checked: skin === 'mascot', click: () => applySkin('mascot') },
      { label: t('skin.pixel'), type: 'radio', checked: skin === 'pixel', click: () => applySkin('pixel') },
      { label: t('skin.cat'), type: 'radio', checked: skin === 'cat', click: () => applySkin('cat') },
      { label: t('skin.whale'), type: 'radio', checked: skin === 'whale', click: () => applySkin('whale') },
    ] },
    ...(petMode === 'duo' ? [{ label: t('tray.skinCodex'), submenu: [
      { label: t('skin.mascot'), type: 'radio', checked: skinCodex === 'mascot', click: () => applySkin('mascot', 'codex') },
      { label: t('skin.pixel'), type: 'radio', checked: skinCodex === 'pixel', click: () => applySkin('pixel', 'codex') },
      { label: t('skin.cat'), type: 'radio', checked: skinCodex === 'cat', click: () => applySkin('cat', 'codex') },
      { label: t('skin.whale'), type: 'radio', checked: skinCodex === 'whale', click: () => applySkin('whale', 'codex') },
    ] }] : []),
    ...(dshPet ? [{ label: t('tray.skinDsh'), submenu: [
      { label: t('skin.mascot'), type: 'radio', checked: skinDsh === 'mascot', click: () => applySkin('mascot', 'dsh') },
      { label: t('skin.pixel'), type: 'radio', checked: skinDsh === 'pixel', click: () => applySkin('pixel', 'dsh') },
      { label: t('skin.cat'), type: 'radio', checked: skinDsh === 'cat', click: () => applySkin('cat', 'dsh') },
      { label: t('skin.whale'), type: 'radio', checked: skinDsh === 'whale', click: () => applySkin('whale', 'dsh') },
    ] }] : []),
    { label: t('tray.shape'), submenu: [
      { label: t('shape.pet'), type: 'radio', checked: mode === 'pet', click: () => applyMode('pet') },
      { label: t('shape.panel'), type: 'radio', checked: mode === 'panel', click: () => applyMode('panel') },
      { label: t('shape.menubar'), type: 'radio', checked: mode === 'menubar', click: () => applyMode('menubar') },
    ] },
    ...(process.platform === 'darwin' ? [
      { label: t('tray.patrol'), type: 'checkbox', checked: !!cfg.territory,
        click: () => applyTerritory(!config.get().territory) },
      { label: t('tray.patrolNow'), click: runTerritoryNow },
    ] : []),
    { label: muted ? t('tray.unmute') : t('tray.mute'), click: () => { config.save({ muted: !muted }); broadcastConfig(); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: t('tray.launchClaude'), click: () => launchClaude({}).catch(() => {}) },
    { label: t('tray.launchCodex'), click: () => launchCodex({}).catch(() => {}) },
    { label: t('tray.launchDsh'), click: () => launchDsh({}).catch(() => {}) },
    { label: t('tray.openLog'), click: () => shell.openPath(LOG_PATH) },
    { type: 'separator' },
    { label: t('tray.uninstallHook'), click: () => {
      // Stop the settings watcher first — otherwise it sees our hooks vanish and
      // re-registers them within 800ms, silently undoing this uninstall.
      try { if (stopWatcher) { stopWatcher(); stopWatcher = null; } } catch {}
      hooks.uninstall();
    } },
    { label: t('tray.quit'), click: () => app.quit() },
  ]));
}

function setAgentStartup(agent, enabled) {
  if (!['claude', 'codex', 'dsh'].includes(agent)) return;
  const current = config.get().agentStartup;
  config.save({ agentStartup: { ...current, [agent]: enabled === true } });
  broadcastConfig();
  refreshTrayMenu();
  log('startup', `${agent} auto-start → ${enabled === true}`);
}

function runAgentStartup(options = {}) {
  if (!agentStartup) return Promise.resolve([]);
  return agentStartup.run(options).catch((error) => {
    log('startup', 'unified agent startup failed:', error.message);
    return [];
  });
}

// Historical compatibility namespace: move the oldest ~/.llmpet data into
// ~/.octopus. The public brand is LLMPET, but this path stays stable so upgrades
// preserve usage history, config, installed hooks and permissions.
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
  app.on('second-instance', () => {
    try { for (const st of petStates()) st.win.show(); } catch {}
    openArchive();
  });
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
      const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.icns'));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
      await app.dock.show();
    }
    const rival = await findRivalInstance();
    if (rival) {
      log('main', `another LLMPET server is live on 127.0.0.1:${rival} — quitting (OCTOPUS_ALLOW_MULTI=1 to bypass)`);
      dialog.showErrorBox(
        t('dlg.dupTitle'),
        t('dlg.dupBody', { port: rival }) + t('dlg.dupHint')
      );
      app.quit();
      return;
    }
    migrateState();
    registerIpc();
    bootBackend();
    agentStartup = createAgentStartup({
      getSettings: () => config.get().agentStartup,
      onResult: (result) => log('startup', `${result.agent}: ${result.status}${result.message ? ` (${result.message})` : ''}`),
    });
    createPetWindows();
    startMemeWatcher();
    bootTerritory();
    try { buildTray(); } catch (e) { log('main', 'tray unavailable:', e.message); }
    // Let the pet and tray become responsive first; startup failures are
    // isolated and never block LLMPET's own ready path.
    setTimeout(() => runAgentStartup(), 700).unref?.();
    // LLMPET now has a real desktop library. The initial launch remains pet-only,
    // while a later Dock click always opens or focuses the archive window.
    app.on('activate', openArchive);
    log('main', 'LLMPET ready');
  });
}

app.on('window-all-closed', () => { /* tray app: stay alive */ });

app.on('before-quit', () => {
  try { if (territory) territory.stop(); } catch {}
  try { if (travelManager) travelManager.shutdown(); } catch {}
  try { if (sessionArchive) sessionArchive.stop(); } catch {}
  try { if (programRegistry) programRegistry.stop(); } catch {}
  try { if (runtimeMonitor) runtimeMonitor.stop(); } catch {}
  try { if (codexWatch) codexWatch.stop(); } catch {}
  try { if (dshWatch) dshWatch.stop(); } catch {}
  try { if (stopMemeWatcher) stopMemeWatcher(); } catch {}
  try { if (stopWatcher) stopWatcher(); } catch {}
  try { if (permissions) permissions.cleanup(); } catch {}
  try { if (server) server.stop(); } catch {}
  try { if (metering) metering.stop(); } catch {}
  try { if (codexMetering) codexMetering.stop(); } catch {}
  try { if (pricingSync) pricingSync.stop(); } catch {}
  try { if (core) core.stopStaleCleanup(); } catch {}
  log('main', 'LLMPET quit');
});
