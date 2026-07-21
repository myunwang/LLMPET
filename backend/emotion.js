'use strict';

// Lightweight emotion sniffer — turns the last user prompt or Claude reply into
// a short-lived "vibe" tag the octopus can react to with a matching expression.
//
// Keyword-based, conservative (false-negative > false-positive — one wrong face
// is more annoying than a missed one). Never blocks anything: returns null when
// in doubt. Role-gated so loved/sad only fire from YOU, sorry/puzzled only fire
// from Claude, and excited can come from either side.

// "Negation lookback" — if the 6 chars BEFORE a keyword contain a negation
// particle, treat the match as flipped (e.g. "不太好" ≠ loved).
const NEGATION_RE_CN = /[不没别勿无]/;
const NEGATION_RE_EN = /\b(?:not|no|don't|doesn't|isn't|wasn't|never|hardly|barely)\b/i;

// Each entry = { id, cn[], en[] }. Order is priority — first match wins.
// Keep word lists tight: a noisy match here = a wrong octopus face on screen.
const EMOTIONS = [
  {
    id: 'loved',
    cn: ['你最棒', '太牛了', '太牛', '真牛', '真棒', '绝了', 'yyds', '666', '多谢', '谢谢', '感谢', '辛苦了', '真厉害', '给力', '点赞', '棒极了', '非常好', '干得漂亮', '干得好', '做得好', '太好了', '太赞了', '满意'],
    en: ['awesome', 'amazing', 'perfect', 'wonderful', 'great work', 'great job', 'well done', 'nice job', 'nice work', 'love it', 'beautiful', 'thank you', 'thanks', 'appreciate it'],
  },
  {
    id: 'sad',
    cn: ['又错了', '错了', '搞砸', '失望', '烦死', '烦人', '真讨厌', '讨厌', '气死', '怎么搞的', '不像话', '算了吧', '真无语', '无语', '糟糕', '糟透了', '一团糟', '又坏了', '你怎么回事', '别再错'],
    en: ['disappointing', 'frustrating', 'terrible', 'awful', 'garbage', 'useless', 'what the hell', 'damn it', 'seriously?'],
  },
  {
    id: 'sorry',
    cn: ['抱歉', '对不起', '不好意思', '我错了', '是我错了', '是我的疏忽', '我的失误', '失误了', '道歉', '没注意到', '没考虑到', '疏忽了', '请见谅'],
    en: ['sorry', 'apologize', 'my mistake', 'my bad', 'my apologies', 'i was wrong'],
  },
  {
    id: 'excited',
    cn: ['搞定了', '大功告成', '完美收工', '一气呵成', '终于', '搞定！', '完工'],
    en: ['nailed it', 'finally', 'yay', 'woohoo', 'shipped it', "let's go", 'lets go'],
  },
  {
    id: 'puzzled',
    cn: ['不太确定', '我不确定', '也许', '可能是', '不清楚', '似乎', '看起来像', '大概', '或许', '不一定'],
    en: ['not sure', 'not entirely sure', 'maybe', 'perhaps', 'seems like', 'it looks like'],
  },
];

function neighborNegation(text, idx) {
  const before = text.slice(Math.max(0, idx - 8), idx);
  return NEGATION_RE_CN.test(before) || NEGATION_RE_EN.test(before);
}

function isWordChar(ch) {
  return !!ch && /[a-z0-9_]/i.test(ch);
}

function findLiteralPhrase(text, phrase) {
  const haystack = text.toLowerCase();
  const needle = phrase.toLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return -1;
    const before = i > 0 ? haystack[i - 1] : '';
    const after = i + needle.length < haystack.length ? haystack[i + needle.length] : '';
    if (!isWordChar(before) && !isWordChar(after)) return i;
    from = i + 1;
  }
  return -1;
}

function findOne(text, words, isCn) {
  for (const w of words) {
    const i = isCn ? text.indexOf(w) : findLiteralPhrase(text, w);
    if (i >= 0 && !neighborNegation(text, i)) return true;
  }
  return false;
}

const ROLE_ALLOW = {
  user: new Set(['loved', 'sad', 'excited']),
  assistant: new Set(['sorry', 'puzzled', 'excited']),
};

function detectEmotion(text, role) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || t.length > 6000) return null;
  // Emotion lives in the recent sentiment, not the whole essay.
  const tail = t.length > 1500 ? t.slice(-1500) : t;
  const allowed = ROLE_ALLOW[role] || new Set(EMOTIONS.map((e) => e.id));
  for (const e of EMOTIONS) {
    if (!allowed.has(e.id)) continue;
    if (findOne(tail, e.cn, true)) return e.id;
    if (findOne(tail, e.en, false)) return e.id;
  }
  return null;
}

module.exports = { detectEmotion, EMOTIONS };
