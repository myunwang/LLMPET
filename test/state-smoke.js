'use strict';

// Renderer state-machine smoke test — loads the REAL renderer/pet.js headless
// (test/dom-stub.js) and drives it with synthetic pet:stats / pet:event traffic.
// Covers the bug class「状态被秒盖 / 闪烁 / 卡死 / class 泄漏 / 素材不可达」.
// Run: node test/state-smoke.js

const assert = require('assert');
const vm = require('vm');
const { loadRenderer } = require('./dom-stub');
const States = require('../shared/states');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// 状态词全集取自唯一来源 shared/states.js（用于 class 泄漏检测）。此前这里是
// pet.js 的手抄副本、漏了 'loafing'，让 R8 泄漏检测对该状态失明——现在同源。
const STATE_WORDS = States.RENDER_STATE_WORDS;

function baseStats(over = {}) {
  return {
    today: { cost: 0 }, lifetime: { cost: 0 }, sessions: [], bg: { zombie: 0 },
    waitingCount: 0, needsinputCount: 0, workingCount: 0, jugglingCount: 0,
    sweepingCount: 0, thinkingCount: 0, loafingCount: 0, errorCount: 0, idleMs: 1000,
    ...over,
  };
}

function world() {
  const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'renderer/pet.js']);
  w.handlers.config({ skin: 'cat', muted: true }); // muted: 免声音路径干扰
  return w;
}
const stateClasses = (el) => el.classList.list.filter((c) => STATE_WORDS.includes(c));
const catSrc = (w) => w.elements('cat-img').getAttribute('src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('[R-1] 桌宠会话板 Session ID');
  {
    const w = world();
    const fullId = '019fc6b1-fd00-7a21-9c33-2b7e51aa1f04';
    const row = vm.runInContext(`(() => {
      const row = createSessRow();
      updateSessRow(row, {
        project: 'copy-session-test', agent: 'codex', state: 'idle',
        sessionId: '${fullId}', badge: null,
      });
      return row;
    })()`, w.sandbox);
    check('会话行恢复 Session ID', () => assert.strictEqual(row._parts.sessionId.textContent, 'ID 019fc6b1…1f04 ⧉'));
    check('悬停可看到完整 Session ID', () => assert(row._parts.sessionId.title.startsWith(fullId)));
    row._parts.sessionId.dispatch('click');
    await sleep(0);
    check('点击复制的是完整 Session ID', () => assert(w.calls.some((c) => c[0] === 'copySessionId' && c[1][0] === fullId)));
    check('复制成功有即时反馈', () => assert(row._parts.sessionId.classList.contains('copied')));
  }

  console.log('[R-1b] provider capability 与 DSH 计费边界');
  {
    const w = world();
    const row = vm.runInContext('createSessRow()', w.sandbox);
    const update = (agent) => vm.runInContext(
      `updateSessRow(__row, { project: 'capability-test', agent: '${agent}', state: 'idle', sessionId: 'cap-${agent}', badge: null })`,
      Object.assign(w.sandbox, { __row: row }),
    );
    const hidden = (action) => row._parts[action].classList.contains('hidden');

    update('claude');
    check('Claude 显示接管/表情包/旅行', () => assert.deepStrictEqual(
      ['takeover', 'meme', 'travel'].map(hidden), [false, false, false],
    ));
    update('dsh');
    check('DSH 只保留作为来源的接管入口', () => assert.deepStrictEqual(
      ['takeover', 'meme', 'travel'].map(hidden), [false, true, true],
    ));
    update('unknown');
    check('unknown 三个动作全部 fail-closed', () => assert.deepStrictEqual(
      ['takeover', 'meme', 'travel'].map(hidden), [true, true, true],
    ));
    const blockedTakeover = vm.runInContext("openTakeoverPage({ agent: 'unknown' })", w.sandbox);
    const blockedMeme = await vm.runInContext("openMemePage({ agent: 'unknown' })", w.sandbox);
    const blockedTravel = await vm.runInContext("openTravelPage({ agent: 'unknown' })", w.sandbox);
    check('unknown 无法绕过隐藏状态直接打开动作页', () => assert.deepStrictEqual(
      [blockedTakeover, blockedMeme, blockedTravel], [false, false, false],
    ));
    vm.runInContext("takeoverTarget = { agent: 'unknown', sessionId: 'unknown-takeover' }", w.sandbox);
    const blockedTakeoverRun = await vm.runInContext("runTakeover('claude')", w.sandbox);
    vm.runInContext("travelTarget = { agent: 'unknown', sessionId: 'unknown-travel' }", w.sandbox);
    w.elements('sl-travel-mission').value = 'must not run';
    await w.elements('sl-travel-start')._listeners.click[0]({ stopPropagation() {} });
    check('unknown 即使污染内部 target 也不能触发 takeover/travel IPC', () => {
      assert.strictEqual(blockedTakeoverRun, false);
      assert.strictEqual(w.calls.some((call) => call[0] === 'takeOverSession'), false);
      assert.strictEqual(w.calls.some((call) => call[0] === 'startTravel'), false);
    });
    update('codex');
    check('row 复用回 Codex 后三个入口恢复，hidden 不残留', () => assert.deepStrictEqual(
      ['takeover', 'meme', 'travel'].map(hidden), [false, false, false],
    ));

    const dsh = loadRenderer(
      ['shared/i18n.js', 'shared/states.js', 'renderer/pet.js'],
      { search: '?agent=dsh' },
    );
    dsh.handlers.config({ skin: 'pixel', muted: true });
    dsh.handlers.stats(baseStats({
      billingAvailable: false,
      today: { cost: 123.456 },
      lifetime: { cost: 999.999 },
      codexUsage: { today: { cost: 88, tokens: 12345 } },
    }));
    check('DSH 独立宠只显示身份，不显示任何 Claude/Codex 美元值', () => {
      assert.strictEqual(dsh.elements('chip-cost').textContent, 'DeepSeek Harness');
      assert(dsh.elements('chip-sep').classList.contains('hidden'));
      assert(dsh.elements('chip-window').classList.contains('hidden'));
      assert(!dsh.elements('chip-cost').textContent.includes('$'));
      assert(!dsh.elements('chip-window').textContent.includes('$'));
    });
  }

  console.log('[R0] 状态词表单一来源一致性');
  {
    // 后端 VALID_STATES（core 接受的状态）必须全部落在渲染端 STATE_WORDS 里，
    // 否则新增一个后端状态时 classList.remove 覆盖不到 → class 残留。
    const missing = States.VALID_STATES.filter((s) => !States.RENDER_STATE_WORDS.includes(s));
    check('渲染端 STATE_WORDS ⊇ 后端 VALID_STATES', () => assert.deepStrictEqual(missing, []));
    check('STATE_WORDS 含 loafing（曾在手抄副本里漏掉）', () => assert(STATE_WORDS.includes('loafing')));
    check('renderer 通过 <script> 拿到同一份 STATE_WORDS', () => {
      const oi = world().window.OctoStates;
      assert(oi && Array.isArray(oi.RENDER_STATE_WORDS));
      assert.deepStrictEqual(oi.RENDER_STATE_WORDS, States.RENDER_STATE_WORDS);
    });
  }

  console.log('[R0.1] 透明窗拖拽失败路径');
  {
    const w = world();
    w.handlers.config({ skin: 'mascot', muted: true });
    const mascot = w.elements('mascot');
    mascot.dispatch('pointerdown', {
      button: 0, buttons: 1, pointerId: 41, screenX: 100, screenY: 100,
    });
    await sleep(0);
    mascot.dispatch('pointermove', {
      buttons: 0, pointerId: 41, screenX: 145, screenY: 145,
    });
    check('漏掉 pointerup 后的纯 hover 不再移动窗口', () => {
      assert(!w.calls.some((c) => c[0] === 'setWinPos'));
      assert(!mascot.classList.contains('dragging'));
    });

    mascot.dispatch('pointerdown', {
      button: 0, buttons: 1, pointerId: 42, screenX: 200, screenY: 200,
    });
    await sleep(0);
    mascot.dispatch('lostpointercapture', { pointerId: 42 });
    mascot.dispatch('pointermove', {
      buttons: 1, pointerId: 42, screenX: 250, screenY: 250,
    });
    check('pointer capture 丢失后不会继续拖动', () => {
      assert(!w.calls.some((c) => c[0] === 'setWinPos'));
      assert(!mascot.classList.contains('dragging'));
    });
  }

  {
    const w = world();
    const cat = w.elements('cat');
    const pendingOrigins = [];
    w.window.pet.getWinPos = () => new Promise((resolve) => pendingOrigins.push(resolve));

    cat.dispatch('pointerdown', {
      button: 0, buttons: 1, pointerId: 51, screenX: 10, screenY: 10,
    });
    cat.dispatch('pointerup', { pointerId: 51 });
    cat.dispatch('pointerdown', {
      button: 0, buttons: 1, pointerId: 52, screenX: 100, screenY: 100,
    });
    pendingOrigins[0]([900, 700]);
    await sleep(0);
    cat.dispatch('pointermove', {
      buttons: 1, pointerId: 52, screenX: 130, screenY: 130,
    });
    check('旧手势的异步窗口坐标不会污染新手势', () => {
      assert(!w.calls.some((c) => c[0] === 'setWinPos'));
    });
    pendingOrigins[1]([20, 30]);
    await sleep(0);
    cat.dispatch('pointermove', {
      buttons: 1, pointerId: 52, screenX: 135, screenY: 135,
    });
    check('新手势自己的窗口坐标到达后仍可正常拖动', () => {
      assert(w.calls.some((c) => c[0] === 'setWinPos'));
    });
    cat.dispatch('pointercancel', { pointerId: 52 });
  }

  console.log('[R0.2] 权限卡到确认气泡的尺寸交接');
  {
    const w = world();
    w.handlers.config({ skin: 'mascot', muted: false });
    const choice = {
      kind: 'perm', sessionId: 'permission-resize', permId: 'perm-resize',
      project: 'LLMPET', question: '允许执行命令吗？',
      options: [
        { label: '允许', key: 'allow' },
        { label: '拒绝', key: 'deny' },
      ],
    };
    w.handlers.stats(baseStats({
      waitingCount: 1,
      sessions: [{
        sessionId: choice.sessionId, project: choice.project, agent: 'claude',
        state: 'waiting', choice,
      }],
    }));
    await sleep(20);
    const callsBeforeAllow = w.calls.length;
    w.elements('ask-opts').children[0].dispatch('click');
    await sleep(20);
    const transitionSizes = w.calls.slice(callsBeforeAllow)
      .filter((c) => c[0] === 'setPetSize')
      .map((c) => c[1].slice(0, 2));
    check('点击允许不会先收成基础窗再展开确认气泡', () => {
      assert(!transitionSizes.some(([width, height]) => width === 0 && height === 0),
        'unexpected intermediate collapse: ' + JSON.stringify(transitionSizes));
      assert(w.calls.slice(callsBeforeAllow).some((c) => c[0] === 'decidePermission'));
      assert(!w.elements('bubble').classList.contains('hidden'));
    });
  }

  console.log('[R1] 聚合梯子优先级（对齐 STATES.md）');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 2, thinkingCount: 1 }));
    check('working > thinking', () => assert(cat.classList.contains('working')));
    w.handlers.stats(baseStats({ workingCount: 2, jugglingCount: 1 }));
    check('juggling > working（并行子任务可见）', () => assert(cat.classList.contains('juggling')));
    check('cat 显示 juggling 素材', () => assert(catSrc(w).endsWith('cat-juggling.gif')));
    w.handlers.stats(baseStats({ jugglingCount: 1, sweepingCount: 1 }));
    check('sweeping > juggling', () => assert(cat.classList.contains('sweeping')));
    w.handlers.stats(baseStats({ workingCount: 3, needsinputCount: 1 }));
    check('needsinput > working（等你回复不被干活盖住）', () => assert(cat.classList.contains('needsinput')));
    w.handlers.stats(baseStats({ needsinputCount: 1, errorCount: 1 }));
    check('error > needsinput', () => assert(cat.classList.contains('error')));
    w.handlers.stats(baseStats({ errorCount: 1, waitingCount: 1 }));
    check('waiting > error', () => assert(cat.classList.contains('waiting')));
  }

  console.log('[R2] thinking transient：多会话干活时提交 prompt 仍可见，且到期回落');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 2 }));
    w.handlers.event({ kind: 'user-turn', project: 'p' });
    check('user-turn 后进入 thinking', () => assert(cat.classList.contains('thinking')));
    w.handlers.stats(baseStats({ workingCount: 2 })); // 快照立刻到达（曾经 150ms 秒盖）
    check('快照到达后 thinking 仍在（transient 存续）', () => assert(cat.classList.contains('thinking')));
    w.clock.offset += 4000; // 越过 3500ms 窗口
    w.handlers.stats(baseStats({ workingCount: 2 }));
    check('transient 到期后回落 working', () => assert(cat.classList.contains('working')));
  }

  console.log('[R3] operation 事件的守卫');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'user-turn', project: 'p' });
    w.handlers.event({ kind: 'operation', tool: 'Bash', icon: '⚙️', detail: '运行命令' });
    check('首个 operation 立即结束 thinking 过渡态并进入 working', () => assert(cat.classList.contains('working')));
    w.handlers.stats(baseStats({ workingCount: 1 }));
    check('后续快照不让已清理的 thinking 复活', () => assert(cat.classList.contains('working')));
    // needsinput 稳态不被 op 降级
    const w2 = world();
    const cat2 = w2.elements('cat');
    w2.handlers.stats(baseStats({ needsinputCount: 1, workingCount: 1 }));
    assert(cat2.classList.contains('needsinput'));
    w2.handlers.event({ kind: 'operation', tool: 'Bash', icon: '⚙️', detail: '运行命令' });
    check('needsinput 稳态不被 operation 打断', () => assert(cat2.classList.contains('needsinput')));
    // error 稳态同理（曾经 working↔error 闪烁）
    const w3 = world();
    const cat3 = w3.elements('cat');
    w3.handlers.stats(baseStats({ errorCount: 1, workingCount: 1 }));
    w3.handlers.event({ kind: 'operation', tool: 'Read', icon: '📖', detail: '读取文件' });
    check('error 稳态不被 operation 打断', () => assert(cat3.classList.contains('error')));
  }

  console.log('[R4] happy 庆祝不被同批 say 秒盖，say 接棒');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'turn-done', project: 'p' });
    check('turn-done → happy', () => assert(cat.classList.contains('happy')));
    w.handlers.event({ kind: 'say', text: '我修好了那个 bug，测试也通过了。', project: 'p' });
    check('同批 say 不秒盖 happy', () => assert(cat.classList.contains('happy')));
    await sleep(2000); // happy 1800ms 结束后 say 接棒
    check('happy 结束后 talking 接棒', () => assert(cat.classList.contains('talking')));
  }

  console.log('[R5] needsinput / waiting 清残留 transient');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'say', text: '这是一段比较长的回复文本内容。', project: 'p' });
    assert(cat.classList.contains('talking'));
    w.handlers.event({ kind: 'needsinput', project: 'p' });
    check('needsinput 事件即时生效', () => assert(cat.classList.contains('needsinput')));
    w.handlers.stats(baseStats({ needsinputCount: 1, workingCount: 1 }));
    check('下个快照 talking 不复活（transient 已清）', () => assert(cat.classList.contains('needsinput')));
  }

  console.log('[R6] 睡眠判定');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ idleMs: 7 * 60 * 1000 }));
    check('空闲超阈值 → sleeping', () => assert(cat.classList.contains('sleeping')));
    w.handlers.stats(baseStats({ idleMs: null }));
    check('无活跃会话(idleMs=null) → sleeping 不惊醒', () => assert(cat.classList.contains('sleeping')));
    w.handlers.stats(baseStats({ idleMs: 1000 }));
    check('有近期活动 → idle', () => assert(cat.classList.contains('idle')));
  }

  console.log('[R7] 情绪短暂态的皮肤映射（不再回落成摸鱼图）');
  {
    const w = world();
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'user-turn', emotion: 'loved', project: 'p' });
    check('被夸 → cat-happy 素材', () => assert(catSrc(w).endsWith('cat-happy.gif')));
    const w2 = world();
    w2.handlers.stats(baseStats({ workingCount: 1 }));
    w2.handlers.event({ kind: 'user-turn', emotion: 'sad', project: 'p' });
    check('负面情绪 → cat-sad 素材', () => assert(catSrc(w2).endsWith('cat-sad.gif')));
  }

  console.log('[R8] class 泄漏检测：任意时刻皮肤元素上最多一个状态词');
  {
    const w = world();
    const cat = w.elements('cat');
    const seq = [
      () => w.handlers.stats(baseStats({ workingCount: 1 })),
      () => w.handlers.event({ kind: 'user-turn', project: 'p' }),
      () => w.handlers.stats(baseStats({ jugglingCount: 1 })),
      () => { w.clock.offset += 4000; w.handlers.stats(baseStats({ sweepingCount: 1 })); },
      () => w.handlers.event({ kind: 'turn-done', project: 'p' }),
      () => w.handlers.event({ kind: 'waiting', project: 'p' }),
      () => w.handlers.stats(baseStats({ errorCount: 1 })),
      () => w.handlers.stats(baseStats({ idleMs: null })),
    ];
    let leaked = null;
    for (const step of seq) {
      step();
      const cs = stateClasses(cat);
      if (cs.length > 1) { leaked = cs; break; }
    }
    check('全序列无 class 残留', () => assert(!leaked, 'leaked: ' + JSON.stringify(leaked)));
  }

  console.log('[R9] 启动不闪 idle');
  {
    const w = loadRenderer(['shared/i18n.js', 'renderer/pet.js']);
    w.handlers.config({ skin: 'cat', muted: true });
    // 模拟 init 拿到快照（getStats stub 返回 null，这里直接补推快照 + 确认不被覆盖）
    w.handlers.stats(baseStats({ workingCount: 1 }));
    await sleep(30); // 让 init 的 async IIFE 走完（getStats→null→setState('idle') 只在无快照时）
    const cat = w.elements('cat');
    check('有快照时状态保持 working', () => assert(cat.classList.contains('working')));
  }

  console.log('[R10] working/thinking 多姿态轮换');
  {
    const w = world();
    const WPOOL = ['cat-working.gif', 'cat-working-2.gif', 'cat-working-3.gif', 'cat-working-4.gif'];
    const TPOOL = ['cat-thinking.gif', 'cat-thinking-2.gif'];
    w.handlers.stats(baseStats({ workingCount: 1 }));
    const first = catSrc(w).split('/').pop();
    check('working 显示轮换池素材', () => assert(WPOOL.includes(first)));
    w.handlers.stats(baseStats({ idleMs: 1000 }));           // 离开 working
    w.handlers.stats(baseStats({ workingCount: 1 }));        // 再次进入
    const second = catSrc(w).split('/').pop();
    check('再次进入 working 轮换到下一张', () => {
      assert(WPOOL.includes(second));
      assert.notStrictEqual(second, first);
    });
    w.handlers.stats(baseStats({ thinkingCount: 1 }));       // 切到 thinking
    check('thinking 显示思考轮换池素材', () => assert(TPOOL.includes(catSrc(w).split('/').pop())));
    // loafing 摸鱼：工具间隙，优先级低于 thinking、高于 idle
    const LPOOL = ['cat-loafing.gif', 'cat-loafing-2.gif', 'cat-loafing-3.gif'];
    w.handlers.stats(baseStats({ loafingCount: 1 }));
    check('loafing 显示摸鱼轮换池素材', () => assert(LPOOL.includes(catSrc(w).split('/').pop())));
    w.handlers.stats(baseStats({ loafingCount: 1, thinkingCount: 1 }));
    check('thinking > loafing', () => assert(w.elements('cat').classList.contains('thinking')));
    w.handlers.stats(baseStats({ loafingCount: 1, workingCount: 1 }));
    check('working > loafing', () => assert(w.elements('cat').classList.contains('working')));
  }

  console.log('[R11] 青蛙旅行视觉层');
  {
    const w = world();
    const activeTravel = {
      active: {
        id: 'trip-1', agent: 'claude', project: 'p', mission: '只读侦察',
        status: 'traveling', startedAt: Date.now(),
      },
      latest: null,
      growth: { totalTokens: 0, completed: 0, rank: {} },
      templates: [],
    };
    w.handlers.stats(baseStats({ workingCount: 2, travel: activeTravel }));
    check('旅行中覆盖普通 working，显示 roam 素材', () => {
      assert(w.elements('cat').classList.contains('roam'));
      assert(catSrc(w).endsWith('cat-roam.gif'));
    });
    w.handlers.stats(baseStats({ needsinputCount: 1, workingCount: 2, travel: activeTravel }));
    check('待用户回复仍高于旅行视觉', () => assert(w.elements('cat').classList.contains('needsinput')));
    w.handlers.travel({
      type: 'completed',
      trip: { id: 'trip-1', agent: 'claude', result: 'postcard', usage: { tokens: 10000 } },
      state: { active: null, latest: null, growth: { totalTokens: 10000, completed: 1, rank: { leaf: 1 } }, templates: [] },
    });
    check('旅行归来进入 happy 庆祝', () => assert(w.elements('cat').classList.contains('happy')));
  }

  console.log('[R10b] 鲸鱼女仆皮肤状态与领地动画');
  {
    const w = world();
    w.handlers.config({ skin: 'whale', muted: true });
    w.handlers.stats(baseStats({ workingCount: 1 }));
    check('whale working 使用鲸鱼素材', () => {
      assert(catSrc(w).endsWith('/whale/whale-working.gif'));
    });
    w.handlers.event({ kind: 'loot', phase: 'kick', direction: -1 });
    check('whale 出脚重播不会串回月薪喵素材', () => {
      assert(/\/whale\/whale-idle\.gif\?loot-kick=\d+$/.test(catSrc(w)));
      assert(!catSrc(w).includes('/cat/'));
    });
  }

  console.log('[R12] 旅行授权使用稳定的来信卡片');
  {
    const w = world();
    w.handlers.stats(baseStats({
      waitingCount: 1,
      sessions: [{
        sessionId: 'travel-mailbox',
        agent: 'claude',
        state: 'waiting',
        reason: 'perm',
        headless: false,
        sessionRole: 'travel',
        choice: {
          kind: 'perm',
          sessionId: 'travel-mailbox',
          permId: 'travel-perm',
          project: 'Claude 旅行信箱',
          header: 'Claude 猫猫在路上',
          question: '它想继续赶路，需要：联网搜索',
          options: [
            { label: '这次放行', key: 'allow' },
            { label: '以后旅行联网都放行', key: 'travel:always-web' },
            { label: '不去了', key: 'deny' },
          ],
          travel: true,
        },
      }],
    }));
    check('旅行来信保持在 ask 面板而不是闪退', () => {
      assert(!w.elements('ask').classList.contains('hidden'));
      assert(w.elements('ask').classList.contains('travel-letter'));
      assert.strictEqual(w.elements('ask-label').textContent, '✉️ 旅行来信');
    });
    check('旅行来信提供专属终端入口', () => {
      assert.strictEqual(w.elements('ask-term').textContent, '💬 去旅行终端看看');
    });

    const w2 = world();
    w2.handlers.stats(baseStats({
      sessions: [{ sessionId: 'ordinary', agent: 'codex', project: '普通任务', state: 'idle', headless: false }],
    }));
    const pet = w2.elements('cat');
    pet.dispatch('pointerdown', { button: 0, pointerId: 1, screenX: 0, screenY: 0 });
    pet.dispatch('pointerup', { pointerId: 1 });
    w2.handlers.stats(baseStats({
      waitingCount: 1,
      sessions: [{
        sessionId: 'background-choice',
        agent: 'codex',
        project: '后台任务',
        state: 'waiting',
        headless: false,
        choice: {
          kind: 'continue',
          sessionId: 'background-choice',
          project: '后台任务',
          question: '继续吗？',
          options: [{ label: '继续', key: 'continue' }],
        },
      }],
    }));
    check('后台授权快照不会闪关用户打开的会话面板', () => {
      assert(!w2.elements('sesslist').classList.contains('hidden'));
      assert(w2.elements('ask').classList.contains('hidden'));
    });
  }

  console.log('[R13] 旅行会话独立列表 + 字符画明信片');
  {
    const w = world();
    w.window.pet.getTravel = () => Promise.resolve({
      active: null,
      latest: null,
      growth: { totalTokens: 12000, completed: 1, rank: { units: 1, leaf: 1 } },
      templates: [],
    });
    w.window.pet.getTravelPostcards = () => Promise.resolve([{
      id: 'postcard-1',
      agent: 'codex',
      project: '地球怪角落',
      status: 'completed',
      result: [
        '这趟我去了四个完全不同的地方。',
        '',
        '第一站｜珠穆朗玛峰',
        '我沿着雪线走到很高的山脊，看见了很小的营地。',
        '',
        '第二站｜纳米布沙漠',
        '我在沙丘之间找到了会出生也会消失的仙女圈。',
        '',
        '可第三站一挖到地下，是白蚁巢。',
        '',
        '偏偏一条线索又把我带去了第四站——澳大利亚皮尔巴拉。',
      ].join('\n'),
      usage: { tokens: 12000 },
    }]);
    w.handlers.stats(baseStats({
      machineGrowth: {
        totalTokens: 8970000000,
        claudeTokens: 6980000000,
        codexTokens: 1990000000,
        rank: {
          unitTokens: 10000000,
          units: 897,
          crown: 3,
          sun: 2,
          moon: 0,
          star: 0,
          leaf: 1,
          progressTokens: 0,
          nextTokens: 10000000,
        },
      },
      sessions: [
        { sessionId: 'ordinary', agent: 'claude', project: '普通任务', state: 'idle', headless: false },
        {
          sessionId: 'travel-mailbox',
          agent: 'codex',
          travelAgent: 'codex',
          project: 'Codex 旅行信箱',
          state: 'idle',
          headless: false,
          sessionRole: 'travel',
        },
      ],
    }));
    const cat = w.elements('cat');
    cat.dispatch('pointerdown', { button: 0, pointerId: 1, screenX: 0, screenY: 0 });
    cat.dispatch('pointerup', { pointerId: 1 });
    check('普通任务列表不再混入旅行会话', () => {
      assert.strictEqual(w.elements('sl-rows').children.length, 1);
      const row = w.elements('sl-rows').children[0];
      assert.strictEqual(row._parts.name.textContent, '普通任务');
      assert(!row._parts.name.textContent.includes('旅行信箱'));
    });
    w.elements('sl-travel-inbox').dispatch('click', { stopPropagation() {} });
    await sleep(20);
    check('旅行信箱固定展示 Claude / Codex 两个专属位置', () => {
      assert.strictEqual(w.elements('sl-travel-mailboxes').children.length, 2);
    });
    check('旅行等级与本机累计等级分开计算，且不使用绿色叶片', () => {
      assert.strictEqual(w.elements('sl-travel-rank-icons').textContent, '🐾');
      assert.strictEqual(w.elements('sl-machine-rank-icons').textContent, '👑👑👑 ☀️☀️ 🐾');
      assert(w.elements('sl-machine-rank-meta').textContent.includes('8.97B'));
      assert(w.elements('sl-machine-rank-meta').textContent.includes('Claude 6.98B / Codex 1.99B'));
      assert(!w.elements('sl-travel-rank-icons').textContent.includes('🍃'));
      assert(!w.elements('sl-machine-rank-icons').textContent.includes('🍃'));
    });
    check('旧旅行按站拆成单页卡片，并生成不同地点的字符画', () => {
      const cards = w.elements('sl-travel-stop-track').children;
      assert.strictEqual(cards.length, 4);
      assert(cards[0].classList.contains('active'));
      assert(!cards[1].classList.contains('active'));
      assert(cards[0].innerHTML.includes('珠穆朗玛峰'));
      assert(cards[0].innerHTML.includes('^^^'));
      assert(cards[1].innerHTML.includes('纳米布沙漠'));
      assert(cards[1].innerHTML.includes('--'));
      assert(cards[2].innerHTML.includes('第三站'));
      assert(cards[3].innerHTML.includes('第四站'));
      assert.notStrictEqual(cards[0].innerHTML, cards[1].innerHTML);
      const arts = cards.map((card) => {
        const match = /<pre class="sl-travel-postcard-art">([\s\S]*?)<\/pre>/.exec(card.innerHTML);
        return match ? match[1].replace(/\s+/g, '') : '';
      });
      assert.strictEqual(new Set(arts).size, 4);
      assert(cards.every((card) => card.innerHTML.length < 2300));
    });
    check('左右按钮切换独立站点卡片', () => {
      assert.strictEqual(w.elements('sl-travel-stop-page').textContent, '第 1/4 站');
      w.elements('sl-travel-stop-next').dispatch('click', { stopPropagation() {} });
      assert.strictEqual(w.elements('sl-travel-stop-page').textContent, '第 2/4 站');
      const cards = w.elements('sl-travel-stop-track').children;
      assert(!cards[0].classList.contains('active'));
      assert(cards[1].classList.contains('active'));
    });
    w.handlers.travel({
      type: 'failed',
      trip: {
        id: 'failed-trip',
        agent: 'claude',
        status: 'failed',
        error: 'Visible wander closed before returning a message.',
        usage: { tokens: 0 },
      },
      state: {
        active: null,
        latest: {
          id: 'failed-trip',
          agent: 'claude',
          status: 'failed',
          error: 'Visible wander closed before returning a message.',
        },
        growth: { totalTokens: 12000, completed: 1, failed: 1, rank: { leaf: 1 } },
        templates: [],
      },
    });
    check('失败或取消的旅行不被包装成明信片', () => {
      assert.strictEqual(w.elements('sl-travel-history').children.length, 1);
      assert(!w.elements('sl-travel-stop-track').innerHTML.includes('Visible wander closed'));
    });
  }

  console.log('[R14] Codex 选择对话镜像');
  {
    const w = world();
    const choice = {
      kind: 'codex-ask', requestId: 'call-r14', externalOnly: true,
      sessionId: 'codex-session-r14', project: 'LLMPET', header: '方案',
      question: '你要用哪一个方案？',
      questions: [{
        header: '方案', question: '你要用哪一个方案？',
        options: [{ label: 'A', description: '保守' }, { label: 'B', description: '激进' }],
      }],
      options: [{ label: 'A', desc: '保守' }, { label: 'B', desc: '激进' }],
      allowInput: true,
    };
    w.handlers.stats(baseStats({
      needsinputCount: 1,
      sessions: [{ sessionId: choice.sessionId, project: 'LLMPET', agent: 'codex', state: 'needsinput', choice }],
    }));
    check('Codex 真实问题出现在 LLMPET 问答面板', () => {
      assert.strictEqual(w.elements('ask-q').textContent, '你要用哪一个方案？');
      assert.strictEqual(w.elements('ask-opts').children.length, 2);
      assert.strictEqual(w.elements('ask-term').textContent, '💬 去 Codex 选择');
    });
    w.elements('ask-term').dispatch('click');
    check('点击后按 session ID 打开 Codex，不伪造 permission 回答', () => {
      assert(w.calls.some((c) => c[0] === 'focusSession' && c[1][0] === 'codex-session-r14'));
      assert(!w.calls.some((c) => c[0] === 'decidePermission'));
    });
    w.handlers.stats(baseStats({ needsinputCount: 0, sessions: [] }));
    check('Codex 继续后选择卡从快照中消失', () => assert(w.elements('ask').classList.contains('hidden')));
  }

  console.log(`\n${failures === 0 ? '✅ RENDERER ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
