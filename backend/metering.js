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
const { readJsonBoundedSync } = require('./safe-json');
const { dict, finiteNonNegative, safeMapKey, cleanDailyMap, cleanByModelMap, cleanHourlyMap, cleanRecent, cleanCursors, cleanSeen, readJsonBounded } = require('./metering-state');

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
const MAX_PRICING_FILE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES_PER_TICK = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 5000;
const MAX_RECENT_RECORDS = 50000;
const MAX_SEEN_RECORDS = 200000;
const SEEN_TRIM_BATCH = 10000;

// USD per 1,000,000 tokens. Family-level ESTIMATES — only a last-resort fallback
// now that we price by exact model id (pricing._models, synced from LiteLLM).
// Override via ~/.octopus/pricing.json (families and/or a "models" map):
//   { "opus": {...}, "models": { "claude-opus-4-8": {"input":5,"output":25,...} } }
const DEFAULT_PRICING = {
  opus:    { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  fable:   { input: 10, output: 50, cacheWrite: 12.5,  cacheRead: 1 },
  sonnet:  { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:   { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
  default: { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
};

// Normalize a model name to match the pricing table: lowercase, strip any
// provider/region prefix (anthropic./us.…), and drop the date + version suffix.
// transcript names (claude-opus-4-8) are already bare — this mainly folds
// LiteLLM's dated variants (claude-opus-4-5-20251101) onto the bare id.
function normModelName(model) {
  const s = String(model || '').toLowerCase().trim().split(':')[0];
  if (!s) return '';
  const seg = s.split(/[/.]/).find((p) => p.includes('claude')) || s;
  return seg.replace(/-\d{8}\b/g, '').replace(/-v\d+$/, '').replace(/@.*$/, '');
}

function normalizePriceRow(row, fallback) {
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_PRICING.default;
  const out = {};
  for (const key of ['input', 'output', 'cacheWrite', 'cacheRead']) {
    const candidate = row && Number(row[key]);
    out[key] = Number.isFinite(candidate) && candidate >= 0 && candidate <= 1_000_000
      ? candidate
      : base[key];
  }
  return out;
}

// Priority: user manual override > LiteLLM sync cache > built-in defaults.
// Family-level shallow merge — sub-keys (input/output/cacheWrite/cacheRead)
// from a higher layer replace the same key in a lower layer; missing sub-keys
// keep the lower-layer value. So a stale cache can't zero-out a missing field.
function loadPricing() {
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  out._models = dict(); // exact per-model-id prices (claude-fable-5 → {...}); wins over family
  // layer 1: synced cache (~/.octopus/pricing-cache.json)
  try {
    const c = readJsonBoundedSync(PRICING_CACHE_PATH, MAX_PRICING_FILE_BYTES);
    if (c && c.pricing && typeof c.pricing === 'object') {
      for (const [fam, row] of Object.entries(c.pricing)) {
        if (Object.prototype.hasOwnProperty.call(DEFAULT_PRICING, fam) && row && typeof row === 'object') {
          out[fam] = normalizePriceRow(row, out[fam]);
        }
      }
    }
    if (c && c.models && typeof c.models === 'object') {
      for (const [id, row] of Object.entries(c.models)) {
        if (row && typeof row === 'object' && Number.isFinite(row.input)) {
          const key = safeMapKey(normModelName(id), '', 256);
          if (key) out._models[key] = normalizePriceRow(row, DEFAULT_PRICING.default);
        }
      }
    }
  } catch {}
  // layer 2: user override (~/.octopus/pricing.json) — wins. Supports both family
  // keys and a "models" map of exact ids.
  try {
    const raw = readJsonBoundedSync(PRICING_OVERRIDE_PATH, MAX_PRICING_FILE_BYTES);
    for (const [fam, row] of Object.entries(raw)) {
      if (fam === 'models' && row && typeof row === 'object') {
        for (const [id, r] of Object.entries(row)) {
          const k = safeMapKey(normModelName(id), '', 256);
          if (k && r && typeof r === 'object') out._models[k] = normalizePriceRow(r, out._models[k] || DEFAULT_PRICING.default);
        }
      } else if (Object.prototype.hasOwnProperty.call(DEFAULT_PRICING, fam) && row && typeof row === 'object') {
        out[fam] = normalizePriceRow(row, out[fam]);
      }
    }
  } catch {}
  return out;
}

// Price a model: exact per-id table first (correct across opus generations and
// new models like fable-5), then family keyword, then the generic default.
function priceFor(pricing, model) {
  const models = pricing._models || dict();
  const norm = safeMapKey(normModelName(model), '', 256);
  if (norm && Object.prototype.hasOwnProperty.call(models, norm)) return normalizePriceRow(models[norm], pricing.default);
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return pricing.opus;
  if (m.includes('fable')) return pricing.fable || pricing.default;
  if (m.includes('haiku')) return pricing.haiku;
  if (m.includes('sonnet')) return pricing.sonnet;
  return pricing.default;
}

function dayKey(ts) {
  let d = new Date(ts);
  if (!Number.isFinite(d.getTime())) d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Incrementally read complete JSONL records with fixed memory. When a single
// line is larger than the chunk, advance through it without parsing; the next
// call detects that the cursor is mid-line and discards bytes up to the next LF.
async function readNewLinesBounded(file, fromOffset, size, maxBytes = READ_CHUNK_BYTES) {
  if (size <= fromOffset) {
    return { lines: [], newOffset: size < fromOffset ? 0 : fromOffset, bytesRead: 0 };
  }
  const fh = await fsp.open(file, 'r');
  try {
    const wanted = Math.max(1, Math.min(size - fromOffset, maxBytes));
    const buf = Buffer.allocUnsafe(wanted);
    const { bytesRead } = await fh.read(buf, 0, wanted, fromOffset);
    if (!bytesRead) return { lines: [], newOffset: fromOffset, bytesRead: 0 };
    const data = buf.subarray(0, bytesRead);

    let startsMidLine = false;
    if (fromOffset > 0) {
      const previous = Buffer.allocUnsafe(1);
      const prevRead = await fh.read(previous, 0, 1, fromOffset - 1);
      startsMidLine = prevRead.bytesRead === 1 && previous[0] !== 0x0A;
    }

    let start = 0;
    let discardedThrough = 0;
    if (startsMidLine) {
      const firstNl = data.indexOf(0x0A);
      if (firstNl < 0) {
        const moreRemains = fromOffset + bytesRead < size;
        return {
          lines: [],
          newOffset: moreRemains ? fromOffset + bytesRead : fromOffset,
          bytesRead,
        };
      }
      start = firstNl + 1;
      discardedThrough = start;
    }

    const lastNl = data.lastIndexOf(0x0A);
    if (lastNl < start) {
      const moreRemains = fromOffset + bytesRead < size;
      return {
        lines: [],
        newOffset: discardedThrough
          ? fromOffset + discardedThrough
          : (moreRemains ? fromOffset + bytesRead : fromOffset),
        bytesRead,
      };
    }

    const complete = data.subarray(start, lastNl).toString('utf8');
    return {
      lines: complete ? complete.split('\n') : [],
      newOffset: fromOffset + lastNl + 1,
      bytesRead,
    };
  } finally {
    await fh.close();
  }
}

function emptyDay() {
  return { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function createMetering() {
  let pricing = loadPricing();

  // Persisted state.
  let state = {
    cursors: dict(),          // filePath -> byte offset already consumed
    seen: dict(),             // `${msgId}|${requestId}` -> dayKey, dedupe across files/runs
    daily: dict(),            // 'YYYY-MM-DD' -> { cost, tokens, msgs, input, output, cacheCreate, cacheRead }
    byModelByDay: dict(),     // 'YYYY-MM-DD' -> { model: { cost, tokens } }
    hourlyByDay: dict(),      // 'YYYY-MM-DD' -> [24] cost
    recent: [],           // [{ ts, cost, tokens }] within RECENT_KEEP_MS, for window5h
  };
  let scanning = false;
  let dirty = false;
  let saveTimer = null;
  let scanStartIndex = 0;

  function load() {
    try {
      const raw = readJsonBounded(STATE_PATH);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        state.cursors = cleanCursors(raw.cursors);
        state.seen = cleanSeen(raw.seen);
        state.daily = cleanDailyMap(raw.daily);
        state.byModelByDay = cleanByModelMap(raw.byModelByDay);
        state.hourlyByDay = cleanHourlyMap(raw.hourlyByDay);
        state.recent = cleanRecent(raw.recent);
      }
    } catch (err) {
      if (err && err.code === 'ESTATEBIG') log('meter', 'ignored oversized state file:', err.message);
    }
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
      fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
      const tmp = path.join(STATE_DIR, `.usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, STATE_PATH);
      try { fs.chmodSync(STATE_PATH, 0o600); } catch {}
    } catch (err) {
      log('meter', 'save failed:', err.message);
    }
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - BACKFILL_MS);
    for (const k of Object.keys(state.daily)) if (k < cutoff) delete state.daily[k];
    for (const k of Object.keys(state.byModelByDay)) if (k < cutoff) delete state.byModelByDay[k];
    for (const k of Object.keys(state.hourlyByDay)) if (k < cutoff) delete state.hourlyByDay[k];
    // Bound the dedupe set to the retention window and a hard runtime cap.
    for (const k of Object.keys(state.seen)) if (state.seen[k] < cutoff) delete state.seen[k];
    const seenKeys = Object.keys(state.seen);
    if (seenKeys.length > MAX_SEEN_RECORDS) {
      const removeCount = Math.max(SEEN_TRIM_BATCH, seenKeys.length - MAX_SEEN_RECORDS);
      for (const k of seenKeys.slice(0, removeCount)) delete state.seen[k];
    }
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

    const fam = (state.byModelByDay[k] = state.byModelByDay[k] || dict());
    const mk = safeMapKey(model, 'unknown', 256);
    // Per-model detail (cost + token 四元组 + 轮次) so the panel can show 有总有分.
    const mv = (fam[mk] = fam[mk] || { cost: 0, tokens: 0, msgs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    mv.cost += cost; mv.tokens += tokens; mv.msgs += 1;
    mv.input += input; mv.output += output; mv.cacheCreate += cacheCreate; mv.cacheRead += cacheRead;

    const hours = (state.hourlyByDay[k] = state.hourlyByDay[k] || new Array(24).fill(0));
    hours[new Date(tsMs).getHours()] += cost;

    if (Date.now() - tsMs < RECENT_KEEP_MS) {
      state.recent.push({ ts: tsMs, cost, tokens });
      if (state.recent.length > MAX_RECENT_RECORDS) {
        state.recent.splice(0, state.recent.length - MAX_RECENT_RECORDS);
      }
    }
  }

  function pruneRecent() {
    const cutoff = Date.now() - RECENT_KEEP_MS;
    if (state.recent.length && state.recent[0].ts < cutoff) {
      state.recent = state.recent.filter((r) => r.ts >= cutoff);
    }
    if (state.recent.length > MAX_RECENT_RECORDS) {
      state.recent.splice(0, state.recent.length - MAX_RECENT_RECORDS);
    }
  }

  async function scanFile(file, byteBudget = READ_CHUNK_BYTES) {
    let st;
    try { st = await fsp.stat(file); } catch { return; }
    if (st.mtimeMs < Date.now() - BACKFILL_MS) return; // too old to matter
    let offset = state.cursors[file] || 0;
    if (offset > st.size) offset = 0; // file truncated/rotated
    if (st.size <= offset) return;

    const { lines, newOffset, bytesRead } = await readNewLinesBounded(
      file,
      offset,
      st.size,
      Math.max(1, Math.min(byteBudget, READ_CHUNK_BYTES))
    );
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
    return bytesRead || 0;
  }

  async function listTranscripts() {
    const out = [];
    let dirs;
    try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sub = path.join(PROJECTS_DIR, d.name);
      let files;
      try { files = await fsp.readdir(sub, { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        out.push(path.join(sub, f.name));
        if (out.length >= MAX_TRANSCRIPT_FILES) return out;
      }
    }
    return out;
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const files = await listTranscripts();
      if (files.length) {
        scanStartIndex %= files.length;
        let remaining = MAX_SCAN_BYTES_PER_TICK;
        let processed = 0;
        for (let i = 0; i < files.length && remaining > 0; i++) {
          const file = files[(scanStartIndex + i) % files.length];
          // Isolate per file: one unreadable/poison transcript must not abort
          // the whole loop. A global byte budget also keeps the UI responsive.
          try {
            const consumed = await scanFile(file, remaining);
            remaining -= Math.max(0, consumed || 0);
          } catch (e) {
            log('meter', 'scanFile failed:', file, e.message);
          }
          processed++;
        }
        scanStartIndex = (scanStartIndex + processed) % files.length;
      } else {
        scanStartIndex = 0;
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
      const c = readJsonBoundedSync(PRICING_CACHE_PATH, MAX_PRICING_FILE_BYTES);
      if (c && c.pricing && typeof c.pricing === 'object' && Object.keys(c.pricing).length) {
        live = true; ts = Number(c.ts) || 0; source = 'litellm';
        // Prefer the exact per-model count (what actually drives billing now).
        count = (c.models && typeof c.models === 'object' && Object.keys(c.models).length)
          ? Object.keys(c.models).length
          : Object.keys(c.pricing).length;
      }
    } catch {}
    try { fs.accessSync(PRICING_OVERRIDE_PATH); live = true; source = 'override'; } catch {}
    return { live, count, ts, source };
  }

  // Whole-history recompute: clear the aggregates + cursors + dedupe set and
  // re-scan every transcript from byte 0 with the CURRENT (fixed) price table.
  // The transcripts are the source of truth, so this retroactively corrects cost
  // stored under a wrong price (e.g. fable-5 previously billed at sonnet). Async.
  async function rebuild() {
    load(); // pull existing so a partial failure still leaves the old data
    state.cursors = dict();
    state.seen = dict();
    state.daily = dict();
    state.byModelByDay = dict();
    state.hourlyByDay = dict();
    state.recent = [];
    pricing = loadPricing();
    await scan();
    saveNow();
    return totals();
  }

  // All-time cost/token totals per model, summed across the retained days.
  function totals() {
    let cost = 0, tokens = 0;
    const byModel = {};
    for (const day of Object.values(state.byModelByDay)) {
      for (const [id, v] of Object.entries(day)) {
        byModel[id] = (byModel[id] || 0) + (v.cost || 0);
        cost += v.cost || 0; tokens += v.tokens || 0;
      }
    }
    return { cost, tokens, byModel };
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

  return { start, stop, scan, getStats, priceInfo, reloadPricing, rebuild, totals, _state: state };
}

function num(v) {
  const n = Number(v);
  return finiteNonNegative(n, 1e12);
}

module.exports = {
  createMetering, DEFAULT_PRICING, normModelName, priceFor, loadPricing,
  _readNewLinesBounded: readNewLinesBounded,
  _limits: { READ_CHUNK_BYTES, MAX_SCAN_BYTES_PER_TICK, MAX_TRANSCRIPT_FILES, MAX_RECENT_RECORDS, MAX_SEEN_RECORDS },
};
