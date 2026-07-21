'use strict';

// Persisted app config. Shape matches the frontend contract (preload README §4):
//   { mode, skin, petPosition, budget5h, muted, permHook }
// Stored atomically under ~/.octopus/config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');
const { readJsonBoundedSync } = require('./safe-json');

const CONFIG_DIR = path.join(os.homedir(), '.octopus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const MAX_CONFIG_BYTES = 1024 * 1024;

const DEFAULTS = Object.freeze({
  mode: 'pet',            // 'pet' | 'panel' | 'menubar'
  skin: 'mascot',         // 'mascot' | 'pixel' | 'cat'
  petPosition: null,      // {x,y} | null
  budget5h: 10,           // USD — kept for forward-compat; pricing is deferred
  muted: false,
  permHook: true,         // whether the blocking permission HTTP hook is active
  territory: false,       // 领地模式:发现别的桌宠就顶到屏幕边上(macOS,需辅助功能权限)
  territoryRivals: [],    // 用户自定义的对手进程名特征(叠加在内置名单上)
  currency: 'USD',        // 显示币种: 'USD' ($) 或 'CNY' (¥)
  fxRate: 7.2,           // 汇率: 1 USD = 7.2 CNY（CNY 显示时转换用）
  providers: ['claude'],  // active provider ids (read by providers/index.js)
});

let cache = null;

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (['pet', 'panel', 'menubar'].includes(raw.mode)) out.mode = raw.mode;
  if (['mascot', 'pixel', 'cat'].includes(raw.skin)) out.skin = raw.skin;
  if (raw.petPosition && Number.isFinite(raw.petPosition.x) && Number.isFinite(raw.petPosition.y)) {
    out.petPosition = { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) };
  }
  if (Number.isFinite(raw.budget5h) && raw.budget5h >= 0) out.budget5h = Math.min(100000, raw.budget5h);
  out.muted = !!raw.muted;
  out.permHook = raw.permHook !== false;
  out.territory = !!raw.territory;
  // 币种配置：USD 或 CNY；旧 config 无此字段时默认为 USD
  if (raw.currency === 'USD' || raw.currency === 'CNY') out.currency = raw.currency;
  if (Number.isFinite(raw.fxRate) && raw.fxRate > 0) out.fxRate = Math.min(100, Math.max(0.01, raw.fxRate));
  if (Array.isArray(raw.territoryRivals)) {
    out.territoryRivals = raw.territoryRivals
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, 64)) // 单条封顶:超长字符串没有匹配意义,还会拖慢 osascript
      .slice(0, 30);
  }
  // Round 8: providers array — list of known provider ids (e.g. ['claude','codewhale']).
  // W22: claude is no longer forced — users can disable it to "unlock" Claude
  // Code from the pet's permission hook. Any non-empty subset of known ids is
  // accepted (must keep at least one to show anything).
  if (Array.isArray(raw.providers) && raw.providers.length) {
    const KNOWN = new Set(['claude', 'codewhale', 'aider']);
    const ids = raw.providers
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => KNOWN.has(s));
    if (ids.length) out.providers = ids;
  }
  return out;
}

function load() {
  if (cache) return cache;
  try {
    cache = sanitize(readJsonBoundedSync(CONFIG_PATH, MAX_CONFIG_BYTES));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(partial) {
  cache = sanitize({ ...load(), ...partial });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch {}
    const tmp = path.join(CONFIG_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, CONFIG_PATH);
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch (err) {
    log('config', 'save failed:', err.message);
  }
  return cache;
}

function get() { return load(); }

module.exports = { get, save, CONFIG_PATH, DEFAULTS, MAX_CONFIG_BYTES, _sanitize: sanitize };
