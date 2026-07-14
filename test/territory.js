'use strict';

// territory 单元测试 — 纯逻辑部分:扫描输出解析、推挤方向/目标、贴边判定、
// 站位计算,以及 tick 的前置条件短路(不真的调 osascript)。
// Run: node test/territory.js

const assert = require('assert');
const { createTerritory, parsePresence, parseScan, scanCandidateScore, nearestEdgeTarget, edgeAwayFromPet, atEdge, windowTargetForVisual, visualAtEdge, visualShiftMatches, interpolateFrame, standX, DEFAULT_RIVALS } = require('../backend/territory');

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
check('视觉补推身份忽略纵向 7px 晃动，但水平走开会失效', () => {
  const record = { windowX: 1156, windowY: 357, windowW: 356, windowH: 320 };
  assert(visualShiftMatches(record, { x: 1156, y: 364, w: 356, h: 320 }));
  assert(!visualShiftMatches(record, { x: 1146, y: 357, w: 356, h: 320 }));
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

console.log('[T4] standX：站到推挤反方向那一侧,保持 42px 紧密重叠');
check('向右推 → 站左侧', () => assert.strictEqual(standX(500, 200, 1, 320), 500 - 320 + 42));
check('向左推 → 站右侧', () => assert.strictEqual(standX(500, 200, -1, 320), 500 + 200 - 42));

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

check('ChatGPT 校准拖拽重置 HIDIdleTime → 不误判用户活跃，继续推到边缘', async () => {
  const phases = [];
  let rivalX = 800;
  let idleChecks = 0;
  let dragCalls = 0;
  const world = {
    presence: () => '',
    windows: () => `ChatGPT|42|${rivalX}|300|356|320\n`,
    move: () => { throw new Error('ChatGPT 应走拖拽路径'); },
  };
  const { hooks } = mockHooks({
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => (++idleChecks <= 2 ? 999 : 0.1),
    dragRival: async (_rival, targetX, _rx, _ry, _ms, onProgress) => {
      dragCalls++;
      rivalX = targetX;
      if (onProgress) onProgress(1);
      return { ok: true };
    },
    runOsa: fakeOsa(world),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert(dragCalls >= 2, `应先校准再正式推边，实际拖拽 ${dragCalls} 次`);
  assert(phases.includes('victory'), `应完成推边，实际 phases=${phases.join(',')}`);
  const visualRight = rivalX + 356 * 0.65 - 70 + 140;
  assert(Math.abs(visualRight - (WA.x + WA.width)) <= 12,
    `可见本体应贴右边，实际 right=${visualRight}`);
});

check('ChatGPT 透明外框被系统 clamp → WindowServer 补齐可见本体最后 55px', async () => {
  const phases = [];
  let rivalX = 800;
  let visualShift = 0;
  const outerRightLimit = WA.x + WA.width - 356;
  const world = {
    presence: () => '',
    windows: () => `ChatGPT|42|${rivalX}|300|356|320\n`,
    move: () => { throw new Error('ChatGPT 应走拖拽路径'); },
  };
  const { hooks } = mockHooks({
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 999,
    dragRival: async (_rival, targetX, _rx, _ry, _ms, onProgress) => {
      rivalX = Math.min(targetX, outerRightLimit);
      if (onProgress) onProgress(1);
      return { ok: true };
    },
    warpRivalVisual: async (_rival, dx) => {
      visualShift = dx;
      return { ok: true };
    },
    runOsa: fakeOsa(world),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert(phases.includes('victory'), `透明外框贴边后应补推胜利，实际 phases=${phases.join(',')}`);
  assert(Math.abs(visualShift - 54.6) < 1,
    `应补齐约 55px 透明留白，实际 shift=${visualShift}`);
  const visibleRight = rivalX + visualShift + 356 * 0.65 - 70 + 140;
  assert(Math.abs(visibleRight - (WA.x + WA.width)) <= 1,
    `可见本体应精确贴边，实际 right=${visibleRight}`);
});

check('ChatGPT 外框已在边缘且 Octopus 刚重启 → 不抢鼠标，直接恢复视觉贴边', async () => {
  const phases = [];
  const outerRightLimit = WA.x + WA.width - 356;
  let visualShift = 0;
  let dragCalls = 0;
  const world = {
    presence: () => '',
    windows: () => `ChatGPT|42|${outerRightLimit}|300|356|320\n`,
    move: () => { throw new Error('ChatGPT 应走视觉补推路径'); },
  };
  const { hooks } = mockHooks({
    rivalNames: () => [],
    hostRivalNames: () => ['ChatGPT'],
    emit: (ev) => phases.push(ev.phase),
    sleep: async () => {},
    userIdleSeconds: async () => 0,
    dragRival: async () => { dragCalls++; return { ok: true }; },
    warpRivalVisual: async (_rival, dx) => {
      if (Math.abs(dx) > 1) visualShift = dx;
      return { ok: true };
    },
    runOsa: fakeOsa(world),
  });
  const t = createTerritory(hooks);
  await t.tick();
  assert.strictEqual(dragCalls, 0, '外框已贴边时不应再接管鼠标校准');
  assert(Math.abs(visualShift - 54.6) < 1, `应恢复约 55px 视觉补偿，实际 ${visualShift}`);
  assert(phases.includes('victory'), `应直接胜利，实际 phases=${phases.join(',')}`);
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
