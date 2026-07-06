'use strict';

const stage = document.getElementById('stage');
const pixel = document.getElementById('pixel');
const mascot = document.getElementById('mascot');
const mascotImg = document.getElementById('mascot-img');
const cat = document.getElementById('cat');

// 图标款按状态换眼神（每种状态一张只改眼睛的图）
const MASCOT_EYES = {
  working: 'mascot-work.png', // 干活：对着笔记本敲代码 + 咖啡（整幅工作场景）
  juggling: 'mascot-work.png', // 并行子任务：无独立图，回落到干活
  sweeping: 'mascot-work.png', // 清理上下文：无独立图，回落到干活
  loafing: 'mascot-sleep.png', // 间隙摸鱼：无独立图，回落到闭眼待机
  idle: 'mascot-sleep.png',   // 无任务：闭眼
  sleeping: 'mascot-sleep.png',
  thinking: 'mascot-think.png', // 思考：往上看
  happy: 'mascot-happy.png',  // 完成：^^ 笑眼
  greet: 'mascot-happy.png',
  talking: 'mascot-happy.png',
  waiting: 'mascot-wait.png', // 等你处理：瞪大
  needsinput: 'mascot-think.png', // 等你回复：往上看(期待)
  error: 'mascot-wait.png',
  // 情绪短暂态 → 就近回落（专属图未画）
  loved: 'mascot-happy.png',
  excited: 'mascot-happy.png',
  sad: 'mascot-wait.png',
  sorry: 'mascot-wait.png',
  puzzled: 'mascot-think.png',
};
function updateMascotEyes(s) {
  if (!mascotImg) return;
  const f = MASCOT_EYES[s] || 'mascot.png';
  if (!mascotImg.getAttribute('src').endsWith(f)) mascotImg.src = '../assets/' + f;
}

// 月薪喵（cat）：每个状态一张 meme GIF（原作者：抖音 @月薪喵）
const catImg = document.getElementById('cat-img');
const CAT_STATES = {
  idle: 'cat-idle.gif',           // 转椅上冰淇淋+手机摸鱼：待命
  roam: 'cat-roam.gif',           // 撒腿跑着玩：闲逛
  working: 'cat-working.gif',     // 戴耳机猛拍「上号」按钮：干活
  thinking: 'cat-thinking.gif',   // 对着笔记本挠头：思考
  talking: 'cat-talking.gif',     // 对着笔记本疯狂输出喵喵喵：回应中
  juggling: 'cat-juggling.gif',   // 趴键盘上还同时刷手机：并行子任务
  sweeping: 'cat-sweeping.gif',   // 喷消毒水打扫：压缩/清理
  waiting: 'cat-waiting.gif',     // 冒汗紧张等待：等你授权
  needsinput: 'cat-needsinput.gif', // 头顶冒问号挠头：等你回复
  happy: 'cat-happy.gif',         // 摸小猫的头夸夸：完成庆祝
  greet: 'cat-greet.gif',         // 被闹钟炸醒弹射到工位：新会话火速上线
  attention: 'cat-attention.gif', // 从工位起身够手机看消息：需要注意
  sleeping: 'cat-sleeping.gif',   // 被窝里睡成一坨：睡觉
  error: 'cat-error.gif',         // 抱头崩溃大叫：出错
  loafing: 'cat-loafing.gif',     // 躺地上刷手机：上一步干完、等下一步的间隙摸鱼
  // 情绪短暂态 → 就近映射，别回落到摸鱼 idle 图（表情和文案会打架）
  loved: 'cat-happy.gif',         // 被夸 → 摸头开心
  excited: 'cat-happy.gif',
  sad: 'cat-sad.gif',             // 惹你生气了 → 嚎啕大哭
  sorry: 'cat-waiting.gif',       // 道歉 → 冒冷汗心虚
  puzzled: 'cat-needsinput.gif',  // 疑惑 → 头顶问号
};
// working/thinking 是停留最久的两个状态 → 多张姿态轮换：进入时换下一张，
// 持续期间每 60s 也换一张。大上下文会话推理一次要几分钟，单张静止图
// 播几分钟观感像卡死，轮换让「还活着」看得见。
const CAT_POOLS = {
  working: [
    'cat-working.gif',   // 猛拍「上号」按钮
    'cat-working-2.gif', // 熬夜冠军：戴耳机对着显示器
    'cat-working-3.gif', // 捂着耳朵埋头猛敲键盘
    'cat-working-4.gif', // 边吃零食边敲键盘
  ],
  thinking: [
    'cat-thinking.gif',   // 对着笔记本挠头
    'cat-thinking-2.gif', // 躺着想：头顶「浮云」思考泡
  ],
  sleeping: [
    'cat-sleeping.gif',   // 被窝里睡成一坨
    'cat-sleeping-2.gif', // 坐椅子上拔下肚子毛当眼罩睡
  ],
  loafing: [
    'cat-loafing.gif',   // 躺地上刷手机
    'cat-loafing-2.gif', // 沙发上点外卖
    'cat-loafing-3.gif', // 靠着枕头奶瓶+手机
  ],
};
const POOL_ROTATE_MS = 60 * 1000;
let poolIdx = 0;
let poolRot = null;
function updateCat(s) {
  if (!catImg) return;
  const pool = CAT_POOLS[s];
  const f = pool ? pool[poolIdx % pool.length] : (CAT_STATES[s] || CAT_STATES.idle);
  if (!catImg.getAttribute('src').endsWith(f)) catImg.src = '../assets/cat/' + f;
  if (pool) {
    if (!poolRot) {
      poolRot = setInterval(() => {
        const cur = CAT_POOLS[state];
        if (!cur || skin !== 'cat') return;
        poolIdx++;
        catImg.src = '../assets/cat/' + cur[poolIdx % cur.length];
      }, POOL_ROTATE_MS);
    }
  } else if (poolRot) {
    clearInterval(poolRot);
    poolRot = null;
    poolIdx++; // 下次进入轮换态直接是下一张
  }
}
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const chipCost = document.getElementById('chip-cost');
const chipWindow = document.getElementById('chip-window');
const chip = document.getElementById('chip');
const sessionsEl = document.getElementById('sessions');
const radial = document.getElementById('radial');
const thinkEl = document.getElementById('think');
const sleepEl = document.getElementById('sleep');
const propEl = document.getElementById('prop');
const sidekickEl = document.getElementById('sidekick');
const askEl = document.getElementById('ask');
const askLabel = document.getElementById('ask-label');
const askSess = document.getElementById('ask-sess');
const askQhead = document.getElementById('ask-qhead');
const askQ = document.getElementById('ask-q');
const askHint = document.getElementById('ask-hint');
const askOpts = document.getElementById('ask-opts');
const askInputRow = document.getElementById('ask-input-row'); // .ask-other
const askText = document.getElementById('ask-text');
const askPage = document.getElementById('ask-page');
const askFoot = document.getElementById('ask-foot');
const askSubmit = document.getElementById('ask-submit');
const askBack = document.getElementById('ask-back');
const askTerm = document.getElementById('ask-term');
const notepad = document.getElementById('notepad');
const npBadge = document.getElementById('np-badge');
const todopop = document.getElementById('todopop');
const tpProg = document.getElementById('tp-prog');
const tpList = document.getElementById('tp-list');
const tpActs = document.getElementById('tp-acts');
const tpActSec = document.getElementById('tp-act-sec');
const tpTodoSec = document.getElementById('tp-todo-sec');
const sesslist = document.getElementById('sesslist');
const slRows = document.getElementById('sl-rows');
const slSub = document.getElementById('sl-sub');

let askActive = false;
let askQueue = []; // 当前所有待处理的选择/输入（每项含 project）
let askIdx = 0;
let lastAskSig = ''; // 当前面板内容签名，避免每 2s 重渲冲掉用户输入
const answered = new Set(); // 已答的 key，避免快照延迟导致重弹
let askHover = false; // 鼠标在选项面板上
let elic = null;      // elicitation 渲染态：{ key, questions, qIdx, answers, selected }
// 面板开着、且(鼠标在面板上 / 输入框聚焦/有草稿 / 已选了选项) = 交互中：
// 此时别重渲面板、别改小章鱼状态，免得打断你思考/选择。面板一关就自动解除。
const isInteracting = () => askActive && (askHover || document.activeElement === askText || !!(askText && askText.value) || (elic && elic.selected != null));

const rlog = (tag, msg) => { try { window.pet.petLog(tag, msg); } catch {} }; // 把 UI 决策写日志，便于自检
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 带上 sessionId：否则同一项目下两个并行会话若问了同样的问题，会共用一个 key，
// 答掉一个就把另一个也标记成 answered 吞掉。choice 各构造处都带 sessionId。
const choiceKey = (c) => (c && (c.sessionId || '') + '|' + (c.project || '') + '|' + (c.question || '')) || '';

// 动态定高：弹层贴 pet 上方(bottom:200)，把窗口高度调到刚好容纳内容，
// 避免固定大窗口留白 / 顶屏被下移。w=440 让会话名有地方换行不截断。
const POPUP_W = 440;
const POPUP_BOTTOM = 200;
function fitPopup(el) {
  if (!el) return;
  requestAnimationFrame(() => {
    // 关键：先临时去掉 max-height 再量，否则 scrollHeight 会被「当前小窗口算出的
    // max-height」钳住（鸡生蛋问题）→ 窗口永远只长一点点、列表只剩 1 行+滚动条。
    const prev = el.style.maxHeight;
    el.style.maxHeight = 'none';
    const h = el.scrollHeight; // 真实内容高度
    el.style.maxHeight = prev;
    const winH = Math.max(340, POPUP_BOTTOM + h + 24);
    try { window.pet.setPetSize(POPUP_W, winH); } catch {}
  });
}
function resetPetSize() { try { window.pet.setPetSize(0, 0); } catch {} }

// 从快照重建队列（多任务都在、且标明项目）
function refreshAsk(stats) {
  // 记事本行动中心开着时，事项在那里处理，别再另弹选项面板抢窗口
  if (todoPopOpen) { hideAsk(); return; }
  const items = (stats.sessions || [])
    .filter((x) => (x.state === 'waiting' || x.state === 'needsinput') && x.choice)
    .map((x) => x.choice)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
  const present = new Set(items.map(choiceKey));
  for (const k of [...answered]) if (!present.has(k)) answered.delete(k); // 已消失=已答完，清理
  const fresh = items.filter((c) => !answered.has(choiceKey(c)));

  // 你正在答当前卡片、且它后端仍然有效 → 不重渲(保住勾选/输入)，但仍静默对账队列其余项，
  // 这样已解决的卡片不会残留、新卡片不会被你的“交互中”状态永久挡在外面。
  const cur = askActive ? askQueue[askIdx] : null;
  if (isInteracting() && cur && present.has(choiceKey(cur))) {
    askQueue = fresh;
    const i = fresh.findIndex((c) => choiceKey(c) === choiceKey(cur));
    askIdx = i >= 0 ? i : 0;
    return;
  }

  askQueue = fresh;
  if (!askQueue.length) { hideAsk(); return; }
  if (askIdx >= askQueue.length) askIdx = 0;
  const sig = askQueue.map(choiceKey).join(',');
  if (askActive && sig === lastAskSig) return; // 内容没变，别重渲（保住正在输入/勾选的）
  lastAskSig = sig;
  showAskPanel();
}

function enqueueChoice(c) {
  if (!c || (!(c.options && c.options.length) && !c.allowInput)) return;
  answered.delete(choiceKey(c));
  const i = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  if (i < 0) askQueue.push(c);
  // 记事本行动中心开着 → 新事项在那里显示，不另弹面板
  if (todoPopOpen) { renderTodoPop(); return; }
  // 你正在答当前面板时，新任务先进队列、不抢面板（等你答完再显示），避免打断
  if (isInteracting() && askActive) return;
  askIdx = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  showAskPanel();
}

function showAskPanel() {
  const c = askQueue[askIdx];
  if (!c) { hideAsk(); return; }
  if (sessListOpen) closeSessList(); // 卡片优先于会话列表

  const sess = c.sessionId ? ' · #' + String(c.sessionId).slice(-3) : '';
  askSess.textContent = (c.project || '?') + sess;

  if (c.kind === 'ask') {
    if (!elic || elic.key !== choiceKey(c)) {
      elic = { key: choiceKey(c), questions: Array.isArray(c.questions) ? c.questions : [], qIdx: 0, answers: {}, selected: null, selSet: [], multi: false, otherOn: false };
    }
    renderElicitation(c);
  } else {
    elic = null;
    if (c.kind === 'perm' && c.permId) renderPerm(c);
    else if (c.kind === 'plan' && c.permId) renderPlan(c);
    else renderContinue(c);
  }

  bubble.classList.add('hidden');
  askEl.classList.remove('hidden');
  lastAskSig = askQueue.map(choiceKey).join(',');
  askActive = true;
  rlog('ask', 'show ' + (c.kind || '') + ': ' + String(c.question || '').slice(0, 36));
  fitPopup(askEl); // 富卡片：动态定高 + 440 宽
}

function clearAskBody() {
  askOpts.innerHTML = '';
  askOpts.classList.remove('perm-row');
  askQhead.textContent = '';
  askHint.textContent = '';
  askPage.textContent = '';
  askInputRow.classList.add('hidden');
  askText.value = '';
}

// ① elicitation（AskUserQuestion）：多选项卡 + Other + 分页 + Submit/Back
function renderElicitation(c) {
  clearAskBody();
  askLabel.textContent = 'Needs Input';
  const qs = elic.questions;
  const q = qs[elic.qIdx] ||
    { question: c.question || '需要你回答', options: (c.options || []).map((o) => ({ label: o.label, description: o.desc })) };
  askQhead.textContent = q.header || '';
  askQ.textContent = q.question || '';
  const multi = !!q.multiSelect;
  elic.multi = multi;
  askHint.textContent = multi ? '可多选（点选多个）' : 'Choose one option';

  const prior = elic.answers[q.question];
  const opts = q.options || [];
  const known = (v) => opts.some((o) => o.label === v);
  if (multi) {
    const parts = prior ? String(prior).split(/,\s*/).filter(Boolean) : [];
    elic.selSet = parts.filter(known);
    const otherText = parts.find((p) => !known(p));
    elic.otherOn = !!otherText;
    elic.selected = null;
    if (otherText) askText.value = otherText;
  } else {
    elic.selSet = [];
    elic.otherOn = false;
    elic.selected = prior != null ? (known(prior) ? prior : '__other__') : null;
  }

  for (const o of opts) askOpts.appendChild(buildRadioCard(o.label, o.description, o.label, q));
  askOpts.appendChild(buildRadioCard('Other', '', '__other__', q));
  if (elic.selected === '__other__' || (multi && elic.otherOn)) {
    askInputRow.classList.remove('hidden');
    if (!multi && prior && !known(prior)) askText.value = prior;
  }

  askPage.textContent = `${elic.qIdx + 1} / ${qs.length || 1}`;
  askFoot.classList.remove('hidden');
  const last = elic.qIdx >= (qs.length || 1) - 1;
  askSubmit.textContent = last ? 'Submit Answer' : 'Next ›';
  askBack.classList.toggle('hidden', elic.qIdx === 0);
  askTerm.classList.remove('hidden');
  updateSubmitEnabled(q);
  fitPopup(askEl); // 题目切换后内容高度变了，重新定高
}

function buildRadioCard(label, desc, value, q) {
  const multi = elic.multi;
  const isSel = multi ? (value === '__other__' ? elic.otherOn : elic.selSet.includes(value)) : elic.selected === value;
  const card = document.createElement('button');
  card.className = 'ask-opt' + (multi ? ' multi' : '') + (isSel ? ' sel' : '');
  card.innerHTML =
    '<span class="ask-radio"></span><span class="ask-ot">' +
    `<span class="ask-ol">${esc(label)}</span>` + (desc ? `<span class="ask-od">${esc(desc)}</span>` : '') +
    '</span>';
  card.addEventListener('click', () => {
    if (multi) {
      if (value === '__other__') {
        elic.otherOn = !elic.otherOn;
        card.classList.toggle('sel', elic.otherOn);
        askInputRow.classList.toggle('hidden', !elic.otherOn);
        if (elic.otherOn) setTimeout(() => askText.focus(), 0);
      } else {
        const i = elic.selSet.indexOf(value);
        if (i >= 0) elic.selSet.splice(i, 1); else elic.selSet.push(value);
        card.classList.toggle('sel');
      }
    } else {
      elic.selected = value;
      askInputRow.classList.toggle('hidden', value !== '__other__');
      if (value === '__other__') setTimeout(() => askText.focus(), 0);
      [...askOpts.children].forEach((el) => el.classList.remove('sel'));
      card.classList.add('sel');
    }
    updateSubmitEnabled(q);
  });
  return card;
}

function updateSubmitEnabled() {
  let ok;
  if (elic && elic.multi) ok = elic.selSet.length > 0 || (elic.otherOn && (askText.value || '').trim());
  else ok = elic && elic.selected && (elic.selected !== '__other__' || (askText.value || '').trim());
  askSubmit.classList.toggle('disabled', !ok);
}

// 自定义输入为空时按回车：不发送，抖一下 + 提示别忘了填（2.6s 后复原 placeholder）
let emptyWarnTimer = null;
function warnEmptyInput() {
  askText.focus();
  askText.classList.add('warn');
  if (!askText.dataset.ph) askText.dataset.ph = askText.placeholder || '输入自定义回答…';
  askText.placeholder = '⚠️ 还没输入内容，是不是忘了填？';
  clearTimeout(emptyWarnTimer);
  emptyWarnTimer = setTimeout(() => {
    askText.classList.remove('warn');
    if (askText.dataset.ph) { askText.placeholder = askText.dataset.ph; delete askText.dataset.ph; }
  }, 2600);
}

function elicNextOrSubmit(c) {
  const qs = elic.questions;
  const q = qs[elic.qIdx];
  let val;
  if (elic.multi) {
    const parts = [...elic.selSet];
    if (elic.otherOn && (askText.value || '').trim()) parts.push((askText.value).trim());
    val = parts.join(', ');
  } else {
    val = elic.selected === '__other__' ? (askText.value || '').trim() : elic.selected;
  }
  if (!val) return; // 必须先选/填
  if (q && q.question) elic.answers[q.question] = val;
  else elic.answers[c.question || '_'] = val;
  if (elic.qIdx < (qs.length || 1) - 1) { elic.qIdx++; renderElicitation(c); return; }
  window.pet.decidePermission(c.permId, { type: 'elicitation-submit', answers: { ...elic.answers } });
  rlog('ask', 'elicitation submit ' + Object.keys(elic.answers).length);
  finishChoice(c, '✅ 已提交回答');
}

function elicBack(c) {
  if (elic && elic.qIdx > 0) { elic.qIdx--; renderElicitation(c); }
}

// ② 授权：允许(绿)/拒绝(红) + 可选「始终允许」建议按钮(中性)
function renderPerm(c) {
  clearAskBody();
  askLabel.textContent = '需要授权';
  askQhead.textContent = c.header || '';
  askQ.textContent = c.question || '需要你授权';
  const opts = c.options || [];
  if (opts.length === 2) askOpts.classList.add('perm-row'); // 仅允许/拒绝时并排
  opts.forEach((opt) => {
    const kind = opt.key === 'allow' ? 'allow' : opt.key === 'deny' ? 'deny' : 'sugg';
    const card = document.createElement('button');
    card.className = 'ask-opt act ' + kind;
    card.innerHTML = `<span class="ask-ot"><span class="ask-ol">${esc(opt.label)}</span></span>`;
    card.addEventListener('click', () => submitPerm(opt.key, c, opt.label));
    askOpts.appendChild(card);
  });
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ③ 纯回复（无选项）：只读问题 + Go to Terminal
function renderContinue(c) {
  clearAskBody();
  askLabel.textContent = 'Needs Input';
  askQ.textContent = c.question || 'Claude 在等你回复';
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ④ ExitPlanMode 方案评审：展示方案 + 批准 / 打回并反馈
function renderPlan(c) {
  clearAskBody();
  askLabel.textContent = '方案评审';
  askQhead.textContent = c.project ? '📂 ' + c.project : '';
  askQ.textContent = c.question || '请审阅这个方案';
  const approve = document.createElement('button');
  approve.className = 'ask-opt act allow';
  approve.innerHTML = '<span class="ask-ot"><span class="ask-ol">✅ 批准方案</span></span>';
  approve.addEventListener('click', () => submitPerm('allow', c, '✅ 已批准方案'));
  askOpts.appendChild(approve);
  const reject = document.createElement('button');
  reject.className = 'ask-opt act deny';
  reject.innerHTML = '<span class="ask-ot"><span class="ask-ol">✏️ 打回并反馈</span></span>';
  reject.addEventListener('click', () => {
    window.pet.decidePermission(c.permId, { type: 'plan-feedback', feedback: (askText.value || '').trim() });
    finishChoice(c, '✏️ 已打回方案');
  });
  askOpts.appendChild(reject);
  askInputRow.classList.remove('hidden');
  askText.placeholder = '可写修改意见，打回让 Claude 改…';
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

function finishChoice(choice, bubbleMsg) {
  answered.add(choiceKey(choice));
  elic = null;
  askQueue = askQueue.filter((c) => choiceKey(c) !== choiceKey(choice));
  if (askQueue.length) {
    // 还有下一题：直接展示，不弹确认气泡盖住选项面板
    askIdx = 0; showAskPanel();
  } else {
    // 先关面板（置 askActive=false），确认气泡才不会被 showBubble 的 askActive 早退拦掉
    hideAsk();
    showBubble(bubbleMsg, 2600);
  }
}
function submitPerm(key, choice, label) {
  window.pet.decidePermission(choice.permId, key);
  const msg = key === 'allow' ? '✅ 已允许' : key === 'deny' ? '⛔ 已拒绝' : '🔓 已记住（始终允许）';
  finishChoice(choice, msg);
}
// Go to Terminal：去会话终端自己答（授权/elicitation 都回 deny，让 CC 在终端重问）
function gotoSession(choice) {
  if (choice.permId) window.pet.decidePermission(choice.permId, 'deny');
  window.pet.focusSession(choice.sessionId || '');
  finishChoice(choice, '💬 已带你去终端');
}

function hideAsk() {
  if (askActive) rlog('ask', 'hide');
  lastAskSig = '';
  elic = null;
  askEl.classList.add('hidden');
  askHover = false;
  if (askText) askText.value = ''; // 清掉草稿，避免关闭后仍被判为「交互中」冻住状态
  if (askActive) { askActive = false; resetPetSize(); window.pet.blurPet(); }
}

// ---------- 记事本 / 行动清单 ----------
let curTodos = [];
let curTodosProj = '';
let curSessions = [];
let todoPopOpen = false;
const TODO_ICON = { completed: '✅', in_progress: '▶️', pending: '⬜️' };

// 当前需要你处理的事项：有 choice、还没答过的 waiting/needsinput 会话
function actionableItems() {
  return curSessions
    .filter((x) => (x.state === 'waiting' || x.state === 'needsinput') && x.choice && !answered.has(choiceKey(x.choice)))
    .map((x) => x.choice)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
}

let notepadShown = false;
function updateNotepad(s) {
  curTodos = Array.isArray(s.todos) ? s.todos : [];
  curTodosProj = s.todosProject || '';
  curSessions = s.sessions || [];
  const acts = actionableItems();
  if (!curTodos.length && !acts.length) {
    notepad.classList.add('hidden');
    if (notepadShown) { rlog('notepad', 'hide'); notepadShown = false; }
    if (todoPopOpen) closeTodoPop();
    return;
  }
  notepad.classList.remove('hidden');
  if (!notepadShown) { rlog('notepad', `show acts=${acts.length} todos=${curTodos.length}`); notepadShown = true; }
  if (acts.length) {
    npBadge.textContent = acts.length; // 优先显示「需处理」数
    npBadge.classList.add('urgent');
  } else {
    const done = curTodos.filter((t) => t.status === 'completed').length;
    npBadge.textContent = `${done}/${curTodos.length}`;
    npBadge.classList.remove('urgent');
  }
  // 弹层开着、且用户没在弹层里打字 → 同步刷新内容
  if (todoPopOpen && !todopop.contains(document.activeElement)) { renderTodoPop(); fitPopup(todopop); }
}

function renderTodoPop() {
  const acts = actionableItems();
  const done = curTodos.filter((t) => t.status === 'completed').length;
  tpProg.textContent = curTodos.length ? `待办 ${done}/${curTodos.length}` : '';
  // 需要你处理
  if (acts.length) {
    tpActSec.classList.remove('hidden');
    tpActs.innerHTML = '';
    acts.forEach((c) => tpActs.appendChild(buildActCard(c)));
  } else {
    tpActSec.classList.add('hidden');
    tpActs.innerHTML = '';
  }
  // 待办
  if (curTodos.length) {
    tpTodoSec.classList.remove('hidden');
    tpList.innerHTML = curTodos
      .map((t) => {
        const cls = t.status === 'completed' ? 'tp-row done' : t.status === 'in_progress' ? 'tp-row doing' : 'tp-row';
        return `<div class="${cls}"><span class="ic">${TODO_ICON[t.status] || '⬜️'}</span><span class="tx">${esc(t.content)}</span></div>`;
      })
      .join('');
  } else {
    tpTodoSec.classList.add('hidden');
    tpList.innerHTML = '';
  }
}

// 一张「需要你处理」卡片：问题 + 选项按钮(可点即答) + 自定义输入
function buildActCard(c) {
  const card = document.createElement('div');
  card.className = 'tp-act';
  const kindTag = c.kind === 'perm' ? '授权' : c.kind === 'continue' ? '回复' : c.kind === 'plan' ? '方案' : '选择';
  const head = document.createElement('div');
  head.className = 'tp-act-proj';
  head.textContent = `📂 ${c.project || '?'} · ${kindTag}`;
  card.appendChild(head);
  const q = document.createElement('div');
  q.className = 'tp-act-q';
  q.textContent = (c.header ? '【' + c.header + '】 ' : '') + (c.question || '需要你处理');
  card.appendChild(q);

  const opts = document.createElement('div');
  opts.className = 'tp-act-opts';
  if (c.kind === 'perm' && c.permId) {
    // 授权：允许/拒绝 → HTTP 原生通道回 CC
    (c.options || []).forEach((opt) => {
      const b = document.createElement('button');
      b.textContent = opt.label;
      if (opt.desc) b.title = opt.desc;
      b.addEventListener('click', (e) => { e.stopPropagation(); popPerm(c, opt.key); });
      opts.appendChild(b);
    });
  } else {
    // 对话类：选项只读展示 + 「去回复」按钮（桌宠不替你打字）
    (c.options || []).forEach((opt) => {
      const label = typeof opt === 'string' ? opt : opt.label;
      const desc = typeof opt === 'string' ? '' : opt.desc || '';
      const d = document.createElement('div');
      d.className = 'tp-act-ro';
      d.textContent = label;
      if (desc) d.title = desc;
      opts.appendChild(d);
    });
    const go = document.createElement('button');
    go.className = 'tp-act-go';
    go.textContent = '💬 去这个会话回复 →';
    go.addEventListener('click', (e) => { e.stopPropagation(); popGoto(c); });
    opts.appendChild(go);
  }
  card.appendChild(opts);
  return card;
}

// 授权：回 CC 决策
function popPerm(choice, key) {
  window.pet.decidePermission(choice.permId, key);
  answered.add(choiceKey(choice));
  renderTodoPop();
  maybeCloseEmptyPop();
}
// 对话类：定位并唤起该会话窗口
function popGoto(choice) {
  window.pet.focusSession(choice.sessionId || '');
  answered.add(choiceKey(choice));
  renderTodoPop();
  maybeCloseEmptyPop();
}
function maybeCloseEmptyPop() {
  if (!actionableItems().length && !curTodos.length) closeTodoPop();
}

function openTodoPop() {
  if (askActive) hideAsk(); // 别和选项面板抢窗口
  if (sessListOpen) closeSessList();
  renderTodoPop();
  todopop.classList.remove('hidden');
  todoPopOpen = true;
  rlog('pop', `open acts=${actionableItems().length} todos=${curTodos.length}`);
  fitPopup(todopop);
}
function closeTodoPop() {
  todopop.classList.add('hidden');
  todoPopOpen = false;
  rlog('pop', 'close');
  window.pet.blurPet();
  resetPetSize();
}

// ---------- 会话列表 HUD（左键弹出）----------
let sessListOpen = false;
// Claude 橙色 burst（小图标）
const CLAUDE_ICON =
  '<svg viewBox="0 0 24 24" fill="#d97757"><path d="M12 1l2.2 6.3L20.5 5l-4 5.4 6.5 1.6-6.5 1.6 4 5.4-6.3-2.3L12 23l-2.2-6.3L3.5 19l4-5.4L1 12l6.5-1.6-4-5.4 6.3 2.3z"/></svg>';
const SESS_META = {
  waiting: '✋ 等你授权', needsinput: '💬 等你回复',
  working: '⚙️ 干活中', juggling: '🤹 并行子任务', sweeping: '🧹 清理上下文',
  thinking: '💭 思考中', loafing: '🍦 摸鱼中(等下一步)', error: '😵 出错了',
  idle: '空闲', sleeping: '💤 休息中',
};
const SESS_SORT = { waiting: 0, needsinput: 0, error: 1, working: 2, juggling: 2, sweeping: 2, thinking: 2, loafing: 3, idle: 4, sleeping: 5 };

// 对齐参考项目阈值：≥90% 红(hot)、≥75% 黄(warm)、其余灰
function ctxClass(p) { return p >= 90 ? 'high' : p >= 75 ? 'mid' : ''; }

// 单一判定：哪些会话出现在「头顶小点」和「会话列表 HUD」里（保持两处联动一致）
const isVisibleSession = (s) => !!s && !s.headless && s.state !== 'sleeping';
// 单一配色：小点和 HUD 用同一套（完成→绿、中断→红，否则按状态）
function sessionDotClass(s) {
  if (s.state === 'idle' && s.badge === 'done') return 'done';
  if (s.state === 'idle' && s.badge === 'interrupted') return 'error';
  return s.state || 'idle';
}

function visibleSessions() {
  return (curSessions || [])
    .filter(isVisibleSession)
    .sort((a, b) => {
      const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
      const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
      if (pa !== pb) return pa - pb;
      return (a.idleMs || 0) - (b.idleMs || 0); // most-recently-active first
    });
}

function renderSessList() {
  const list = visibleSessions();
  slSub.textContent = list.length ? `${list.length} 个` : '';
  slRows.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'sl-empty';
    e.textContent = '暂无活跃会话 — 点下面新开一个';
    slRows.appendChild(e);
    return;
  }
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'sl-row';
    const attn = s.state === 'waiting' || s.state === 'needsinput';
    // meta：等待类显示「等你…」；忙碌显示当前操作；其余只显示状态（不要把陈旧 op 显示成"处理中"）
    let meta;
    if (attn) meta = s.reason ? (s.state === 'waiting' ? '✋ 等你' + s.reason : '💬 等你' + s.reason) : SESS_META[s.state];
    else if (s.state === 'working' || s.state === 'juggling' || s.state === 'sweeping' || s.state === 'thinking') meta = s.op || SESS_META[s.state];
    else if (s.badge === 'done') meta = '✅ 刚完成';
    else if (s.badge === 'interrupted') meta = '⚠️ 中断';
    else meta = SESS_META[s.state] || s.state;
    const dotCls = sessionDotClass(s); // 与头顶小点同一套配色
    const ctx = typeof s.contextPercent === 'number'
      ? `<span class="sl-ctx ${ctxClass(s.contextPercent)}">${s.contextPercent}%</span>` : '';
    row.innerHTML =
      `<span class="sl-dot ${dotCls}"></span>` +
      `<span class="sl-icon">${CLAUDE_ICON}</span>` +
      `<div class="sl-main"><div class="sl-name">${esc(s.project)}</div>` +
      `<div class="sl-meta ${attn ? 'attn' : ''}">${esc(meta)}</div></div>` +
      ctx;
    row.addEventListener('click', () => {
      window.pet.focusSession(s.sessionId || '');
      rlog('sesslist', 'focus ' + (s.project || ''));
      closeSessList();
    });
    slRows.appendChild(row);
  }
}

function openSessList() {
  if (radialOpen) closeRadial();
  if (todoPopOpen) closeTodoPop();
  hideAsk();
  renderSessList();
  sesslist.classList.remove('hidden');
  sessListOpen = true;
  rlog('sesslist', 'open ' + visibleSessions().length);
  fitPopup(sesslist); // 动态定高 + 440 宽，会话名不截断
}
function closeSessList() {
  if (!sessListOpen) return;
  sesslist.classList.add('hidden');
  sessListOpen = false;
  rlog('sesslist', 'close');
  resetPetSize();
}
function toggleSessList() { sessListOpen ? closeSessList() : openSessList(); }

// 工具 -> 干活动作；道具 emoji 的运动变体
const TOOL_ACT = {
  Edit: 'type', MultiEdit: 'type', Write: 'type', NotebookEdit: 'type',
  Read: 'read',
  Bash: 'crank',
  Grep: 'search', Glob: 'search',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'summon', Agent: 'summon',
  TodoWrite: 'check',
};
const ACT_CLASSES = ['act-type', 'act-read', 'act-search', 'act-crank', 'act-web', 'act-summon', 'act-check', 'act-work'];
const PROP_MOTION = { crank: 'spin', web: 'spin', search: 'hunt', type: 'jit' };
let actTimer = null;

let state = 'idle';
let bubbleTimer = null;
let blinkTimer = null;
let transientUntil = 0;   // 短暂状态（happy/error）持续到的时间
let transientState = null;
let muted = false;
let skin = 'mascot';
let lastWaiting = 0;
let lastBgZombie = 0; // 后台疑似僵尸数
let radialOpen = false;

const IDLE_SLEEP_MS = 6 * 60 * 1000;
const stateEls = [pixel, mascot, cat].filter(Boolean);
const DEBUG_STATE = null; // 调试用：强制某状态（如 'sleeping'）；正常运行设为 null
const DEBUG_CONFETTI = false; // 临时：定时放彩带验证；验证完改回 false

// ---------- 像素小怪兽 ----------
const PIXEL_MAP = [
  '..##############..',
  '..##############..',
  '..##############..',
  '#####OO####OO#####',
  '#####OO####OO#####',
  '..##############..',
  '..##############..',
  '..##############..',
  '..##############..',
  '...##.##..##.##...',
  '...##.##..##.##...',
];
function buildPixel() {
  if (!pixel) return;
  const sprite = pixel.querySelector('.pixel-sprite');
  const rows = PIXEL_MAP.length;
  const cols = PIXEL_MAP[0].length;
  const cell = 9;
  const W = cols * cell;
  const H = rows * cell;
  let rects = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = PIXEL_MAP[y][x];
      if (c === '.') continue;
      const fill = c === 'O' ? '#2a1b2e' : '#c2694a';
      rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`;
    }
  }
  sprite.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${rects}</svg>`;
}
buildPixel();

// ---------- 状态机（作用于两种形象，仅当前皮肤可见） ----------
// 前端会 setState 的全部状态词（聚合态 + 短暂态 + 情绪态）。
// classList.remove 必须覆盖此全集，漏一个就会 class 残留在皮肤元素上。
const STATE_WORDS = [
  'idle', 'working', 'juggling', 'sweeping', 'loafing', 'happy', 'sleeping', 'waiting',
  'thinking', 'needsinput', 'error', 'greet', 'talking', 'attention', 'roam',
  'loved', 'sad', 'sorry', 'excited', 'puzzled',
];
function setState(s) {
  if (state === s) return;
  for (const el of stateEls) {
    el.classList.remove(...STATE_WORDS);
    el.classList.add(s);
  }
  state = s;
  rlog('state', s);
  thinkEl.classList.toggle('on', s === 'thinking');
  sleepEl.classList.toggle('on', s === 'sleeping');
  if (s === 'thinking' || s === 'sleeping') bubble.classList.add('hidden');
  if (s === 'working') {
    // 进入干活态 → 立刻挂上「持续忙碌」基线动作，不等具体 tool 事件，
    // 任何时刻都显得在忙（具体 tool 动作会在它之上叠加，结束后回落到这里）。
    for (const el of stateEls) el.classList.add('act-work');
  } else {
    clearAction(); // 离开干活态才清掉动作
  }
  // 注意：不要在这里 hideAsk()！面板显隐只由 refreshAsk(按是否有待答事项) 管。
  // 之前「s!=='waiting' 就 hideAsk」会在聚合态变 working/thinking 时把 needsinput 的面板闪掉。
  if (skin === 'mascot') updateMascotEyes(s);
  if (skin === 'cat') updateCat(s);
}

// 按工具播放专属动作 + 头顶道具
function playAction(toolName, icon) {
  if (state === 'waiting' || state === 'sleeping') return;
  const act = TOOL_ACT[toolName] || 'work';
  for (const el of stateEls) {
    el.classList.remove(...ACT_CLASSES);
    el.classList.add('act-' + act); // 通用 work 也有身体动作（不再只闪图标）
  }
  if (icon) {
    propEl.textContent = icon;
    propEl.className = 'prop';
    void propEl.offsetWidth; // 重启动画
    const pm = PROP_MOTION[act];
    propEl.className = 'prop on' + (pm ? ' ' + pm : '');
  }
  if (act === 'summon') {
    sidekickEl.classList.remove('on');
    void sidekickEl.offsetWidth;
    sidekickEl.classList.add('on');
  }
  clearTimeout(actTimer);
  actTimer = setTimeout(clearAction, 2200);
}
function clearAction() {
  for (const el of stateEls) el.classList.remove(...ACT_CLASSES);
  propEl.classList.remove('on');
  // 具体 tool 动作结束后，仍在干活 → 回落到「持续忙碌」基线，别安静下来
  if (state === 'working') for (const el of stateEls) el.classList.add('act-work');
}

// 短暂状态：happy/error/greet…，到点后由 applyStats 接管。
// 到期不再干等下一个快照（周期推送最坏 ~4s，短暂态会拖尾）——
// 定时用最近一次快照主动重算聚合态，到点即回落。
let transientTimer = null;
function transient(s, ms, text, holdMs) {
  if (state === 'waiting') return; // 等用户优先
  transientState = s;
  transientUntil = perfNow() + ms;
  setState(s);
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { if (lastStats) applyStats(lastStats); }, ms + 30);
  if (text) showBubble(text, holdMs || ms);
}
// 高优先级稳态（waiting/needsinput/error）接管时清掉残留短暂态，
// 否则 talking/thinking 会在下个快照借 transientUntil 复活盖回来。
function clearTransient() {
  transientUntil = 0;
  clearTimeout(transientTimer);
}

// ---------- 声音提示（Web Audio 合成，无需音频文件） ----------
let audioCtx = null;
function beep(freqs, dur = 0.13, type = 'sine', gain = 0.06) {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator();
      const gnode = audioCtx.createGain();
      o.type = type;
      o.frequency.value = f;
      gnode.gain.setValueAtTime(0, t);
      gnode.gain.linearRampToValueAtTime(gain, t + 0.012);
      gnode.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(gnode);
      gnode.connect(audioCtx.destination);
      o.start(t);
      o.stop(t + dur);
      t += dur * 0.92;
    }
  } catch {}
}
const SOUND = {
  waiting: () => beep([660, 880], 0.2, 'sine', 0.08), // 上行提示音
  done: () => beep([784, 1047], 0.15, 'triangle', 0.06), // 愉快叮咚
  error: () => beep([220, 165], 0.2, 'sawtooth', 0.05), // 低沉
  greet: () => beep([523, 784], 0.13, 'sine', 0.05), // 招呼
  bigDone: () => beep([659, 784, 988, 1319], 0.13, 'triangle', 0.07), // 上行小号角
};

// 大任务完成的彩带
function confetti() {
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height * 0.35;
  const emojis = ['🎉', '✨', '⭐', '🧡', '🎊'];
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = emojis[i % emojis.length];
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8; // 向上扇形
    const dist = 45 + Math.random() * 70;
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    s.style.fontSize = 12 + Math.random() * 12 + 'px';
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    s.style.animationDelay = Math.random() * 0.12 + 's';
    stage.appendChild(s);
    setTimeout(() => s.remove(), 1300);
  }
}

function showBubble(text, holdMs = 3200, force = false) {
  if (!force && (muted || radialOpen || askActive)) return; // 选项面板开着时不弹气泡盖住它(force=重要提示强制显示)
  // emoji → 内联 SVG（OctoIcons 在 emoji 字符与 SVG 之间做安全替换；不可识别字符原样保留）
  if (window.OctoIcons && window.OctoIcons.hasMappedEmoji(text)) {
    window.OctoIcons.setTextWithIcons(bubbleText, text);
  } else {
    bubbleText.textContent = text;
  }
  bubble.classList.remove('hidden');
  bubble.scrollTop = 0; // 重置滚动到顶（上次长气泡可能滚到了下边）
  // 大段文字：把窗口按实际高度撑开（fitPopup 已按屏幕封顶，永远不顶出屏幕；
  // 实在超屏时由 #bubble 自身 overflow-y:auto 内滚动兜底）。
  fitPopup(bubble);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, holdMs);
}
function hideBubble() {
  bubble.classList.add('hidden');
  // 若没有其它弹层占用大窗口尺寸，恢复原始尺寸（避免 pet 一直停在加大窗口里）
  if (!askActive && !sessListOpen && !todoPopOpen) resetPetSize();
}

function scheduleBlink() {
  blinkTimer = setTimeout(() => {
    // 仅像素怪兽保留 class 眨眼位（cat 是 GIF 自带动效；mascot 之前的
    // 「眨眼」是把整幅工作场景换成闭眼底图 150ms，观感是画面闪断，已移除）。
    if (skin === 'pixel' && state !== 'sleeping' && state !== 'waiting') {
      pixel.classList.add('blink');
      setTimeout(() => pixel.classList.remove('blink'), 160);
    }
    scheduleBlink();
  }, 2500 + Math.random() * 4000);
}
scheduleBlink();

// 空闲小动作：闲着时偶尔东张西望 / 蹦一下，更有生命感
function scheduleIdleAction() {
  setTimeout(() => {
    if (state === 'idle' && !radialOpen && !muted) {
      // 只有像素怪兽有 peek 动画；mascot 的 glance CSS 指向已不存在的
      // #teyes（img 皮肤没有 SVG 眼睛节点），cat 由 GIF 自带动效。
      if (skin === 'pixel') {
        pixel.classList.add('peek');
        setTimeout(() => pixel.classList.remove('peek'), 620);
      }
    }
    scheduleIdleAction();
  }, 7000 + Math.random() * 7000);
}
scheduleIdleAction();

const curSkinEl = () => (skin === 'pixel' ? pixel : skin === 'cat' ? cat : mascot);

// ---------- 事件 ----------
window.pet.onEvent((ev) => {
  // 你正在答面板/打字时：新的待答任务只悄悄进队列(不抢面板)，其余动画/彩带/气泡/状态变化一律不打断
  if (isInteracting()) {
    if ((ev.kind === 'waiting' || ev.kind === 'needsinput') && ev.choice) enqueueChoice(ev.choice);
    return;
  }
  switch (ev.kind) {
    case 'operation': {
      // 高优先级稳态（等授权/等回复/出错/清理）不被工具事件降级成 working——
      // 之前 error 期间其它会话干活会导致 working↔error 持续闪烁。
      const hold = state === 'waiting' || state === 'needsinput' || state === 'error' || state === 'sweeping';
      // transient（thinking/happy/talking…）存续期间也不盖（STATES.md：短暂态高于聚合）
      if (!hold && perfNow() >= transientUntil) {
        setState('working');
        playAction(ev.tool, ev.icon);
      }
      showBubble(`${ev.icon || '🔧'} ${ev.detail}`);
      break;
    }
    case 'say':
      if (ev.text && ev.text.length > 2 && state !== 'waiting') {
        const dur = Math.min(6000, Math.max(2200, ev.text.length * 80));
        // Stop 会同批派生 turn-done(happy) + say(talking)：让庆祝先演完，
        // talking 排在 happy 结束后接棒，气泡文本立刻显示不用等。
        if (transientState === 'happy' && perfNow() < transientUntil) {
          showBubble(`💬 ${ev.text}`, Math.min(4200, dur));
          const token = ++sayToken;
          setTimeout(() => {
            if (token === sayToken && state !== 'waiting') transient(ev.emotion || 'talking', dur);
          }, Math.max(0, transientUntil - perfNow()));
        } else if (ev.emotion) {
          // Claude 的话里带情绪（sorry/puzzled/excited）→ 短暂表情替代 talking
          transient(ev.emotion, 2800, `💬 ${ev.text}`, Math.min(4200, ev.text.length * 80));
        } else {
          transient('talking', dur, `💬 ${ev.text}`, Math.min(4200, dur));
        }
      }
      break;
    case 'user-turn':
      // 你的输入里带情绪（loved/sad/excited）→ 章鱼即时反应；否则像以前一样进 thinking
      if (ev.emotion && state !== 'waiting') {
        const tip = ev.emotion === 'loved' ? '🥰 谢谢夸奖！' : ev.emotion === 'sad' ? '😢 别生气…' : '✨ 收到！';
        transient(ev.emotion, 2800, tip, 2600);
      } else {
        // 多会话时聚合里 working > thinking，直接 setState 会在下个快照被盖掉
        // （只闪 ~150ms）。用 transient 保证「刚提交任务」的思考表情至少停留一会。
        if (state !== 'waiting') transient('thinking', 3500);
        showBubble('📨 收到新任务！', 2600);
      }
      break;
    case 'turn-done':
      transient('happy', 1800, '✅ 这一轮搞定啦！', 3400);
      SOUND.done();
      break;
    case 'big-done':
      transient('happy', 2200, `🎉 大任务搞定！(${ev.ops || ''}步)`, 3800);
      confetti();
      SOUND.bigDone();
      break;
    case 'error':
      transient('error', 2600, ev.text || '😵 出了点状况，在想办法…', 3000);
      SOUND.error();
      break;
    case 'waiting':
      clearTransient(); // 残留的 talking/thinking 短暂态不得盖过等授权
      setState('waiting');
      SOUND.waiting();
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice); // 直接弹出选项/输入
      } else {
        showBubble(`✋ ${ev.project || ''} 等你${ev.reason || '处理'}`, 6000);
      }
      break;
    case 'needsinput':
      // Claude 在末尾问「要不要继续」之类，等你回复 → 黄点 + 可在桌宠上继续/回复
      if (state !== 'waiting') { clearTransient(); setState('needsinput'); }
      SOUND.done();
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice);
      } else {
        showBubble(`💬 ${ev.project || ''} 等你回复`, 6000);
      }
      break;
    case 'greet':
      transient('greet', 2000, `👋 ${ev.project || ''} 新会话，你好！`, 2600);
      SOUND.greet();
      break;
    case 'longcmd':
      if (state !== 'waiting') showBubble('💦 这条命令有点久，稍等…', 3000);
      break;
  }
});

function perfNow() {
  return Date.now();
}

// ---------- 统计 + 聚合状态 ----------
let lastStats = null; // 最近一次快照：transient 到期时用它立即重算聚合态
let sayToken = 0;     // say 接棒 happy 的排队令牌（新事件作废旧排队）
function applyStats(s) {
  if (!s) return;
  lastStats = s;
  chipCost.textContent = '$' + (s.today.cost || 0).toFixed(3);
  chipWindow.textContent = '5h $' + (s.window5h.cost || 0).toFixed(3);
  lastWaiting = (s.waitingCount || 0) + (s.needsinputCount || 0); // 待处理徽标含「等你回复」
  lastBgZombie = (s.bg && s.bg.zombie) || 0;
  if (radialOpen) updateRadialBadge();
  renderSessions(s.sessions || []);
  updateNotepad(s); // 记事本：行动清单 + 待办
  if (sessListOpen) { renderSessList(); fitPopup(sesslist); } // HUD 开着时随快照刷新并重定高

  // 选项面板：按快照重建队列（多任务都在、标明项目；防漏事件/启动时已在等待）
  refreshAsk(s);

  if (DEBUG_STATE) { setState(DEBUG_STATE); return; }

  // 你正在看面板/打字 → 不再改小章鱼状态(别动来动去打断你)，安静等你答完
  if (isInteracting()) return;

  // 聚合梯子，对齐 STATES.md 的优先级表：
  //   waiting > 短暂态 > error(8) > needsinput/notification(7) > sweeping(6)
  //   > juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
  // 之前 working 排在 needsinput 前面，多会话时「等你回复」被干活态彻底盖住。
  if (s.waitingCount > 0) {
    setState('waiting');
  } else if (perfNow() < transientUntil) {
    setState(transientState);
  } else if (s.errorCount > 0) {
    setState('error'); // 有会话卡在 API 错误 → 瘫倒，直到该会话恢复或 oneshot 衰减
  } else if (s.needsinputCount > 0) {
    setState('needsinput');
  } else if (s.sweepingCount > 0) {
    setState('sweeping');
  } else if (s.jugglingCount > 0) {
    setState('juggling');
  } else if (s.workingCount > 0) {
    setState('working');
  } else if (s.thinkingCount > 0) {
    setState('thinking');
  } else if (s.loafingCount > 0) {
    setState('loafing'); // 工具间隙：上一步干完等下一步 → 摸鱼
  } else if (s.idleMs == null || s.idleMs > IDLE_SLEEP_MS) {
    // idleMs=null 表示已无任何活跃会话——什么都没发生就该睡觉；
    // 之前 null 落到 idle，桌宠永不入睡，睡着后会话被回收还会凭空惊醒。
    setState('sleeping');
  } else {
    setState('idle');
  }
}
window.pet.onStats(applyStats);

function renderSessions(sessions) {
  sessionsEl.innerHTML = '';
  // 与会话列表 HUD 完全联动：同一过滤(非 headless/非睡眠)、同一配色、同一排序。
  const list = (sessions || []).filter(isVisibleSession).sort((a, b) => {
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'sess-dot ' + sessionDotClass(s);
    const label = s.state === 'waiting' ? `等你${s.reason || '处理'}` : (SESS_META[s.state] || s.state);
    d.title = `${s.project} · ${label}`;
    sessionsEl.appendChild(d);
  }
  // 菜单开着时同步「待处理」角标
  if (radialOpen) updateRadialBadge();
}

window.pet.onConfig((cfg) => {
  if (!cfg) return;
  muted = !!cfg.muted;
  if (cfg.skin) applySkin(cfg.skin);
});

function applySkin(s) {
  skin = ['pixel', 'mascot', 'cat'].includes(s) ? s : 'mascot';
  document.body.classList.toggle('skin-pixel', skin === 'pixel');
  document.body.classList.toggle('skin-mascot', skin === 'mascot');
  document.body.classList.toggle('skin-cat', skin === 'cat');
  if (skin === 'mascot') updateMascotEyes(state);
  if (skin === 'cat') updateCat(state);
}

// ====================================================================
// 拖动 + 点击（短按=泡泡菜单 / 拖动=移动窗口）
// ====================================================================
let g = null; // 当前手势（同步建立，保证快速点击也能识别）
function attachDrag(el) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
    g = { el, pid: e.pointerId, sx: e.screenX, sy: e.screenY, moved: false, win: null };
    window.pet.getWinPos().then(([wx, wy]) => { if (g) g.win = [wx, wy]; });
  });
  el.addEventListener('pointermove', (e) => {
    if (!g) return;
    const dx = e.screenX - g.sx;
    const dy = e.screenY - g.sy;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
    if (g.moved && g.win) {
      if (radialOpen) closeRadial();
      window.pet.setWinPos(g.win[0] + dx, g.win[1] + dy);
    }
  });
  el.addEventListener('pointerup', () => {
    if (!g) return;
    const wasMove = g.moved;
    try { el.releasePointerCapture(g.pid); } catch {}
    el.classList.remove('dragging');
    g = null;
    if (!wasMove) {
      // 左键短按 = 会话列表 HUD（状态/会话名/上下文用量一览，点行聚焦该会话）。
      // 权限的允许/拒绝仍由 waiting 事件自动弹气泡，不走这里。
      if (radialOpen) closeRadial();
      else toggleSessList();
    }
  });
  el.addEventListener('pointercancel', () => { if (g) el.classList.remove('dragging'); g = null; });
  // 右键 = 泡泡菜单
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleRadial();
  });
}
stateEls.forEach(attachDrag);

// 卡片按钮：Submit/Next、Back、Go to Terminal、Other 输入
askSubmit.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicNextOrSubmit(c); });
askBack.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicBack(c); });
askTerm.addEventListener('click', () => { const c = askQueue[askIdx]; if (c) gotoSession(c); });
askText.addEventListener('input', () => updateSubmitEnabled());
// 自定义输入里按回车直接发送（仅 elicitation）；空内容不发、提示别忘了填
askText.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const c = askQueue[askIdx];
  if (!c || !elic) return;
  if (!(askText.value || '').trim()) { warnEmptyInput(); return; }
  if (askSubmit.classList.contains('disabled')) { warnEmptyInput(); return; }
  elicNextOrSubmit(c);
});
// 鼠标在面板上 = 交互中（配合 isInteracting 冻结轮询）
askEl.addEventListener('pointerenter', () => { askHover = true; });
askEl.addEventListener('pointerleave', () => { askHover = false; });

// 记事本：点击开/关 行动清单弹层
notepad.addEventListener('click', (e) => { e.stopPropagation(); todoPopOpen ? closeTodoPop() : openTodoPop(); });
notepad.addEventListener('contextmenu', (e) => e.stopPropagation());
document.getElementById('tp-close').addEventListener('click', (e) => { e.stopPropagation(); closeTodoPop(); });

// 会话列表 HUD：关闭 + 底部操作
document.getElementById('sl-close').addEventListener('click', (e) => { e.stopPropagation(); closeSessList(); });
document.getElementById('sl-new').addEventListener('click', (e) => { e.stopPropagation(); window.pet.launchClaude(); closeSessList(); });
document.getElementById('sl-panel').addEventListener('click', (e) => { e.stopPropagation(); window.pet.openPanel(); closeSessList(); });
sesslist.addEventListener('contextmenu', (e) => e.stopPropagation());
todopop.querySelectorAll('.tp-ops button').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const op = b.dataset.op;
    if (op === 'panel') window.pet.openPanel();
    else if (op === 'claude') window.pet.launchClaude();
    else if (op === 'log') window.pet.openLog();
    closeTodoPop();
  });
});

// ---------- 泡泡菜单 ----------
const MENU = [
  { ic: 'chart',  label: '详情', act: () => window.pet.openPanel() },
  { ic: 'mask',   label: '形象', act: () => toggleSkin() },
  { ic: 'hand',   label: '待处理', badge: true, act: () => window.pet.openPanel() },
  { ic: 'zombie', label: '后台', badgeBg: true, act: () => window.pet.openPanel() },
  { ic: 'doc',    label: '日志', act: () => window.pet.openLog() },
  { ic: 'bell',   label: '静音', act: () => window.pet.toggleMute() },
  { ic: 'power',  label: '退出', act: () => window.pet.quit() },
];

function toggleSkin() {
  const order = ['mascot', 'pixel', 'cat'];
  const next = order[(order.indexOf(skin) + 1) % order.length];
  applySkin(next);
  window.pet.setSkin(next);
}

function buildRadial() {
  radial.innerHTML = '';
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height / 2;
  const n = MENU.length;
  const radius = 96;
  const startA = 192, endA = 348; // 头顶上方的弧
  MENU.forEach((it, i) => {
    const a = ((startA + (endA - startA) * (n === 1 ? 0.5 : i / (n - 1))) * Math.PI) / 180;
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    const b = document.createElement('div');
    b.className = 'radial-item';
    b.style.left = x + 'px';
    b.style.top = y + 'px';
    b.style.transitionDelay = i * 0.03 + 's';
    const icName = it.label === '静音' ? (muted ? 'bell-off' : 'bell') : it.ic;
    const icHtml = (window.OctoIcons && window.OctoIcons.icon(icName)) || '';
    b.innerHTML = `<span class="ri-ic oi">${icHtml}</span><span class="ri-lb">${it.label}</span>`;
    const cnt = it.badge ? lastWaiting : it.badgeBg ? lastBgZombie : 0;
    if ((it.badge || it.badgeBg) && cnt > 0) {
      const bd = document.createElement('span');
      bd.className = 'ri-badge';
      bd.textContent = cnt;
      b.appendChild(bd);
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      it.act();
      closeRadial();
    });
    radial.appendChild(b);
  });
}

function updateRadialBadge() {
  const items = radial.querySelectorAll('.radial-item');
  MENU.forEach((m, idx) => {
    if (!m.badge && !m.badgeBg) return;
    const node = items[idx];
    if (!node) return;
    const cnt = m.badge ? lastWaiting : lastBgZombie;
    let bd = node.querySelector('.ri-badge');
    if (cnt > 0) {
      if (!bd) { bd = document.createElement('span'); bd.className = 'ri-badge'; node.appendChild(bd); }
      bd.textContent = cnt;
    } else if (bd) bd.remove();
  });
}

function openRadial() {
  if (todoPopOpen) closeTodoPop();
  if (sessListOpen) closeSessList();
  buildRadial();
  radial.classList.remove('hidden');
  radialOpen = true;
  bubble.classList.add('hidden');
}
function closeRadial() {
  radial.classList.add('hidden');
  radialOpen = false;
}
function toggleRadial() {
  radialOpen ? closeRadial() : openRadial();
}
// 点遮罩空白处关闭
radial.addEventListener('click', () => closeRadial());
window.addEventListener('blur', () => { if (radialOpen) closeRadial(); });

// ---------- 初始化 ----------
(async () => {
  const cfg = await window.pet.getConfig();
  if (cfg) {
    muted = !!cfg.muted;
    applySkin(cfg.skin || 'mascot');
  }
  const s = await window.pet.getStats();
  // 有快照就按真实聚合态亮相；之前无条件 setState('idle') 会把刚算出的
  // working/waiting 盖掉，启动瞬间总是先闪一下空闲。getStats 落空但推送
  // 已先到时（lastStats 已有值）同样不能清。
  if (s) applyStats(s);
  else if (!lastStats) setState('idle');
  showBubble('🐙 小章鱼上线，开始盯任务啦！', 3000);
  if (DEBUG_CONFETTI) setInterval(() => confetti(), 2500);
})();

// ---------- 透明区域点击穿透（命中测试）----------
// 桌宠窗口是透明矩形，空白处不该拦住后面的应用。光标在内容(小章鱼/卡片/菜单/记事本)
// 上 → 接收点击；在透明区 → 让窗口穿透。forward:true 使穿透时 mousemove 仍回传，
// 因此一旦光标回到内容上即可恢复可点。拖动中(g)始终保持可点。
const HIT_SEL = '#pixel,#mascot,#cat,#radial,#notepad,#todopop,#ask,#sesslist';
let mouseIgnoring = false;
function setMouseIgnore(on) {
  if (on === mouseIgnoring) return;
  mouseIgnoring = on;
  try { window.pet.setIgnoreMouse(on); } catch {}
}
window.addEventListener('mousemove', (e) => {
  if (g) { setMouseIgnore(false); return; } // 拖动中保持可点
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 命中测试权威同步悬停态：穿透切换时 pointerleave 可能漏发，会把 askHover 卡在 true，
  // 进而让 isInteracting() 永远为真、refreshAsk 永不对账（旧卡片冻结、新卡片进不来）。
  askHover = !!(el && el.closest('#ask'));
  setMouseIgnore(!(el && el.closest(HIT_SEL)));
}, true);
// 启动即默认穿透（透明区不挡），光标移到内容上时由上面的命中测试恢复
setMouseIgnore(true);
