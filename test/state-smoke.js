'use strict';

// Renderer state-machine smoke test — loads the REAL renderer/pet.js headless
// (test/dom-stub.js) and drives it with synthetic pet:stats / pet:event traffic.
// Covers the bug class「状态被秒盖 / 闪烁 / 卡死 / class 泄漏 / 素材不可达」.
// Run: node test/state-smoke.js

const assert = require('assert');
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
    today: { cost: 0 }, window5h: { cost: 0 }, sessions: [], bg: { zombie: 0 },
    waitingCount: 0, needsinputCount: 0, workingCount: 0, jugglingCount: 0,
    sweepingCount: 0, thinkingCount: 0, loafingCount: 0, errorCount: 0, idleMs: 1000,
    ...over,
  };
}

function world() {
  const w = loadRenderer(['shared/states.js', 'renderer/pet.js']);
  w.handlers.config({ skin: 'cat', muted: true }); // muted: 免声音路径干扰
  return w;
}
const stateClasses = (el) => el.classList.list.filter((c) => STATE_WORDS.includes(c));
const catSrc = (w) => w.elements('cat-img').getAttribute('src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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
    check('transient 存续期 operation 不盖 thinking', () => assert(cat.classList.contains('thinking')));
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
    const w = loadRenderer(['renderer/pet.js']);
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

  console.log(`\n${failures === 0 ? '✅ RENDERER ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
