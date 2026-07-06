'use strict';

// Session store + state machine + snapshot.
//
// Narrowed to the Claude Code path. The /state HTTP body is parsed in
// server.js and handed here as already-normalized fields (route parses, core
// stores). Original implementation; it targets Claude Code's hook lifecycle.
//
// State vocabulary, priority, the rolling recent-event history, and the
// completion gate are all implemented here directly (no external deps).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');
const transcript = require('./transcript');
const States = require('../shared/states');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Rolling per-session event history → drives the "done/interrupted" badge
// without bloating the state enum. Capped to keep long sessions bounded.
const RECENT_EVENT_LIMIT = 8;
function pushRecentEvent(session, state, event, now) {
  const prev = Array.isArray(session && session.recentEvents)
    ? session.recentEvents.slice(-(RECENT_EVENT_LIMIT - 1))
    : [];
  prev.push({ at: now, event: event || null, state: state || 'idle' });
  return prev;
}

// ── pet state vocabulary + priority — sourced from shared/states.js so the
// renderer and the test share the exact same words (no more 5-way drift).
// oneshot decay backstop: error/attention/sweeping/carrying settle to idle after
// their TTL if no further event arrives; notification is excluded (it means
// "waiting for you" and must persist until you act).
const STATE_PRIORITY = States.STATE_PRIORITY;
const ONESHOT_STATES = new Set(States.ONESHOT_STATES);
const ONESHOT_TTL_MS = States.ONESHOT_TTL_MS;
const VALID_STATES = new Set(States.VALID_STATES); // states the /state route accepts
const BUSY_STATES = new Set(States.BUSY_STATES);

const DONE_EVENTS = new Set(['Stop']);
const WORK_START_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']);

// Stale-cleanup thresholds (ms). An idle session whose terminal process is still
// ALIVE stays visible (never auto-slept or removed) — so every open Claude
// session keeps showing. We only retire sessions whose terminal is gone, or that
// have been silent far too long.
const WORKING_STALE_MS = 5 * 60 * 1000;   // stuck working/thinking → drop to idle (keep visible)
const CWD_ACTIVE_MS = 10 * 60 * 1000;     // 同 cwd 近期活跃窗口：期间新 SessionStart 视为进入既有工作，不欢迎
const DETACHED_REMOVE_MS = 30 * 1000;     // terminal pid dead → remove after a short grace
const SESSION_STALE_MS = 30 * 60 * 1000;  // no live terminal + this idle → remove; ended (sleeping) → remove
const BACKFILL_MAX_AGE_MS = SESSION_STALE_MS; // on boot, seed sessions whose transcript changed within this
const BACKFILL_MAX = 15;                  // cap seeded sessions

// The session's Claude Code transcript file. Prefer the real path CC hands us
// (forwarded by the hook / captured during backfill); only fall back to deriving
// it from cwd. CC encodes the project dir by replacing "/", "." AND "_" with "-"
// — the old derivation missed "_", so ~30% of projects resolved to a nonexistent
// dir and the 10s poll (interrupt / API-error / context refresh) silently died.
function transcriptPathFor(s) {
  if (!s) return null;
  if (typeof s.transcriptPath === 'string' && s.transcriptPath) return s.transcriptPath;
  if (!s.cwd || !s.id) return null;
  const enc = String(s.cwd).replace(/[/._]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', enc, `${s.id}.jsonl`);
}

function getPriority(state) {
  return STATE_PRIORITY[state] || 0;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null; // unknown
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true; // exists, not ours
    return false;
  }
}

function deriveBadge(s) {
  if (!s) return 'idle';
  const events = Array.isArray(s.recentEvents) ? s.recentEvents : [];
  const latest = events.length ? events[events.length - 1] : null;
  const ev = latest && latest.event;
  // A failure wins regardless of the current state word (octopus stores the
  // 'error' state, unlike clawd which stores idle, so check this first).
  if (ev === 'StopFailure' || ev === 'PostToolUseFailure' || ev === 'ApiError') return 'interrupted';
  if (s.state !== 'idle' && s.state !== 'sleeping') return 'running';
  if (s.state === 'sleeping') return 'idle';
  // 只认 requiresCompletionAck（真完成才置位）。之前 DONE_EVENTS.has(ev) 兜底会
  // 击穿 Stop 完成门：被抑制的 Stop（后台任务在跑 / stop-hook 续跑）也显示 done，
  // 且 ackCompletion 清了标志徽标仍在。
  if (s.requiresCompletionAck === true) return 'done';
  return 'idle';
}

function createCore(options = {}) {
  const onActivity = typeof options.onActivity === 'function' ? options.onActivity : () => {};
  const onDirty = typeof options.onDirty === 'function' ? options.onDirty : () => {};

  /** @type {Map<string, object>} */
  const sessions = new Map();
  let cleanupTimer = null;

  function setField(s, key, value) {
    if (value === undefined || value === null) return;
    s[key] = value;
  }

  // Ingest one hook state update for a session (Claude Code only).
  function updateSession(sid, incomingState, event, f = {}) {
    const id = sid || 'default';
    const now = Date.now();
    const prev = sessions.get(id);
    const isNew = !prev;
    const s = prev || { id, createdAt: now, state: 'idle', recentEvents: [] };
    const prevState = s.state;

    // Merge identity / focus fields only when provided (never clobber with null).
    setField(s, 'agentId', f.agentId);
    setField(s, 'cwd', f.cwd);
    setField(s, 'transcriptPath', f.transcriptPath);
    setField(s, 'sourcePid', f.sourcePid);
    setField(s, 'pidChain', f.pidChain);
    setField(s, 'editor', f.editor);
    setField(s, 'tmuxSocket', f.tmuxSocket);
    setField(s, 'tmuxClient', f.tmuxClient);
    setField(s, 'wtHwnd', f.wtHwnd);
    setField(s, 'ghosttyTerminalId', f.ghosttyTerminalId);
    setField(s, 'model', f.model);
    if (typeof f.headless === 'boolean') s.headless = f.headless;
    if (f.sessionTitle != null) s.sessionTitle = f.sessionTitle;
    if (f.contextUsage) s.contextUsage = f.contextUsage;
    if (f.errorType) s.errorType = f.errorType; // last API/server error kind
    // Pending emotion (per-event, one-shot). Adapter consumes it when it ships
    // the user-turn / say event; we clear AFTER consumption (see buildSnapshot
    // does not carry these — they live only on the freshly-updated session
    // between updateSession() and the onActivity() callback).
    s.pendingUserEmotion = f.userEmotion || null;
    s.pendingAssistantEmotion = f.assistantEmotion || null;
    s.pendingSessionSource = f.sessionSource || null; // SessionStart 来源，同为 per-event

    // assistant_last_output only arrives on Stop; keep prior otherwise.
    let assistantChanged = false;
    if (typeof f.assistantLastOutput === 'string' && f.assistantLastOutput) {
      if (s.assistantLastOutput !== f.assistantLastOutput) assistantChanged = true;
      s.assistantLastOutput = f.assistantLastOutput;
      s.assistantLastOutputTruncated = f.assistantLastOutputTruncated === true;
    }

    // Resolve the stored state.
    let resolvedState = VALID_STATES.has(incomingState) ? incomingState : 'idle';
    let realCompletion = false;

    // Subagent juggling: hold the "juggling" state through the subagent's tool
    // calls instead of letting the next working event overwrite it after one
    // step. Released by SubagentStop/UserPromptSubmit/Stop (non-tool events).
    if (prevState === 'juggling' && (event === 'PreToolUse' || event === 'PostToolUse')) {
      resolvedState = 'juggling';
    }

    if (event === 'Stop') {
      // #406 completion gate: a Stop with live background shells / cron wakeups /
      // a stop-hook continuation is NOT a real turn completion.
      const suppressed =
        (Number(f.backgroundTasksCount) || 0) > 0 ||
        (Number(f.sessionCronsCount) || 0) > 0 ||
        f.stopHookActive === true;
      if (suppressed) {
        resolvedState = 'idle';
      } else {
        // Store idle (NOT a lingering "attention") so the session settles and the
        // badge derives to "done" via requiresCompletionAck. The celebration is
        // event-driven (turn-done/big-done) off realCompletion, not the state.
        resolvedState = 'idle';
        realCompletion = true;
        s.requiresCompletionAck = true;
      }
    }

    // preserve_state: some hooks ask us to keep the prior steady state.
    if (f.preserveState === true && prev) resolvedState = prevState;

    // SessionEnd（含 /clear → sweeping）标记会话已结束：之后无论落在什么状态，
    // 陈旧清理都会按「已结束」回收，不再因终端 pid 还活着而永久留在列表里。
    if (event === 'SessionEnd') s.ended = true;
    else if (WORK_START_EVENTS.has(event) || event === 'SessionStart') s.ended = false;

    // 「同项目已有活跃会话」判定：点进正在执行的任务时，ccd 可能 fork 出全新
    // session id、新 transcript 未落盘、也不带 source——hook 端无从分辨。
    // 但该 cwd 必然已有忙碌/近期更新的会话，据此压掉误报的「新会话欢迎」。
    let cwdActive = false;
    if (event === 'SessionStart' && s.cwd) {
      for (const [oid, o] of sessions) {
        if (oid === id || o.headless) continue;
        if (o.cwd === s.cwd && (BUSY_STATES.has(o.state) || now - (o.updatedAt || 0) < CWD_ACTIVE_MS)) {
          cwdActive = true;
          break;
        }
      }
      log('core', `SessionStart ${id.slice(0, 8)} source=${f.sessionSource || '-'} isNew=${isNew} cwdActive=${cwdActive} cwd=${s.cwd || '-'}`);
    }

    s.state = resolvedState;
    s.sweepError = false; // 任何真实 hook 事件到达都接管状态，巡检错误标记作废
    s.lastEvent = { rawEvent: event || null, at: now };
    if (f.toolName) s.lastEventTool = f.toolName;
    s.recentEvents = pushRecentEvent(s, resolvedState, event, now);
    s.updatedAt = now;

    // New real work clears a pending completion ack.
    if (WORK_START_EVENTS.has(event)) s.requiresCompletionAck = false;

    sessions.set(id, s);

    try {
      onActivity({ session: s, event: event || null, prevState, newState: resolvedState, isNew, realCompletion, assistantChanged, cwdActive });
    } catch (err) {
      log('core', 'onActivity error:', err.message);
    }
    onDirty();
    return s;
  }

  // Mark a session as "completion acknowledged" (user saw the done state).
  function ackCompletion(sid) {
    const s = sessions.get(sid);
    if (!s || !s.requiresCompletionAck) return false;
    s.requiresCompletionAck = false;
    onDirty();
    return true;
  }

  function getSession(sid) {
    return sessions.get(sid) || null;
  }

  function toEntry(s) {
    const now = Date.now();
    return {
      id: s.id,
      agentId: s.agentId || 'claude-code',
      state: s.state || 'idle',
      badge: deriveBadge(s),
      cwd: s.cwd || '',
      headless: !!s.headless,
      sessionTitle: s.sessionTitle || null,
      model: s.model || null,
      contextUsage: s.contextUsage || null,
      assistantLastOutput: typeof s.assistantLastOutput === 'string' ? s.assistantLastOutput : null,
      assistantLastOutputTruncated: !!s.assistantLastOutputTruncated,
      requiresCompletionAck: !!s.requiresCompletionAck,
      lastEvent: s.lastEvent || null,
      lastEventTool: s.lastEventTool || null,
      updatedAt: s.updatedAt || 0,
      idleMs: Math.max(0, now - (s.updatedAt || now)),
      transcriptActiveAt: s.transcriptActiveAt || 0,
      sourcePid: s.sourcePid || null,
      pidChain: Array.isArray(s.pidChain) ? s.pidChain : null,
      editor: s.editor || null,
      tmuxSocket: s.tmuxSocket || null,
      tmuxClient: s.tmuxClient || null,
      wtHwnd: s.wtHwnd || null,
      ghosttyTerminalId: s.ghosttyTerminalId || null,
    };
  }

  function buildSnapshot() {
    const list = [...sessions.values()];
    const entries = list.map(toEntry);
    // Active = most-recently-updated non-headless session.
    let active = null;
    for (const e of entries) {
      if (e.headless) continue;
      if (!active || e.updatedAt > active.updatedAt) active = e;
    }
    return {
      sessions: entries,
      active: active
        ? { sessionId: active.id, project: active.cwd, model: active.model, lastActivity: active.updatedAt }
        : null,
      idleMs: active ? active.idleMs : null,
      lastActivityTs: active ? active.updatedAt : 0,
      ts: Date.now(),
    };
  }

  // On boot the in-memory map is empty, so the list would look empty until hooks
  // fire again (unlike clawd, which has been running and accumulated sessions).
  // Seed recently-active sessions straight from the transcripts so the list
  // matches what you've actually been working in.
  function backfillFromTranscripts() {
    let files = [];
    try {
      const cutoff = Date.now() - BACKFILL_MAX_AGE_MS;
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const sub = path.join(PROJECTS_DIR, d.name);
        let names; try { names = fs.readdirSync(sub); } catch { continue; }
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue;
          const fp = path.join(sub, n);
          let st; try { st = fs.statSync(fp); } catch { continue; }
          if (st.mtimeMs < cutoff) continue;
          files.push({ fp, mtime: st.mtimeMs, id: n.slice(0, -6) });
        }
      }
    } catch { return; }
    files.sort((a, b) => b.mtime - a.mtime);
    let added = 0;
    for (const f of files.slice(0, BACKFILL_MAX)) {
      if (sessions.has(f.id)) continue;
      let entries; try { entries = transcript.readTail(f.fp); } catch { entries = null; }
      if (!entries || !entries.length) continue;
      let cwd = '';
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i] && typeof entries[i].cwd === 'string' && entries[i].cwd) { cwd = entries[i].cwd; break; }
      }
      sessions.set(f.id, {
        id: f.id, createdAt: f.mtime, updatedAt: f.mtime,
        state: 'idle', recentEvents: [], agentId: 'claude-code',
        cwd, transcriptPath: f.fp, sessionTitle: transcript.sessionTitle(entries) || null,
        contextUsage: transcript.contextUsage(entries, f.id) || null,
        sourcePid: null, headless: false,
      });
      added++;
    }
    if (added) { log('core', `backfilled ${added} recent session(s)`); onDirty(); }
  }

  // Re-read each live session's transcript so context% tracks the real client
  // (a hook only pushes context_usage on events; between turns it would freeze).
  // 同一趟顺带检测 ESC 中断：中断不触发任何 hook 事件，只写 transcript，
  // 之前只能靠 5 分钟 WORKING_STALE 兜底，桌宠会长时间假装还在干活。
  function refreshContextUsage() {
    let changed = false;
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.headless) continue;
      const p = transcriptPathFor(s);
      if (!p) continue;
      try {
        // transcript 的 mtime = 模型最近一次产出时间。事件间隙里文件还在长，
        // 说明模型在干活（重连后继续跑/流式输出），adapter 据此不判摸鱼。
        try { s.transcriptActiveAt = fs.statSync(p).mtimeMs; } catch {}
        const entries = transcript.readTail(p);
        if (!entries) continue;
        const cu = transcript.contextUsage(entries, s.id);
        if (cu) s.contextUsage = cu;
        if (BUSY_STATES.has(s.state) && transcript.interruptedAfter(entries, s.lastEvent ? s.lastEvent.at : 0)) {
          s.state = 'idle';
          s.recentEvents = pushRecentEvent(s, 'idle', 'StopFailure', now); // 徽标 → 中断
          s.updatedAt = now;
          changed = true;
        }
        // 网络重试/API 报错同样发生在事件间隙：忙碌态（含 thinking）会话 tail
        // 出现未恢复的 API 错误 → 显示 error，而不是被「长间隙=思考」误判成思考中。
        if (BUSY_STATES.has(s.state)) {
          const apiErr = transcript.apiErrorAfter(entries, s.id, s.lastEvent ? s.lastEvent.at : 0);
          if (apiErr) {
            s.state = 'error';
            s.errorType = apiErr.errorType;
            s.sweepError = true; // 巡检发现的错误，恢复也由巡检负责
            s.recentEvents = pushRecentEvent(s, 'error', 'ApiError', now);
            s.updatedAt = now;
            changed = true;
          }
        } else if (s.sweepError && s.state === 'error') {
          if (transcript.apiErrorAfter(entries, s.id, 0)) {
            s.updatedAt = now; // 还在重试失败 → 保持 error，别被 oneshot 衰减放掉
          } else {
            s.state = 'working'; // 重试成功、回合继续 → 恢复干活（后续事件会再校正）
            s.sweepError = false;
            s.updatedAt = now;
            changed = true;
          }
        }
      } catch {}
    }
    return changed;
  }

  function cleanStaleSessions() {
    let changed = refreshContextUsage();
    const now = Date.now();
    for (const [id, s] of sessions) {
      const idle = now - (s.updatedAt || now);
      const alive = s.sourcePid ? pidAlive(s.sourcePid) : null;

      // Oneshot decay backstop: error/attention/sweeping/carrying settle to idle
      // after their TTL if no further event arrives (StopFailure / /clear paths).
      const ttl = ONESHOT_TTL_MS[s.state];
      if (ttl && idle > ttl) { s.state = 'idle'; changed = true; }

      // Ended session (SessionEnd → sleeping / clear → sweeping): retire after a while.
      if (s.state === 'sleeping' || s.ended) {
        if (idle > SESSION_STALE_MS) { sessions.delete(id); changed = true; }
        if (s.state === 'sleeping') continue;
      }
      // Terminal process is gone → remove after a short grace.
      if (alive === false && idle > DETACHED_REMOVE_MS) {
        sessions.delete(id); changed = true; continue;
      }
      // No terminal info at all + silent very long → remove.
      if (alive === null && idle > SESSION_STALE_MS) {
        sessions.delete(id); changed = true; continue;
      }
      // Stuck working/thinking → settle to idle, but KEEP it visible.
      // 「卡死」的判定用 事件时间 和 transcript 产出时间 取较新者：慢长任务
      // （17 分钟一轮、token 缓慢增长）事件少但文件一直在写，不算卡死。
      const busyIdle = now - Math.max(s.updatedAt || 0, s.transcriptActiveAt || 0);
      if (BUSY_STATES.has(s.state) && busyIdle > WORKING_STALE_MS) {
        s.state = 'idle'; changed = true;
      }
      // Idle sessions whose terminal is still alive stay visible (no auto-sleep)
      // — this is what keeps every open Claude session in the list, like clawd.
    }
    if (changed) onDirty();
  }

  function startStaleCleanup() {
    if (cleanupTimer) return;
    try { backfillFromTranscripts(); } catch (e) { log('core', 'backfill failed:', e.message); }
    cleanupTimer = setInterval(cleanStaleSessions, 10000);
    if (cleanupTimer.unref) cleanupTimer.unref();
  }

  function stopStaleCleanup() {
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  }

  return {
    sessions,
    VALID_STATES,
    updateSession,
    ackCompletion,
    getSession,
    buildSnapshot,
    cleanStaleSessions,
    startStaleCleanup,
    stopStaleCleanup,
  };
}

module.exports = {
  createCore,
  STATE_PRIORITY,
  ONESHOT_STATES,
  VALID_STATES,
  getPriority,
  deriveBadge,
};
