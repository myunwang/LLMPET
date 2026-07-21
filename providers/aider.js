'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Aider provider — stub/skeleton validating the abstraction layer's extensibility.
// ─────────────────────────────────────────────────────────────────────────────
//
// Aider (https://aider.chat) is a Python-based terminal AI pair-programming tool.
// Unlike Claude Code and CodeWhale, aider does NOT have a native hook/event system.
// It supports:
//   • Notification commands (run when a response is ready)
//   • .aider.conf.yml configuration
//   • Git-based session tracking (each chat creates a git commit)
//
// This stub demonstrates that the provider abstraction layer can accommodate
// agents with fundamentally different integration approaches. A full aider
// integration would use one of:
//   (a) File-watch on .aider.chat.history.md for message events
//   (b) Process monitoring (pgrep/ps for aider Python process)
//   (c) Aider's --notification-command flag to POST to Octopus
//
// For now, all methods except parseHookStdin and installHooks/uninstallHooks are
// stubs (makeNotImplemented). parseHookStdin is a minimal implementation that
// can translate synthetic events (from a future file-watch bridge) into the
// internal body shape.

const path = require('path');
const os = require('os');
const { makeNotImplemented } = require('./base');

const ID = 'aider';

const DATA_HOME = path.join(os.homedir(), '.aider');

const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'aider-hook.js');
const HOOK_MARKER = 'aider-hook.js';

// Aider doesn't have native lifecycle hooks. These represent the events a
// future file-watch or notification-command bridge would synthesize.
// The stub hook script will only handle 'session_start' and 'turn_end' to
// demonstrate the basic flow.
const HOOK_EVENTS = Object.freeze([
  'session_start',
  'message_submit',
  'tool_call_before',
  'turn_end',
  'session_end',
]);

const EVENT_MAP = Object.freeze({
  session_start:    { internal: 'SessionStart',    state: 'idle' },
  message_submit:   { internal: 'UserPromptSubmit', state: 'thinking' },
  tool_call_before: { internal: 'PreToolUse',      state: 'working' },
  turn_end:         { internal: 'Stop',            state: 'attention' },
  session_end:      { internal: 'SessionEnd',      state: 'sleeping' },
});

const eventToPetState = {};
for (const [ev, m] of Object.entries(EVENT_MAP)) eventToPetState[ev] = m.state;

// ── parseHookStdin ──────────────────────────────────────────────────────────
// Minimal implementation: accepts a synthetic payload (from a future bridge)
// and produces the standard internal body shape.  The bridge would call this
// after detecting changes in .aider.chat.history.md or from --notification-command.
function parseHookStdin(event, payload) {
  const p = payload || {};
  const mapping = EVENT_MAP[event];
  if (!mapping) return null;

  const sid = p.session_id;
  if (typeof sid !== 'string' || !sid) return null;

  const body = {
    provider: ID,
    event: mapping.internal,
    state: mapping.state,
    session_id: sid,
    background_tasks_count: 0,
    session_crons_count: 0,
  };
  if (typeof p.cwd === 'string' && p.cwd) body.cwd = p.cwd;
  if (typeof p.model === 'string' && p.model) body.model = p.model;

  return body;
}

// ── Hook installer (minimal — just logs, doesn't modify aider config yet) ──
// A future implementation would add --notification-command to .aider.conf.yml
// or set up a file-watch bridge. For now it returns a no-op result.
function installHooks() {
  // TODO: add --notification-command to .aider.conf.yml pointing to aider-hook.js
  return { added: 0, skipped: true, reason: 'aider hooks not yet implemented (stub provider)' };
}

function uninstallHooks() {
  return { removed: 0, reason: 'aider hooks not yet implemented (stub provider)' };
}

function markerPresent() {
  return false; // No hooks installed yet
}

// ── Provider descriptor ─────────────────────────────────────────────────────
const provider = {
  id: ID,
  displayName: 'Aider',

  dirs: {
    settingsFile: path.join(DATA_HOME, '.aider.conf.yml'),
    settingsFormat: 'yaml',
    dataHome: DATA_HOME,
    configDir: DATA_HOME,
    envOverride: null, // aider doesn't have a standard env override for home
  },

  hookScript: HOOK_SCRIPT,
  hookMarker: HOOK_MARKER,
  hookEvents: HOOK_EVENTS,
  eventToPetState,

  stdinShape: {
    common: ['event', 'session_id', 'cwd', 'model'],
    perEvent: {
      session_start: [],
      message_submit: ['text'],
      tool_call_before: ['tool_name'],
      turn_end: ['status', 'error'],
      session_end: [],
    },
    notes: 'Aider has no native hook system. Events would come from a file-watch bridge or --notification-command.',
  },

  permission: {
    // Aider asks for confirmation in-terminal; no external permission hook.
    // A future bridge could intercept this via PTY parsing, but for now
    // the permission bubble is not supported.
    mechanism: 'none',
    notes: 'Aider uses in-terminal confirmation. Pet permission bubble not applicable.',
  },

  transcript: {
    // Aider stores chat history in .aider.chat.history.md (markdown format).
    // Session tracking is git-based (each chat = git commit).
    rootGlob: '**/.aider.chat.history.md',
    format: 'markdown',
    notes: 'Aider transcript is markdown, not JSON/JSONL. Parsing would need a markdown→entries adapter.',
  },

  pricing: {
    // Aider reports cost in its output. Could be parsed from response headers.
    source: 'none',
    notes: 'Aider cost tracking is not yet integrated. Would need response parsing or --verbose output scraping.',
  },

  capabilities: {
    permissionBubble: false,  // aider confirms in-terminal
    metering: false,          // no hook-based usage data
    sessionList: false,       // git-based sessions, not file-based
    transcriptBubble: false,  // markdown format, not yet parsed
    focus: false,             // no platform-specific focus support
    launch: false,            // TODO: find aider binary and open terminal
    greetSleep: false,        // no native session_start/session_end events
  },

  installHooks,
  uninstallHooks,
  markerPresent,
  parseHookStdin,

  // Stub implementations — will throw ENOTIMPL if called
  launch: makeNotImplemented(ID, 'launch'),
  readTranscriptTail: makeNotImplemented(ID, 'readTranscriptTail'),
  lastAssistantText: makeNotImplemented(ID, 'lastAssistantText'),
};

module.exports = provider;