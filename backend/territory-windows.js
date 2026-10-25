'use strict';

const { createWindowsDesktop } = require('./windows-desktop');
const { DEFAULT_RIVALS, edgeAwayFromPet, standX, lootApproachX, createLootCaptureFlow } = require('./territory');
const { log } = require('./log');

const HOSTS = ['ChatGPT', 'Codex'];
const PET_TITLE = /^(?:Codex Pet(?: Mascot(?: Effect)?)?|ChatGPT Pet|(?:Codex |ChatGPT )?Avatar(?: Overlay)?)$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameWindow = (a, b) => !!a && !!b && a.hwnd === b.hwnd && a.pid === b.pid
  && a.name === b.name && a.title === b.title && a.className === b.className;

function selectRivals(windows, names = DEFAULT_RIVALS, excluded = [], toDip = (r) => r) {
  const result = [];
  for (const raw of windows || []) {
    if (!raw || !/^\d+$/.test(raw.hwnd) || !Number.isInteger(raw.pid) || excluded.includes(raw.pid)) continue;
    if (![raw.x, raw.y, raw.w, raw.h].every(Number.isFinite) || raw.w < 24 || raw.h < 24) continue;
    const host = HOSTS.some((name) => name.toLowerCase() === String(raw.name).toLowerCase());
    const matched = names.some((name) => name && String(raw.name).toLowerCase().includes(name.toLowerCase()));
    // Host processes also own chat, login, notifications and settings windows.
    // A size match alone is never sufficient evidence for moving/closing one.
    if (host ? !(PET_TITLE.test(raw.title) || raw.mascot) : !matched) continue;
    if (host && ((raw.style & 0x00c00000) || !(raw.exStyle & (0x00080000 | 0x00000080)))) continue;
    const rect = toDip({ x: raw.x, y: raw.y, width: raw.w, height: raw.h });
    let visual = rect;
    if (host && raw.mascot) {
      const m = raw.mascot;
      if (![m.x, m.y, m.w, m.h].every(Number.isFinite) || m.w < 24 || m.h < 24
          || m.x < raw.x - 2 || m.y < raw.y - 2 || m.x + m.w > raw.x + raw.w + 2 || m.y + m.h > raw.y + raw.h + 2) continue;
      visual = toDip({ x: m.x, y: m.y, width: m.w, height: m.h });
    }
    if (visual.width > 650 || visual.height > 650) continue;
    result.push({ ...raw, x: rect.x, y: rect.y, w: rect.width, h: rect.height,
      visual: { x: visual.x, y: visual.y, w: visual.width, h: visual.height }, host, raw });
  }
  return result;
}

function createWindowsTerritory(hooks) {
  const desktop = hooks.desktop || createWindowsDesktop();
  const wait = hooks.sleep || sleep;
  const toDip = hooks.screenToDipRect || ((r) => r);
  const toScreen = hooks.dipToScreenPoint || ((p) => p);
  let timer = null;
  let active = null;
  let activeKind = null;
  let automatic = false;
  let cancelRequested = false;
  let dominating = false;
  let stopped = false;
  const names = () => hooks.rivalNames ? hooks.rivalNames() : DEFAULT_RIVALS;
  const emit = (kind, phase, extra = {}) => hooks.emit({ kind, phase, ...extra, ts: Date.now() });
  const aborted = (loot) => stopped || cancelRequested || (automatic && !hooks.isEnabled())
    || (loot ? (hooks.shouldAbortLoot || hooks.shouldAbort)() : hooks.shouldAbort());
  const atEdge = (visual, area, direction) => Math.abs(direction > 0
    ? visual.x + visual.w - area.x - area.width : visual.x - area.x) <= 3;

  async function scanDetailed() {
    const result = await desktop.request('scan', { names: [...new Set([...names(), ...HOSTS])] });
    return { ...result, rivals: result.ok ? selectRivals(result.data, names(), hooks.excludePids(), toDip) : [] };
  }
  async function observe(target) {
    const result = await desktop.request('read', { hwnd: target.hwnd });
    if (!result.ok) return { error: result.error };
    if (!result.data) return { gone: true };
    if (!sameWindow(target.raw, result.data)) return { error: 'target-changed' };
    const rival = selectRivals([result.data], names(), hooks.excludePids(), toDip)[0];
    return rival ? { rival } : { error: 'target-no-longer-pet' };
  }
  async function close(target, direction, area) {
    if (!target.host || aborted(true)) return false;
    const checked = await observe(target);
    if (aborted(true)) return false;
    if (!checked.rival) return !!checked.gone;
    if (!atEdge(checked.rival.visual, area, direction)) return false;
    const result = await desktop.request('close', { target: checked.rival.raw });
    if (!result.ok) return false;
    for (let n = 0; n < 10; n++) {
      await wait(100);
      const observed = await observe(target);
      if (observed.error) return false;
      if (observed.gone) return true;
    }
    return false;
  }
  async function push(target, dir, loot) {
    let rival = target;
    let resistance = 0;
    // Keep this episode on the original monitor, including monitors with a
    // negative origin. Re-selecting a monitor at an edge can cause ping-pong.
    const area = hooks.getWorkArea(rival.visual);
    for (let step = 0; step < 160; step++) {
      if (aborted(loot)) return { outcome: 'abort' };
      const observed = await observe(rival);
      if (aborted(loot)) return { outcome: 'abort' };
      if (observed.error) return { outcome: 'defeat' };
      if (observed.gone) return { outcome: 'victory', gone: true };
      rival = observed.rival;
      const edge = dir > 0 ? area.x + area.width - rival.visual.w : area.x;
      if (atEdge(rival.visual, area, dir)) return { outcome: 'victory', rival, area };
      const x = rival.visual.x + Math.sign(edge - rival.visual.x) * Math.min(loot ? 52 : 24, Math.abs(edge - rival.visual.x));
      // A large transparent surface can start on a differently scaled monitor.
      // Convert the visible mascot anchor, then apply its physical delta to
      // the HWND. Converting the outer origin can choose the wrong display.
      const anchor = rival.raw.mascot || rival.raw;
      const point = toScreen({ x: Math.round(x), y: Math.round(rival.visual.y) });
      const moved = await desktop.request('move', { target: rival.raw,
        x: rival.raw.x + point.x - anchor.x, y: rival.raw.y });
      if (!moved.ok) {
        log('territory', `Windows move refused: ${moved.error}`);
        return { outcome: 'defeat' };
      }
      await wait(loot ? 25 : 45);
      const landed = await observe(rival);
      if (aborted(loot)) return { outcome: 'abort' };
      if (landed.error) return { outcome: 'defeat' };
      if (landed.gone) return { outcome: 'victory', gone: true };
      if (Math.abs(landed.rival.x - rival.x) < 2) resistance++; else resistance = 0;
      if (resistance >= 3) return { outcome: 'defeat' };
      rival = landed.rival;
      if (!loot) {
        const pet = hooks.getPetBounds();
        await hooks.tweenPetTo(standX(rival.visual.x, rival.visual.w, dir, pet.width), pet.y, 45);
      }
    }
    return { outcome: 'defeat' };
  }
  async function episode(target, loot, sessions) {
    const kind = loot ? 'loot' : 'territory';
    const home = hooks.getPetBounds();
    let flow = null;
    let outcome = 'abort';
    let kicked = false;
    try {
      const wa = hooks.getWorkArea(target.visual);
      const { dir } = edgeAwayFromPet(target.visual, wa, home);
      emit(kind, loot ? 'approach' : 'spotted', { rival: target.name, direction: dir });
      if (!loot) await wait(700);
      if (aborted(loot)) return 'abort';
      let x = loot ? lootApproachX(target.visual.x, target.visual.w, dir, home.x, home.width)
        : standX(target.visual.x, target.visual.w, dir, home.width);
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - home.width));
      const y = Math.max(wa.y, Math.min(target.visual.y + target.visual.h - home.height, wa.y + wa.height - home.height));
      if (!loot) emit(kind, 'march', { rival: target.name });
      await hooks.tweenPetTo(x, y, 900);
      if (aborted(loot)) return 'abort';
      const confirmed = await observe(target);
      if (!confirmed.rival) { outcome = 'defeat'; emit(kind, loot ? 'pushFailed' : 'defeat'); return outcome; }
      if (loot) {
        emit(kind, 'taunt', { rival: target.name, direction: dir });
        // Only real session metadata is imported into LLMPET's index. No
        // source log is moved, removed or rewritten.
        flow = createLootCaptureFlow(sessions, { wait, emit: hooks.emit, rival: target.name, direction: dir,
          shouldAbort: () => aborted(true) });
        const captured = await flow.stopForReady();
        if (aborted(true)) return 'abort';
        emit(kind, 'ready', { count: captured.length, direction: dir });
        await wait(flow.remainingAnimationMs());
        if (aborted(true)) return 'abort';
        emit(kind, 'kick', { direction: dir });
        await wait(420);
        if (aborted(true)) return 'abort';
        kicked = true;
        emit(kind, 'push', { direction: dir });
      }
      const pushed = await push(confirmed.rival, dir, loot);
      outcome = pushed.outcome;
      if (loot) {
        if (outcome === 'abort') return outcome;
        if (outcome !== 'victory') { emit(kind, 'pushFailed'); return outcome; }
        if (!pushed.gone && !(await close(pushed.rival, dir, pushed.area))) {
          if (aborted(true)) { outcome = 'abort'; return outcome; }
          emit(kind, 'closeFailed');
          return 'close-failed';
        }
        emit(kind, 'targetClosed', { direction: dir });
        emit(kind, 'closed', { direction: dir });
        return 'closed';
      }
      emit(kind, outcome, { rival: target.name });
      return outcome;
    } catch (error) {
      outcome = 'failed';
      log(kind, `Windows episode failed: ${error.message}`);
      emit(kind, loot ? 'failed' : 'defeat');
      return outcome;
    } finally {
      if (flow) flow.stop();
      if (outcome === 'abort') emit(kind, 'abort');
      if (!stopped && (!loot || !kicked)) {
        try { await hooks.tweenPetTo(home.x, home.y, 900); } catch {}
      }
    }
  }
  function run(force = false, loot = false, sessions = []) {
    const kind = loot ? 'loot' : 'territory';
    if (active) {
      if (force && activeKind === kind) return active;
      if (force) emit(kind, 'busy');
      return Promise.resolve('busy');
    }
    if (stopped) return Promise.resolve('blocked');
    if (!force && !hooks.isEnabled()) {
      if (dominating) hooks.relaxTop();
      dominating = false;
      return Promise.resolve('disabled');
    }
    activeKind = kind;
    automatic = !force;
    cancelRequested = false;
    active = (async () => {
      if (force) emit(kind, 'searching');
      if (!hooks.canScan()) {
        if (force) await wait(150);
        if (!hooks.canScan()) { if (force) emit(kind, 'blocked'); return 'blocked'; }
      }
      if (!force) {
        const idle = await desktop.request('idle');
        if (!idle.ok || idle.data < 2) return 'blocked';
      }
      const first = await scanDetailed();
      if (!first.ok) { emit(kind, loot ? 'failed' : 'blocked'); return 'scan-error'; }
      if (aborted(loot)) { if (force) emit(kind, 'abort'); return 'abort'; }
      if (first.rivals.length) { dominating = true; hooks.assertTop(); }
      else if (dominating) { dominating = false; hooks.relaxTop(); }
      const target = first.rivals.find((r) => {
        if (loot) return r.host;
        const area = hooks.getWorkArea(r.visual);
        return !atEdge(r.visual, area, -1) && !atEdge(r.visual, area, 1);
      });
      if (!target) {
        const present = !loot && first.rivals.length > 0;
        if (force) emit(kind, loot ? 'notFound' : present ? 'ontop' : 'clear');
        return present ? 'present' : 'clear';
      }
      await wait(140);
      const confirmed = await observe(target);
      if (aborted(loot)) { if (force) emit(kind, 'abort'); return 'abort'; }
      if (!confirmed.rival) { if (force) emit(kind, 'blocked'); return 'blocked'; }
      const visual = confirmed.rival.visual;
      const wa = hooks.getWorkArea(visual);
      if (!loot && (atEdge(visual, wa, -1) || atEdge(visual, wa, 1))) {
        if (force) emit(kind, 'ontop', { rival: target.name });
        return 'present';
      }
      return episode(confirmed.rival, loot, sessions);
    })().catch((error) => {
      log(kind, `Windows patrol failed: ${error.message}`);
      emit(kind, loot ? 'failed' : 'blocked');
      return 'scan-error';
    }).finally(() => { active = null; activeKind = null; });
    return active;
  }
  function start() {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => run(), Math.max(3000, Number(process.env.OCTOPUS_TERRITORY_INTERVAL) || 7000));
    timer.unref();
  }
  function stop() {
    stopped = true;
    clearInterval(timer); timer = null;
    desktop.stop();
  }
  function cancelPatrol() {
    if (activeKind === 'territory') cancelRequested = true;
    if (dominating) hooks.relaxTop();
    dominating = false;
  }
  return { start, stop, cancelPatrol, emergencyRelease: stop, scan: async () => (await scanDetailed()).rivals,
    tick: (force) => run(force), runNow: () => run(true), runLoot: (sessions) => run(true, true, sessions),
    get busy() { return !!active; }, get dominating() { return dominating; } };
}

module.exports = { createWindowsTerritory, selectRivals, sameWindow, PET_TITLE };
