'use strict';

// Persisted app config. Shape matches the frontend contract (preload README §4):
//   { mode, skin, petPosition, budget5h, muted, permHook }
// Stored atomically under ~/.octopus/config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');

const CONFIG_DIR = path.join(os.homedir(), '.octopus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  mode: 'pet',            // 'pet' | 'panel' | 'menubar'
  skin: 'mascot',         // 'mascot' | 'pixel'
  petPosition: null,      // {x,y} | null
  budget5h: 10,           // USD — kept for forward-compat; pricing is deferred
  muted: false,
  permHook: true,         // whether the blocking permission HTTP hook is active
});

let cache = null;

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (['pet', 'panel', 'menubar'].includes(raw.mode)) out.mode = raw.mode;
  if (['mascot', 'pixel'].includes(raw.skin)) out.skin = raw.skin;
  if (raw.petPosition && Number.isFinite(raw.petPosition.x) && Number.isFinite(raw.petPosition.y)) {
    out.petPosition = { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) };
  }
  if (Number.isFinite(raw.budget5h) && raw.budget5h >= 0) out.budget5h = raw.budget5h;
  out.muted = !!raw.muted;
  out.permHook = raw.permHook !== false;
  return out;
}

function load() {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
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
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    log('config', 'save failed:', err.message);
  }
  return cache;
}

function get() { return load(); }

module.exports = { get, save, CONFIG_PATH, DEFAULTS };
