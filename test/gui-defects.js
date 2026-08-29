'use strict';

// GUI defect regression suite — drives the REAL renderer/pet.js headless via
// test/dom-stub.js. Each group pins one defect found in the round-3 GUI audit:
//
//   G1  ask-card i18n: label / submit / "Other" used to be hardcoded English,
//       so a Japanese UI rendered a mixed-language card (needsInput label,
//       Next/Submit button, Other option all bypassed the dictionary).
//   G2  placeholder leak: a plan card sets a reject-feedback placeholder; the
//       next elicitation card must reset it, not inherit "打回让 Claude 改…".
//   G3  radial badges: updateRadialBadge used to align MENU indices with the
//       filtered DOM children — fine only while conditional items stay last.
//       Badges are now tagged on the node itself, so filtering cannot misplace
//       them, and a zero count removes the badge it created.
//   G4  session-list empty state must distinguish "no sessions" from "your
//       search/filter matched nothing".
//   G5  the cat/whale pose-rotation interval must stop when the skin switches
//       away from meme packs (it used to early-return forever, leaking a 60s
//       timer per meme visit for the rest of the app's life).
//
// Run: node test/gui-defects.js

const assert = require('assert');
const vm = require('vm');
const { loadRenderer } = require('./dom-stub');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

function world(lang = 'zh') {
  const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'renderer/pet.js']);
  w.handlers.config({ skin: 'mascot', muted: true, lang });
  return w;
}

function baseStats(over = {}) {
  return {
    today: { cost: 0 }, lifetime: { cost: 0 }, sessions: [], bg: { zombie: 0 },
    waitingCount: 0, needsinputCount: 0, workingCount: 0, jugglingCount: 0,
    sweepingCount: 0, thinkingCount: 0, loafingCount: 0, errorCount: 0, idleMs: 1000,
    ...over,
  };
}

const run = (w, code) => vm.runInContext(code, w.sandbox, { filename: 'drive' });

function main() {
  console.log('[G1] ask 卡片 i18n（ja）');
  {
    const w = world('ja');
    run(w, `
      enqueueChoice({
        kind: 'ask', sessionId: 's1', permId: 'p1', project: 'P', allowInput: true,
        options: [{ label: 'A' }, { label: 'B' }],
        questions: [
          { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Q2', options: [{ label: 'C' }] },
        ],
      });
    `);
    check('标签走 i18n（入力が必要）', () => {
      assert.strictEqual(w.elements('ask-label').textContent, '入力が必要');
    });
    check('非末题按钮是「次へ ›」', () => {
      assert.strictEqual(w.elements('ask-submit').textContent, '次へ ›');
    });
    check('Other 选项卡本地化（その他）', () => {
      const opts = w.elements('ask-opts');
      const other = opts.children[opts.children.length - 1];
      assert.ok(other._innerHTML.includes('その他'), `got: ${other._innerHTML}`);
    });
    check('末题按钮是「回答を送信」', () => {
      run(w, 'elic.qIdx = 1; renderElicitation(askQueue[askIdx]);');
      assert.strictEqual(w.elements('ask-submit').textContent, '回答を送信');
    });
    check('zh 语言的 Other/Next 保持英文（上游惯例）', () => {
      const wz = world('zh');
      run(wz, `
        enqueueChoice({
          kind: 'ask', sessionId: 's1', permId: 'p1', project: 'P', allowInput: true,
          options: [{ label: 'A' }],
          questions: [{ question: 'Q', options: [{ label: 'A' }] }, { question: 'Q2', options: [{ label: 'B' }] }],
        });
      `);
      assert.strictEqual(wz.elements('ask-submit').textContent, 'Next ›');
      const opts = wz.elements('ask-opts');
      assert.ok(opts.children[opts.children.length - 1]._innerHTML.includes('Other'));
    });
  }

  console.log('[G2] plan 卡片 placeholder 不泄漏到下一张卡');
  {
    const w = world('zh');
    run(w, `
      askQueue = [{ kind: 'plan', permId: 'p2', project: 'P', question: '方案?' }];
      askIdx = 0; elic = null; showAskPanel();
    `);
    check('plan 卡设置打回意见 placeholder', () => {
      assert.ok(w.elements('ask-text').placeholder.includes('打回'), w.elements('ask-text').placeholder);
    });
    run(w, `
      askQueue = [{
        kind: 'ask', sessionId: 's2', permId: 'p3', project: 'P', allowInput: true,
        options: [{ label: 'A' }],
        questions: [{ question: 'Q', options: [{ label: 'A' }] }],
      }];
      askIdx = 0; showAskPanel();
    `);
    check('elicitation 卡复位为通用输入 placeholder', () => {
      assert.ok(w.elements('ask-text').placeholder.includes('自定义'), w.elements('ask-text').placeholder);
    });
    check('dataset.ph 缓存一并复位', () => {
      assert.strictEqual(w.elements('ask-text').dataset.ph, undefined);
    });
  }

  console.log('[G3] 径向菜单徽标：节点自带种别，过滤不错位');
  {
    const w = world('zh');
    // Non-mac platform filters loot+patrol out of the menu; badges must still
    // land on the right buttons because the kind is tagged on each node.
    run(w, 'lastWaiting = 2; buildRadial();');
    const radial = w.elements('radial');
    const pending = radial.children.find((n) => n._badgeKind === 'pending');
    const bg = radial.children.find((n) => n._badgeKind === 'bg');
    const plain = radial.children.find((n) => !n._badgeKind);
    check('徽标种别已打在节点上', () => {
      assert.ok(pending && bg && plain, `children=${radial.children.length}`);
    });
    check('初始徽标随菜单构建并挂到正确节点', () => {
      assert.ok(pending._badgeEl, 'pending badge appended at build time');
      assert.strictEqual(String(pending._badgeEl.textContent), '2');
      assert.strictEqual(plain._badgeEl, undefined);
    });
    check('stats 推送更新 pending 徽标数字', () => {
      run(w, 'radialOpen = true;');
      w.handlers.stats(baseStats({ waitingCount: 3 }));
      assert.strictEqual(String(pending._badgeEl.textContent), '3');
    });
    check('计数归零时移除徽标', () => {
      // 先取引用再清零：清零后 children.includes(_badgeEl) 恒真断言无效
      // （评审发现的变异逃逸——删掉 remove() 只留置 null 曾全部通过）。
      const badge = pending._badgeEl;
      run(w, 'lastWaiting = 0; updateRadialBadge();');
      assert.strictEqual(pending._badgeEl, null);
      assert.strictEqual(pending.children.includes(badge), false);
    });
    check('僵尸徽标走 bg 通道', () => {
      run(w, 'lastBgZombie = 4; updateRadialBadge();');
      assert.ok(bg._badgeEl, 'bg badge created');
      assert.strictEqual(String(bg._badgeEl.textContent), '4');
    });
  }

  console.log('[G4] 会话列表空态区分「无会话」与「无匹配」');
  {
    const w = world('zh');
    w.handlers.stats(baseStats({
      sessions: [{ project: 'alpha', agent: 'claude', state: 'working', sessionId: 's1' }],
    }));
    run(w, 'openSessList();');
    check('有会话时渲染会话行（非空态）', () => {
      const rows = w.elements('sl-rows');
      assert.ok(rows.children.length > 0, 'one session row renders');
      assert.ok(!rows.children[0].classList.contains('sl-empty'));
    });
    run(w, 'sessionSearch = "zzz"; renderSessList();');
    check('搜索无结果显示“没有匹配”', () => {
      const rows = w.elements('sl-rows');
      assert.strictEqual(rows.children.length, 1);
      assert.ok(rows.children[0].classList.contains('sl-empty'));
      assert.ok(rows.children[0].textContent.includes('匹配'), rows.children[0].textContent);
    });
    run(w, 'sessionSearch = ""; sessionFilter = "codex"; renderSessList();');
    check('来源筛选无结果也提示调整筛选', () => {
      const rows = w.elements('sl-rows');
      assert.ok(rows.children[0].textContent.includes('匹配'), rows.children[0].textContent);
    });
    run(w, 'sessionFilter = "all"; renderSessList();');
    check('清空筛选恢复会话行', () => {
      assert.ok(!w.elements('sl-rows').children[0].classList.contains('sl-empty'));
    });
    run(w, 'showArchived = true; renderSessList();');
    check('归档视图无归档会话也提示调整筛选', () => {
      const rows = w.elements('sl-rows');
      assert.ok(rows.children[0].textContent.includes('匹配'), rows.children[0].textContent);
    });
    const we = world('zh');
    we.handlers.stats(baseStats({ sessions: [] }));
    run(we, 'openSessList();');
    check('真正无会话时显示「暂无活跃会话」', () => {
      const rows = we.elements('sl-rows');
      assert.strictEqual(rows.children.length, 1);
      assert.ok(rows.children[0].classList.contains('sl-empty'));
      assert.ok(rows.children[0].textContent.includes('暂无活跃会话'), rows.children[0].textContent);
    });
  }

  console.log('[G5] 离开 meme 皮肤时停掉姿态轮换定时器');
  {
    const w = world('zh');
    w.handlers.config({ skin: 'cat', muted: true });
    w.handlers.stats(baseStats({ workingCount: 1 }));
    check('cat 皮肤 + working 进入轮换（定时器存在）', () => {
      assert.ok(run(w, '!!poolRot'));
    });
    w.handlers.config({ skin: 'mascot', muted: true });
    check('切回 mascot 后轮换定时器被清除', () => {
      assert.strictEqual(run(w, '!!poolRot'), false);
    });
    w.handlers.config({ skin: 'whale', muted: true });
    w.handlers.stats(baseStats({ workingCount: 1 }));
    check('whale 重新进入轮换', () => {
      assert.ok(run(w, '!!poolRot'));
    });
    w.handlers.config({ skin: 'mascot', muted: true });
    check('再次离开也清除', () => {
      assert.strictEqual(run(w, '!!poolRot'), false);
    });
  }

  if (failures) {
    console.error(`\n${failures} GUI defect check(s) failed`);
    process.exit(1);
  }
  // The renderer keeps long-lived timers (blink, visual-bounds fallback);
  // exit explicitly like the other renderer suites.
  console.log('\nGUI defect checks passed');
  process.exit(0);
}

main();
