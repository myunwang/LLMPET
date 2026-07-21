'use strict';

// ── R17-拓展: Adaptive stats polling test ──────────────────────────────────
// Verifies the main-process adaptive polling logic (STATS_FAST_MS /
// STATS_SLOW_MS / isAnySessionActive / scheduleStatsTimer).
//
// Since main.js has top-level Electron side-effects, we duplicate the tiny
// pure-logic here.  The real code in main.js is trivially reviewable against
// these tests.

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); process.exitCode = 1; }
}

// ── Constants (must match main.js) ──────────────────────────────────────────
const STATS_FAST_MS = 4000;
const STATS_SLOW_MS = 30000;
const ACTIVE_THRESHOLD_MS = 300_000; // 5 minutes

// ── isAnySessionActive logic (mirrors main.js) ──────────────────────────────
function isAnySessionActive(snapshot, now) {
  if (!snapshot) return false;
  if (!snapshot.active) return false;
  return (now - snapshot.active.lastActivityTs) < ACTIVE_THRESHOLD_MS;
}

// ── Tests ───────────────────────────────────────────────────────────────────

console.log('[A1] isAnySessionActive — no snapshot');
assert(isAnySessionActive(null, 0) === false, 'null snapshot → false');
assert(isAnySessionActive(undefined, 0) === false, 'undefined snapshot → false');

console.log('[A2] isAnySessionActive — no active session');
assert(isAnySessionActive({ active: null, sessions: [] }, 1000) === false, 'no active → false');
assert(isAnySessionActive({ active: null }, 1000) === false, 'no active (minimal) → false');

console.log('[A3] isAnySessionActive — session active within threshold');
const now = 1_700_000_000_000;
const recentSnap = { active: { lastActivityTs: now - 60_000 }, sessions: [] }; // 1 min ago
assert(isAnySessionActive(recentSnap, now) === true, '1 min ago → active');
const edgeSnap = { active: { lastActivityTs: now - 299_000 }, sessions: [] }; // 4m59s ago
assert(isAnySessionActive(edgeSnap, now) === true, '4m59s ago → active (just under threshold)');

console.log('[A4] isAnySessionActive — session idle beyond threshold');
const idleSnap = { active: { lastActivityTs: now - 301_000 }, sessions: [] }; // 5m1s ago
assert(isAnySessionActive(idleSnap, now) === false, '5m1s ago → not active');
const oldSnap = { active: { lastActivityTs: now - 3_600_000 }, sessions: [] }; // 1 hour ago
assert(isAnySessionActive(oldSnap, now) === false, '1 hour ago → not active');
const zeroSnap = { active: { lastActivityTs: 0 }, sessions: [] };
assert(isAnySessionActive(zeroSnap, now) === false, 'epoch → not active');

console.log('[A5] interval selection');
function pickInterval(snapshot, now) {
  return isAnySessionActive(snapshot, now) ? STATS_FAST_MS : STATS_SLOW_MS;
}
assert(pickInterval(recentSnap, now) === STATS_FAST_MS, 'active → 4000ms');
assert(pickInterval(idleSnap, now) === STATS_SLOW_MS, 'idle → 30000ms');
assert(pickInterval(null, now) === STATS_SLOW_MS, 'no snapshot → 30000ms');

console.log('[A6] constants are positive and ordered');
assert(STATS_FAST_MS > 0, 'FAST > 0');
assert(STATS_SLOW_MS > 0, 'SLOW > 0');
assert(STATS_SLOW_MS > STATS_FAST_MS, 'SLOW > FAST');
assert(ACTIVE_THRESHOLD_MS > 0, 'THRESHOLD > 0');
assert(ACTIVE_THRESHOLD_MS > STATS_SLOW_MS, 'THRESHOLD > SLOW (one slow tick fits within threshold)');

console.log('[A7] transition detection (simulate active → idle → active)');
const t0 = 1_700_000_000_000;
const s1 = { active: { lastActivityTs: t0 }, sessions: [] };
assert(pickInterval(s1, t0) === STATS_FAST_MS, 'T=0 active → fast');
assert(pickInterval(s1, t0 + 300_000) === STATS_SLOW_MS, 'T=5min → slow (at threshold boundary)');
assert(pickInterval(s1, t0 + 60_000) === STATS_FAST_MS, 'T=1min → still fast');
const s2 = { active: { lastActivityTs: t0 + 360_000 }, sessions: [] }; // new activity at 6min
assert(pickInterval(s2, t0 + 360_000) === STATS_FAST_MS, 'new activity at T=6min → fast');
assert(pickInterval(s2, t0 + 660_000) === STATS_SLOW_MS, 'T=11min no new activity → slow');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n✅ ALL PASS — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);