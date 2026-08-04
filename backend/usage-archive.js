'use strict';

// Upgrade-safe history for both usage ledgers.
//
// Both metering.js and codex-metering.js used to do this on a schema bump:
//
//   if (raw.schemaVersion !== STATE_SCHEMA) return;   // ← every aggregate dropped
//
// …and then rebuild from the transcripts. But Claude Code deletes transcripts
// after `cleanupPeriodDays` (30 by default) and Codex rollouts age out too, so
// the rebuild can only recover the recent tail — everything older is gone for
// good. That is why installing a new build appeared to reset the billing: the
// v1→v2 bump on this machine took 2026-05-08 … 2026-05-28 with it.
//
// Instead of dropping the old aggregates we freeze them into `archive` and merge
// them back at read time. Per day we keep whichever ledger observed MORE tokens,
// so a rebuild that only partially recovers a day can never shrink it, and once
// the live ledger overtakes the frozen copy the archived row is dropped.
//
// Lifetime is a rolling window plus a carry, never a second accumulator:
//   carried  += a day's row at the moment it is pruned out of the window
//   lifetime  = carried + sum(merged daily)
// so it survives pruning, cannot drift from the daily ledger, and cannot double
// count a day that gets rebuilt.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Sum numeric fields across rows. Shape-agnostic: the Claude ledger carries
// cost/cacheWrite5m/…, the Codex one cachedInput/reasoningOutput/….
function sumRows(rows) {
  const out = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number') out[key] = num(out[key]) + value;
    }
  }
  return out;
}

function addRow(target, row) {
  if (!row || typeof row !== 'object') return target;
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'number') target[key] = num(target[key]) + value;
  }
  return target;
}

// Whichever row observed more tokens wins. Ties (and missing rows) prefer
// `live`, which is the fresher, current-schema computation.
function pickRicher(archived, live) {
  if (!archived) return live;
  if (!live) return archived;
  return num(archived.tokens) > num(live.tokens) ? archived : live;
}

// Freeze the aggregates of a state object we are about to discard.
function buildArchive(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : null;
  if (!daily || !Object.keys(daily).length) return null;
  const lifetime = raw.lifetime && typeof raw.lifetime === 'object'
    ? raw.lifetime
    : sumRows(Object.values(daily));
  const retained = sumRows(Object.values(daily));
  // Whatever the old lifetime knew about beyond its own retained days is the
  // history that has already aged out — it can only survive as a carry.
  const carried = {};
  for (const key of new Set([...Object.keys(lifetime), ...Object.keys(retained)])) {
    if (typeof lifetime[key] !== 'number' && typeof retained[key] !== 'number') continue;
    carried[key] = Math.max(0, num(lifetime[key]) - num(retained[key]));
  }
  return {
    fromSchema: Number(raw.schemaVersion) || 1,
    ts: Date.now(),
    daily,
    byModelByDay: raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {},
    hourlyByDay: raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {},
    hourlyTokensByDay: raw.hourlyTokensByDay && typeof raw.hourlyTokensByDay === 'object' ? raw.hourlyTokensByDay : {},
    carried,
  };
}

// Fold an older archive into a newer one so repeated schema bumps keep stacking
// history instead of each bump discarding the previous archive.
function mergeArchives(older, newer) {
  if (!older) return newer;
  if (!newer) return older;
  const daily = { ...older.daily };
  for (const [day, row] of Object.entries(newer.daily || {})) daily[day] = pickRicher(daily[day], row);
  const carried = {};
  for (const key of new Set([...Object.keys(older.carried || {}), ...Object.keys(newer.carried || {})])) {
    // Both carries describe the same pre-window history; the larger one is the
    // one that saw further back. Summing them would double count it.
    carried[key] = Math.max(num(older.carried && older.carried[key]), num(newer.carried && newer.carried[key]));
  }
  return {
    fromSchema: newer.fromSchema,
    ts: newer.ts,
    daily,
    byModelByDay: { ...(older.byModelByDay || {}), ...(newer.byModelByDay || {}) },
    hourlyByDay: { ...(older.hourlyByDay || {}), ...(newer.hourlyByDay || {}) },
    hourlyTokensByDay: { ...(older.hourlyTokensByDay || {}), ...(newer.hourlyTokensByDay || {}) },
    carried,
  };
}

// Days the live ledger has fully overtaken are dead weight — drop them. Days
// past the retention cutoff move into the carry instead of vanishing.
function pruneArchive(archive, liveDaily, cutoffDay) {
  if (!archive || !archive.daily) return archive;
  archive.carried = archive.carried || {};
  for (const day of Object.keys(archive.daily)) {
    const overtaken = liveDaily && liveDaily[day]
      && num(liveDaily[day].tokens) >= num(archive.daily[day].tokens);
    const expired = cutoffDay && day < cutoffDay;
    if (!overtaken && !expired) continue;
    if (expired && !overtaken) addRow(archive.carried, archive.daily[day]);
    delete archive.daily[day];
    delete archive.byModelByDay[day];
    delete archive.hourlyByDay[day];
    if (archive.hourlyTokensByDay) delete archive.hourlyTokensByDay[day];
  }
  return archive;
}

// Read-time merge of the daily ledger.
function mergedDaily(liveDaily, archive) {
  const out = { ...(liveDaily || {}) };
  if (!archive || !archive.daily) return out;
  for (const [day, row] of Object.entries(archive.daily)) out[day] = pickRicher(row, out[day]);
  return out;
}

// Read-time merge of a keyed-by-day side map (byModelByDay / hourlyByDay). The
// archived entry is used only for days the live ledger has no row for at all,
// so a day the rebuild recovered keeps its own coherent breakdown.
function mergedDayMap(liveMap, archiveMap) {
  const out = { ...(liveMap || {}) };
  if (!archiveMap) return out;
  for (const [day, row] of Object.entries(archiveMap)) if (!out[day]) out[day] = row;
  return out;
}

// lifetime = carry + the retained window. Both carries are pre-window history
// for the same machine, so the larger one wins rather than being summed.
function mergedLifetime(liveCarried, archive, mergedDailyMap) {
  const carried = {};
  const archived = (archive && archive.carried) || {};
  for (const key of new Set([...Object.keys(liveCarried || {}), ...Object.keys(archived)])) {
    carried[key] = Math.max(num(liveCarried && liveCarried[key]), num(archived[key]));
  }
  return addRow(carried, sumRows(Object.values(mergedDailyMap || {})));
}

module.exports = {
  addRow,
  buildArchive,
  mergeArchives,
  mergedDaily,
  mergedDayMap,
  mergedLifetime,
  pruneArchive,
  pickRicher,
  sumRows,
};
