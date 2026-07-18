'use strict';

// territory 单元测试 — 纯逻辑部分:扫描输出解析、推挤方向/目标、贴边判定、
// 站位计算,以及 tick 的前置条件短路(不真的调 osascript)。
// Run: node test/territory.js

const assert = require('assert');
const {
  createTerritory, parsePresence, parseScan, scanCandidateScore,
  nearestEdgeTarget, edgeAwayFromPet, atEdge, atEdgeInDirection,
  windowTargetForVisual, visualAtEdge, visualAtEdgeInDirection,
  visualShiftMatches, visualShiftOffset, interpolateFrame, chatGPTVisualBounds,
  chatGPTDragCandidates, parseDragHelperResult, parseProbeHelperResult,
  parseIsolatedDragHelperResult, parseWarpHelperLine, warpHoldNeedsRecovery,
  standX, DEFAULT_RIVALS,
} = require('../backend/territory');

let failures = 0;
const pending = [];
// 兼容 async 用例:fn 返回 Promise 时挂到 pending,最后统一 await 再判定退出码
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => console.log('  ✓', name),
        (e) => { failures++; console.log('  ✗', name, '\n     ', e.message); }));
      return;
    }
    console.log('  ✓', name);
  } catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

console.log('[T1] parseScan：System Events 输出 → rival 列表');
check('正常行解析 + 字段数值化', () => {
  const r = parseScan('Desktop Goose|123|40|500|180|160\n', []);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0], { name: 'Desktop Goose', pid: 123, x: 40, y: 500, w: 180, h: 160 });
});
check('多行 + 按 pid 去重', () => {
  const out = 'BongoCat|11|0|0|100|100\nBongoCat|11|0|0|100|100\nShimeji|22|5|5|80|80\n';
  assert.strictEqual(parseScan(out, []).length, 2);
});
check('排除自己的 pid', () => {
  const r = parseScan('Electron|999|0|0|100|100\n', [999]);
  assert.strictEqual(r.length, 0);
});
check('脏行/空行/字段缺失/零尺寸都丢弃', () => {
  const out = '\ngarbage\nA|1|2|3\nB|x|0|0|100|100\nC|33|0|0|0|100\n';
  assert.strictEqual(parseScan(out, []).length, 0);
});
check('同进程多窗:大主窗被体型过滤,只认最小的宠物窗(Codex 寄生在 ChatGPT 场景)', () => {
  const out = 'ChatGPT|98060|1716|-268|1512|865\nChatGPT|98060|1512|407|356|320\nChatGPT|98060|100|100|500|400\n';
  const r = parseScan(out, []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].w, 356);
  assert.strictEqual(r[0].h, 320);
});
check('只有大主窗(宠物没出来)→ 不算对手', () => {
  const r = parseScan('ChatGPT|98060|1716|-268|1512|865\n', []);
  assert.strictEqual(r.length, 0);
});
check('ChatGPT 同进程有更小 popup 时仍选择 356×320 桌宠轮廓', () => {
  const out = 'ChatGPT|98060|100|100|180|120\nChatGPT|98060|500|300|356|320\n';
  const r = parseScan(out, []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].x, 500);
  assert.strictEqual(r[0].w, 356);
});
check('ChatGPT 轮廓评分优于不合理小窗', () => {
  assert(scanCandidateScore({ name: 'ChatGPT', w: 356, h: 320 })
    < scanCandidateScore({ name: 'ChatGPT', w: 180, h: 120 }));
});
check('只有 ChatGPT 小 popup 时硬过滤，不误认成桌宠', () => {
  assert.deepStrictEqual(parseScan('ChatGPT|42|500|300|180|120\n', []), []);
});

console.log('[T2] nearestEdgeTarget：推向更近的水平边');
const WA = { x: 0, y: 25, width: 1440, height: 875 };
check('偏左的窗口推向左边缘', () => {
  const t = nearestEdgeTarget({ x: 200, y: 300, w: 200, h: 200 }, WA);
  assert.strictEqual(t.dir, -1);
  assert.strictEqual(t.targetX, 0);
});
check('偏右的窗口推向右边缘(target=右边-宽)', () => {
  const t = nearestEdgeTarget({ x: 1000, y: 300, w: 200, h: 200 }, WA);
  assert.strictEqual(t.dir, 1);
  assert.strictEqual(t.targetX, 1240);
});
check('副屏(工作区 x 偏移)也按该屏的边算', () => {
  const wa2 = { x: 1440, y: 0, width: 1920, height: 1080 };
  const t = nearestEdgeTarget({ x: 1500, y: 300, w: 200, h: 200 }, wa2);
  assert.strictEqual(t.dir, -1);
  assert.strictEqual(t.targetX, 1440);
});

console.log('[T2b] edgeAwayFromPet：从当前所在侧直接接近，不横穿对手');
check('小章鱼在左侧 → 直接向右推', () => {
  const t = edgeAwayFromPet(
    { x: 600, y: 300, w: 200, h: 200 }, WA,
    { x: 350, y: 300, width: 120, height: 120 });
  assert.deepStrictEqual(t, { dir: 1, targetX: 1240 });
});
check('小章鱼在右侧 → 直接向左推', () => {
  const t = edgeAwayFromPet(
    { x: 600, y: 300, w: 200, h: 200 }, WA,
    { x: 900, y: 300, width: 120, height: 120 });
  assert.deepStrictEqual(t, { dir: -1, targetX: 0 });
});

console.log('[T3] atEdge：已经贴边的不再骚扰');
check('贴左边 → true', () => assert(atEdge({ x: 4, y: 0, w: 100, h: 100 }, WA)));
check('贴右边 → true', () => assert(atEdge({ x: 1340, y: 0, w: 100, h: 100 }, WA)));
check('屏幕中间 → false', () => assert(!atEdge({ x: 600, y: 0, w: 100, h: 100 }, WA)));
check('目标方向边界不能被反方向边界冒充', () => {
  const left = { x: 0, y: 0, w: 100, h: 100 };
  assert(atEdgeInDirection(left, WA, -1));
  assert(!atEdgeInDirection(left, WA, 1));
  assert(visualAtEdgeInDirection(left, WA, -1));
  assert(!visualAtEdgeInDirection(left, WA, 1));
});

console.log('[T3b] 透明窗口按可见本体贴边');
check('右推时允许透明外框出屏，只让本体右缘贴边', () => {
  const rival = { x: 1000, y: 0, w: 356, h: 320 };
  const visual = { x: 1071, y: 100, w: 140, h: 140 }; // 本体相对外框左偏移 71
  assert.strictEqual(windowTargetForVisual(rival, visual, WA, 1), 1440 - (71 + 140));
});
check('左推时按本体左缘补偿透明 padding', () => {
  const rival = { x: 500, y: 0, w: 356, h: 320 };
  const visual = { x: 620, y: 100, w: 140, h: 140 };
  assert.strictEqual(windowTargetForVisual(rival, visual, WA, -1), -120);
});
check('本体右缘贴边才算完成', () => {
  assert(visualAtEdge({ x: 1300, y: 0, w: 140, h: 140 }, WA));
  assert(!visualAtEdge({ x: 1100, y: 0, w: 140, h: 140 }, WA));
});
check('视觉补推身份跟随逻辑窗口横纵移动，仅窗口轮廓改变才失效', () => {
  const record = { targetWindowX: 1156, windowX: 1156, windowY: 357, windowW: 356, windowH: 320 };
  assert(visualShiftMatches(record, { x: 1156, y: 364, w: 356, h: 320 }));
  assert(visualShiftMatches(record, { x: 900, y: 357, w: 356, h: 320 }));
  assert(!visualShiftMatches(record, { x: 900, y: 357, w: 320, h: 320 }));
});
check('回归：ChatGPT 逻辑 x 自行变化后，合成层可见 x 必须保持不变', () => {
  const record = { targetWindowX: 1198, dx: 312, dy: 0 };
  const before = { x: 886, y: 404 };
  const after = { x: 931, y: 409 };
  assert.strictEqual(before.x + visualShiftOffset(record, before).dx, 1198);
  assert.strictEqual(after.x + visualShiftOffset(record, after).dx, 1198);
});
check('ChatGPT 可见本体几何不再随拖拽锚点漂移', () => {
  const rightTop = chatGPTVisualBounds({ name: 'ChatGPT', pid: 1, x: 800, y: 50, w: 356, h: 320 }, WA, 1);
  assert.deepStrictEqual(
    { x: rightTop.x, y: rightTop.y, w: rightTop.w, h: rightTop.h },
    { x: 1030, y: 241, w: 84, h: 121 });
  const leftTop = chatGPTVisualBounds({ name: 'ChatGPT', pid: 1, x: 100, y: 50, w: 356, h: 320 }, WA, -1);
  assert.strictEqual(leftTop.x, 125);
});
check('ChatGPT 已校准 placement 不会被推送方向覆盖', () => {
  const rival = { name: 'ChatGPT', pid: 1, x: 800, y: 50, w: 356, h: 320 };
  const learnedStart = [67 / 356, 251 / 320];
  const visual = chatGPTVisualBounds(rival, WA, 1, learnedStart);
  assert.strictEqual(visual.x, 825, '向右推时仍应采用实测 start placement');
});
check('ChatGPT 首次按默认 top-end 的稳定 mascot 中心开始', () => {
  const points = chatGPTDragCandidates({ name: 'ChatGPT', x: 900, y: 50, w: 356, h: 320 }, WA);
  assert(Math.abs(points[0][0] - 272 / 356) < 1e-9);
  assert(Math.abs(points[0][1] - 251 / 320) < 1e-9);
  assert.strictEqual(new Set(points.map((p) => p.join(','))).size, 4);
});
check('ChatGPT 有历史命中点时先复验，再横向/纵向翻转', () => {
  const learned = [67 / 356, 124 / 320];
  const points = chatGPTDragCandidates({ name: 'ChatGPT', x: 900, y: 50, w: 356, h: 320 }, WA, learned);
  assert.deepStrictEqual(points[0], learned);
  assert.deepStrictEqual(points[1], [272 / 356, 124 / 320]);
  assert.deepStrictEqual(points[2], [67 / 356, 251 / 320]);
});

console.log('[T3c] 同一进度源的逐帧跟随插值');
check('progress=0/0.5/1 与目标拖拽轨迹严格同相', () => {
  const from = { x: 100, y: 200 };
  const to = { x: 500, y: 300 };
  assert.deepStrictEqual(interpolateFrame(from, to, 0), from);
  assert.deepStrictEqual(interpolateFrame(from, to, 0.5), { x: 300, y: 250 });
  assert.deepStrictEqual(interpolateFrame(from, to, 1), to);
});
check('异常进度会 clamp，避免跟随越界', () => {
  assert.deepStrictEqual(interpolateFrame({ x: 0, y: 0 }, { x: 10, y: 20 }, -1), { x: 0, y: 0 });
  assert.deepStrictEqual(interpolateFrame({ x: 0, y: 0 }, { x: 10, y: 20 }, 2), { x: 10, y: 20 });
});

console.log('[T3d] Swift 拖动助手：普通桌宠定向事件 + ChatGPT 可恢复 HID 租约');
check('目标 PID/window、零 warp/hide/associate、定向释放齐全才接受', () => {
  const out = 'cursor|100|200|100|200\ninterrupted|user=0\ntransport|targeted=1|pid=42|window=99|nsEvent=1|windowLocation=1|slevent=1|eventMask=1|warp=0|associate=0|hide=0\nrelease|targeted=1\noverlay|native=1|opaque=0|alpha=0|shadow=0|ignoresMouse=1|sharing=1|cornerAlpha=0|serverBounds=1|serverSharing=1\nok|targeted=1|userCursorFree=1\n';
  assert(parseDragHelperResult(out, 0).ok);
});
check('用户真鼠标可在定向拖拽期间自由移动', () => {
  const moved = 'cursor|1|1|800|500\ninterrupted|user=0\ntransport|targeted=1|pid=42|window=99|nsEvent=1|windowLocation=1|slevent=1|eventMask=1|warp=0|associate=0|hide=0\nrelease|targeted=1\noverlay|native=1|opaque=0|alpha=0|shadow=0|ignoresMouse=1|sharing=1|cornerAlpha=0|serverBounds=1|serverSharing=1\nok|targeted=1|userCursorFree=1\n';
  const parsed = parseDragHelperResult(moved, 0);
  assert(parsed.ok);
  assert(parsed.cursorTravel > 900);
});
check('全局传输、缺少定向释放或用户介入一律不算成功', () => {
  const good = 'cursor|1|1|1|1\ninterrupted|user=0\ntransport|targeted=1|pid=42|window=99|nsEvent=1|windowLocation=1|slevent=1|eventMask=1|warp=0|associate=0|hide=0\nrelease|targeted=1\noverlay|native=1|opaque=0|alpha=0|shadow=0|ignoresMouse=1|sharing=1|cornerAlpha=0|serverBounds=1|serverSharing=1\nok|targeted=1|userCursorFree=1\n';
  assert(!parseDragHelperResult(good.replace('targeted=1|pid=42', 'targeted=0|pid=42'), 0).ok);
  assert(!parseDragHelperResult(good.replace('release|targeted=1\n', ''), 0).ok);
  const interrupted = good.replace('interrupted|user=0', 'interrupted|user=1');
  assert.strictEqual(parseDragHelperResult(interrupted, 6).interrupted, true);
});
check('悬停探针也必须使用同一个定向、零全局光标传输', () => {
  const points = [[0.7, 0.8], [0.2, 0.8]];
  const good = 'cursor|100|200|300|400\nprobe|1\ninterrupted|user=0\ntransport|targeted=1|pid=42|window=99|nsEvent=1|windowLocation=1|slevent=1|eventMask=1|warp=0|associate=0|hide=0\noverlay|native=1|opaque=0|alpha=0|shadow=0|ignoresMouse=1|sharing=1|cornerAlpha=0|serverBounds=1|serverSharing=1\n';
  assert.deepStrictEqual(parseProbeHelperResult(good, 0, points).point, points[1]);
  assert(!parseProbeHelperResult(good.replace('targeted=1', 'targeted=0'), 0, points).ok);
  assert(!parseProbeHelperResult(good.replace('probe|1', 'probe|9'), 0, points).ok);
});
check('Electron 指针窗口已移除，原生覆盖层保持全透明且鼠标穿透', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const swift = fs.readFileSync(path.join(root, 'backend', 'drag-window.swift'), 'utf8');
  assert(!main.includes('patrolPointerWin'));
  assert(!main.includes('patrol-pointer.html'));
  assert(swift.includes('panel.isOpaque = false'));
  assert(swift.includes('panel.backgroundColor = .clear'));
  assert(swift.includes('panel.hasShadow = false'));
  assert(swift.includes('panel.ignoresMouseEvents = true'));
  assert(swift.includes('panel.sharingType = .readOnly'));
  assert(swift.includes('CGEventSetWindowLocation(event, local)'));
  assert(swift.includes('SLEventPostToPid(targetPid, event)'));
  assert(swift.includes('AXUIElementGetWindow(window, &windowID)'));
  assert(swift.includes('.mouseEventWindowUnderMousePointer'));
  assert(swift.includes('if windowCommand == "--isolated-drag-pid"'));
  assert(swift.includes('CGAssociateMouseAndMouseCursorPosition(0)'));
  assert(swift.includes('CGAssociateMouseAndMouseCursorPosition(1)'));
  assert(swift.includes('CGDisplayHideCursor(cursorDisplay)'));
  assert(swift.includes('CGDisplayShowCursor(cursorDisplay)'));
  assert(swift.includes('matchingHitWindow(at: start, pid: targetPid'));
});
check('ChatGPT 独占 HID 租约只有完整还原鼠标后才接受成功', () => {
  const good = 'original|100|200\nhit|target=1\nprogress|1\ncursor|100|200|100|200\nisolation|afterCapture=1|associate=0\nrestore|warp=0|associate=0|show=0\nbutton|left=0\noverlay|native=1|opaque=0|alpha=0|shadow=0|ignoresMouse=1|sharing=1|cornerAlpha=0|serverBounds=1|serverSharing=1\ntransport|isolated-hid=1|warp=0\nok|hide=0|associate=0|afterCapture=1|restored=1\n';
  assert(parseIsolatedDragHelperResult(good, 0).ok);
  assert(!parseIsolatedDragHelperResult(good.replace('button|left=0', 'button|left=1'), 0).ok);
  assert(!parseIsolatedDragHelperResult(good.replace('cursor|100|200|100|200', 'cursor|100|200|120|200'), 0).ok);
  assert(parseIsolatedDragHelperResult('hit|target=0\n', 7).miss);
});
check('回归：warped 最后一帧不能报胜利，必须等 stable 保持证明', () => {
  assert.strictEqual(parseWarpHelperLine('progress|1').type, 'progress');
  assert.strictEqual(parseWarpHelperLine('warped|42|886|404|312|0').type, 'warped');
  assert.notStrictEqual(parseWarpHelperLine('warped|42|886|404|312|0').type, 'stable');
  assert.strictEqual(parseWarpHelperLine('stable|42|1198|404').type, 'stable');
});
check('回归：保持进程异常退出会恢复，用户接管/主动停止/超过上限不会恢复', () => {
  const base = { confirmedStable: true, recoveryAttempt: 0 };
  assert(warpHoldNeedsRecovery(base));
  assert(!warpHoldNeedsRecovery({ ...base, userReleased: true }));
  assert(!warpHoldNeedsRecovery({ ...base, stopping: true }));
  assert(!warpHoldNeedsRecovery({ ...base, recoveryAttempt: 2 }));
  assert(!warpHoldNeedsRecovery({ ...base, confirmedStable: false }));
});
check('回归：Swift helper 必须动态补偿逻辑 x，且稳定后才握手', () => {
  const fs = require('fs');
  const path = require('path');
  const swift = fs.readFileSync(path.join(__dirname, '..', 'backend', 'drag-window.swift'), 'utf8');
  assert(swift.includes('let pinnedWindowX = initialBounds.origin.x + shiftX'));
  assert(swift.includes('let liveShiftX = pinnedWindowX - currentBounds.origin.x'));
  assert(swift.includes('stableTicks >= 4'));
  assert(swift.includes('print("stable|'));
  assert(!swift.includes('abs(currentBounds.origin.x - expectedX) <= 3'));
});

console.log('[T4] standX：站到推挤反方向一侧，贴身但不遮住拖拽热点');
check('向右推 → 站左侧并保持 30px 重叠', () => assert.strictEqual(standX(500, 200, 1, 320), 500 - 320 + 30));
check('向左推 → 站右侧并保持 30px 重叠', () => assert.strictEqual(standX(500, 200, -1, 320), 500 + 200 - 30));

console.log('[T4b] parsePresence：猫爪在上的进程存在性解析');
check('正常行 + 去重 + 排除自己', () => {
  const out = 'BongoCat|11\nBongoCat|11\nDesktop Goose|22\nElectron|99\n';
  const r = parsePresence(out, [99]);
  assert.deepStrictEqual(r, [{ name: 'BongoCat', pid: 11 }, { name: 'Desktop Goose', pid: 22 }]);
});
check('脏行丢弃', () => assert.strictEqual(parsePresence('\njunk\nA|x\n', []).length, 0));

console.log('[T5] tick 前置条件短路(不触发 osascript)');
check('默认对手名单非空且含 Goose/Bongo/Shimeji', () => {
  assert(DEFAULT_RIVALS.length >= 3);
  assert(DEFAULT_RIVALS.some((n) => /goose/i.test(n)));
  assert(DEFAULT_RIVALS.some((n) => /bongo/i.test(n)));
  assert(DEFAULT_RIVALS.some((n) => /shimeji/i.test(n)));
});
function mockHooks(over) {
  const calls = { assertTop: 0, relaxTop: 0, emitted: 0, scanned: 0 };
  const hooks = {
    isEnabled: () => true,
    canScan: () => { calls.scanned++; return true; },
    rivalNames: () => [], // 名单为空 → presence/scan 都不会真调 osascript
    hostRivalNames: () => [], // 测试里关掉内置寄生型名单,保持无外部调用
    excludePids: () => [],
    shouldAbort: () => false,
    getPetBounds: () => ({ x: 0, y: 0, width: 320, height: 340 }),
    tweenPetTo: async () => {},
    getWorkArea: () => WA,
    clearRivalVisual: async () => ({ ok: true }),
    warpRivalVisual: async () => ({ ok: true }),
    probeDragPoint: async (_rival, points) => ({ ok: true, index: 0, point: points[0] }),
    assertTop: () => { calls.assertTop++; },
    relaxTop: () => { calls.relaxTop++; },
    emit: () => { calls.emitted++; },
    ...over,
  };
  return { hooks, calls };
}
check('isEnabled=false 时 tick 不扫描不出手不动层级', async () => {
  const { hooks, calls } = mockHooks({ isEnabled: () => false });
  const t = createTerritory(hooks);
  await t.tick();
  assert.strictEqual(calls.scanned, 0, 'isEnabled=false 应最先短路');
  assert.strictEqual(calls.assertTop + calls.relaxTop + calls.emitted, 0);
  assert.strictEqual(t.busy, false);
  assert.strictEqual(t.dominating, false);
});
check('对手名单为空 → presence 为空 → 不抬层级不开战', async () => {
  const { hooks, calls } = mockHooks();
  const t = createTerritory(hooks);
  await t.tick();
  assert.strictEqual(calls.assertTop, 0);
  assert.strictEqual(calls.emitted, 0);
  assert.strictEqual(t.dominating, false);
});
check('手动 runNow 即使自动巡逻关闭也会扫描一次并反馈 clear', async () => {
  const phases = [];
  const { hooks, calls } = mockHooks({
    isEnabled: () => false,
    emit: (ev) => phases.push(ev.phase),
  });
  const t = createTerritory(hooks);
  const result = await t.runNow();
  assert.strictEqual(result, 'clear');
  assert.strictEqual(calls.scanned, 1);
  assert.deepStrictEqual(phases, ['searching', 'clear']);
});

console.log('[T6] 整场驱逐战编排(注入 osascript/拖拽/空闲检测假实现,零真实副作用)');
// 按脚本内容路由的假 osascript:AXPosition→推窗、AXRaise→抬窗、含窗口枚举→scan、其余→presence
function fakeOsa(world) {
  return async (script, args) => {
    if (script.includes('AXPosition')) return { ok: true, out: world.move(+args[0], +args[1], +args[2]), err: '' };
    if (script.includes('AXRaise')) return { ok: true, out: 'ok', err: '' };
    if (script.includes('position of w')) return { ok: true, out: world.windows(), err: '' };
    return { ok: true, out: world.presence(), err: '' };
  };
}

check('victory:发现对手 → ontop/spotted/march → 一步步推到屏幕边', async () => {
  const phases = [];
  let rivalX = 700;
  const { hooks } = mockHooks({
    rivalNames: () => ['BongoCat'],
    canMove: () => { throw new Error('扫描成功后不应再读取可能滞后的权限缓存'); },
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    runOsa: fakeOsa({
      presence: () => 'BongoCat|42\n',
      windows: () => `BongoCat|42|${rivalX}|300|120|120\n`,
      move: (_pid, x) => { const old = rivalX; rivalX = x; return `${old}|300|${x}|300`; },
    }),
  });
  const t = createTerritory(hooks);
  const res = await t.tick();
  assert.strictEqual(res, 'episode');
  assert.deepStrictEqual(phases, ['ontop', 'spotted', 'march', 'victory']);
  assert(rivalX >= 1320 - 6, `对手应被推到右边缘,实际 x=${rivalX}`); // WA 1440 - 宽 120
  assert.strictEqual(t.busy, false, 'episode 结束后必须放开 busy');
});

check('defeat:AXPosition 无效+软件指针也推不动 → 拔河认怂', async () => {
  const phases = [];
  const { hooks } = mockHooks({
    rivalNames: () => ['Shimeji'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    dragRival: async () => ({ ok: true }), // 拖了,但 scan 显示纹丝不动
    runOsa: fakeOsa({
      presence: () => 'Shimeji|7\n',
      windows: () => 'Shimeji|7|700|300|120|120\n',
      move: () => '700|300|700|300', // 请求推 76px,实际没动(对手顶回来)
    }),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert.deepStrictEqual(phases, ['ontop', 'spotted', 'march', 'defeat']);
});

check('ChatGPT 必须由隔离 HID 真实移动 AX frame，不能再靠 compositor 返回值冒充', async () => {
  const phases = [];
  let rivalX = 800;
  let isolatedCalls = 0;
  let visualShift = 0;
  const world = {
    presence: () => '',
    windows: () => `ChatGPT|42|${rivalX}|300|356|320\n`,
    move: () => { throw new Error('ChatGPT 不应走 AXPosition'); },
  };
  const { hooks } = mockHooks({
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    dragRival: async () => { throw new Error('ChatGPT 不应走定向事件'); },
    isolatedDragRival: async (_rival, targetX, _rx, _ry, _duration, onProgress) => {
      isolatedCalls++;
      rivalX = Math.min(targetX, WA.x + WA.width - 356);
      if (onProgress) onProgress(1);
      return { ok: true };
    },
    warpRivalVisual: async (_rival, dx) => { visualShift = dx; return { ok: true }; },
    runOsa: fakeOsa(world),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert(isolatedCalls >= 2, `应先校准再长拖，实际 ${isolatedCalls} 次`);
  assert.strictEqual(rivalX, WA.x + WA.width - 356, '真实 AX frame 必须移动到系统边界');
  assert(phases.includes('partial'), `系统 clamp 后应如实 partial，实际 phases=${phases.join(',')}`);
  assert(Math.abs(visualShift - 42) < 1, `最后仅允许约 42px cosmetic 补偿，实际 ${visualShift}`);
});

check('ChatGPT 透明外框已被系统 clamp → 合成层只补齐最后约 42px', async () => {
  const phases = [];
  const rivalX = WA.x + WA.width - 356;
  let visualShift = 0;
  const world = {
    presence: () => '',
    windows: () => `ChatGPT|42|${rivalX}|300|356|320\n`,
    move: () => { throw new Error('ChatGPT 不应走 AXPosition'); },
  };
  const { hooks } = mockHooks({
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    dragRival: async () => { throw new Error('ChatGPT 不应发送鼠标事件'); },
    warpRivalVisual: async (_rival, dx) => {
      visualShift = dx;
      return { ok: true };
    },
    runOsa: fakeOsa(world),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert(phases.includes('partial'), `透明外框贴边后只能报告系统边界，实际 phases=${phases.join(',')}`);
  assert(!phases.includes('victory'), '没有像素级证明时不能报告完整胜利');
  assert(Math.abs(visualShift - 42) < 1,
    `应补齐约 42px 透明留白，实际 shift=${visualShift}`);
  const visible = chatGPTVisualBounds({ name: 'ChatGPT', pid: 42, x: rivalX, y: 300, w: 356, h: 320 }, WA, 1);
  const visibleRight = visible.x + visualShift + visible.w;
  assert(Math.abs(visibleRight - (WA.x + WA.width)) <= 1,
    `可见本体应精确贴边，实际 right=${visibleRight}`);
});

check('ChatGPT 隔离 HID 拖拽失败 → 必须 defeat，不能回退到 compositor 假胜利', async () => {
  const phases = [];
  const rivalX = 800;
  const { hooks } = mockHooks({
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    dragRival: async () => { throw new Error('ChatGPT 不应走定向事件'); },
    isolatedDragRival: async () => ({ ok: false, error: 'isolated drag failed' }),
    warpRivalVisual: async () => { throw new Error('真实拖拽失败后不得用 compositor 假装移动'); },
    runOsa: fakeOsa({
      presence: () => '',
      windows: () => `ChatGPT|42|${rivalX}|300|356|320\n`,
      move: () => { throw new Error('ChatGPT 不应走 AXPosition'); },
    }),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert(phases.includes('defeat'), `复扫错误必须失败，实际 phases=${phases.join(',')}`);
  assert(!phases.includes('victory'), `复扫错误绝不能胜利，实际 phases=${phases.join(',')}`);
});

check('ChatGPT 真实 frame 到系统边界后再次巡视不会重复长拖', async () => {
  const phases = [];
  let rivalX = 800;
  let warpCalls = 0;
  let isolatedCalls = 0;
  const world = {
    presence: () => '',
    windows: () => `ChatGPT|42|${rivalX}|300|356|320\n`,
    move: () => { throw new Error('ChatGPT 应走视觉补推路径'); },
  };
  const { hooks } = mockHooks({
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    dragRival: async () => { throw new Error('ChatGPT 不应走定向事件'); },
    isolatedDragRival: async (_rival, targetX) => {
      isolatedCalls++;
      rivalX = Math.min(targetX, WA.x + WA.width - 356);
      return { ok: true };
    },
    warpRivalVisual: async () => {
      warpCalls++;
      return { ok: true };
    },
    runOsa: fakeOsa(world),
  });
  const t = createTerritory(hooks);
  await t.tick();
  await t.tick();
  // 第一次开战前 clearVisual 属于测试 hook，不计入 warpCalls；实际推边仅一次。
  assert.strictEqual(warpCalls, 1, `视觉补偿只应执行一次，实际 ${warpCalls} 次`);
  assert.strictEqual(isolatedCalls, 2, `第二次巡视不应重复校准/长拖，实际 ${isolatedCalls} 次`);
  assert.strictEqual(phases.filter((phase) => phase === 'partial').length, 1);
});

check('用户手上有活(输入空闲<2s)→ 软件光标不出手,静默 abort 撤退', async () => {
  const phases = [];
  const { hooks } = mockHooks({
    rivalNames: () => ['Shimeji'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 0.2,
    dragRival: async () => { throw new Error('用户活跃时不该进入拖拽'); },
    runOsa: fakeOsa({
      presence: () => 'Shimeji|7\n',
      windows: () => 'Shimeji|7|700|300|120|120\n',
      move: () => '700|300|700|300',
    }),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert.deepStrictEqual(phases, ['ontop', 'spotted', 'march', 'abort']);
});

check('定向拖拽期间用户按下真鼠标 → 用户优先并立即 abort', async () => {
  const phases = [];
  const { hooks } = mockHooks({
    rivalNames: () => ['Shimeji'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    dragRival: async () => ({ ok: false, interrupted: true, error: 'drag helper exited 6' }),
    runOsa: fakeOsa({
      presence: () => 'Shimeji|7\n',
      windows: () => 'Shimeji|7|700|300|120|120\n',
      move: () => '700|300|700|300',
    }),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert(phases.includes('abort'), `用户介入应撤退，实际 phases=${phases.join(',')}`);
  assert(!phases.includes('defeat'), `用户介入不能算失败，实际 phases=${phases.join(',')}`);
});

check('手动巡视授权本轮软件指针，不把启动点击误判为用户干扰', async () => {
  const phases = [];
  let rivalX = 800;
  let warpCalls = 0;
  let isolatedCalls = 0;
  const { hooks } = mockHooks({
    isEnabled: () => false,
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 0.1,
    dragRival: async () => { throw new Error('ChatGPT 不应走定向事件'); },
    isolatedDragRival: async (_rival, targetX) => {
      isolatedCalls++;
      rivalX = Math.min(targetX, WA.x + WA.width - 356);
      return { ok: true };
    },
    warpRivalVisual: async () => {
      warpCalls++;
      return { ok: true };
    },
    runOsa: fakeOsa({
      presence: () => '',
      windows: () => `ChatGPT|42|${rivalX}|300|356|320\n`,
      move: () => { throw new Error('ChatGPT 应走拖拽路径'); },
    }),
  });
  const t = createTerritory(hooks);
  await t.runNow();
  assert.strictEqual(isolatedCalls, 2, `手动巡视应完成校准+长拖，实际 ${isolatedCalls} 次`);
  assert.strictEqual(warpCalls, 1, `手动巡视最多做一次边缘 cosmetic 补偿，实际 ${warpCalls} 次`);
  assert(phases.includes('partial'), `手动巡视应报告真实系统边界，实际 phases=${phases.join(',')}`);
});

check('shouldAbort(弹层打开)→ 广播 abort 复位表情并回家', async () => {
  const phases = [];
  let lastTween = null;
  const { hooks } = mockHooks({
    rivalNames: () => ['Shimeji'],
    shouldAbort: () => true,
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    tweenPetTo: async (x, y) => { lastTween = [x, y]; },
    runOsa: fakeOsa({
      presence: () => 'Shimeji|7\n',
      windows: () => 'Shimeji|7|700|300|120|120\n',
      move: () => { throw new Error('shouldAbort 下不该出手'); },
    }),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert.deepStrictEqual(phases, ['ontop', 'spotted', 'abort']);
  assert.deepStrictEqual(lastTween, [0, 0], '撤退后应回到出发位');
});

Promise.all(pending).then(() => {
  if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
  console.log('\nterritory: all passed');
});
