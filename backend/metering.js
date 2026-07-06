'use strict';

// Metering + billing for Claude Code usage.
//
// Claude Code writes a transcript JSONL per session under
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Each assistant turn line carries message.usage (input / output / cache tokens)
// and message.model. We incrementally tail every transcript (byte cursor per
// file), dedupe each assistant message by message.id (the SAME id is written on
// multiple streaming lines — double-counting if not deduped), attribute the
// usage to its local day/hour/model by the line timestamp, and price it with a
// per-model-family table. Aggregates persist to ~/.octopus/usage.json so history
// (the 90-day calendar) survives restarts; the first run backfills from the
// existing transcripts (last 95 days).
//
// Same idea as the ccusage tool: read only token counts + model + timestamps
// from the transcripts (never message content), then price them.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { log } = require('./log');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const STATE_DIR = path.join(os.homedir(), '.octopus');
const STATE_PATH = path.join(STATE_DIR, 'usage.json');
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'pricing.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json'); // LiteLLM 同步缓存

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 60 * 1000;     // Claude's 5h rate window (approx)
const DAILY_KEEP_DAYS = 95;
const RECENT_KEEP_MS = WINDOW_MS + 30 * 60 * 1000;
const BACKFILL_MS = DAILY_KEEP_DAYS * DAY_MS;

// USD per 1,000,000 tokens. Estimates — override via ~/.octopus/pricing.json:
//   { "opus": {"input":15,"output":75,"cacheWrite":18.75,"cacheRead":1.5}, ... }
const DEFAULT_PRICING = {
  opus:    { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet:  { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:   { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
  default: { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
};

// Priority: user manual override > LiteLLM sync cache > built-in defaults.
// Family-level shallow merge — sub-keys (input/output/cacheWrite/cacheRead)
// from a higher layer replace the same key in a lower layer; missing sub-keys
// keep the lower-layer value. So a stale cache can't zero-out a missing field.
function loadPricing() {
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  // layer 1: synced cache (~/.octopus/pricing-cache.json)
  try {
    const c = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (c && c.pricing && typeof c.pricing === 'object') {
      for (const [fam, row] of Object.entries(c.pricing)) {
        if (out[fam] && row && typeof row === 'object') {
          for (const k of Object.keys(out[fam])) if (Number.isFinite(row[k])) out[fam][k] = row[k];
        }
      }
    }
  } catch {}
  // layer 2: user override (~/.octopus/pricing.json) — wins
  try {
    const raw = JSON.parse(fs.readFileSync(PRICING_OVERRIDE_PATH, 'utf8'));
    for (const [fam, row] of Object.entries(raw)) {
      if (row && typeof row === 'object') out[fam] = { ...(out[fam] || {}), ...row };
    }
  } catch {}
  return out;
}

function priceFor(pricing, model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return pricing.opus;
  if (m.includes('sonnet')) return pricing.sonnet;
  if (m.includes('haiku')) return pricing.haiku;
  return pricing.default;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay() {
  return { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function createMetering() {
  let pricing = loadPricing();

  // Persisted state.
  let state = {
    cursors: {},          // filePath -> byte offset already consumed
    seen: {},             // `${msgId}|${requestId}` -> dayKey, dedupe across files/runs
    daily: {},            // 'YYYY-MM-DD' -> { cost, tokens, msgs, input, output, cacheCreate, cacheRead }
    byModelByDay: {},     // 'YYYY-MM-DD' -> { model: { cost, tokens } }
    hourlyByDay: {},      // 'YYYY-MM-DD' -> [24] cost
    recent: [],           // [{ ts, cost, tokens }] within RECENT_KEEP_MS, for window5h
  };
  let scanning = false;
  let dirty = false;
  let saveTimer = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.cursors = raw.cursors && typeof raw.cursors === 'object' ? raw.cursors : {};
        state.seen = raw.seen && typeof raw.seen === 'object' ? raw.seen : {};
        state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
        state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
        state.hourlyByDay = raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {};
        state.recent = Array.isArray(raw.recent) ? raw.recent : [];
      }
    } catch {}
    pruneDaily();
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function saveNow() {
    dirty = false;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = path.join(STATE_DIR, `.usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, STATE_PATH);
    } catch (err) {
      log('meter', 'save failed:', err.message);
    }
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - BACKFILL_MS);
    for (const k of Object.keys(state.daily)) if (k < cutoff) delete state.daily[k];
    for (const k of Object.keys(state.byModelByDay)) if (k < cutoff) delete state.byModelByDay[k];
    for (const k of Object.keys(state.hourlyByDay)) if (k < cutoff) delete state.hourlyByDay[k];
    // Bound the dedupe set to the retention window (dayKey values sort lexically).
    for (const k of Object.keys(state.seen)) if (state.seen[k] < cutoff) delete state.seen[k];
  }

  // Add one deduped assistant usage record into the aggregates.
  function record(tsMs, model, usage) {
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    const cacheCreate = num(usage.cache_creation_input_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const tokens = input + output + cacheCreate + cacheRead;
    if (tokens <= 0) return;

    const p = priceFor(pricing, model);
    const cost = (input * p.input + output * p.output + cacheCreate * p.cacheWrite + cacheRead * p.cacheRead) / 1e6;

    const k = dayKey(tsMs);
    const d = (state.daily[k] = state.daily[k] || emptyDay());
    d.cost += cost; d.tokens += tokens; d.msgs += 1;
    d.input += input; d.output += output; d.cacheCreate += cacheCreate; d.cacheRead += cacheRead;

    const fam = (state.byModelByDay[k] = state.byModelByDay[k] || {});
    const mk = model || 'unknown';
    const mv = (fam[mk] = fam[mk] || { cost: 0, tokens: 0 });
    mv.cost += cost; mv.tokens += tokens;

    const hours = (state.hourlyByDay[k] = state.hourlyByDay[k] || new Array(24).fill(0));
    hours[new Date(tsMs).getHours()] += cost;

    if (Date.now() - tsMs < RECENT_KEEP_MS) state.recent.push({ ts: tsMs, cost, tokens });
  }

  function pruneRecent() {
    const cutoff = Date.now() - RECENT_KEEP_MS;
    if (state.recent.length && state.recent[0].ts < cutoff) {
      state.recent = state.recent.filter((r) => r.ts >= cutoff);
    }
  }

  // Read appended bytes since the stored cursor, returning complete lines only.
  async function readNewLines(file, fromOffset, size) {
    if (size <= fromOffset) return { lines: [], newOffset: size < fromOffset ? 0 : fromOffset };
    const fh = await fsp.open(file, 'r');
    try {
      const len = size - fromOffset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, fromOffset);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return { lines: [], newOffset: fromOffset }; // no complete line yet
      const consumed = text.slice(0, lastNl);
      return { lines: consumed.split('\n'), newOffset: fromOffset + Buffer.byteLength(consumed, 'utf8') + 1 };
    } finally {
      await fh.close();
    }
  }

  async function scanFile(file) {
    let st;
    try { st = await fsp.stat(file); } catch { return; }
    if (st.mtimeMs < Date.now() - BACKFILL_MS) return; // too old to matter
    let offset = state.cursors[file] || 0;
    if (offset > st.size) offset = 0; // file truncated/rotated
    if (st.size <= offset) return;

    const { lines, newOffset } = await readNewLines(file, offset, st.size);
    for (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123) continue; // fast skip non-'{' lines
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'assistant') continue;
      const msg = o.message;
      const usage = msg && msg.usage;
      if (!usage || typeof usage !== 'object') continue;
      const id = msg.id || `${o.requestId || ''}:${o.timestamp || ''}`;
      const key = `${id}|${o.requestId || ''}`;
      // Dedupe globally, not just within this batch: streaming writes the same id
      // on several lines, and resume/fork copies prior turns (same id) into a NEW
      // file — a per-batch Set missed both of those and double-billed the tokens.
      if (state.seen[key]) continue;
      const tsMs = o.timestamp ? Date.parse(o.timestamp) : st.mtimeMs;
      if (!Number.isFinite(tsMs)) continue;
      state.seen[key] = dayKey(tsMs);
      record(tsMs, msg.model || 'unknown', usage);
    }
    state.cursors[file] = newOffset;
  }

  async function listTranscripts() {
    const out = [];
    let dirs;
    try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sub = path.join(PROJECTS_DIR, d.name);
      let files;
      try { files = await fsp.readdir(sub); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(sub, f));
    }
    return out;
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const files = await listTranscripts();
      for (const file of files) {
        // Isolate per file: a single unreadable/poison transcript must not abort
        // the whole loop and starve every file after it, scan after scan.
        try { await scanFile(file); } catch (e) { log('meter', 'scanFile failed:', file, e.message); }
      }
      pruneRecent();
      pruneDaily();
      scheduleSave();
    } catch (err) {
      log('meter', 'scan error:', err.message);
    } finally {
      scanning = false;
    }
  }

  function getStats() {
    const todayK = dayKey(Date.now());
    const today = { ...emptyDay(), ...(state.daily[todayK] || {}) };
    const byModel = state.byModelByDay[todayK] ? { ...state.byModelByDay[todayK] } : {};
    const hourly = (state.hourlyByDay[todayK] || new Array(24).fill(0)).slice();

    // Rolling 5h window from recent events.
    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    let wCost = 0, wTok = 0, oldest = 0;
    for (const r of state.recent) {
      if (r.ts < windowStart) continue;
      wCost += r.cost; wTok += r.tokens;
      if (!oldest || r.ts < oldest) oldest = r.ts;
    }
    const window5h = {
      cost: wCost,
      tokens: wTok,
      startTs: oldest || 0,
      resetTs: oldest ? oldest + WINDOW_MS : 0,
    };

    // Daily map trimmed to the calendar fields the panel reads.
    const daily = {};
    for (const [k, v] of Object.entries(state.daily)) {
      daily[k] = { cost: v.cost, tokens: v.tokens, msgs: v.msgs };
    }

    return { today, window5h, byModel, hourly, daily };
  }

  // Re-read the price table (call after a LiteLLM sync lands a fresh cache).
  function reloadPricing() { pricing = loadPricing(); }

  // Report the price table the UI is actually using — the old hard-coded
  // { live:false, source:'builtin' } told every online user their sync failed.
  function priceInfo() {
    let live = false;
    let ts = 0;
    let count = Object.keys(DEFAULT_PRICING).length - 1;
    let source = 'builtin';
    try {
      const c = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
      if (c && c.pricing && typeof c.pricing === 'object' && Object.keys(c.pricing).length) {
        live = true; ts = Number(c.ts) || 0; count = Object.keys(c.pricing).length; source = 'litellm';
      }
    } catch {}
    try { fs.accessSync(PRICING_OVERRIDE_PATH); live = true; source = 'override'; } catch {}
    return { live, count, ts, source };
  }

  let timer = null;
  function start(intervalMs = 30000) {
    load();
    scan();
    timer = setInterval(scan, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow(); // always flush the latest aggregates on quit
  }

  return { start, stop, scan, getStats, priceInfo, reloadPricing, _state: state };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = { createMetering, DEFAULT_PRICING };
