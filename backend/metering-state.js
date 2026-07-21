'use strict';

// Defensive persistence helpers shared by Claude and CodeWhale metering.
// Metering state is local, but it is derived from transcript/hook data and may
// also be truncated or manually edited. Treat it as untrusted at load time so a
// corrupt file cannot create prototype keys, NaN/Infinity values, or unbounded
// in-memory collections.

const fs = require('fs');

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_METRIC = 1e15;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function dict() { return Object.create(null); }
function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function finiteNonNegative(v, max = MAX_METRIC) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

function safeMapKey(value, fallback = '', maxLength = 512) {
  const key = String(value == null ? '' : value).trim().slice(0, maxLength);
  if (!key || UNSAFE_KEYS.has(key) || /[\0\r\n]/.test(key)) return fallback;
  return key;
}

function validDayKey(key) {
  return typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key);
}

function metricRow(value) {
  const v = isRecord(value) ? value : {};
  return {
    cost: finiteNonNegative(v.cost, 1e12),
    tokens: finiteNonNegative(v.tokens),
    msgs: Math.floor(finiteNonNegative(v.msgs, 1e12)),
    input: finiteNonNegative(v.input),
    output: finiteNonNegative(v.output),
    cacheCreate: finiteNonNegative(v.cacheCreate),
    cacheRead: finiteNonNegative(v.cacheRead),
  };
}

function cleanDailyMap(raw) {
  const out = dict();
  if (!isRecord(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (++count > 366 || !validDayKey(key)) continue;
    out[key] = metricRow(value);
  }
  return out;
}

function cleanByModelMap(raw) {
  const out = dict();
  if (!isRecord(raw)) return out;
  let dayCount = 0;
  for (const [day, models] of Object.entries(raw)) {
    if (++dayCount > 366 || !validDayKey(day) || !isRecord(models)) continue;
    const cleanModels = dict();
    let modelCount = 0;
    for (const [rawModel, value] of Object.entries(models)) {
      if (++modelCount > 2048) break;
      const model = safeMapKey(rawModel, '', 256);
      if (!model) continue;
      cleanModels[model] = metricRow(value);
    }
    out[day] = cleanModels;
  }
  return out;
}

function cleanHourlyMap(raw) {
  const out = dict();
  if (!isRecord(raw)) return out;
  let count = 0;
  for (const [day, hours] of Object.entries(raw)) {
    if (++count > 366 || !validDayKey(day) || !Array.isArray(hours)) continue;
    out[day] = Array.from({ length: 24 }, (_, i) => finiteNonNegative(hours[i], 1e12));
  }
  return out;
}

function cleanRecent(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(-20000)) {
    if (!isRecord(item)) continue;
    const ts = Number(item.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    out.push({ ts, cost: finiteNonNegative(item.cost, 1e12), tokens: finiteNonNegative(item.tokens) });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function cleanCursors(raw) {
  const out = dict();
  if (!isRecord(raw)) return out;
  let count = 0;
  for (const [rawKey, value] of Object.entries(raw)) {
    if (++count > 20000) break;
    const key = safeMapKey(rawKey, '', 4096);
    if (!key) continue;
    out[key] = Math.floor(finiteNonNegative(value, Number.MAX_SAFE_INTEGER));
  }
  return out;
}

function cleanSeen(raw) {
  const out = dict();
  if (!isRecord(raw)) return out;
  const entries = Object.entries(raw).slice(-200000);
  for (const [rawKey, day] of entries) {
    const key = safeMapKey(rawKey, '', 4096);
    if (!key || !validDayKey(day)) continue;
    out[key] = day;
  }
  return out;
}

function readJsonBounded(filePath, maxBytes = MAX_STATE_BYTES) {
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size < 0 || st.size > maxBytes) {
    const err = new Error(`state file exceeds ${maxBytes} bytes`);
    err.code = 'ESTATEBIG';
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  MAX_STATE_BYTES,
  dict,
  isRecord,
  finiteNonNegative,
  safeMapKey,
  metricRow,
  cleanDailyMap,
  cleanByModelMap,
  cleanHourlyMap,
  cleanRecent,
  cleanCursors,
  cleanSeen,
  readJsonBounded,
};
