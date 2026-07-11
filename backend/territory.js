'use strict';

// territory.js — 「领地模式」:两条定律。
//
// ① 猫爪在上定律:只要检测到别的桌宠进程在跑,就把自己窗口层级抬到
//    screen-saver 并每次巡逻 moveTop —— 谁也不许压在咱头上。只查进程名,
//    不碰别人窗口,**不需要**辅助功能权限,锁屏也能查。对手消失即降回
//    floating,不长期霸占高层级。
// ② 驱逐战:发现对方的窗口,走过去把它顶到屏幕边上(见下)。
//
// macOS only。扫描/推窗走 osascript + System Events(和 focus.js 同一条权限
// 链路),推窗需要「辅助功能(Accessibility)」授权;没授权时窗口扫描会失败,
// 降级为每 15 分钟提醒一次 + 只执行猫爪在上,不影响其余功能。
//
// 一场「驱逐战」(episode)的编排:
//   spotted(发现入侵者,愣 1s) → march(走到对方身侧) → 逐步把对方窗口推向
//   最近的水平屏幕边缘(每步 ~76px,osascript 的启动开销天然构成推挤节奏) →
//   victory(顶到边上)/ defeat(连续几步推不动 —— 比如 Desktop Goose 会自己
//   把窗口挪回来,拔河输了就认怂) → 走回原位。
// 宠物自身窗口的移动由 main.js 提供的 tweenPetTo 原语完成,本模块只管编排。

const { execFile, spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log } = require('./log');

// 已知桌宠的进程名特征(System Events 的 name contains 匹配,大小写不敏感)。
// 刻意保守:宁可漏认,不可把用户正经的悬浮小窗(画中画/计时器)当宠物顶走。
// 用户可在 ~/.octopus/config.json 的 territoryRivals 里追加(按「独立型」对待)。
//
// 独立型(dedicated):桌宠是独立进程,进程在跑 = 宠物在场(猫爪在上凭进程名
// 就触发,无需辅助功能权限)。
const DEFAULT_RIVALS = [
  'Desktop Goose', 'DesktopGoose',
  'BongoCat', 'Bongo Cat',
  'Shimeji',
  'WindowPet',
  'DeskPet',
];

// 寄生型(host):桌宠寄生在大应用进程里(Codex 桌宠属于 ChatGPT.app 进程,
// 和聊天主窗口同进程)。进程在 ≠ 宠物在 —— 必须扫到「宠物体型」的窗口才算在场,
// 否则用户一开 ChatGPT 聊天,章鱼就无脑常驻最高层。这类只走窗口扫描(需辅助功能)。
const HOST_RIVALS = ['ChatGPT'];

// 宠物体型上限(px):超过这个尺寸的窗口不认作桌宠(挡下 ChatGPT 主窗口、
// 也保证 MOVE 时永远只推同进程里最小的那扇宠物窗)。
const MAX_RIVAL_SIZE = 650;
const DRAG_HELPER = path.join(__dirname, 'drag-window.swift');
const PUSH_OVERLAP = 42;

// 只查「对手进程在不在」(名字+pid):不读窗口,无需辅助功能权限。
const PRESENCE_SCRIPT = [
  'on run argv',
  '  set out to ""',
  '  tell application "System Events"',
  '    repeat with pat in argv',
  '      repeat with p in (every process whose name contains pat)',
  '        set out to out & (name of p) & "|" & (unix id of p) & linefeed',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return out',
  'end run',
].join('\n');

// 列出匹配进程的**每一扇**窗口(一进程可能既有大主窗又有宠物窗,由 JS 侧按
// 体型过滤后选最小的那扇)。
const SCAN_SCRIPT = [
  'on run argv',
  '  set out to ""',
  '  tell application "System Events"',
  '    repeat with pat in argv',
  '      repeat with p in (every process whose name contains pat)',
  '        try',
  '          repeat with w in (every window of p)',
  '            set {px, py} to position of w',
  '            set {pw, ph} to size of w',
  '            set out to out & (name of p) & "|" & (unix id of p) & "|" & px & "|" & py & "|" & pw & "|" & ph & linefeed',
  '          end repeat',
  '        end try',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return out',
  'end run',
].join('\n');

// 一步推挤:在目标进程里挑「体型 ≤ maxSide 中最小」的窗口(= 宠物窗,永远不会
// 碰同进程的大主窗),先读它当前位置(对方可能自己挪回来了),再 set,再回读落点。
// 返回 "旧x|旧y|新x|新y";进程没了/没有宠物体型的窗口返回 "gone"。
// 注意变量名避开 AppleScript 保留字(by/at/of…都不能当变量)。
const MOVE_SCRIPT = [
  'on run argv',
  '  set thePid to (item 1 of argv) as integer',
  '  set nx to (item 2 of argv) as integer',
  '  set ny to (item 3 of argv) as integer',
  '  set maxSide to (item 4 of argv) as integer',
  '  tell application "System Events"',
  '    set procs to (every process whose unix id is thePid)',
  '    if (count of procs) is 0 then return "gone"',
  '    set bestWin to missing value',
  '    set bestArea to 0',
  '    repeat with w in (every window of (item 1 of procs))',
  '      set {pw, ph} to size of w',
  '      if pw is less than or equal to maxSide and ph is less than or equal to maxSide then',
  '        if bestWin is missing value or (pw * ph) < bestArea then',
  '          set bestWin to w',
  '          set bestArea to pw * ph',
  '        end if',
  '      end if',
  '    end repeat',
  '    if bestWin is missing value then return "gone"',
  '    set {oldX, oldY} to position of bestWin',
  // 透明/无标题栏 Electron 窗口对 System Events 的普通 `position` setter
  // 可能静默 no-op；直接写 AXPosition 才会真正经过 Accessibility API。
  '    set value of attribute "AXPosition" of bestWin to {nx, ny}',
  '    set {newX, newY} to position of bestWin',
  '    return (oldX as text) & "|" & (oldY as text) & "|" & (newX as text) & "|" & (newY as text)',
  '  end tell',
  'end run',
].join('\n');

// 在杂乱桌面上先把已确认的目标窗抬到普通窗口最上方，避免物理拖拽命中
// 覆盖它的编辑器/通知窗。自己的窗口仍在 screen-saver 层，并会再次 assertTop。
const RAISE_SCRIPT = [
  'on run argv',
  '  set thePid to (item 1 of argv) as integer',
  '  set targetW to (item 2 of argv) as integer',
  '  set targetH to (item 3 of argv) as integer',
  '  tell application "System Events"',
  '    set procs to (every process whose unix id is thePid)',
  '    if (count of procs) is 0 then return "gone"',
  '    set bestWin to missing value',
  '    set bestScore to 999999',
  '    repeat with w in (every window of (item 1 of procs))',
  '      set {pw, ph} to size of w',
  '      set dw to pw - targetW',
  '      if dw < 0 then set dw to -dw',
  '      set dh to ph - targetH',
  '      if dh < 0 then set dh to -dh',
  '      if (dw + dh) < bestScore then',
  '        set bestWin to w',
  '        set bestScore to dw + dh',
  '      end if',
  '    end repeat',
  '    if bestWin is missing value then return "gone"',
  '    perform action "AXRaise" of bestWin',
  '    return "ok"',
  '  end tell',
  'end run',
].join('\n');

function runOsa(script, args, timeout) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script, ...args.map(String)], { timeout: timeout || 5000 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err || '') });
      });
  });
}

function isPermError(errText) {
  return /assistive access|-25211|not authorized|-1719/i.test(errText || '');
}

// "name|pid" 行 → {name, pid};去重 pid,排除自己。
function parsePresence(out, excludePids) {
  const res = [];
  const seen = new Set();
  for (const line of String(out || '').split('\n')) {
    const parts = line.split('|');
    if (parts.length !== 2) continue;
    const name = parts[0].trim();
    const pid = +parts[1];
    if (!name || !Number.isFinite(pid)) continue;
    if (seen.has(pid) || (excludePids || []).includes(pid)) continue;
    seen.add(pid);
    res.push({ name, pid });
  }
  return res;
}

// "name|pid|x|y|w|h" 行(一行一扇窗)→ rival 列表。只认「宠物体型」(≤ maxSize)
// 的窗口,同 pid 取面积最小的一扇 —— 一个进程可能既有大主窗(ChatGPT 聊天窗)
// 又有宠物窗(Codex 桌宠),永远只盯后者。排除自己的 pid。
function parseScan(out, excludePids, maxSize) {
  const cap = maxSize == null ? MAX_RIVAL_SIZE : maxSize;
  const best = new Map(); // pid → 最小的宠物体型窗口
  for (const line of String(out || '').split('\n')) {
    const parts = line.split('|');
    if (parts.length !== 6) continue;
    const [name, pid, x, y, w, h] = parts;
    const r = { name: name.trim(), pid: +pid, x: +x, y: +y, w: +w, h: +h };
    if (!r.name || !Number.isFinite(r.pid) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    if (!(r.w > 0) || !(r.h > 0) || r.w > cap || r.h > cap) continue;
    if ((excludePids || []).includes(r.pid)) continue;
    const prev = best.get(r.pid);
    if (!prev || scanCandidateScore(r) < scanCandidateScore(prev)) best.set(r.pid, r);
  }
  return [...best.values()];
}

function scanCandidateScore(r) {
  if (/chatgpt/i.test(r.name)) {
    // Codex/ChatGPT 桌宠实机外框稳定为 356×320。优先轮廓匹配，而非同进程
    // 面积更小的通知、设置面板或瞬时 popup。
    const shape = Math.abs(r.w - 356) + Math.abs(r.h - 320);
    const implausible = r.w < 260 || r.w > 460 || r.h < 220 || r.h > 430;
    return (implausible ? 1e7 : 0) + shape;
  }
  return r.w * r.h;
}

// 推向左右哪条边:看对方中心离哪边近。返回 {dir, targetX};dir=-1 推向左。
function nearestEdgeTarget(rival, wa) {
  const cx = rival.x + rival.w / 2;
  const leftDist = cx - wa.x;
  const rightDist = wa.x + wa.width - cx;
  if (leftDist <= rightDist) return { dir: -1, targetX: wa.x };
  return { dir: 1, targetX: wa.x + wa.width - rival.w };
}

// 从小章鱼当前所在侧直接接近并把对方往远离自己的方向推，不为追求更近的
// 屏幕边而横穿对方。pet 在左 → 向右推；pet 在右 → 向左推。
function edgeAwayFromPet(rival, wa, pet) {
  const rivalCenter = rival.x + rival.w / 2;
  const petCenter = pet.x + pet.width / 2;
  if (petCenter <= rivalCenter) return { dir: 1, targetX: wa.x + wa.width - rival.w };
  return { dir: -1, targetX: wa.x };
}

function atEdge(rival, wa, slack) {
  const s = slack == null ? 12 : slack;
  return rival.x <= wa.x + s || rival.x + rival.w >= wa.x + wa.width - s;
}

function windowTargetForVisual(rival, visual, wa, dir) {
  const visualLeftOffset = visual.x - rival.x;
  const visualRightOffset = visualLeftOffset + visual.w;
  return dir === 1
    ? wa.x + wa.width - visualRightOffset
    : wa.x - visualLeftOffset;
}

function visualAtEdge(visual, wa, slack) {
  const s = slack == null ? 12 : slack;
  return visual.x <= wa.x + s || visual.x + visual.w >= wa.x + wa.width - s;
}

function interpolateFrame(from, to, progress) {
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  return {
    x: from.x + (to.x - from.x) * p,
    y: from.y + (to.y - from.y) * p,
  };
}

// 宠物站到对方身侧的 x(与对方保持 26px 重叠,看起来贴身顶着)
function standX(rivalX, rivalW, dir, petW) {
  return dir === 1 ? rivalX - petW + PUSH_OVERLAP : rivalX + rivalW - PUSH_OVERLAP;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// hooks(由 main.js 提供):
//   isEnabled()            — 领地模式开关(每 tick 现查 config)
//   rivalNames()           — 匹配特征列表(默认 + 用户自定义)
//   excludePids()          — 永不当成对手的 pid(自己)
//   canScan()              — 宠物窗口可见等前置条件
//   shouldAbort()          — 弹层打开/有待授权时中途撤退
//   getPetBounds()         — 宠物窗口当前 bounds
//   tweenPetTo(x, y, ms)   — 平滑走位(Promise)
//   getWorkArea(rect)      — rect 所在显示器的工作区
//   assertTop()            — 猫爪在上:窗口层级抬到 screen-saver + moveTop
//   relaxTop()             — 对手都走了,降回 floating
//   emit(ev)               — pet:event 转发({kind:'territory', phase, rival})
function createTerritory(hooks) {
  const intervalMs = Math.max(3000, +process.env.OCTOPUS_TERRITORY_INTERVAL || 7000);
  let timer = null;
  let episode = false;
  let lastPermNag = 0;
  let dominating = false; // 猫爪在上状态(边沿触发气泡,持续 moveTop)
  let checking = false;   // osascript 扫描尚未结束时禁止定时器/按钮重复开局
  let dragHelperPromise = null;
  let dragHelperBin = null;
  let lastPointerOrigin = null;
  const activeDrags = new Set();
  const preferredDragPoint = new Map(); // 对手名 → 上次成功命中的透明窗内部比例

  function rivalVisualBounds(rival) {
    if (!/chatgpt/i.test(rival.name)) return rival;
    // ChatGPT/Codex 桌宠寄生在较大的透明窗里；成功拖点近似可见本体中心。
    const [rx, ry] = preferredDragPoint.get(rival.name) || [0.65, 0.72];
    const side = Math.min(140, rival.w, rival.h);
    return {
      ...rival,
      x: rival.x + rival.w * rx - side / 2,
      y: rival.y + rival.h * ry - side / 2,
      w: side, h: side,
    };
  }

  function rivalAtEdge(rival, wa) {
    return /chatgpt/i.test(rival.name)
      ? visualAtEdge(rivalVisualBounds(rival), wa)
      : atEdge(rival, wa);
  }

  function extraRivals() {
    return String(process.env.OCTOPUS_TERRITORY_RIVALS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
  }

  function allNames() {
    return [...new Set([...hooks.rivalNames(), ...extraRivals()])];
  }

  async function presence() {
    const names = allNames();
    if (!names.length) return [];
    const res = await runOsa(PRESENCE_SCRIPT, names);
    if (!res.ok) return [];
    return parsePresence(res.out, hooks.excludePids());
  }

  function hostNames() {
    return hooks.hostRivalNames ? hooks.hostRivalNames() : HOST_RIVALS;
  }

  async function scan() {
    const names = [...new Set([...allNames(), ...hostNames()])];
    if (!names.length) return [];
    const res = await runOsa(SCAN_SCRIPT, names);
    if (!res.ok) {
      if (isPermError(res.err) && Date.now() - lastPermNag > 15 * 60 * 1000) {
        lastPermNag = Date.now();
        log('territory', 'no accessibility permission — cannot read rival windows');
        hooks.emit({ kind: 'territory', phase: 'noperm', ts: Date.now() });
      }
      return [];
    }
    return parseScan(res.out, hooks.excludePids());
  }

  async function moveRival(pid, x, y) {
    const res = await runOsa(MOVE_SCRIPT, [pid, Math.round(x), Math.round(y), MAX_RIVAL_SIZE]);
    if (!res.ok) return { error: res.err };
    if (res.out === 'gone') return { gone: true };
    const [bx, by, ax, ay] = res.out.split('|').map(Number);
    if (![bx, by, ax, ay].every(Number.isFinite)) return { error: 'bad output: ' + res.out };
    return { bx, by, ax, ay };
  }

  async function raiseRival(rival) {
    const res = await runOsa(RAISE_SCRIPT, [rival.pid, rival.w, rival.h]);
    if (!res.ok || res.out !== 'ok') {
      log('territory', 'raise rival failed:', String(res.err || res.out).slice(0, 200));
      return false;
    }
    if (hooks.assertTop) hooks.assertTop();
    return true;
  }

  function ensureDragHelper() {
    if (dragHelperPromise) return dragHelperPromise;
    const packaged = path.join(process.resourcesPath || '', 'drag-window');
    try {
      fs.accessSync(packaged, fs.constants.X_OK);
      dragHelperPromise = Promise.resolve({ ok: true, bin: packaged });
      dragHelperBin = packaged;
      return dragHelperPromise;
    } catch {}
    const bin = path.join(os.tmpdir(), `octopus-drag-window-${process.pid}`);
    dragHelperPromise = new Promise((resolve) => {
      execFile('/usr/bin/swiftc', ['-O', DRAG_HELPER, '-o', bin], { timeout: 20000 },
        (err, _stdout, stderr) => {
          if (!err) dragHelperBin = bin;
          resolve(err
            ? { ok: false, error: String(stderr || err || '').trim() }
            : { ok: true, bin });
        });
    });
    return dragHelperPromise;
  }

  async function dragRival(rival, targetX, rx, ry, durationMs = 520, onProgress) {
    // Drag from the visible center of the pet by exactly the window delta. The
    // Swift helper restores the user's cursor and always posts mouseUp.
    const helper = await ensureDragHelper();
    if (!helper.ok) return helper;
    const sx = rival.x + rival.w * rx;
    const sy = rival.y + rival.h * ry;
    const ex = sx + (targetX - rival.x);
    return new Promise((resolve) => {
      const child = spawn(helper.bin, [sx, sy, ex, sy, durationMs]);
      activeDrags.add(child);
      let stdout = '';
      let stderr = '';
      let lineBuf = '';
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 4000);
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdout += text;
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          const origin = /^original\|(-?[0-9.]+)\|(-?[0-9.]+)$/.exec(line.trim());
          if (origin) {
            lastPointerOrigin = { x: Number(origin[1]), y: Number(origin[2]) };
            continue;
          }
          const m = /^progress\|([0-9.]+)$/.exec(line.trim());
          if (m && onProgress) onProgress(Math.min(1, Math.max(0, Number(m[1]))));
        }
      });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { stderr += String(err || ''); });
      child.on('close', (code) => {
        activeDrags.delete(child);
        clearTimeout(killTimer);
        const ok = code === 0 && /ok\|/.test(stdout);
        if (!ok && dragHelperBin && !child._octopusReleased) {
          const origin = lastPointerOrigin ? [lastPointerOrigin.x, lastPointerOrigin.y] : [];
          spawnSync(dragHelperBin, ['--release', ...origin], { timeout: 1500 });
        }
        resolve({ ok, error: stderr.trim() });
      });
    });
  }

  async function calibrateDragPoint(rival, dir) {
    const learned = preferredDragPoint.get(rival.name);
    const xs = [0.65, 0.5, 0.35, 0.8, 0.2];
    const ys = [0.72, 0.5, 0.84, 0.3];
    const points = [];
    if (learned) points.push(learned);
    for (const y of ys) for (const x of xs) {
      if (!points.some(([px, py]) => px === x && py === y)) points.push([x, y]);
    }
    let current = { ...rival };
    try {
      if (hooks.setPetClickThrough) hooks.setPetClickThrough(true);
      for (const [rx, ry] of points) {
        if (hooks.shouldAbort()) return null;
        const beforeX = current.x;
        const probeX = beforeX + dir * 22;
        const dragged = await dragRival(current, probeX, rx, ry, 180);
        if (!dragged.ok) {
          log('territory', 'drag calibration helper failed:', dragged.error.slice(0, 240));
          return null;
        }
        await sleep(110);
        const rescanned = (await scan()).find((candidate) => candidate.pid === rival.pid);
        if (!rescanned) return null;
        const delta = rescanned.x - beforeX;
        log('territory', `calibrate @${rx},${ry}: ${beforeX} -> ${rescanned.x}`);
        current = rescanned;
        if (Math.abs(delta) > 6) {
          preferredDragPoint.set(rival.name, [rx, ry]);
          log('territory', `calibrated drag anchor for "${rival.name}": ${rx},${ry}`);
          return current;
        }
      }
      return null;
    } finally {
      if (hooks.setPetClickThrough) hooks.setPetClickThrough(false);
    }
  }

  async function physicalPush(rival, dir, petB) {
    let point = preferredDragPoint.get(rival.name);
    if (!point) return 'defeat';
    let current = { ...rival };
    const startX = current.x;
    let maxTravel = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (hooks.shouldAbort()) return 'abort';
      const wa = hooks.getWorkArea(current);
      const visual = rivalVisualBounds(current);
      const targetX = windowTargetForVisual(current, visual, wa, dir);
      const finalVisualX = visual.x + (targetX - current.x);
      const finalPetX = Math.min(Math.max(
        standX(finalVisualX, visual.w, dir, petB.width),
        wa.x - petB.width + 60), wa.x + wa.width - 60);
      let dragged;
      const startPet = hooks.getPetBounds();
      let syncFrames = 0;
      let finalProgress = 0;
      const syncStarted = Date.now();
      try {
        if (hooks.setPetClickThrough) hooks.setPetClickThrough(true);
        dragged = await dragRival(current, targetX, point[0], point[1], 720, (progress) => {
          if (!hooks.setPetFrame) return;
          syncFrames++;
          finalProgress = progress;
          const frame = interpolateFrame(startPet, { x: finalPetX, y: petB.y }, progress);
          hooks.setPetFrame(frame.x, frame.y);
        });
      } finally {
        if (hooks.endPetFrames) hooks.endPetFrames();
        if (hooks.setPetClickThrough) hooks.setPetClickThrough(false);
      }
      log('territory', `sync frames=${syncFrames} duration=${Date.now() - syncStarted}ms final=${finalProgress.toFixed(3)}`);
      if (!dragged.ok) return 'defeat';
      await sleep(260);
      const rescanned = (await scan()).find((candidate) => candidate.pid === rival.pid);
      if (!rescanned) return 'victory';
      log('territory', `physical push ${attempt + 1}: ${current.x},${current.y} -> ${rescanned.x},${rescanned.y}`);
      maxTravel = Math.max(maxTravel, Math.abs(rescanned.x - startX));
      current = rescanned;
      if (rivalAtEdge(current, hooks.getWorkArea(current))) return 'victory';
      // 点击区域会随 ChatGPT 桌宠姿态/位置变化。每次停滞后重新抬窗和校准，
      // 不要拿同一失效锚点机械重试。
      await raiseRival(current);
      const recalibrated = await calibrateDragPoint(current, dir);
      if (recalibrated) {
        maxTravel = Math.max(maxTravel, Math.abs(recalibrated.x - startX));
        current = recalibrated;
        point = preferredDragPoint.get(rival.name) || point;
      }
    }
    // 窗口发生了明显位移但透明外框被系统边界 clamp，不能误报「纹丝不动」。
    return maxTravel > 8 ? 'partial' : 'defeat';
  }

  // 推挤主循环。返回 'victory' | 'defeat' | 'abort'。
  // 每步以对方「当前实际位置 bx」为基准前进(对方可能自己挪动/挪回),
  // 离边距离连续 4 步没有实质缩短(<20px)→ 拔河输了,认怂。
  async function pushLoop(rival, dir, targetX, wa, petB) {
    let resist = 0;
    let prevDist = Infinity;
    let dragTried = false;
    for (let i = 0; i < 80; i++) {
      if (hooks.shouldAbort()) return 'abort';
      const stepTarget = dir === 1
        ? Math.min(targetX, rival.x + 76)
        : Math.max(targetX, rival.x - 76);
      const r = await moveRival(rival.pid, stepTarget, rival.y);
      if (r.gone) {
        log('territory', `rival "${rival.name}" vanished mid-push — counts as a win`);
        return 'victory';
      }
      if (r.error) {
        if (isPermError(r.error)) hooks.emit({ kind: 'territory', phase: 'noperm', ts: Date.now() });
        log('territory', 'push step failed:', r.error.slice(0, 200));
        return 'defeat';
      }
      // 下一步从真实落点出发;y 也跟着对方走(有的宠物会上下乱跳)
      log('territory', `push ${i + 1}: requested ${stepTarget},${rival.y}; actual ${r.bx},${r.by} -> ${r.ax},${r.ay}`);
      rival.x = r.ax; rival.y = r.ay;
      const distToEdge = Math.abs(targetX - rival.x);
      if (distToEdge <= 6) return 'victory';
      if (distToEdge > prevDist - 20) resist++; else resist = 0;
      if (resist >= 4) {
        if (dragTried) return 'defeat';
        dragTried = true;
        log('territory', `AXPosition ignored by "${rival.name}" — trying physical mouse drag fallback`);
        // 透明窗口的几何中心可能没有任何可拖内容。依次探测少量内部候选点，
        // 每次都重扫验证；一旦真实移动立即停止探测。
        const learned = preferredDragPoint.get(rival.name);
        const defaults = [[0.65, 0.72], [0.5, 0.72], [0.5, 0.5], [0.35, 0.72], [0.5, 0.84]];
        const points = learned
          ? [learned, ...defaults.filter(([x, y]) => x !== learned[0] || y !== learned[1])]
          : defaults;
        let current = { ...rival };
        let moved = false;
        for (const [rx, ry] of points) {
          const beforeX = current.x;
          // 对方和小章鱼沿同一时长同步移动，保持 PUSH_OVERLAP 的贴身推挤。
          const visual = rivalVisualBounds(current);
          // 窗口外框移动 delta 与可见本体一致，所以把 visual.x 平移到最终位置。
          const finalVisualX = visual.x + (targetX - current.x);
          const finalPetX = Math.min(Math.max(
            standX(finalVisualX, visual.w, dir, petB.width),
            wa.x - petB.width + 60), wa.x + wa.width - 60);
          let dragged;
          try {
            if (hooks.setPetClickThrough) hooks.setPetClickThrough(true);
            [dragged] = await Promise.all([
              dragRival(current, targetX, rx, ry),
              hooks.tweenPetTo(finalPetX, petB.y, 600),
            ]);
          } finally {
            if (hooks.setPetClickThrough) hooks.setPetClickThrough(false);
          }
          if (!dragged.ok) {
            log('territory', 'mouse drag fallback failed:', dragged.error.slice(0, 240));
            return 'defeat';
          }
          await sleep(260);
          const rescanned = (await scan()).find((candidate) => candidate.pid === rival.pid);
          if (!rescanned) return 'victory';
          current = rescanned;
          log('territory', `mouse drag @${rx},${ry}: ${beforeX} -> ${current.x}`);
          if (Math.abs(current.x - beforeX) > 8 || atEdge(current, hooks.getWorkArea(current))) {
            moved = true;
            preferredDragPoint.set(rival.name, [rx, ry]);
            break;
          }
        }
        rival.x = current.x; rival.y = current.y;
        const currentWa = hooks.getWorkArea(current);
        const currentTarget = nearestEdgeTarget(current, currentWa).targetX;
        const afterDragDist = Math.abs(currentTarget - rival.x);
        log('territory', `mouse drag result: ${current.x},${current.y}; distance to nearest edge ${afterDragDist}`);
        if (atEdge(current, currentWa)) return 'victory';
        if (!moved) return 'defeat';
        resist = 0;
        prevDist = afterDragDist;
      }
      prevDist = distToEdge;
      // 贴身跟上,保持顶着的姿态
      const px = Math.min(Math.max(standX(rival.x, rival.w, dir, petB.width), wa.x - petB.width + 60), wa.x + wa.width - 60);
      await hooks.tweenPetTo(px, petB.y, 130);
      await sleep(40);
    }
    return 'defeat';
  }

  async function runEpisode(rival) {
    episode = true;
    const home = hooks.getPetBounds();
    let outcome = 'abort';
    try {
      log('territory', `spotted rival "${rival.name}" (pid ${rival.pid}) at ${rival.x},${rival.y} ${rival.w}x${rival.h}`);
      hooks.emit({ kind: 'territory', phase: 'spotted', rival: rival.name, ts: Date.now() });
      await sleep(1100);
      if (hooks.shouldAbort()) return;

      let wa = hooks.getWorkArea(rival);
      let pet = hooks.getPetBounds();
      if (/chatgpt/i.test(rival.name)) {
        // 透明窗口没有稳定几何中心：先在小章鱼保持原位时校准真实可拖锚点。
        await raiseRival(rival);
        const roughDir = pet.x + pet.width / 2 <= rival.x + rival.w / 2 ? 1 : -1;
        const calibrated = await calibrateDragPoint(rival, roughDir);
        if (!calibrated) {
          outcome = 'defeat';
          log('territory', `could not calibrate draggable area for "${rival.name}"`);
          hooks.emit({ kind: 'territory', phase: outcome, rival: rival.name, ts: Date.now() });
          return;
        }
        rival = calibrated;
        wa = hooks.getWorkArea(rival);
        pet = hooks.getPetBounds();
      }
      const visualRival = rivalVisualBounds(rival);
      const { dir } = edgeAwayFromPet(visualRival, wa, pet);
      // 推窗目标必须使用真实透明外框宽度；接近/接触才使用可见本体。
      const targetX = /chatgpt/i.test(rival.name)
        ? windowTargetForVisual(rival, visualRival, wa, dir)
        : (dir === 1 ? wa.x + wa.width - rival.w : wa.x);
      log('territory', `approach: pet ${pet.x},${pet.y} ${pet.width}x${pet.height}; ` +
        `rival window ${rival.x},${rival.y} ${rival.w}x${rival.h}; ` +
        `visual ${Math.round(visualRival.x)},${Math.round(visualRival.y)} ${visualRival.w}x${visualRival.h}; ` +
        `push ${dir === 1 ? 'right' : 'left'} to ${targetX}`);

      // 走到对方身侧(推的反方向那一侧),底边对齐,不出工作区
      let sx = standX(visualRival.x, visualRival.w, dir, pet.width);
      let sy = visualRival.y + visualRival.h - pet.height;
      sx = Math.min(Math.max(sx, wa.x - pet.width + 60), wa.x + wa.width - 60);
      sy = Math.min(Math.max(sy, wa.y), wa.y + wa.height - pet.height);
      hooks.emit({ kind: 'territory', phase: 'march', rival: rival.name, ts: Date.now() });
      const dist = Math.hypot(sx - pet.x, sy - pet.y);
      await hooks.tweenPetTo(sx, sy, Math.min(2600, Math.max(700, dist / 0.6)));
      if (hooks.shouldAbort()) return;

      outcome = /chatgpt/i.test(rival.name)
        ? await physicalPush({ ...rival }, dir, { ...pet, x: sx, y: sy })
        : await pushLoop({ ...rival }, dir, targetX, wa, { ...pet, x: sx, y: sy });
      if (outcome === 'victory' || outcome === 'partial' || outcome === 'defeat') {
        log('territory', `episode vs "${rival.name}": ${outcome}`);
        hooks.emit({ kind: 'territory', phase: outcome, rival: rival.name, ts: Date.now() });
        await sleep(900); // 让表情/气泡先演一拍再回家
      }
    } catch (e) {
      log('territory', 'episode error:', e.message);
    } finally {
      try { await hooks.tweenPetTo(home.x, home.y, 1600); } catch {}
      episode = false;
    }
  }

  async function tick(force = false) {
    if (!force && !hooks.isEnabled()) {
      if (dominating) { dominating = false; hooks.relaxTop(); }
      return 'disabled';
    }
    if (episode || checking) return 'busy';
    checking = true;

    try {

    // 独立型对手:进程在即在场(无需辅助功能权限,锁屏也能查)。
    const dedicated = await presence();
    // 窗口级扫描:独立型 + 寄生型(如 ChatGPT 里的 Codex 桌宠),需辅助功能权限。
    let rivals = [];
    if (!episode && hooks.canScan()) rivals = await scan();
    if (episode) return 'busy'; // scan 期间可能已被并发 tick 抢先开战

    // ── 定律①:猫爪在上。任一对手在场就持续 moveTop(对手也可能自抬,每次
    // 巡逻都重申);对手全走光才降回 floating。
    if (dedicated.length || rivals.length) {
      if (!dominating) {
        dominating = true;
        const who = (dedicated[0] || rivals[0]).name;
        log('territory', `rival present (${[...dedicated, ...rivals].map((p) => p.name).join(',')}) — asserting top`);
        hooks.emit({ kind: 'territory', phase: 'ontop', rival: who, ts: Date.now() });
      }
      hooks.assertTop();
    } else if (dominating) {
      dominating = false;
      log('territory', 'rivals gone — back to floating level');
      hooks.relaxTop();
    }

    // ── 定律②:驱逐战(要能看到对方的宠物窗才打得起来)
    const now = Date.now();
    for (const scanned of rivals) {
      let r = scanned;
      if (/chatgpt/i.test(r.name)) {
        // 连续两帧确认同一尺寸候选，过滤通知/弹层等瞬时小窗。
        await sleep(140);
        const confirmed = (await scan()).find((candidate) => candidate.pid === r.pid
          && Math.abs(candidate.w - r.w) <= 2 && Math.abs(candidate.h - r.h) <= 2);
        if (!confirmed) {
          log('territory', `unstable ChatGPT candidate ${r.pid} — skipping this patrol`);
          continue;
        }
        r = confirmed;
      }
      const wa = hooks.getWorkArea(r);
      if (rivalAtEdge(r, wa)) continue; // 可见本体贴边才算完成，不看透明外框
      if (hooks.canMove && !hooks.canMove()) {
        if (now - lastPermNag > 60 * 1000) {
          lastPermNag = now;
          hooks.emit({ kind: 'territory', phase: 'noperm', ts: now });
        }
        return 'noperm';
      }
      await runEpisode(r);
      return 'episode'; // 一次只打一架
    }
    return dedicated.length || rivals.length ? 'present' : 'clear';
    } finally {
      checking = false;
    }
  }

  async function runNow() {
    hooks.emit({ kind: 'territory', phase: 'searching', ts: Date.now() });
    const result = await tick(true);
    if (result === 'clear') hooks.emit({ kind: 'territory', phase: 'clear', ts: Date.now() });
    else if (result === 'busy') hooks.emit({ kind: 'territory', phase: 'busy', ts: Date.now() });
    return result;
  }

  function start() {
    if (timer || process.platform !== 'darwin') return;
    // 后台预编译一次，真正打架时不再卡在 Swift 冷启动。
    ensureDragHelper().then((r) => {
      if (!r.ok) log('territory', 'drag helper compile failed:', r.error.slice(0, 240));
    });
    timer = setInterval(() => { tick().catch((e) => log('territory', 'tick error:', e.message)); }, intervalMs);
    if (timer.unref) timer.unref();
    log('territory', `watching for rivals every ${intervalMs}ms`);
  }
  function emergencyRelease() {
    for (const child of activeDrags) {
      child._octopusReleased = true;
      try { child.kill('SIGKILL'); } catch {}
    }
    activeDrags.clear();
    if (!dragHelperBin) return;
    const origin = lastPointerOrigin ? [lastPointerOrigin.x, lastPointerOrigin.y] : [];
    try { spawnSync(dragHelperBin, ['--release', ...origin], { timeout: 1500 }); } catch {}
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    emergencyRelease();
  }

  return { start, stop, emergencyRelease, scan, tick, runNow, get busy() { return episode || checking; }, get dominating() { return dominating; } };
}

module.exports = { createTerritory, parsePresence, parseScan, scanCandidateScore, nearestEdgeTarget, edgeAwayFromPet, atEdge, windowTargetForVisual, visualAtEdge, interpolateFrame, standX, DEFAULT_RIVALS, HOST_RIVALS, MAX_RIVAL_SIZE };
