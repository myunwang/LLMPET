#!/usr/bin/env node
'use strict';

// LLMPET compatibility hook — run by Claude Code as: node octopus-hook.js <Event>
//
// Reads the hook's stdin JSON, derives a pet state, enriches it from the session
// transcript (Claude's last message, context usage, API errors, title), figures
// out which terminal owns the session (for "去回复" focus), and POSTs it to the
// running LLMPET server. Must be fast and never throw — Claude Code waits on it.

const transport = require('../backend/transport');
const transcript = require('../backend/transcript');
const pidwalk = require('../backend/pidwalk');
const { detectEmotion } = require('../backend/emotion');

const EVENT_STATE = {
  SessionStart: 'idle',
  SessionEnd: 'sleeping',
  UserPromptSubmit: 'thinking',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'error',
  Stop: 'attention',
  StopFailure: 'error',
  SubagentStart: 'juggling',
  SubagentStop: 'working',
  PreCompact: 'sweeping',
  PostCompact: 'thinking',
  Notification: 'notification',
  Elicitation: 'notification',
};
const FOCUS_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let payload = {};
      try { const raw = Buffer.concat(chunks).toString('utf8'); if (raw.trim()) payload = JSON.parse(raw); } catch {}
      resolve(payload);
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 300);
  });
}

function count(v) { return Array.isArray(v) ? v.length : 0; }

function buildBody(event, p) {
  let state = EVENT_STATE[event];
  if (!state) return null;
  // A subagent launch may surface as PreToolUse(Task) without SubagentStart.
  if (event === 'PreToolUse' && p.tool_name === 'Task') state = 'juggling';
  // /clear shows up as SessionEnd(source=clear) → context sweep, not sleep.
  if (event === 'SessionEnd' && (p.source === 'clear' || p.reason === 'clear')) state = 'sweeping';
  // Manual /compact ends a turn (settle to idle); auto-compact keeps working.
  if (event === 'PostCompact' && p.trigger === 'manual') state = 'idle';

  // 没有 session_id 的事件（stdin 300ms 超时读到空 payload 等）直接丢弃：
  // 以 'default' 入库会伪造一个名为「efault」的幽灵会话并跨会话串状态。
  if (typeof p.session_id !== 'string' || !p.session_id) return null;
  const sid = p.session_id;
  const body = { state, event, session_id: sid };
  if (typeof p.cwd === 'string' && p.cwd) body.cwd = p.cwd;
  // Forward CC's real transcript path so the server never has to re-derive the
  // encoded project dir (its /._→- guess missed '_', breaking the 10s poll for
  // ~30% of projects: interrupt/API-error/context refresh went silent there).
  if (typeof p.transcript_path === 'string' && p.transcript_path) body.transcript_path = p.transcript_path;
  if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
  if (typeof p.model === 'string' && p.model) body.model = p.model;
  if (p.stop_hook_active === true) body.stop_hook_active = true;
  // StopFailure carries the API/server error kind (CC 2.1.x enum: server_error,
  // rate_limit, overloaded_error, billing_error, authentication_failed, …).
  if (event === 'StopFailure') {
    const t = p.api_error_type || p.error || p.reason || p.failure_kind;
    if (typeof t === 'string' && t) body.api_error_type = t;
  }
  body.background_tasks_count = count(p.background_tasks);
  body.session_crons_count = count(p.session_crons);

  // Transcript-derived enrichment (read the tail once).
  const entries = transcript.readTail(p.transcript_path);

  // SessionStart 来源（startup/resume/clear/compact）：只有 startup 是真·新对话，
  // resume/compact 进入已有任务不该触发「新会话欢迎」。有的环境（ccd）不带
  // source —— 用 transcript 是否已有正式对话兜底判定。
  if (event === 'SessionStart') {
    body.session_source = (typeof p.source === 'string' && p.source)
      ? p.source
      : (transcript.hasHistory(entries) ? 'resume' : 'startup');
  }

  if (entries) {
    const ctx = transcript.contextUsage(entries, p.session_id || null);
    if (ctx) body.context_usage = ctx;
    const title = transcript.sessionTitle(entries);
    if (title) body.session_title = title;
    if (event === 'Stop') {
      const err = transcript.apiError(entries, sid);
      if (err) {
        body.state = 'error';
        body.event = 'ApiError';
        body.api_error_type = err.api_error_type;
      } else {
        const text = transcript.lastAssistantText(entries, sid);
        if (text) { body.assistant_last_output = text; }
      }
    }
  }
  if (!body.session_title && event === 'UserPromptSubmit') {
    const pt = transcript.promptTitle(p.prompt);
    if (pt) body.session_title = pt;
  }

  // Emotion sniff — only on the two events that carry user/assistant text.
  // user prompt: loved/sad/excited; assistant reply: sorry/puzzled/excited.
  // Never blocks; null is fine.
  if (event === 'UserPromptSubmit' && typeof p.prompt === 'string') {
    const emo = detectEmotion(p.prompt, 'user');
    if (emo) body.user_emotion = emo;
  } else if (event === 'Stop' && body.assistant_last_output) {
    const emo = detectEmotion(body.assistant_last_output, 'assistant');
    if (emo) body.assistant_emotion = emo;
  }

  // `claude --resume -p` launched by a meme action belongs to the user-selected
  // original session. Do not overwrite that session's focus route/headless bit
  // with the short-lived resume process, and do not retire it on CLI exit.
  const memeResume = process.env.LLMPET_MEME_RESUME === '1';
  if (memeResume) {
    body.headless = false;
    body.external_resume = true;
  } else if (FOCUS_EVENTS.has(event)) {
    try {
      const r = pidwalk.resolve(process.ppid, 10, sid);
      if (r.sourcePid) body.source_pid = r.sourcePid;
      if (r.pidChain && r.pidChain.length) body.pid_chain = r.pidChain;
      if (r.editor) body.editor = r.editor;
      if (r.tmuxSocket) body.tmux_socket = r.tmuxSocket;
      if (r.tmuxClient) body.tmux_client = r.tmuxClient;
      if (r.terminalApp) body.terminal_app = r.terminalApp;
      if (r.terminalTty) body.terminal_tty = r.terminalTty;
      body.headless = r.headless === true; // background `claude -p` runs
    } catch {}
  }
  return body;
}

function main() {
  const event = process.argv[2];
  if (!EVENT_STATE[event]) process.exit(0);
  readStdin().then((payload) => {
    let body;
    try { body = buildBody(event, payload || {}); } catch { body = null; }
    if (!body) process.exit(0);
    transport.postState(body, () => process.exit(0));
    setTimeout(() => process.exit(0), 250); // never hang Claude Code
  }).catch(() => process.exit(0));
}

if (require.main === module) main();
module.exports = { buildBody, EVENT_STATE };
