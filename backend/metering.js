'use strict';

// Metering + billing for Claude Code usage.
//
// Claude Code writes a transcript JSONL per session under
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// plus nested subagent transcripts under
//   ~/.claude/projects/<encoded-cwd>/<session-id>/subagents/**.jsonl
// (Task-tool and workflow runs). Both are billed to the same account, so the
// walk is recursive — a flat one-level readdir silently dropped every subagent
// turn, which on this machine was up to 30% of a heavy day.
//
// Each assistant turn line carries message.usage (input / output / cache tokens)
// and message.model. Claude writes the SAME message id several times while the
// response streams; later rows contain the completed output token count. We keep
// the component-wise maximum snapshot per message and apply only the positive
// delta, so neither the first partial row nor a resumed/copied transcript can
// under-count or double-count usage. Aggregates persist to ~/.octopus/usage.json
// so history (the 90-day calendar) survives restarts; the first run backfills
// from the existing transcripts (last 95 days), and a schema bump archives the
// old aggregates instead of dropping them (see usage-archive.js).
//
// Same idea as the ccusage tool: read only token counts + model + timestamps
// from the transcripts (never message content), then price them.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { log } = require('./log');
const archiveUtil = require('./usage-archive');

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
const STATE_SCHEMA = 3;
const MAX_TRANSCRIPT_DEPTH = 6; // projects/<proj>/<session>/subagents/workflows/<wf>/

// USD per 1,000,000 tokens. Family-level ESTIMATES — only a last-resort fallback
// now that we price by exact model id (pricing._models, synced from LiteLLM).
// Override via ~/.octopus/pricing.json (families and/or a "models" map):
//   { "opus": {...}, "models": { "claude-opus-4-8": {"input":5,"output":25,...} } }
const DEFAULT_PRICING = {
  opus:    { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  fable:   { input: 10, output: 50, cacheWrite5m: 12.5,  cacheWrite1h: 20, cacheRead: 1 },
  sonnet:  { input: 3,  output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6, cacheRead: 0.3 },
  haiku:   { input: 1,  output: 5,  cacheWrite5m: 1.25,  cacheWrite1h: 2, cacheRead: 0.1 },
  default: { input: 3,  output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6, cacheRead: 0.3 },
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

// Priority: user manual override > LiteLLM sync cache > built-in defaults.
// Family-level shallow merge — sub-keys (input/output/cacheWrite/cacheRead)
// from a higher layer replace the same key in a lower layer; missing sub-keys
// keep the lower-layer value. So a stale cache can't zero-out a missing field.
function normalizePriceRow(row, fallback = DEFAULT_PRICING.default) {
  const input = Number.isFinite(row && row.input) ? row.input : fallback.input;
  const output = Number.isFinite(row && row.output) ? row.output : fallback.output;
  const cacheWrite5m = Number.isFinite(row && row.cacheWrite5m)
    ? row.cacheWrite5m
    : Number.isFinite(row && row.cacheWrite) ? row.cacheWrite : input * 1.25;
  const cacheWrite1h = Number.isFinite(row && row.cacheWrite1h) ? row.cacheWrite1h : input * 2;
  const cacheRead = Number.isFinite(row && row.cacheRead) ? row.cacheRead : input * 0.1;
  const out = { input, output, cacheWrite5m, cacheWrite1h, cacheRead };
  if (Number.isFinite(row && row.contextWindow) && row.contextWindow > 0) {
    out.contextWindow = Math.floor(row.contextWindow);
  }
  return out;
}

function mergePriceRow(base, incoming) {
  const row = incoming && typeof incoming === 'object' ? { ...incoming } : {};
  // Backward compatibility with pricing.json files documented by older LLMPET
  // versions. A legacy cacheWrite override must beat the new built-in 5m field.
  if (!Number.isFinite(row.cacheWrite5m) && Number.isFinite(row.cacheWrite)) {
    row.cacheWrite5m = row.cacheWrite;
  }
  return normalizePriceRow(row, normalizePriceRow(base || DEFAULT_PRICING.default));
}

function loadPricing(options = {}) {
  const cachePath = options.pricingCachePath || PRICING_CACHE_PATH;
  const overridePath = options.pricingOverridePath || PRICING_OVERRIDE_PATH;
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  out._models = {}; // exact per-model-id prices (claude-fable-5 → {...}); wins over family
  // layer 1: synced cache (~/.octopus/pricing-cache.json)
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c && c.pricing && typeof c.pricing === 'object') {
      for (const [fam, row] of Object.entries(c.pricing)) {
        if (out[fam] && row && typeof row === 'object') {
          out[fam] = mergePriceRow(out[fam], row);
        }
      }
    }
    if (c && c.models && typeof c.models === 'object') {
      for (const [id, row] of Object.entries(c.models)) {
        if (row && typeof row === 'object' && Number.isFinite(row.input)) {
          out._models[normModelName(id)] = normalizePriceRow(row);
        }
      }
    }
  } catch {}
  // layer 2: user override (~/.octopus/pricing.json) — wins. Supports both family
  // keys and a "models" map of exact ids.
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    for (const [fam, row] of Object.entries(raw)) {
      if (fam === 'models' && row && typeof row === 'object') {
        for (const [id, r] of Object.entries(row)) {
          const k = normModelName(id);
          if (r && typeof r === 'object') out._models[k] = mergePriceRow(out._models[k] || DEFAULT_PRICING.default, r);
        }
      } else if (row && typeof row === 'object') {
        out[fam] = mergePriceRow(out[fam] || DEFAULT_PRICING.default, row);
      }
    }
  } catch {}
  for (const fam of ['opus', 'fable', 'sonnet', 'haiku', 'default']) {
    out[fam] = normalizePriceRow(out[fam], DEFAULT_PRICING[fam] || DEFAULT_PRICING.default);
  }
  return out;
}

// Price a model: exact per-id table first (correct across opus generations and
// new models like fable-5), then family keyword, then the generic default.
function priceFor(pricing, model) {
  const models = pricing._models || {};
  const norm = normModelName(model);
  if (norm && models[norm]) return normalizePriceRow(models[norm]);
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return normalizePriceRow(pricing.opus);
  if (m.includes('fable')) return normalizePriceRow(pricing.fable || pricing.default);
  if (m.includes('haiku')) return normalizePriceRow(pricing.haiku);
  if (m.includes('sonnet')) return normalizePriceRow(pricing.sonnet);
  return normalizePriceRow(pricing.default);
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay() {
  return {
    cost: 0, tokens: 0, msgs: 0, input: 0, output: 0,
    cacheCreate: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
  };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

// One API call's usage. `usage.iterations[]` is handled by the caller.
function usageRow(usage) {
  const nested = usage && usage.cache_creation && typeof usage.cache_creation === 'object'
    ? usage.cache_creation : {};
  const totalCreate = num(usage && usage.cache_creation_input_tokens);
  const oneHour = num(nested.ephemeral_1h_input_tokens);
  const explicitFive = num(nested.ephemeral_5m_input_tokens);
  // Older transcript rows expose only the aggregate field. Anthropic's default
  // cache TTL is 5 minutes, so any unclassified remainder belongs there.
  const fiveMinute = explicitFive + Math.max(0, totalCreate - explicitFive - oneHour);
  return {
    input: num(usage && usage.input_tokens),
    output: num(usage && usage.output_tokens),
    cacheWrite5m: fiveMinute,
    cacheWrite1h: oneHour,
    cacheRead: num(usage && usage.cache_read_input_tokens),
  };
}

// A turn that needed several API calls carries every one of them in
// `usage.iterations[]`, while the TOP-LEVEL fields describe only the LAST
// iteration. Billing is per API call, so sum the iterations whenever they are
// present and fall back to the top level for older transcripts that lack them.
function usageSnapshot(usage) {
  const iterations = usage && Array.isArray(usage.iterations) ? usage.iterations : null;
  if (!iterations || !iterations.length) return usageRow(usage);
  const out = emptyUsage();
  for (const iteration of iterations) {
    const row = usageRow(iteration);
    for (const key of Object.keys(out)) out[key] += row[key];
  }
  // A malformed/empty iterations array must never bill less than the row we can
  // already see at the top level.
  const top = usageRow(usage);
  return usageTokens(out) >= usageTokens(top) ? out : top;
}

function mergeUsage(previous, incoming) {
  const a = previous || emptyUsage();
  const b = incoming || emptyUsage();
  const out = {};
  for (const key of Object.keys(emptyUsage())) out[key] = Math.max(num(a[key]), num(b[key]));
  return out;
}

function usageDelta(previous, next) {
  const a = previous || emptyUsage();
  const b = next || emptyUsage();
  const out = {};
  for (const key of Object.keys(emptyUsage())) out[key] = Math.max(0, num(b[key]) - num(a[key]));
  return out;
}

function usageTokens(usage) {
  const u = usage || emptyUsage();
  return num(u.input) + num(u.output) + num(u.cacheWrite5m) + num(u.cacheWrite1h) + num(u.cacheRead);
}

function usageCost(usage, price) {
  const u = usage || emptyUsage();
  const p = normalizePriceRow(price);
  return (
    num(u.input) * p.input
    + num(u.output) * p.output
    + num(u.cacheWrite5m) * p.cacheWrite5m
    + num(u.cacheWrite1h) * p.cacheWrite1h
    + num(u.cacheRead) * p.cacheRead
  ) / 1e6;
}

function createMetering(options = {}) {
  const projectsDir = options.projectsDir || PROJECTS_DIR;
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'usage.json');
  const pricingPaths = {
    pricingCachePath: options.pricingCachePath || path.join(stateDir, 'pricing-cache.json'),
    pricingOverridePath: options.pricingOverridePath || path.join(stateDir, 'pricing.json'),
  };
  let pricing = loadPricing(pricingPaths);

  // Persisted state.
  let state = {
    schemaVersion: STATE_SCHEMA,
    cursors: {},          // filePath -> byte offset already consumed
    records: {},          // message key -> final/max usage snapshot for streaming correction
    daily: {},            // 'YYYY-MM-DD' -> { cost, tokens, msgs, input, output, cacheCreate, cacheRead }
    byModelByDay: {},     // 'YYYY-MM-DD' -> { model: { cost, tokens } }
    hourlyByDay: {},      // 'YYYY-MM-DD' -> [24] cost
    hourlyTokensByDay: {},// 'YYYY-MM-DD' -> [24] real token usage
    recent: [],           // [{ ts, cost, tokens }] within RECENT_KEEP_MS, for window5h
    carried: emptyDay(),  // days pruned out of the window; lifetime = carried + daily
    archive: null,        // frozen aggregates from a previous schema (usage-archive.js)
    diagnostics: {
      lastScanTs: 0, scannedFiles: 0, records: 0, streamingCorrections: 0,
      migratedFrom: null, estimatedModels: {},
    },
  };
  let scanning = false;
  let dirty = false;
  let saveTimer = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.schemaVersion !== STATE_SCHEMA) {
          // Freeze the old aggregates before rebuilding. The transcripts behind
          // them are routinely deleted by Claude Code's own cleanup, so throwing
          // the aggregates away — what every earlier version did — permanently
          // erased the part of the calendar the rebuild can no longer reach.
          state.diagnostics.migratedFrom = Number(raw.schemaVersion) || 1;
          state.archive = archiveUtil.mergeArchives(
            raw.archive || null,
            archiveUtil.buildArchive(raw),
          );
          const kept = state.archive ? Object.keys(state.archive.daily).length : 0;
          log('meter', `usage schema ${state.diagnostics.migratedFrom} → ${STATE_SCHEMA}; rebuilding from transcripts (archived ${kept} day(s) of history)`);
          return;
        }
        state.cursors = raw.cursors && typeof raw.cursors === 'object' ? raw.cursors : {};
        state.records = raw.records && typeof raw.records === 'object' ? raw.records : {};
        state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
        state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
        state.hourlyByDay = raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {};
        state.hourlyTokensByDay = raw.hourlyTokensByDay && typeof raw.hourlyTokensByDay === 'object' ? raw.hourlyTokensByDay : {};
        state.recent = Array.isArray(raw.recent) ? raw.recent : [];
        state.archive = raw.archive || null;
        // lifetime is derived (carried + retained days), so a file written
        // before `carried` existed seeds it from whatever its own lifetime
        // counter knew beyond its retained days.
        if (raw.carried && typeof raw.carried === 'object') {
          state.carried = { ...emptyDay(), ...raw.carried };
        } else if (raw.lifetime && typeof raw.lifetime === 'object') {
          const retained = archiveUtil.sumRows(Object.values(state.daily));
          state.carried = emptyDay();
          for (const key of Object.keys(state.carried)) {
            state.carried[key] = Math.max(0, num(raw.lifetime[key]) - num(retained[key]));
          }
        }
        state.diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object'
          ? { ...state.diagnostics, ...raw.diagnostics } : state.diagnostics;
        state.schemaVersion = STATE_SCHEMA;
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
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = path.join(stateDir, `.usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
      try { fs.chmodSync(statePath, 0o600); } catch {}
    } catch (err) {
      log('meter', 'save failed:', err.message);
    }
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - BACKFILL_MS);
    for (const k of Object.keys(state.daily)) {
      if (k >= cutoff) continue;
      // A day leaving the calendar window moves into the carry, so the lifetime
      // total keeps it. Dropping it outright is what made lifetime a separate
      // accumulator that could drift from the daily ledger.
      archiveUtil.addRow(state.carried, state.daily[k]);
      delete state.daily[k];
    }
    for (const k of Object.keys(state.byModelByDay)) if (k < cutoff) delete state.byModelByDay[k];
    for (const k of Object.keys(state.hourlyByDay)) if (k < cutoff) delete state.hourlyByDay[k];
    for (const k of Object.keys(state.hourlyTokensByDay)) if (k < cutoff) delete state.hourlyTokensByDay[k];
    // Bound final usage records to the same retention window.
    for (const [key, rec] of Object.entries(state.records)) {
      if (!rec || rec.day < cutoff) delete state.records[key];
    }
    state.archive = archiveUtil.pruneArchive(state.archive, state.daily, cutoff);
  }

  // Apply a positive usage delta. Message count increments only for the first
  // snapshot; later streaming rows correct token/cost without inventing turns.
  function recordDelta(tsMs, model, usage, isNew) {
    const input = num(usage.input);
    const output = num(usage.output);
    const cacheWrite5m = num(usage.cacheWrite5m);
    const cacheWrite1h = num(usage.cacheWrite1h);
    const cacheCreate = cacheWrite5m + cacheWrite1h;
    const cacheRead = num(usage.cacheRead);
    const tokens = usageTokens(usage);
    if (tokens <= 0) return;

    const p = priceFor(pricing, model);
    const cost = usageCost(usage, p);

    const k = dayKey(tsMs);
    const d = (state.daily[k] = state.daily[k] || emptyDay());
    d.cost += cost; d.tokens += tokens; d.msgs += isNew ? 1 : 0;
    d.input += input; d.output += output; d.cacheCreate += cacheCreate;
    d.cacheWrite5m = num(d.cacheWrite5m) + cacheWrite5m;
    d.cacheWrite1h = num(d.cacheWrite1h) + cacheWrite1h;
    d.cacheRead += cacheRead;

    const fam = (state.byModelByDay[k] = state.byModelByDay[k] || {});
    const mk = model || 'unknown';
    // Per-model detail (cost + token 四元组 + 轮次) so the panel can show 有总有分.
    const mv = (fam[mk] = fam[mk] || {
      cost: 0, tokens: 0, msgs: 0, input: 0, output: 0,
      cacheCreate: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
    });
    mv.cost += cost; mv.tokens += tokens; mv.msgs += isNew ? 1 : 0;
    mv.input += input; mv.output += output; mv.cacheCreate += cacheCreate;
    mv.cacheWrite5m = num(mv.cacheWrite5m) + cacheWrite5m;
    mv.cacheWrite1h = num(mv.cacheWrite1h) + cacheWrite1h;
    mv.cacheRead += cacheRead;

    const hours = (state.hourlyByDay[k] = state.hourlyByDay[k] || new Array(24).fill(0));
    const hour = new Date(tsMs).getHours();
    hours[hour] += cost;
    const hourlyTokens = (state.hourlyTokensByDay[k] = state.hourlyTokensByDay[k] || new Array(24).fill(0));
    hourlyTokens[hour] += tokens;

    if (Date.now() - tsMs < RECENT_KEEP_MS) state.recent.push({ ts: tsMs, cost, tokens });
  }

  function ingest(key, tsMs, model, rawUsage) {
    const incoming = usageSnapshot(rawUsage);
    if (usageTokens(incoming) <= 0) return false;
    const previous = state.records[key] || null;
    const merged = mergeUsage(previous && previous.usage, incoming);
    const delta = usageDelta(previous && previous.usage, merged);
    if (usageTokens(delta) <= 0) return false;
    const isNew = !previous;
    recordDelta(previous ? previous.ts : tsMs, previous ? previous.model : model, delta, isNew);
    state.records[key] = {
      day: dayKey(previous ? previous.ts : tsMs),
      ts: previous ? previous.ts : tsMs,
      model: previous ? previous.model : model,
      usage: merged,
    };
    if (!isNew) state.diagnostics.streamingCorrections = num(state.diagnostics.streamingCorrections) + 1;
    const norm = normModelName(model);
    if (!norm || !(pricing._models && pricing._models[norm])) {
      const estimates = state.diagnostics.estimatedModels || (state.diagnostics.estimatedModels = {});
      estimates[model || 'unknown'] = num(estimates[model || 'unknown']) + (isNew ? 1 : 0);
    }
    return true;
  }

  function pruneRecent() {
    const cutoff = Date.now() - RECENT_KEEP_MS;
    // `recent` is appended in transcript-scan order, not time order, so the head
    // is not necessarily the oldest entry — gating the filter on recent[0] left
    // expired events inflating the 5h window.
    if (!state.recent.length) return;
    if (state.recent.some((r) => r.ts < cutoff)) {
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
      const tsMs = o.timestamp ? Date.parse(o.timestamp) : st.mtimeMs;
      if (!Number.isFinite(tsMs)) continue;
      ingest(key, tsMs, msg.model || 'unknown', usage);
    }
    state.cursors[file] = newOffset;
  }

  // Recursive: subagent + workflow transcripts live in nested directories
  // (<session-id>/subagents/**), and they bill to the same account.
  async function listTranscripts(dir = projectsDir, out = [], depth = 0) {
    if (depth > MAX_TRANSCRIPT_DEPTH) return out;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await listTranscripts(full, out, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
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
      state.diagnostics.lastScanTs = Date.now();
      state.diagnostics.scannedFiles = files.length;
      state.diagnostics.records = Object.keys(state.records).length;
      scheduleSave();
    } catch (err) {
      log('meter', 'scan error:', err.message);
    } finally {
      scanning = false;
    }
  }

  function getStats() {
    const todayK = dayKey(Date.now());
    // Archived days (frozen by an earlier schema bump) are merged back in for
    // the calendar and the lifetime total. Today always comes from the live
    // ledger — the archive can only ever describe days that already closed.
    const daily = archiveUtil.mergedDaily(state.daily, state.archive);
    const today = { ...emptyDay(), ...(state.daily[todayK] || {}) };
    const byModel = state.byModelByDay[todayK] ? { ...state.byModelByDay[todayK] } : {};
    const hourly = (state.hourlyByDay[todayK] || new Array(24).fill(0)).slice();
    const hourlyTok = (state.hourlyTokensByDay[todayK] || new Array(24).fill(0)).slice();

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
    const calendar = {};
    for (const [k, v] of Object.entries(daily)) {
      calendar[k] = { cost: num(v.cost), tokens: num(v.tokens), msgs: num(v.msgs) };
    }

    return {
      today,
      lifetime: { ...emptyDay(), ...archiveUtil.mergedLifetime(state.carried, state.archive, daily) },
      window5h,
      byModel,
      hourly,
      hourlyTok,
      daily: calendar,
      diagnostics: diagnostics(),
    };
  }

  // Re-read the price table (call after a LiteLLM sync lands a fresh cache).
  function reloadPricing() {
    pricing = loadPricing(pricingPaths);
    repriceRecords();
    scheduleSave();
  }

  // Report the price table the UI is actually using — the old hard-coded
  // { live:false, source:'builtin' } told every online user their sync failed.
  function priceInfo() {
    let live = false;
    let ts = 0;
    let count = Object.keys(DEFAULT_PRICING).length - 1;
    let source = 'builtin';
    try {
      const c = JSON.parse(fs.readFileSync(pricingPaths.pricingCachePath, 'utf8'));
      if (c && c.pricing && typeof c.pricing === 'object' && Object.keys(c.pricing).length) {
        live = true; ts = Number(c.ts) || 0; source = 'litellm';
        // Prefer the exact per-model count (what actually drives billing now).
        // Both halves count: the Codex/OpenAI table prices the panel too.
        const claudeModels = c.models && typeof c.models === 'object' ? Object.keys(c.models).length : 0;
        const openaiModels = c.openaiModels && typeof c.openaiModels === 'object' ? Object.keys(c.openaiModels).length : 0;
        count = (claudeModels + openaiModels) || Object.keys(c.pricing).length;
      }
    } catch {}
    try { fs.accessSync(pricingPaths.pricingOverridePath); live = true; source = 'override'; } catch {}
    const stale = ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000;
    return { live, count, ts, source, stale, estimate: true };
  }

  // Whole-history recompute: clear the aggregates + cursors + dedupe set and
  // re-scan every transcript from byte 0 with the CURRENT (fixed) price table.
  // The transcripts are the source of truth, so this retroactively corrects cost
  // stored under a wrong price (e.g. fable-5 previously billed at sonnet). Async.
  async function rebuild() {
    load(); // pull existing so a partial failure still leaves the old data
    // A manual rebuild is also a point of no return for days whose transcripts
    // are gone, so archive first — same protection as a schema bump.
    state.archive = archiveUtil.mergeArchives(state.archive, archiveUtil.buildArchive({
      schemaVersion: STATE_SCHEMA,
      daily: state.daily,
      byModelByDay: state.byModelByDay,
      hourlyByDay: state.hourlyByDay,
      hourlyTokensByDay: state.hourlyTokensByDay,
      lifetime: archiveUtil.mergedLifetime(state.carried, null, state.daily),
    }));
    state.cursors = {};
    state.records = {};
    state.daily = {};
    state.byModelByDay = {};
    state.hourlyByDay = {};
    state.hourlyTokensByDay = {};
    state.recent = [];
    state.carried = emptyDay();
    state.diagnostics = {
      lastScanTs: 0, scannedFiles: 0, records: 0, streamingCorrections: 0,
      migratedFrom: null, estimatedModels: {},
    };
    pricing = loadPricing(pricingPaths);
    await scan();
    saveNow();
    return totals();
  }

  function resetAggregates() {
    state.daily = {};
    state.byModelByDay = {};
    state.hourlyByDay = {};
    state.hourlyTokensByDay = {};
    state.recent = [];
    state.diagnostics.estimatedModels = {};
  }

  function repriceRecords() {
    resetAggregates();
    const rows = Object.values(state.records).sort((a, b) => a.ts - b.ts);
    for (const rec of rows) {
      // Only the retained window is replayed; `carried` covers the days whose
      // records are already gone and is deliberately left untouched.
      recordDelta(rec.ts, rec.model, rec.usage, true);
      const norm = normModelName(rec.model);
      if (!norm || !(pricing._models && pricing._models[norm])) {
        const estimates = state.diagnostics.estimatedModels;
        estimates[rec.model || 'unknown'] = num(estimates[rec.model || 'unknown']) + 1;
      }
    }
    pruneRecent();
    pruneDaily();
  }

  function diagnostics() {
    const info = priceInfo();
    const estimated = state.diagnostics.estimatedModels || {};
    return {
      schemaVersion: STATE_SCHEMA,
      lastScanTs: num(state.diagnostics.lastScanTs),
      scannedFiles: num(state.diagnostics.scannedFiles),
      records: Object.keys(state.records).length,
      streamingCorrections: num(state.diagnostics.streamingCorrections),
      migratedFrom: state.diagnostics.migratedFrom || null,
      estimatedModelCount: Object.keys(estimated).length,
      estimatedModels: Object.entries(estimated)
        .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([model, count]) => ({ model, count })),
      pricing: info,
    };
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

  return {
    start, stop, scan, getStats, priceInfo, reloadPricing, rebuild, totals, diagnostics,
    _state: state, _ingest: ingest,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = {
  createMetering, DEFAULT_PRICING, normModelName, priceFor, loadPricing,
  normalizePriceRow, mergePriceRow, usageSnapshot, mergeUsage, usageDelta, usageTokens, usageCost,
};
