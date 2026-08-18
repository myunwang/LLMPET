'use strict';

// Persisted app config. Shape matches the frontend contract (preload README §4):
//   { mode, skin, petPosition, muted, permHook }
// Stored atomically under ~/.octopus/config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');

const CONFIG_DIR = path.join(os.homedir(), '.octopus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  mode: 'pet',            // 'pet' | 'panel' | 'menubar'
  skin: 'mascot',         // 见 SKINS
  petPosition: null,      // {x,y} | null
  muted: false,
  permHook: true,         // whether the blocking permission HTTP hook is active
  territory: false,       // 领地模式:发现别的桌宠就顶到屏幕边上(macOS,需辅助功能权限)
  territoryRivals: [],    // 用户自定义的对手进程名特征(叠加在内置名单上)
  petMode: 'single',      // 'single' 一只宠监控全部后端 | 'duo' Claude/Codex 各一只
  skinCodex: 'cat',       // 双宠模式里 Codex 宠的形象（和主形象错开才认得出谁是谁）
  petPositionCodex: null, // {x,y} | null — Codex 宠的落脚点
  // dsh（DeepSeek Harness）宠是独立开关，不并进 petMode：Codex 宠开不开与
  // dsh 宠开不开互不影响，四种组合都成立（主宠始终兜住没被分出去的后端）。
  dshPet: false,
  skinDsh: 'pixel',       // dsh 宠默认像素怪兽：和主宠(章鱼)/Codex 宠(月薪喵)三者错开
  petPositionDsh: null,   // {x,y} | null — dsh 宠的落脚点
  lang: 'zh',             // 'zh' | 'en' | 'ja' — 界面与表情包文案语言
  pinnedSessions: [],     // 会话 HUD 置顶项（按稳定 session id）
  archivedSessions: [],   // 会话 HUD 归档项（不影响后端任务本身）
  lootCapturedSessions: [], // 掠夺会话快照：限时留在普通会话列表，过期自动隐藏
  sessionArchive: {       // 全量历史档案馆；备份必须由用户明确开启
    backupEnabled: false,
    backupIntervalHours: 24,
  },
  agentStartup: {         // LLMPET 启动时，只补拉起当前没有运行的交互式 CLI
    claude: true,
    codex: true,
    dsh: false,           // dsh 默认不自动拉起：它起的是本地 web 服务，会开浏览器
  },
});

let cache = null;

function sanitizeSessionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim().slice(0, 256)))]
    .slice(0, 300);
}

function sanitizeLootCapturedSessions(value, now = Date.now()) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const states = new Set([
    'waiting', 'needsinput', 'working', 'juggling', 'sweeping', 'thinking',
    'loafing', 'error', 'idle', 'sleeping',
  ]);
  const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  const out = [];
  for (const session of value) {
    if (!session || typeof session !== 'object') continue;
    const sessionId = text(session.sessionId || session.id, 256).trim();
    if (!sessionId || seen.has(sessionId)
        || !Number.isFinite(session.expiresAt) || session.expiresAt <= now) continue;
    seen.add(sessionId);
    out.push({
      sessionId,
      project: text(session.project, 240),
      cwd: text(session.cwd, 1024),
      agent: 'codex',
      state: states.has(session.state) ? session.state : 'idle',
      badge: text(session.badge, 32),
      op: text(session.op, 240),
      reason: text(session.reason, 240),
      contextPercent: Number.isFinite(session.contextPercent)
        ? Math.min(100, Math.max(0, Math.round(session.contextPercent))) : null,
      idleMs: Number.isFinite(session.idleMs) ? Math.max(0, session.idleMs) : 0,
      updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : 0,
      capturedAt: Number.isFinite(session.capturedAt) ? session.capturedAt : now,
      expiresAt: session.expiresAt,
    });
    if (out.length >= 12) break;
  }
  return out;
}

// 皮肤白名单只此一份：渲染端 applySkin 和托盘菜单都以它为准，
// 少改一处就会出现"菜单能点、设置存不下"的静默回落。
const SKINS = ['mascot', 'pixel', 'cat', 'whale'];

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (['pet', 'panel', 'menubar'].includes(raw.mode)) out.mode = raw.mode;
  if (SKINS.includes(raw.skin)) out.skin = raw.skin;
  if (raw.petPosition && Number.isFinite(raw.petPosition.x) && Number.isFinite(raw.petPosition.y)) {
    out.petPosition = { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) };
  }
  out.muted = !!raw.muted;
  out.permHook = raw.permHook !== false;
  out.territory = !!raw.territory;
  if (Array.isArray(raw.territoryRivals)) {
    out.territoryRivals = raw.territoryRivals
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, 64)) // 单条封顶:超长字符串没有匹配意义,还会拖慢 osascript
      .slice(0, 30);
  }
  if (raw.petMode === 'duo' || raw.petMode === 'single') out.petMode = raw.petMode;
  if (SKINS.includes(raw.skinCodex)) out.skinCodex = raw.skinCodex;
  if (raw.petPositionCodex && Number.isFinite(raw.petPositionCodex.x) && Number.isFinite(raw.petPositionCodex.y)) {
    out.petPositionCodex = { x: Math.round(raw.petPositionCodex.x), y: Math.round(raw.petPositionCodex.y) };
  }
  out.dshPet = raw.dshPet === true;
  if (SKINS.includes(raw.skinDsh)) out.skinDsh = raw.skinDsh;
  if (raw.petPositionDsh && Number.isFinite(raw.petPositionDsh.x) && Number.isFinite(raw.petPositionDsh.y)) {
    out.petPositionDsh = { x: Math.round(raw.petPositionDsh.x), y: Math.round(raw.petPositionDsh.y) };
  }
  if (['zh', 'en', 'ja'].includes(raw.lang)) out.lang = raw.lang;
  out.pinnedSessions = sanitizeSessionIds(raw.pinnedSessions);
  out.archivedSessions = sanitizeSessionIds(raw.archivedSessions)
    .filter((id) => !out.pinnedSessions.includes(id));
  out.lootCapturedSessions = sanitizeLootCapturedSessions(raw.lootCapturedSessions);
  if (raw.sessionArchive && typeof raw.sessionArchive === 'object') {
    out.sessionArchive = {
      backupEnabled: raw.sessionArchive.backupEnabled === true,
      backupIntervalHours: [6, 12, 24, 72, 168].includes(Number(raw.sessionArchive.backupIntervalHours))
        ? Number(raw.sessionArchive.backupIntervalHours)
        : DEFAULTS.sessionArchive.backupIntervalHours,
    };
  }
  if (raw.agentStartup && typeof raw.agentStartup === 'object') {
    out.agentStartup = {
      claude: raw.agentStartup.claude !== false,
      codex: raw.agentStartup.codex !== false,
      dsh: raw.agentStartup.dsh === true,
    };
  }
  return out;
}

function load() {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(partial) {
  cache = sanitize({ ...load(), ...partial });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = path.join(CONFIG_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch (err) {
    log('config', 'save failed:', err.message);
  }
  return cache;
}

function get() { return load(); }

module.exports = { get, save, sanitize, CONFIG_PATH, DEFAULTS };
