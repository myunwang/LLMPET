'use strict';

// Transcript JSONL helpers (original implementation).
//
// Claude Code writes one JSONL transcript per session; each line is an event,
// assistant lines carry message.{model,id,usage} and message.content. We read
// only the tail (the current turn lives there) and pull out:
//   - the last assistant text  (→ the pet's 💬 "say" bubble, on Stop)
//   - context-window usage      (input+cache tokens of the latest assistant msg)
//   - a current-turn API error  (Claude tags failed turns isApiErrorMessage)
//   - a custom session title
// Token counts only — never persisted, never sent anywhere but our localhost
// server. Field names are Claude Code's transcript format (a data interface).

const fs = require('fs');

const TAIL_BYTES = 256 * 1024;
const ASSISTANT_MAX = 2200;
// strip C0/C1 control chars (except \t\n) without writing literal control bytes
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+', 'g');
const TITLE_MAX = 80;
const SECRET_RE = /\b(api[_-]?key|authorization|bearer|password|passwd|secret|token|private[_-]?key)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}/i;
const CLAUDE_LIMIT = 200000;
const CLAUDE_1M = 1000000;

function readTail(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let fd = null;
  try {
    const st = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(st.size, TAIL_BYTES);
    const truncated = st.size > len;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    const lines = buf.toString('utf8').split('\n');
    if (truncated && lines.length > 1) lines.shift(); // drop partial first line
    const out = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try { const o = JSON.parse(ln); if (o && typeof o === 'object') out.push(o); } catch {}
    }
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function clean(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_RE, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function matchesSession(e, sid) {
  if (!sid) return true;
  return !e.sessionId || e.sessionId === sid;
}
function looksSubagent(e) {
  return e.isSidechain === true || e.isSubagent === true || e.is_subagent === true;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') { parts.push(b); continue; }
    if (b && (b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n\n');
}

// 是否已有正式对话内容（用户/助手消息）。SessionStart 不带 source 的环境
// （如 ccd）用它区分「真·新对话」和 resume 进入已有任务。
function hasHistory(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => e && !looksSubagent(e) && (e.type === 'user' || e.type === 'assistant'));
}

// 尾部是否是「用户手动中断」(ESC)，且发生在 sinceTs 之后。
// ESC 中断不触发任何 hook 事件，只会往 transcript 写一条
// `[Request interrupted by user…]` 的 user 记录——这是唯一的发现渠道。
// 中断之后若已有新的正常消息则不算（说明已经继续对话了）。
function interruptedAfter(entries, sinceTs) {
  if (!Array.isArray(entries)) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || looksSubagent(e)) continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.type === 'user') {
      const txt = textFromContent(e.message && e.message.content);
      if (/\[Request interrupted by user/.test(txt || '')) {
        const ts = Date.parse(e.timestamp || '') || 0;
        return ts > (sinceTs || 0);
      }
    }
    return false; // 最近一条是正常消息 → 没有悬着的中断
  }
  return false;
}

// 网络重试/API 报错发生在事件间隙（不触发任何 hook），只能从 transcript 发现：
// CC 每次失败会写 isApiErrorMessage:true 的 assistant 条目。返回「仍未恢复」
// 的错误（其后没有正常消息），且发生在 sinceTs 之后；恢复后返回 null。
function apiErrorAfter(entries, sid, sinceTs) {
  if (!Array.isArray(entries)) return null;
  let idx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.isApiErrorMessage === true && matchesSession(e, sid)) { idx = i; break; }
  }
  if (idx < 0) return null;
  for (let i = idx + 1; i < entries.length; i++) {
    const t = entries[i] && entries[i].type;
    if (t === 'user') return null;
    if (t === 'assistant' && entries[i].isApiErrorMessage !== true) return null;
  }
  const ts = Date.parse(entries[idx].timestamp || '') || 0;
  if (ts <= (sinceTs || 0)) return null;
  return { errorType: typeof entries[idx].error === 'string' ? entries[idx].error : 'unknown', ts };
}

// Last assistant text of the current turn (stop at the turn's user boundary).
function lastAssistantText(entries, sid) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'user' && matchesSession(e, sid)) break;
    if (e.type !== 'assistant' || e.isApiErrorMessage === true) continue;
    if (!matchesSession(e, sid) || looksSubagent(e)) continue;
    const txt = clean(textFromContent(e.message ? e.message.content : e.content));
    if (!txt) continue;
    return txt.length > ASSISTANT_MAX ? txt.slice(0, ASSISTANT_MAX) + '…' : txt;
  }
  return null;
}

// The 1M context window is enabled via a beta header, NOT the model name, so we
// can't always read it off the name. Key heuristic: a single request's input can
// never exceed the context window — so if observed usage tops the 200k window,
// the session must be on the 1M window. This is what makes the % match the client
// (otherwise long Opus sessions read >200k cached tokens and saturate at 100%).
function contextLimit(model, used) {
  const m = String(model || '').toLowerCase();
  if (/(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(m)) return CLAUDE_1M;
  if (Number(used) > CLAUDE_LIMIT) return CLAUDE_1M;
  return CLAUDE_LIMIT;
}

// Context-window usage from the latest assistant message.
function contextUsage(entries, sid) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== 'assistant' || e.isApiErrorMessage === true) continue;
    if (!matchesSession(e, sid) || looksSubagent(e)) continue;
    const u = e.message && e.message.usage;
    if (!u) continue;
    const used = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    if (used <= 0) continue;
    const limit = contextLimit(e.message.model, used);
    return { used, limit, percent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))), source: 'claude' };
  }
  return null;
}

// A current-turn API error: the most recent isApiErrorMessage with no later
// user/non-error-assistant entry (otherwise the turn moved on / recovered).
function apiError(entries, sid) {
  if (!Array.isArray(entries) || !sid) return null;
  let idx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].isApiErrorMessage === true && entries[i].sessionId === sid) { idx = i; break; }
  }
  if (idx < 0) return null;
  for (let i = idx + 1; i < entries.length; i++) {
    const t = entries[i].type;
    if (t === 'user') return null;
    if (t === 'assistant' && entries[i].isApiErrorMessage !== true) return null;
  }
  return { api_error_type: typeof entries[idx].error === 'string' ? entries[idx].error : 'unknown' };
}

function sessionTitle(entries) {
  if (!Array.isArray(entries)) return null;
  let title = null;
  for (const e of entries) {
    if (e.type !== 'custom-title' && e.type !== 'agent-name') continue;
    const v = e.customTitle || e.title || e.custom_title || e.agentName || e.agent_name;
    if (typeof v === 'string' && v.trim()) title = v.trim();
  }
  if (!title) return null;
  const norm = title.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return norm.length > TITLE_MAX ? norm.slice(0, TITLE_MAX) + '…' : norm;
}

// First non-empty prompt line as a title fallback (redacts secret-looking lines).
function promptTitle(prompt) {
  if (typeof prompt !== 'string') return null;
  for (const line of prompt.split(/\r?\n/)) {
    const c = line.trim();
    if (!c) continue;
    if (SECRET_RE.test(c)) return null;
    return c.length > 40 ? c.slice(0, 40) + '…' : c;
  }
  return null;
}

module.exports = { readTail, lastAssistantText, contextUsage, apiError, apiErrorAfter, sessionTitle, promptTitle, clean, textFromContent, hasHistory, interruptedAfter };
