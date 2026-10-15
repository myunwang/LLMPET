'use strict';
const { classifyError } = require('./codex-status');

// Claude's native hooks own completion; a tool failure or API retry is not a
// terminal task failure. DSH and Codex use their own durable turn events.
function createClaudeActivityAdapter(observe, now = Date.now) {
  const turns = new Map();
  let sequence = 0;
  return function activity(act, seed = false) {
    const s = act && act.session;
    if (!s || s.agentId && s.agentId !== 'claude-code') return;
    const event = act.event;
    const at = seed ? s.updatedAt : now();
    if (event === 'UserPromptSubmit' || !turns.has(s.id)) turns.set(s.id, `${s.id}:${at}:${++sequence}`);
    let kind;
    if (seed) kind = ['thinking', 'working', 'juggling', 'sweeping'].includes(s.state) ? 'running' : s.state === 'notification' ? 'waiting_input' : 'idle';
    else if (event === 'Stop' && act.realCompletion) kind = 'completed';
    else if (act.interrupted) kind = 'interrupted';
    else if (event === 'StopFailure' || event === 'ApiError' && act.terminalError) kind = classifyError({ code: act.errorType || '' }).kind;
    else if (event === 'ApiError') kind = 'error_observed';
    else if (s.state === 'notification' || s.state === 'permission') kind = 'waiting_input';
    else if (['UserPromptSubmit', 'TaskStarted', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'Reasoning'].includes(event)
        || event === 'Stop' && !act.realCompletion) kind = 'running';
    else if (event === 'SessionEnd') kind = 'idle';
    else return;
    observe({ agent: 'claude', sessionId: s.id, turnId: turns.get(s.id), at, seed, kind,
      cwd: s.cwd || '', title: s.sessionTitle || '', model: s.model || '', transcriptPath: s.transcriptPath || '', source: 'claude-hooks' });
  };
}

module.exports = { createClaudeActivityAdapter };
