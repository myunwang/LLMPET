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
const crypto = require('crypto');
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
// 112px ChatGPT mascot 的可见中心距边约 42px；重叠也设 42 会让章鱼
// 120px 透明窗的边缘正好盖住拖拽热点。保留 30px 贴身重叠，同时给热点
// 留出 12px 命中安全缝，避免 click-through 切换竞争导致第一次长拖失效。
const PUSH_OVERLAP = 30;

// Codex 桌宠的 Electron 透明窗固定为 356x320；机器人本体会根据窗口位于
// 屏幕哪一侧在四个 placement 间翻转。这里的数据来自 ChatGPT.app 当前的
// avatar-overlay 布局，而不是把某次“能拖动的点”误当成本体中心。
const CHATGPT_VIEWPORT = { w: 356, h: 320 };
const CHATGPT_MASCOT = {
  width: 112,
  height: 121,
  startLeft: 11,
  endLeft: 216,
  upperTop: 64,
  lowerTop: 191,
  // sprite 自身左右各约 14px 透明；边界判定按真正看得见的像素，而非透明框。
  visiblePadX: 14,
};

function chatGPTPlacement(rival, wa, dir = 0) {
  const end = dir === 1 || (dir === 0
    && rival.x + rival.w / 2 >= wa.x + wa.width / 2);
  // 窗口在屏幕上半部时，mascot 位于透明窗下半部；下半部反之。
  const lower = rival.y + rival.h / 2 <= wa.y + wa.height / 2;
  return { end, lower };
}

function chatGPTVisualBounds(rival, wa, dir = 0, learned = null) {
  const placement = chatGPTPlacement(rival, wa, dir);
  if (learned) {
    const xEnd = 272 / CHATGPT_VIEWPORT.w;
    const xStart = 67 / CHATGPT_VIEWPORT.w;
    const yLower = 251 / CHATGPT_VIEWPORT.h;
    const yUpper = 124 / CHATGPT_VIEWPORT.h;
    // placement 是 ChatGPT 内部粘滞状态，不会因为本轮要向左/右推就翻转。
    // 已校准锚点始终比推送方向可靠，否则 start/end 会错整整 205px。
    placement.end = Math.abs(learned[0] - xEnd) <= Math.abs(learned[0] - xStart);
    placement.lower = Math.abs(learned[1] - yLower) <= Math.abs(learned[1] - yUpper);
  }
  const sx = rival.w / CHATGPT_VIEWPORT.w;
  const sy = rival.h / CHATGPT_VIEWPORT.h;
  const frameLeft = placement.end ? CHATGPT_MASCOT.endLeft : CHATGPT_MASCOT.startLeft;
  const frameTop = placement.lower ? CHATGPT_MASCOT.lowerTop : CHATGPT_MASCOT.upperTop;
  return {
    ...rival,
    x: rival.x + (frameLeft + CHATGPT_MASCOT.visiblePadX) * sx,
    y: rival.y + frameTop * sy,
    w: (CHATGPT_MASCOT.width - CHATGPT_MASCOT.visiblePadX * 2) * sx,
    h: CHATGPT_MASCOT.height * sy,
  };
}

function chatGPTDragCandidates(_rival, _wa, learned = null) {
  // 112x121 默认 mascot 的四个稳定中心。中心像素在当前 57 个动画状态帧中
  // 都是不透明的。placement 具有历史粘滞，不能用透明外框所在半区猜测；
  // 首次按 ChatGPT 默认 top-end，之后从上次实测点开始逐轴翻转。
  const xEnd = 272 / CHATGPT_VIEWPORT.w;
  const xStart = 67 / CHATGPT_VIEWPORT.w;
  const yLower = 251 / CHATGPT_VIEWPORT.h;
  const yUpper = 124 / CHATGPT_VIEWPORT.h;
  if (!learned) return [
    [xEnd, yLower],
    [xStart, yLower],
    [xEnd, yUpper],
    [xStart, yUpper],
  ];
  const x = Math.abs(learned[0] - xEnd) <= Math.abs(learned[0] - xStart) ? xEnd : xStart;
  const y = Math.abs(learned[1] - yLower) <= Math.abs(learned[1] - yUpper) ? yLower : yUpper;
  const flipX = x === xEnd ? xStart : xEnd;
  const flipY = y === yLower ? yUpper : yLower;
  return [[x, y], [flipX, y], [x, flipY], [flipX, flipY]];
}

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

// 在杂乱桌面上先把已确认的目标窗抬到普通窗口最上方，供非 ChatGPT 对手的
// 定向事件 fallback 使用。自己的窗口仍会再次 assertTop。
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
  '    if bestScore > 48 then return "gone"',
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

// 用户输入空闲秒数(IOHIDSystem 的 HIDIdleTime,纳秒)。巡视已经不接管系统
// 鼠标，但自动模式仍避开用户正操作同一桌宠/应用的时刻。
// 读取失败按「空闲」放行(ioreg 在 macOS 上基本不会失败,失败多半是环境异常)。
function userIdleSeconds() {
  return new Promise((resolve) => {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 3000 }, (err, stdout) => {
      const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout || ''));
      resolve(err || !m ? Infinity : Number(m[1]) / 1e9);
    });
  });
}
const IDLE_BEFORE_DRAG_S = 2;
// 部分第三方桌宠 fallback 可能让 HIDIdleTime 变化。成功动作后给短宽限，
// 避免把自身事件误判为用户输入；开战前用户活跃保护仍然生效。
const OWN_DRAG_IDLE_GRACE_MS = 1800;

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
    // ChatGPT 同进程还有通知、设置、快捷面板等小窗。桌宠外框稳定为
    // 356x320；硬过滤轮廓，不能只给 popup 一个较差分数后仍把它当宠物。
    if (/chatgpt/i.test(r.name)
        && Math.abs(r.w - CHATGPT_VIEWPORT.w) + Math.abs(r.h - CHATGPT_VIEWPORT.h) > 24) continue;
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
    return shape;
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

function atEdgeInDirection(rival, wa, dir, slack) {
  const s = slack == null ? 12 : slack;
  return dir === 1
    ? rival.x + rival.w >= wa.x + wa.width - s
    : rival.x <= wa.x + s;
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


function visualAtEdgeInDirection(visual, wa, dir, slack) {
  const s = slack == null ? 12 : slack;
  return dir === 1
    ? visual.x + visual.w >= wa.x + wa.width - s
    : visual.x <= wa.x + s;
}

function visualShiftMatches(record, rival) {
  return !!record
    && Math.abs(record.windowW - rival.w) <= 3
    && Math.abs(record.windowH - rival.h) <= 3;
}

function visualShiftOffset(record, rival) {
  return {
    dx: Number.isFinite(record && record.targetWindowX)
      ? record.targetWindowX - rival.x
      : Number(record && record.dx) || 0,
    dy: Number(record && record.dy) || 0,
  };
}

function parseWarpHelperLine(line) {
  const text = String(line || '').trim();
  const progress = /^progress\|([0-9.]+)$/.exec(text);
  if (progress) return { type: 'progress', progress: Math.min(1, Math.max(0, Number(progress[1]))) };
  if (/^stable\|/.test(text)) return { type: 'stable' };
  if (/^warped\|/.test(text)) return { type: 'warped' };
  if (/^released\|user=1$/.test(text)) return { type: 'user-release' };
  if (/^unwarped\|/.test(text)) return { type: 'unwarped' };
  return { type: 'other' };
}

const MAX_WARP_RECOVERY_ATTEMPTS = 2;
function warpHoldNeedsRecovery(entry) {
  return !!entry
    && entry.confirmedStable === true
    && entry.stopping !== true
    && entry.userReleased !== true
    && (Number(entry.recoveryAttempt) || 0) < MAX_WARP_RECOVERY_ATTEMPTS;
}

function interpolateFrame(from, to, progress) {
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  return {
    x: from.x + (to.x - from.x) * p,
    y: from.y + (to.y - from.y) * p,
  };
}

function parseDragHelperResult(stdout, code) {
  const out = String(stdout || '');
  const interrupted = /^interrupted\|user=1$/m.test(out);
  if (code !== 0) return { ok: false, interrupted, error: `drag helper exited ${code}` };
  if (!/^interrupted\|user=0$/m.test(out)
      || !/^transport\|targeted=1\|pid=\d+\|window=\d+\|nsEvent=1\|windowLocation=1\|slevent=1\|eventMask=1\|warp=0\|associate=0\|hide=0$/m.test(out)
      || !/^release\|targeted=1$/m.test(out)
      || !/^ok\|targeted=1\|userCursorFree=1$/m.test(out)) {
    return { ok: false, interrupted, error: 'drag helper did not prove targeted cursor-free transport' };
  }
  if (!/^overlay\|native=1\|opaque=0\|alpha=0\|shadow=0\|ignoresMouse=1\|sharing=1\|cornerAlpha=0\|serverBounds=1\|serverSharing=1$/m.test(out)) {
    return { ok: false, error: 'drag helper did not confirm a clear native pointer overlay' };
  }
  const m = /^cursor\|(-?[0-9.]+)\|(-?[0-9.]+)\|(-?[0-9.]+)\|(-?[0-9.]+)$/m.exec(out);
  if (!m) return { ok: false, error: 'drag helper omitted physical cursor observations' };
  const [ox, oy, rx, ry] = m.slice(1).map(Number);
  const cursorTravel = Math.hypot(rx - ox, ry - oy);
  if (!Number.isFinite(cursorTravel)) return { ok: false, error: 'invalid physical cursor observations' };
  // Movement is allowed: it means the user used the real pointer concurrently.
  return { ok: true, interrupted: false, cursorTravel };
}

function parseIsolatedDragHelperResult(stdout, code) {
  const out = String(stdout || '');
  if (code === 7 && /^hit\|target=0$/m.test(out)) {
    return { ok: false, miss: true, error: 'isolated drag point did not hit target window' };
  }
  if (code !== 0) return { ok: false, miss: false, error: `isolated drag helper exited ${code}` };
  if (!/^hit\|target=1$/m.test(out)
      || !/^isolation\|afterCapture=1\|associate=0$/m.test(out)
      || !/^restore\|warp=0\|associate=0\|show=0$/m.test(out)
      || !/^button\|left=0$/m.test(out)
      || !/^transport\|isolated-hid=1\|warp=0$/m.test(out)
      || !/^ok\|hide=0\|associate=0\|afterCapture=1\|restored=1$/m.test(out)) {
    return { ok: false, miss: false, error: 'isolated drag did not prove cursor restoration' };
  }
  if (!/^overlay\|native=1\|opaque=0\|alpha=0\|shadow=0\|ignoresMouse=1\|sharing=1\|cornerAlpha=0\|serverBounds=1\|serverSharing=1$/m.test(out)) {
    return { ok: false, miss: false, error: 'isolated drag pointer overlay was not transparent' };
  }
  const cursor = /^cursor\|(-?[0-9.]+)\|(-?[0-9.]+)\|(-?[0-9.]+)\|(-?[0-9.]+)$/m.exec(out);
  if (!cursor) return { ok: false, miss: false, error: 'isolated drag omitted cursor restoration coordinates' };
  const [ox, oy, rx, ry] = cursor.slice(1).map(Number);
  const cursorDrift = Math.hypot(rx - ox, ry - oy);
  if (!Number.isFinite(cursorDrift) || cursorDrift > 2) {
    return { ok: false, miss: false, error: `isolated drag cursor drifted ${cursorDrift}px` };
  }
  return { ok: true, miss: false, cursorDrift };
}

function parseProbeHelperResult(stdout, code, points) {
  const out = String(stdout || '');
  const interrupted = /^interrupted\|user=1$/m.test(out);
  if (code !== 0) return { ok: false, interrupted, error: `probe helper exited ${code}` };
  if (!/^interrupted\|user=0$/m.test(out)
      || !/^transport\|targeted=1\|pid=\d+\|window=\d+\|nsEvent=1\|windowLocation=1\|slevent=1\|eventMask=1\|warp=0\|associate=0\|hide=0$/m.test(out)
      || !/^overlay\|native=1\|opaque=0\|alpha=0\|shadow=0\|ignoresMouse=1\|sharing=1\|cornerAlpha=0\|serverBounds=1\|serverSharing=1$/m.test(out)) {
    return { ok: false, interrupted, error: 'probe helper did not prove targeted cursor-free transport' };
  }
  const cursor = /^cursor\|(-?[0-9.]+)\|(-?[0-9.]+)\|(-?[0-9.]+)\|(-?[0-9.]+)$/m.exec(out);
  const probe = /^probe\|(-?\d+)$/m.exec(out);
  if (!cursor || !probe) return { ok: false, error: 'probe helper output incomplete' };
  const [ox, oy, rx, ry] = cursor.slice(1).map(Number);
  const cursorTravel = Math.hypot(rx - ox, ry - oy);
  const index = Number(probe[1]);
  if (!Number.isFinite(cursorTravel) || !Number.isInteger(index)
      || index < -1 || index >= points.length) {
    return { ok: false, error: 'probe helper returned invalid cursor or candidate data' };
  }
  return { ok: true, interrupted: false, index,
    point: index >= 0 ? points[index] : null, cursorTravel };
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
  // 可注入的副作用原语(测试用假实现驱动整场驱逐战,不真调 osascript/CGEvent)
  const osa = hooks.runOsa || runOsa;
  const wait = hooks.sleep || sleep;
  const idleSeconds = hooks.userIdleSeconds || userIdleSeconds;
  const drag = hooks.dragRival || dragRival; // 函数声明有提升,此处可安全引用
  const isolatedDrag = hooks.isolatedDragRival || isolatedDragRival;
  const probe = hooks.probeDragPoint || probeDragPoint;
  const clearVisual = hooks.clearRivalVisual || clearRivalVisual;
  const warpVisual = hooks.warpRivalVisual || warpRivalVisual;
  let timer = null;
  let episode = false;
  let lastPermNag = 0;
  let dominating = false; // 猫爪在上状态(边沿触发气泡,持续 moveTop)
  let checking = false;   // osascript 扫描尚未结束时禁止定时器/按钮重复开局
  let dragHelperPromise = null;
  let dragHelperBin = null;
  const activeDrags = new Set();
  const activeWarps = new Map();
  const preferredDragPoint = new Map(); // 普通桌宠按名称，ChatGPT 按 pid 缓存拖点候选
  const visualShiftByPid = new Map(); // WindowServer 视觉偏移；AXPosition 不会反映它
  let lastOwnDragAt = 0;
  let manualDragAuthorized = false; // 点击“巡视”本身不能被 HID idle 闸门当成用户干扰
  let episodeInterrupted = false; // helper 检测到物理按键后，整场立即让用户优先

  function dragPointKey(rival) {
    return /chatgpt/i.test(rival.name) ? `${rival.name}:${rival.pid}` : rival.name;
  }

  function getPreferredDragPoint(rival) {
    return preferredDragPoint.get(dragPointKey(rival));
  }

  function setPreferredDragPoint(rival, point) {
    preferredDragPoint.set(dragPointKey(rival), point);
  }

  function rivalVisualBounds(rival, includeWindowServerShift = true, dir = 0) {
    if (!/chatgpt/i.test(rival.name)) return rival;
    // “能拖动的点”和“机器人在哪里”是两回事。透明根节点也可能响应拖拽，
    // 所以视觉几何必须来自四象限 layout，绝不能随 learned anchor 漂移。
    const visual = chatGPTVisualBounds(rival, hooks.getWorkArea(rival), dir, getPreferredDragPoint(rival));
    if (includeWindowServerShift) {
      const shifted = visualShiftByPid.get(rival.pid);
      if (visualShiftMatches(shifted, rival)) {
        // helper 会抵消 ChatGPT 自己对逻辑 x 的更新，把合成层窗口持续钉在
        // targetWindowX。这里也必须用动态差值，不能沿用开战时的旧 dx。
        const offset = visualShiftOffset(shifted, rival);
        visual.x += offset.dx;
        visual.y += offset.dy;
      } else if (shifted) {
        // 窗口轮廓改变说明原宠物窗已被替换，旧补偿不能沿用。
        visualShiftByPid.delete(rival.pid);
      }
    }
    return visual;
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

  // 自动巡视避开用户正在交互的时刻。普通桌宠走定向事件；ChatGPT 因为
  // Electron 拒绝定向 capture，会短暂租用全局 HID，但 helper 必须在返回前
  // 恢复真鼠标位置/显示/关联，失败时父进程再执行一次 emergency release。
  async function userHandsOff() {
    if (episodeInterrupted) {
      log('territory', 'user intervened during targeted patrol input — abort');
      return false;
    }
    if (manualDragAuthorized) return true;
    const idle = await idleSeconds();
    if (idle >= IDLE_BEFORE_DRAG_S) return true;
    const sinceOwnDrag = Date.now() - lastOwnDragAt;
    if (lastOwnDragAt && sinceOwnDrag <= OWN_DRAG_IDLE_GRACE_MS) {
      log('territory', `idle ${idle.toFixed(1)}s caused by own drag ${sinceOwnDrag}ms ago — continue`);
      return true;
    }
    log('territory', `user active ${idle.toFixed(1)}s ago — skip physical drag`);
    return false;
  }

  async function performDrag(...args) {
    const result = await drag(...args);
    if (result && result.interrupted) episodeInterrupted = true;
    if (result && result.ok) lastOwnDragAt = Date.now();
    return result;
  }

  async function performIsolatedDrag(...args) {
    const result = await isolatedDrag(...args);
    if (result && result.ok) lastOwnDragAt = Date.now();
    return result;
  }

  async function clearRivalVisual(rival) {
    const helper = await ensureDragHelper();
    if (!helper.ok) return helper;
    const previous = activeWarps.get(rival.pid);
    if (previous) {
      previous.stopping = true;
      try { previous.child.kill('SIGKILL'); } catch {}
      activeWarps.delete(rival.pid);
      visualShiftByPid.delete(rival.pid);
    }
    return new Promise((resolve) => {
      execFile(helper.bin, [
        '--warp-window', rival.pid,
        rival.x, rival.y, rival.w, rival.h,
        0, 0, 0,
      ].map(String), { timeout: 2500 }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        resolve(err || !/^cleared\|/.test(out)
          ? { ok: false, error: String(stderr || err || out || '').trim() }
          : { ok: true, out });
      });
    });
  }

  async function warpRivalVisual(rival, dx, dy = 0, options = {}) {
    const helper = await ensureDragHelper();
    if (!helper.ok) return helper;
    const previous = activeWarps.get(rival.pid);
    if (previous) {
      previous.stopping = true;
      try { previous.child.kill('SIGKILL'); } catch {}
    }
    return new Promise((resolve) => {
      const durationMs = Math.max(0, Math.min(900, Number(options.durationMs) || 220));
      const args = [
        '--warp-window', rival.pid,
        rival.x, rival.y, rival.w, rival.h,
        dx, dy, durationMs,
      ];
      if (options.pointerStart) {
        args.push(options.pointerStart.x, options.pointerStart.y);
      }
      const child = spawn(helper.bin, args.map(String));
      const entry = {
        child, rival: { ...rival }, dx, dy,
        targetWindowX: rival.x + dx,
        recoveryAttempt: Number(options.recoveryAttempt) || 0,
        confirmedStable: false,
        stopping: false,
        userReleased: false,
      };
      activeWarps.set(rival.pid, entry);
      let settled = false;
      let stderr = '';
      let lineBuf = '';
      const startTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          entry.stopping = true;
          try { child.kill('SIGKILL'); } catch {}
          resolve({ ok: false, error: 'window warp startup timed out' });
        }
      }, Math.max(1800, durationMs + 1400));
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          const message = parseWarpHelperLine(line);
          if (message.type === 'progress' && options.onProgress) {
            options.onProgress(message.progress);
          }
          // warped 只表示动画最后一帧写入成功；旧实现此刻就报 victory，
          // 但 helper 可能随即因 ChatGPT 自身走动而退出并清除。必须等连续
          // 4 次维持成功后由 stable 给出真正的完成证明。
          if (!settled && message.type === 'stable') {
            entry.confirmedStable = true;
            settled = true;
            clearTimeout(startTimer);
            resolve({ ok: true });
          }
          if (message.type === 'user-release') entry.userReleased = true;
        }
      });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { stderr += String(err || ''); });
      child.on('close', (code) => {
        clearTimeout(startTimer);
        if (activeWarps.get(rival.pid)?.child === child) {
          activeWarps.delete(rival.pid);
          visualShiftByPid.delete(rival.pid);
        }
        if (settled) {
          log('territory', `compositor hold ended for "${rival.name}" (code ${code})`);
        }
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: stderr.trim() || `window warp exited ${code}` });
        } else if (warpHoldNeedsRecovery(entry)) {
          recoverWarpHold(entry).catch((err) => {
            log('territory', 'compositor hold recovery error:', String(err && err.message || err).slice(0, 240));
          });
        }
      });
    });
  }

  async function recoverWarpHold(entry) {
    await wait(120);
    if (activeWarps.has(entry.rival.pid)) return;
    const observed = await scanDetailed();
    if (!observed.ok) {
      log('territory', 'compositor hold recovery scan failed:', String(observed.error || '').slice(0, 240));
      return;
    }
    const current = observed.rivals.find((candidate) => candidate.pid === entry.rival.pid);
    if (!current) {
      log('territory', `compositor hold ended: "${entry.rival.name}" is gone`);
      return;
    }
    const attempt = entry.recoveryAttempt + 1;
    const dx = entry.targetWindowX - current.x;
    log('territory', `recovering compositor hold for "${entry.rival.name}" (attempt ${attempt})`);
    const recovered = await warpRivalVisual(current, dx, entry.dy, {
      durationMs: 180,
      recoveryAttempt: attempt,
    });
    if (!recovered || !recovered.ok) {
      log('territory', 'compositor hold recovery failed:', String(recovered && recovered.error || '').slice(0, 240));
      return;
    }
    visualShiftByPid.set(current.pid, {
      dx, dy: entry.dy,
      targetWindowX: entry.targetWindowX,
      windowX: current.x, windowY: current.y,
      windowW: current.w, windowH: current.h,
    });
    log('territory', `compositor hold recovered for "${entry.rival.name}"`);
  }

  async function applyVisualShift(rival, dx, dy = 0) {
    const warped = await warpVisual(rival, dx, dy);
    if (!warped || !warped.ok) return warped;
    visualShiftByPid.set(rival.pid, {
      dx, dy,
      targetWindowX: rival.x + dx,
      windowX: rival.x, windowY: rival.y,
      windowW: rival.w, windowH: rival.h,
    });
    return { ok: true };
  }

  async function compositorPush(rival, dir, petB) {
    if (!(await userHandsOff())) return 'abort';
    const wa = hooks.getWorkArea(rival);
    const visual = rivalVisualBounds(rival, false, dir);
    const targetX = windowTargetForVisual(rival, visual, wa, dir);
    const dx = targetX - rival.x;
    if (Math.abs(dx) <= 2) return 'victory';

    const finalVisualX = visual.x + dx;
    const finalPetX = Math.min(Math.max(
      standX(finalVisualX, visual.w, dir, petB.width),
      wa.x - petB.width + 60), wa.x + wa.width - 60);
    const startPet = hooks.getPetBounds();
    let syncFrames = 0;
    const warped = await warpVisual(rival, dx, 0, {
      durationMs: 720,
      pointerStart: {
        x: visual.x + visual.w / 2,
        y: visual.y + visual.h / 2,
      },
      onProgress(progress) {
        if (!hooks.setPetFrame) return;
        syncFrames++;
        const frame = interpolateFrame(startPet, { x: finalPetX, y: petB.y }, progress);
        hooks.setPetFrame(frame.x, frame.y);
      },
    });
    if (hooks.endPetFrames) hooks.endPetFrames();
    if (!warped || !warped.ok) {
      log('territory', 'compositor push failed:', String(warped && warped.error || '').slice(0, 240));
      return /interrupted|exited 6/i.test(String(warped && warped.error || '')) ? 'abort' : 'defeat';
    }
    visualShiftByPid.set(rival.pid, {
      dx, dy: 0,
      targetWindowX: rival.x + dx,
      windowX: rival.x, windowY: rival.y,
      windowW: rival.w, windowH: rival.h,
    });
    log('territory', `compositor push: ${rival.x} + ${dx.toFixed(1)}px; sync frames=${syncFrames}`);
    return 'victory';
  }

  async function presence() {
    const names = allNames();
    if (!names.length) return [];
    const res = await osa(PRESENCE_SCRIPT, names);
    if (!res.ok) return [];
    return parsePresence(res.out, hooks.excludePids());
  }

  function hostNames() {
    return hooks.hostRivalNames ? hooks.hostRivalNames() : HOST_RIVALS;
  }

  async function scanDetailed() {
    const names = [...new Set([...allNames(), ...hostNames()])];
    if (!names.length) return { ok: true, rivals: [], error: '' };
    const res = await osa(SCAN_SCRIPT, names);
    if (!res.ok) {
      if (isPermError(res.err) && Date.now() - lastPermNag > 15 * 60 * 1000) {
        lastPermNag = Date.now();
        log('territory', 'no accessibility permission — cannot read rival windows');
        hooks.emit({ kind: 'territory', phase: 'noperm', ts: Date.now() });
      }
      return { ok: false, rivals: [], error: String(res.err || 'window scan failed') };
    }
    return { ok: true, rivals: parseScan(res.out, hooks.excludePids()), error: '' };
  }

  async function scan() {
    return (await scanDetailed()).rivals;
  }

  // 拖动后的成功只认真实复扫。一次空结果可能是 System Events 抖动；至少
  // 两次成功扫描都找不到才算窗口消失。超时/权限错误绝不能冒充 victory。
  async function observeRival(pid, attempts = 3) {
    let successfulMisses = 0;
    let lastError = '';
    for (let i = 0; i < attempts; i++) {
      const observed = await scanDetailed();
      if (!observed.ok) {
        lastError = observed.error;
      } else {
        const rival = observed.rivals.find((candidate) => candidate.pid === pid);
        if (rival) return { ok: true, rival, gone: false };
        successfulMisses++;
        if (successfulMisses >= 2) return { ok: true, rival: null, gone: true };
      }
      if (i + 1 < attempts) await wait(100);
    }
    return {
      ok: false,
      rival: null,
      gone: false,
      error: lastError || `rival ${pid} was not confirmed after drag`,
    };
  }

  async function moveRival(pid, x, y) {
    const res = await osa(MOVE_SCRIPT, [pid, Math.round(x), Math.round(y), MAX_RIVAL_SIZE]);
    if (!res.ok) return { error: res.err };
    if (res.out === 'gone') return { gone: true };
    const [bx, by, ax, ay] = res.out.split('|').map(Number);
    if (![bx, by, ax, ay].every(Number.isFinite)) return { error: 'bad output: ' + res.out };
    return { bx, by, ax, ay };
  }

  async function raiseRival(rival) {
    const res = await osa(RAISE_SCRIPT, [rival.pid, rival.w, rival.h]);
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
    // 按源码内容缓存，而不是按 mtime。应用打包/解包会重写或保留时间戳，
    // 单纯比较 mtime 会让新版 JS 调到旧版 Swift（参数协议都可能不同）。
    // 内容哈希既避免每次启动重编译，也保证协议变化后一定换新二进制。
    let sourceHash;
    try {
      sourceHash = crypto.createHash('sha256')
        .update(fs.readFileSync(DRAG_HELPER))
        .digest('hex').slice(0, 16);
    } catch (err) {
      return { ok: false, error: String(err || 'could not hash drag helper source') };
    }
    const bin = path.join(os.tmpdir(), `octopus-drag-window-${sourceHash}`);
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      dragHelperBin = bin;
      dragHelperPromise = Promise.resolve({ ok: true, bin });
      return dragHelperPromise;
    } catch {}
    dragHelperPromise = new Promise((resolve) => {
      execFile('/usr/bin/swiftc', [
        '-O', DRAG_HELPER,
        '-F', '/System/Library/PrivateFrameworks',
        '-framework', 'SkyLight',
        '-framework', 'ApplicationServices',
        '-framework', 'AppKit',
        '-o', bin,
      ], { timeout: 20000 },
        (err, _stdout, stderr) => {
          if (!err) dragHelperBin = bin;
          resolve(err
            ? { ok: false, error: String(stderr || err || '').trim() }
            : { ok: true, bin });
        });
    });
    return dragHelperPromise;
  }

  async function probeDragPoint(rival, points) {
    const helper = await ensureDragHelper();
    if (!helper.ok) return helper;
    return new Promise((resolve) => {
      const args = [
        '--probe-window', rival.pid, rival.x, rival.y, rival.w, rival.h,
        ...points.flat(),
      ].map(String);
      const child = spawn(helper.bin, args);
      child._octopusTarget = { pid: rival.pid, x: rival.x, y: rival.y };
      activeDrags.add(child);
      let stdout = '';
      let stderr = '';
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 4000);
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { stderr += String(err || ''); });
      child.on('close', (code) => {
        activeDrags.delete(child);
        clearTimeout(killTimer);
        const parsed = parseProbeHelperResult(stdout, code, points);
        if (parsed.interrupted) episodeInterrupted = true;
        if (parsed.ok) lastOwnDragAt = Date.now();
        resolve(parsed.ok ? parsed : {
          ...parsed,
          error: [stderr.trim(), parsed.error].filter(Boolean).join('; '),
        });
      });
    });
  }

  async function dragRival(rival, targetX, rx, ry, durationMs = 520, onProgress) {
    // Swift 把事件定向投递给目标 PID + WindowServer window；真鼠标始终
    // 保持显示和关联。原生透明 NSPanel 只负责可视化独立的巡视指针。
    const helper = await ensureDragHelper();
    if (!helper.ok) return helper;
    const sx = rival.x + rival.w * rx;
    const sy = rival.y + rival.h * ry;
    const ex = sx + (targetX - rival.x);
    return new Promise((resolve) => {
      const child = spawn(helper.bin, [
        '--drag-pid', rival.pid, rival.x, rival.y, rival.w, rival.h,
        sx, sy, ex, sy, durationMs,
      ].map(String));
      child._octopusTarget = { pid: rival.pid, x: sx, y: sy };
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
          const m = /^progress\|([0-9.]+)$/.exec(line.trim());
          if (m) {
            const progress = Math.min(1, Math.max(0, Number(m[1])));
            if (onProgress) onProgress(progress);
          }
        }
      });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { stderr += String(err || ''); });
      child.on('close', (code) => {
        activeDrags.delete(child);
        clearTimeout(killTimer);
        const parsed = parseDragHelperResult(stdout, code);
        if (!parsed.ok && dragHelperBin && !child._octopusReleased) {
          spawnSync(dragHelperBin, ['--release-pid', rival.pid, sx, sy], { timeout: 1500 });
        }
        if (parsed.interrupted) episodeInterrupted = true;
        resolve({
          ok: parsed.ok,
          interrupted: !!parsed.interrupted,
          error: [stderr.trim(), parsed.ok ? '' : parsed.error].filter(Boolean).join('; '),
          cursorTravel: parsed.cursorTravel,
        });
      });
    });
  }

  async function isolatedDragRival(rival, targetX, rx, ry, durationMs = 520, onProgress) {
    const helper = await ensureDragHelper();
    if (!helper.ok) return helper;
    const sx = rival.x + rival.w * rx;
    const sy = rival.y + rival.h * ry;
    const ex = sx + (targetX - rival.x);
    return new Promise((resolve) => {
      const child = spawn(helper.bin, [
        '--isolated-drag-pid', rival.pid, rival.x, rival.y, rival.w, rival.h,
        sx, sy, ex, sy, durationMs,
      ].map(String));
      child._octopusTransport = 'isolated-hid';
      child._octopusTarget = { pid: rival.pid, x: sx, y: sy };
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
            child._octopusOriginal = { x: Number(origin[1]), y: Number(origin[2]) };
            continue;
          }
          const progress = /^progress\|([0-9.]+)$/.exec(line.trim());
          if (progress && onProgress) {
            onProgress(Math.min(1, Math.max(0, Number(progress[1]))));
          }
        }
      });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { stderr += String(err || ''); });
      child.on('close', (code) => {
        activeDrags.delete(child);
        clearTimeout(killTimer);
        const parsed = parseIsolatedDragHelperResult(stdout, code);
        if (!parsed.ok && dragHelperBin && !child._octopusReleased) {
          const origin = child._octopusOriginal
            ? [child._octopusOriginal.x, child._octopusOriginal.y] : [];
          spawnSync(dragHelperBin, ['--release', ...origin], { timeout: 1500 });
        }
        resolve({
          ...parsed,
          error: [stderr.trim(), parsed.ok ? '' : parsed.error].filter(Boolean).join('; '),
        });
      });
    });
  }

  async function calibrateDragPoint(rival, dir) {
    const learned = getPreferredDragPoint(rival);
    let points;
    if (/chatgpt/i.test(rival.name)) {
      // ChatGPT 有四种 placement，跨屏/换边会翻转。先按当前象限尝试四个
      // mascot 中心，旧缓存只降级为额外候选，绝不优先于当前布局。
      points = chatGPTDragCandidates(rival, hooks.getWorkArea(rival), learned);
    } else {
      const defaults = [[0.65, 0.72], [0.5, 0.72], [0.5, 0.5], [0.35, 0.72], [0.5, 0.84]];
      points = learned
        ? [learned, ...defaults.filter(([x, y]) => x !== learned[0] || y !== learned[1])]
        : defaults;
    }
    let current = { ...rival };
    try {
      if (hooks.setPetClickThrough) {
        hooks.setPetClickThrough(true);
        await wait(90);
      }
      for (const [rx, ry] of points) {
        // ChatGPT 只接受全局 HID capture；helper 会先用 AX hit-test 验证
        // 候选点，未命中时不发送 mouseDown，直接继续下一个象限。
        if (hooks.shouldAbort() || !(await userHandsOff())) return null;
        const beforeX = current.x;
        const probeX = beforeX + dir * 22;
        const dragged = /chatgpt/i.test(rival.name)
          ? await performIsolatedDrag(current, probeX, rx, ry, 180)
          : await performDrag(current, probeX, rx, ry, 180);
        if (!dragged.ok) {
          if (dragged.miss) {
            log('territory', `calibrate @${rx},${ry}: target miss`);
            continue;
          }
          log('territory', 'drag calibration helper failed:', dragged.error.slice(0, 240));
          return null;
        }
        await wait(110);
        const observed = await observeRival(rival.pid, 3);
        if (!observed.ok || observed.gone) {
          if (!observed.ok) log('territory', 'drag calibration rescan failed:', observed.error.slice(0, 240));
          return null;
        }
        const rescanned = observed.rival;
        const delta = rescanned.x - beforeX;
        log('territory', `calibrate @${rx},${ry}: ${beforeX} -> ${rescanned.x}`);
        current = rescanned;
        // 只承认朝目标边的真实位移。ChatGPT 自身漂移或拖到下层窗口造成的
        // 反向移动都不能被学成“成功锚点”。
        if (dir * delta > 6) {
          setPreferredDragPoint(rival, [rx, ry]);
          log('territory', `calibrated drag anchor for "${rival.name}": ${rx},${ry}`);
          return current;
        }
      }
      return null;
    } finally {
      if (hooks.setPetClickThrough) hooks.setPetClickThrough(false);
    }
  }

  async function finishClampedVisualEdge(current, dir, maxTravel = 0) {
    const currentWa = hooks.getWorkArea(current);
    if (!atEdgeInDirection(current, currentWa, dir, 3)) return null;
    // 必须忽略已有内存偏移，计算透明外框相对于可见本体的绝对补偿。
    const unshiftedVisual = rivalVisualBounds(current, false, dir);
    const visualTargetX = windowTargetForVisual(current, unshiftedVisual, currentWa, dir);
    const remaining = visualTargetX - current.x;
    // 正确的 356x320 / 112px mascot 模型只需约 25~42px 补偿。超过
    // 64px 说明识别/placement 已错，禁止再用大幅 compositor warp 假装成功。
    if (Math.abs(remaining) <= 64) {
      const translated = await applyVisualShift(current, remaining, 0);
      if (translated.ok) {
        log('territory', `visual edge finish: window ${current.x},${current.y}; shift ${remaining.toFixed(1)}px`);
        // CGSSetWindowWarp returning success is not visual proof on Electron's
        // CoreAnimation overlay. The real AX frame is at the OS clamp, so never
        // promote this unverified cosmetic finish to a full victory.
        return 'partial';
      }
      log('territory', 'visual edge finish failed:', String(translated.error || '').slice(0, 240));
    }
    return maxTravel > 8 ? 'partial' : 'defeat';
  }

  async function physicalPush(rival, dir, petB) {
    let point = getPreferredDragPoint(rival);
    let current = { ...rival };
    const startX = current.x;
    let maxTravel = 0;
    // Octopus 重启后，真实透明外框可能仍在系统边缘，但上次的 CGS
    // transform/锚点内存都没了。这时无需再向屏外校准，直接重施视觉补偿。
    const alreadyClamped = await finishClampedVisualEdge(current, dir, maxTravel);
    if (alreadyClamped) return alreadyClamped;
    if (!point) {
      const calibrated = await calibrateDragPoint(current, dir);
      if (!calibrated) return 'defeat';
      current = calibrated;
      maxTravel = Math.max(maxTravel, dir * (current.x - startX));
      point = getPreferredDragPoint(rival);
      if (!point) return 'defeat';
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (hooks.shouldAbort()) return 'abort';
      if (!(await userHandsOff())) return 'abort';
      // 行军最长数秒，ChatGPT 桌宠可能已经自行走动。正式长拖前必须重新
      // 读取目标 frame，并确认目标窗能被抬起，绝不能对陈旧坐标发 mouseDown。
      const fresh = await observeRival(rival.pid, 3);
      if (!fresh.ok) {
        log('territory', 'pre-drag rescan failed:', fresh.error.slice(0, 240));
        return 'defeat';
      }
      if (fresh.gone) return 'victory';
      current = fresh.rival;
      if (!(await raiseRival(current))) return maxTravel > 8 ? 'partial' : 'defeat';
      const wa = hooks.getWorkArea(current);
      const visual = rivalVisualBounds(current, true, dir);
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
        if (hooks.setPetClickThrough) {
          hooks.setPetClickThrough(true);
          await wait(60);
        }
        dragged = await performIsolatedDrag(current, targetX, point[0], point[1], 720, (progress) => {
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
      if (!dragged.ok) return dragged.interrupted ? 'abort' : 'defeat';
      await wait(260);
      const observed = await observeRival(rival.pid, 3);
      if (!observed.ok) {
        log('territory', 'physical push rescan failed:', observed.error.slice(0, 240));
        return 'defeat';
      }
      if (observed.gone) return 'victory';
      const rescanned = observed.rival;
      log('territory', `physical push ${attempt + 1}: ${current.x},${current.y} -> ${rescanned.x},${rescanned.y}`);
      maxTravel = Math.max(maxTravel, dir * (rescanned.x - startX));
      current = rescanned;
      if (visualAtEdgeInDirection(rivalVisualBounds(current, true, dir), hooks.getWorkArea(current), dir)) return 'victory';
      // ChatGPT 把 356px 透明外框完整 clamp 在屏内；右推最多只能到
      // workArea.right - 356，可见机器人还会留下约 55px 空白。外框已经贴边时
      // 不再进行一轮必败的重新校准，直接用 WindowServer transform 平滑补齐
      // 剩余视觉距离。它不发送输入事件，也不会抢 Codex/ChatGPT 的焦点。
      const edgeFinished = await finishClampedVisualEdge(current, dir, maxTravel);
      if (edgeFinished) return edgeFinished;
      // 点击区域会随 ChatGPT 桌宠姿态/位置变化。每次停滞后重新抬窗和校准，
      // 不要拿同一失效锚点机械重试。
      if (!(await raiseRival(current))) return maxTravel > 8 ? 'partial' : 'defeat';
      const recalibrated = await calibrateDragPoint(current, dir);
      if (recalibrated) {
        maxTravel = Math.max(maxTravel, dir * (recalibrated.x - startX));
        current = recalibrated;
        point = getPreferredDragPoint(rival) || point;
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
      // 对方可能被推过显示器边界:每步按它当前所在屏重算工作区和目标边
      wa = hooks.getWorkArea(rival);
      targetX = dir === 1 ? wa.x + wa.width - rival.w : wa.x;
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
        if (!(await userHandsOff())) return 'abort';
        log('territory', `AXPosition ignored by "${rival.name}" — trying patrol cursor drag fallback`);
        // 透明窗口的几何中心可能没有任何可拖内容。依次探测少量内部候选点，
        // 每次都重扫验证；一旦真实移动立即停止探测。
        const learned = getPreferredDragPoint(rival);
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
            if (hooks.setPetClickThrough) {
              hooks.setPetClickThrough(true);
              await wait(60);
            }
            [dragged] = await Promise.all([
              performDrag(current, targetX, rx, ry),
              hooks.tweenPetTo(finalPetX, petB.y, 600),
            ]);
          } finally {
            if (hooks.setPetClickThrough) hooks.setPetClickThrough(false);
          }
          if (!dragged.ok) {
            log('territory', 'patrol cursor drag failed:', dragged.error.slice(0, 240));
            return dragged.interrupted ? 'abort' : 'defeat';
          }
          await wait(260);
          const observed = await observeRival(rival.pid, 3);
          if (!observed.ok) {
            log('territory', 'pointer drag rescan failed:', observed.error.slice(0, 240));
            return 'defeat';
          }
          if (observed.gone) return 'victory';
          current = observed.rival;
          log('territory', `pointer drag @${rx},${ry}: ${beforeX} -> ${current.x}`);
          if (dir * (current.x - beforeX) > 8
              || atEdgeInDirection(current, hooks.getWorkArea(current), dir)) {
            moved = true;
            setPreferredDragPoint(rival, [rx, ry]);
            break;
          }
        }
        rival.x = current.x; rival.y = current.y;
        const currentWa = hooks.getWorkArea(current);
        const currentTarget = nearestEdgeTarget(current, currentWa).targetX;
        const afterDragDist = Math.abs(currentTarget - rival.x);
        log('territory', `pointer drag result: ${current.x},${current.y}; distance to nearest edge ${afterDragDist}`);
        if (atEdgeInDirection(current, currentWa, dir)) return 'victory';
        if (!moved) return 'defeat';
        resist = 0;
        prevDist = afterDragDist;
      }
      prevDist = distToEdge;
      // 贴身跟上,保持顶着的姿态
      const px = Math.min(Math.max(standX(rival.x, rival.w, dir, petB.width), wa.x - petB.width + 60), wa.x + wa.width - 60);
      await hooks.tweenPetTo(px, petB.y, 130);
      await wait(40);
    }
    return 'defeat';
  }

  async function runEpisode(rival) {
    episode = true;
    episodeInterrupted = false;
    // home 必须在 try 里取:getPetBounds 若抛异常(petWin 销毁瞬间),episode
    // 标志已置位,不进 finally 的话 territory 会永久卡在 busy。
    let home = null;
    let outcome = 'abort';
    try {
      home = hooks.getPetBounds();
      log('territory', `spotted rival "${rival.name}" (pid ${rival.pid}) at ${rival.x},${rival.y} ${rival.w}x${rival.h}`);
      hooks.emit({ kind: 'territory', phase: 'spotted', rival: rival.name, ts: Date.now() });
      await wait(1100);
      if (hooks.shouldAbort()) return;

      let wa = hooks.getWorkArea(rival);
      let pet = hooks.getPetBounds();
      if (/chatgpt/i.test(rival.name)) {
        // WindowServer 的视觉 transform 可能跨 Octopus 重启仍留在对方窗口上，
        // 而内存里的 visualShiftByPid 已丢失。每次新开战先恢复逻辑 frame 对应
        // 的标准 transform，确保下面的拖点坐标不会落在旧画面之外。
        const normalized = await clearVisual(rival);
        if (normalized && normalized.ok) visualShiftByPid.delete(rival.pid);
        else log('territory', 'visual transform reset skipped:', String(normalized && normalized.error || '').slice(0, 200));
        // ChatGPT/Codex 的特权 Computer Use 输入流不对第三方应用开放；普通
        // postToPid 无法建立这个 Electron 透明窗的拖拽 capture。下面改用
        // 短时隔离 HID，并以 AX frame 的真实位移作为唯一成功依据。
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
        await wait(900); // 让表情/气泡先演一拍再回家
      }
    } catch (e) {
      log('territory', 'episode error:', e.message);
    } finally {
      // 中途撤退(用户来了/弹层打开/出错)也要通知渲染端复位表情——
      // 否则 march 给的 16s 斗志表情会一路挂到超时。
      if (outcome === 'abort') hooks.emit({ kind: 'territory', phase: 'abort', rival: rival.name, ts: Date.now() });
      try { if (home) await hooks.tweenPetTo(home.x, home.y, 1600); } catch {}
      episode = false;
      episodeInterrupted = false;
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
    for (const scanned of rivals) {
      let r = scanned;
      if (/chatgpt/i.test(r.name)) {
        // 连续两帧确认同一尺寸候选，过滤通知/弹层等瞬时小窗。
        await wait(140);
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
      // scan() 已经实际通过 System Events 读到了窗口；不要再用 Electron
      // 可能滞后的 TCC 缓存值二次拦截。真正移动失败时 moveRival 会按实际
      // -25211/not authorized 错误发 noperm。
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
    // 用户明确点击了“巡视”，这次点击会把 HIDIdleTime 清零。只在本次手动
    // episode 内授权软件指针，不让启动按钮反过来把自己的动作拦掉。
    manualDragAuthorized = true;
    try {
      const result = await tick(true);
      if (result === 'clear') hooks.emit({ kind: 'territory', phase: 'clear', ts: Date.now() });
      else if (result === 'busy') hooks.emit({ kind: 'territory', phase: 'busy', ts: Date.now() });
      return result;
    } finally {
      manualDragAuthorized = false;
    }
  }

  function start() {
    if (timer || process.platform !== 'darwin') return;
    // 只在自动巡逻已开启时预热编译(避免功能关着也每次启动付一遍 swiftc;
    // 没装 CLT 的机器上调 /usr/bin/swiftc 还会弹系统的装工具引导框)。
    // 关着的用户走懒路径:首次真要拖拽时由 dragRival 触发编译,产物有 mtime 缓存。
    if (hooks.isEnabled()) {
      ensureDragHelper().then((r) => {
        if (!r.ok) log('territory', 'drag helper compile failed:', r.error.slice(0, 240));
      });
    }
    timer = setInterval(() => { tick().catch((e) => log('territory', 'tick error:', e.message)); }, intervalMs);
    if (timer.unref) timer.unref();
    log('territory', `watching for rivals every ${intervalMs}ms`);
  }
  function emergencyRelease() {
    for (const child of activeDrags) {
      child._octopusReleased = true;
      const target = child._octopusTarget;
      try { child.kill('SIGKILL'); } catch {}
      if (dragHelperBin && target) {
        try {
          if (child._octopusTransport === 'isolated-hid') {
            const origin = child._octopusOriginal
              ? [child._octopusOriginal.x, child._octopusOriginal.y] : [];
            spawnSync(dragHelperBin, ['--release', ...origin].map(String), { timeout: 1500 });
          } else {
            spawnSync(dragHelperBin,
              ['--release-pid', target.pid, target.x, target.y].map(String),
              { timeout: 1500 });
          }
        } catch {}
      }
    }
    activeDrags.clear();
    for (const [pid, entry] of activeWarps) {
      entry.stopping = true;
      try { entry.child.kill('SIGKILL'); } catch {}
      if (dragHelperBin) {
        const r = entry.rival;
        try {
          spawnSync(dragHelperBin, [
            '--warp-window', pid,
            r.x, r.y, r.w, r.h,
            0, 0, 0,
          ].map(String), { timeout: 1500 });
        } catch {}
      }
    }
    activeWarps.clear();
    visualShiftByPid.clear();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    emergencyRelease();
  }

  return { start, stop, emergencyRelease, scan, tick, runNow, get busy() { return episode || checking; }, get dominating() { return dominating; } };
}

module.exports = {
  createTerritory,
  parsePresence,
  parseScan,
  scanCandidateScore,
  nearestEdgeTarget,
  edgeAwayFromPet,
  atEdge,
  atEdgeInDirection,
  windowTargetForVisual,
  visualAtEdge,
  visualAtEdgeInDirection,
  visualShiftMatches,
  visualShiftOffset,
  interpolateFrame,
  chatGPTVisualBounds,
  chatGPTDragCandidates,
  parseDragHelperResult,
  parseIsolatedDragHelperResult,
  parseProbeHelperResult,
  parseWarpHelperLine,
  warpHoldNeedsRecovery,
  standX,
  DEFAULT_RIVALS,
  HOST_RIVALS,
  MAX_RIVAL_SIZE,
};
