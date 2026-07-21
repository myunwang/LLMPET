'use strict';
// R19-拓展: Renderer timer/interval cleanup audit
// Verifies that every setInterval/setTimeout chain in renderer/pet.js
// has a corresponding clearInterval/clearTimeout in beforeunload.
// Pattern: scan source for timer variable declarations, their assignments
// from setInterval/setTimeout, and presence in the beforeunload handler.

const fs = require('fs');
const path = require('path');

const PET_SRC = path.join(__dirname, '..', 'renderer', 'pet.js');
const src = fs.readFileSync(PET_SRC, 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('[C1] beforeunload handler exists');
{
  assert(src.includes("window.addEventListener('beforeunload'"), 'beforeunload listener registered');
}

// Detect timer variables by: (a) declaration patterns, (b) setInterval/setTimeout assignments,
// (c) known non-standard names (poolRot, uiBusyInterval, visualBoundsInterval) from explicit scan.
const trackedTimers = new Set();
const assignedTimers = new Set();
let m;

// Pattern A: "let/const xxxTimer/Interval = null" declarations
const declPattern = /^(?:let|const)\s+(\w+(?:Timer|timer|Interval|interval))\s*=/gm;
while ((m = declPattern.exec(src)) !== null) trackedTimers.add(m[1]);

// Pattern B: "xxxTimer = setTimeout(" or "xxxInterval = setInterval(" assignments
const assignPattern = /(\w+(?:Timer|timer|Interval|interval))\s*=\s*(?:setInterval|setTimeout)\s*\(/gm;
while ((m = assignPattern.exec(src)) !== null) assignedTimers.add(m[1]);

// Pattern C: known tracked timer vars from clearInterval calls (poolRot, uiBusyInterval, etc.)
const clearPattern = /clear(Interval|Timeout)\((\w+)\)/g;
while ((m = clearPattern.exec(src)) !== null) {
  trackedTimers.add(m[2]);
  assignedTimers.add(m[2]);
}

// Union of all timer variables
const allTimers = new Set([...trackedTimers, ...assignedTimers]);

console.log('[C2] tracked timer variables detected');
{
  assert(allTimers.has('poolRot'), 'poolRot detected');
  assert(allTimers.has('bubbleTimer'), 'bubbleTimer detected');
  assert(allTimers.has('transientTimer'), 'transientTimer detected');
  assert(allTimers.has('actTimer'), 'actTimer detected');
  assert(allTimers.has('emptyWarnTimer'), 'emptyWarnTimer detected');
  assert(allTimers.has('blinkTimer'), 'blinkTimer detected');
  assert(allTimers.has('idleActionTimer'), 'idleActionTimer detected');
}

// Extract the beforeunload handler body
const buMatch = src.match(/window\.addEventListener\('beforeunload'\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
const buBody = buMatch ? buMatch[1] : '';

console.log('[C3] beforeunload clears all tracked intervals');
{
  assert(buBody.includes('clearInterval(poolRot)'), 'clearInterval(poolRot) in beforeunload');
  assert(buBody.includes('clearInterval(uiBusyInterval)'), 'clearInterval(uiBusyInterval) in beforeunload');
  assert(buBody.includes('clearInterval(visualBoundsInterval)'), 'clearInterval(visualBoundsInterval) in beforeunload');
}

console.log('[C4] beforeunload clears all tracked timeouts');
{
  assert(buBody.includes('clearTimeout(bubbleTimer)'), 'clearTimeout(bubbleTimer) in beforeunload');
  assert(buBody.includes('clearTimeout(transientTimer)'), 'clearTimeout(transientTimer) in beforeunload');
  assert(buBody.includes('clearTimeout(actTimer)'), 'clearTimeout(actTimer) in beforeunload');
  assert(buBody.includes('clearTimeout(emptyWarnTimer)'), 'clearTimeout(emptyWarnTimer) in beforeunload');
  assert(buBody.includes('clearTimeout(blinkTimer)'), 'clearTimeout(blinkTimer) in beforeunload');
  assert(buBody.includes('clearTimeout(idleActionTimer)'), 'clearTimeout(idleActionTimer) in beforeunload');
}

console.log('[C5] beforeunload nullifies all timer references');
{
  assert(buBody.includes('poolRot = null'), 'poolRot = null in beforeunload');
  assert(buBody.includes('bubbleTimer = null'), 'bubbleTimer = null in beforeunload');
  assert(buBody.includes('transientTimer = null'), 'transientTimer = null in beforeunload');
  assert(buBody.includes('actTimer = null'), 'actTimer = null in beforeunload');
  assert(buBody.includes('emptyWarnTimer = null'), 'emptyWarnTimer = null in beforeunload');
  assert(buBody.includes('blinkTimer = null'), 'blinkTimer = null in beforeunload');
  assert(buBody.includes('idleActionTimer = null'), 'idleActionTimer = null in beforeunload');
}

console.log('[C6] self-scheduling timer chains use defensive clearTimeout');
{
  // scheduleBlink: find function body by scanning from its definition
  const schedBlinkStart = src.indexOf('function scheduleBlink()');
  const schedBlinkEnd = src.indexOf('\n}', schedBlinkStart) + 2;
  const schedBlinkBody = src.slice(schedBlinkStart, schedBlinkEnd);
  assert(schedBlinkBody.includes('clearTimeout(blinkTimer)'), 'scheduleBlink clears previous timer');

  // scheduleIdleAction: same approach
  const schedIdleStart = src.indexOf('function scheduleIdleAction()');
  const schedIdleEnd = src.indexOf('\n}', schedIdleStart) + 2;
  const schedIdleBody = src.slice(schedIdleStart, schedIdleEnd);
  assert(schedIdleBody.includes('clearTimeout(idleActionTimer)'), 'scheduleIdleAction clears previous timer');
}

console.log('[C7] one-shot setTimeout in hot paths use clearTimeout before re-assignment');
{
  // showBubble: scan from function def to next function def
  const sbStart = src.indexOf('function showBubble(');
  const sbEnd = src.indexOf('\nfunction ', sbStart + 1);
  const sbBody = src.slice(sbStart, sbEnd >= 0 ? sbEnd : sbStart + 500);
  assert(sbBody.includes('clearTimeout(bubbleTimer)'), 'showBubble clears previous bubbleTimer');

  // transient: same approach
  const tStart = src.indexOf('function transient(');
  const tEnd = src.indexOf('\nfunction ', tStart + 1);
  const tBody = src.slice(tStart, tEnd >= 0 ? tEnd : tStart + 500);
  assert(tBody.includes('clearTimeout(transientTimer)'), 'transient clears previous transientTimer');

  // playAction (tool action animation): same approach
  const saStart = src.indexOf('function playAction(');
  const saEnd = src.indexOf('\nfunction ', saStart + 1);
  const saBody = src.slice(saStart, saEnd >= 0 ? saEnd : saStart + 500);
  assert(saBody.includes('clearTimeout(actTimer)'), 'playAction clears previous actTimer');

  // warnEmptyInput: same approach
  const weStart = src.indexOf('function warnEmptyInput(');
  const weEnd = src.indexOf('\nfunction ', weStart + 1);
  const weBody = src.slice(weStart, weEnd >= 0 ? weEnd : weStart + 500);
  assert(weBody.includes('clearTimeout(emptyWarnTimer)'), 'warnEmptyInput clears previous emptyWarnTimer');
}

console.log('[C8] top-level setInterval/setTimeout are all assigned to tracked variables');
{
  // Instead of trying to track brace nesting (fragile with strings/comments),
  // verify that every setInterval/setTimeout that appears outside of a function
  // keyword context is assigned to a variable that gets cleared in beforeunload.
  // Simpler approach: check that the two known top-level intervals have tracked vars.
  // (scheduleBlink/scheduleIdleAction are called at top-level but setTimeout is inside functions)
  const lines = src.split('\n');
  // Find lines with setInterval that are at file scope (not indented)
  const topLevelIntervalLines = lines.filter((l, i) => {
    if (!/\bsetInterval\s*\(/.test(l)) return false;
    if (/^\s*\/\//.test(l)) return false;
    // Not inside a function if it's a simple const/let assignment at column 0
    return /^(?:let|const)\s/.test(l);
  });
  // These should be uiBusyInterval and visualBoundsInterval — both in beforeunload
  for (const line of topLevelIntervalLines) {
    const varMatch = line.match(/(?:let|const)\s+(\w+)/);
    const varName = varMatch ? varMatch[1] : 'unknown';
    assert(buBody.includes('clearInterval(' + varName + ')'), `top-level ${varName} cleared in beforeunload`);
  }
  // Verify scheduleBlink/scheduleIdleAction calls at top-level (no setTimeout at top-level)
  const topTimeoutLines = lines.filter(l => {
    if (!/\bsetTimeout\s*\(/.test(l)) return false;
    if (/^\s*\/\//.test(l)) return false;
    return true;
  });
  // All setTimeout calls should be inside functions (indented), not at column 0
  const unindented = topTimeoutLines.filter(l => /^(?:let|const|var)\s/.test(l) || /^\S/.test(l));
  assert(unindented.length === 0, 'no unindented top-level setTimeout: found ' + unindented.length);
}

// --- Main process cleanup audit ---
const MAIN_SRC = path.join(__dirname, '..', 'main.js');
const mainSrc = fs.readFileSync(MAIN_SRC, 'utf8');

console.log('[M1] main.js before-quit handler clears stats-related timers');
{
  const bqStart = mainSrc.indexOf("app.on('before-quit'");
  const bqEnd = mainSrc.indexOf('\n});', bqStart) + 3;
  const bqBody = mainSrc.slice(bqStart, bqEnd);
  assert(bqBody.includes('clearTimeout(statsTimer)'), 'clearTimeout(statsTimer) in before-quit');
  assert(bqBody.includes('clearTimeout(emitDebounce)'), 'clearTimeout(emitDebounce) in before-quit');
  assert(bqBody.includes('statsTimer = null'), 'statsTimer nullified in before-quit');
  assert(bqBody.includes('emitDebounce = null'), 'emitDebounce nullified in before-quit');
}

console.log('[M2] main.js before-quit stops all subsystems');
{
  const bqStart = mainSrc.indexOf("app.on('before-quit'");
  const bqEnd = mainSrc.indexOf('\n});', bqStart) + 3;
  const bqBody = mainSrc.slice(bqStart, bqEnd);
  assert(bqBody.includes('territory.stop()'), 'territory stopped');
  assert(bqBody.includes('stopWatcher()'), 'stopWatcher() called');
  assert(bqBody.includes('permissions.cleanup()'), 'permissions cleaned up');
  assert(bqBody.includes('cwPermissions.cleanup()'), 'cwPermissions cleaned up');
  assert(bqBody.includes('server.stop()'), 'server stopped');
  assert(bqBody.includes('metering.stop()'), 'metering stopped');
  assert(bqBody.includes('pricingSync.stop()'), 'pricingSync stopped');
  assert(bqBody.includes('core.stopStaleCleanup()'), 'core stale cleanup stopped');
}

// --- Summary ---
console.log('');
if (fail) {
  console.log(`❌ FAIL — ${pass} passed, ${fail} failed`);
  process.exit(1);
} else {
  console.log(`✅ ALL PASS — ${pass} passed, 0 failed`);
}