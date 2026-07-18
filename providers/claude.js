'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code provider — wraps the EXISTING backend/* logic, unchanged.
// ─────────────────────────────────────────────────────────────────────────────
//
// This provider is the reference implementation. It does NOT refactor any
// existing module: it simply re-exports hookinstall / transcript / launch /
// octopus-hook.buildBody through the Provider interface so the core can treat
// Claude Code and CodeWhale uniformly.
//
// Behaviour is byte-for-byte identical to the original app when this provider is
// active (the default). All agent-specific facts live here as data so they can
// be diffed against providers/codewhale.js.

const path = require('path');
const os = require('os');

const hookinstall = require('../backend/hookinstall');
const transcript = require('../backend/transcript');
const launch = require('../backend/launch');
const transport = require('../backend/transport');
// octopus-hook.js exports { buildBody, EVENT_STATE } — buildBody is exactly the
// "claude stdin + transcript enrichment → internal body" transform we need.
const hook = require('../hook/octopus-hook');

const ID = 'claude';

const provider = {
  id: ID,
  displayName: 'Claude Code',

  dirs: {
    // Where Claude Code reads its hook settings. hookinstall owns this path.
    settingsFile: hookinstall.SETTINGS_PATH,            // ~/.claude/settings.json
    settingsFormat: 'json',
    // Where Claude Code writes per-session transcripts (read-only, for metering).
    dataHome: path.join(os.homedir(), '.claude'),
    configDir: path.join(os.homedir(), '.claude'),
  },

  hookScript: hookinstall.HOOK_SCRIPT,                  // .../hook/octopus-hook.js
  hookMarker: hookinstall.MARKER,                       // 'octopus-hook.js'

  // Lifecycle events Claude Code fires (command hooks) + the blocking permission
  // HTTP hook. COMMAND_EVENTS comes from hookinstall so the two never drift.
  hookEvents: hookinstall.COMMAND_EVENTS.concat(['PermissionRequest']),

  // Claude event → pet state. Mirrors octopus-hook.js::EVENT_STATE exactly.
  eventToPetState: Object.assign({}, hook.EVENT_STATE),

  stdinShape: {
    // Claude Code pipes a JSON object on stdin for each lifecycle hook. Fields
    // actually consumed by buildBody:
    fields: [
      'session_id', 'cwd', 'transcript_path', 'tool_name', 'model',
      'source', 'reason', 'trigger', 'prompt',
      'stop_hook_active', 'background_tasks', 'session_crons',
      'api_error_type', 'error', 'failure_kind',
    ],
    notes: 'session_id is mandatory; missing/empty → hook drops the event.',
  },

  permission: {
    // Claude Code posts a blocking HTTP request to /permission and waits for our
    // allow/deny JSON response. backend/permission.js implements the holder.
    mechanism: 'blocking-http',
    endpoint: transport.PERMISSION_PATH,                 // '/permission'
    timeoutSec: 600,
  },

  transcript: {
    // ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
    rootGlob: 'projects/**/*.jsonl',
    format: 'jsonl',
    readTail: transcript.readTail,
    lastAssistantText: transcript.lastAssistantText,
    contextUsage: transcript.contextUsage,
    apiError: transcript.apiError,
    sessionTitle: transcript.sessionTitle,
    hasHistory: transcript.hasHistory,
  },

  pricing: {
    // backend/pricing-sync.js pulls the LiteLLM public price sheet every 24h;
    // backend/metering.js multiplies transcript token counts by family/model
    // unit prices. Falls back to a builtin estimate when offline.
    source: 'litellm-sync',
    cachePath: path.join(os.homedir(), '.octopus', 'pricing.json'),
  },

  capabilities: {
    permissionBubble: true,
    metering: true,
    sessionList: true,
    transcriptBubble: true,
    focus: process.platform === 'darwin',   // backend/focus.js is mac-only today
    launch: true,
  },

  // ── delegating implementations ────────────────────────────────────────────
  installHooks(port) {
    return hookinstall.registerHooks(port);
  },
  uninstallHooks(opts) {
    return hookinstall.unregisterHooks(opts || {});
  },
  markerPresent() {
    return hookinstall.markerPresent();
  },
  // (event, payload) → internal body (or null to drop). buildBody also performs
  // transcript enrichment + pidwalk, which is the original behaviour.
  parseHookStdin(event, payload) {
    return hook.buildBody(event, payload || {});
  },
  launch(opts) {
    return launch.launchClaude(opts);
  },
  // Pass-throughs for the transcript helpers (kept explicit so the core can call
  // provider.transcript.readTail OR provider.readTranscriptTail uniformly).
  readTranscriptTail(p) {
    return transcript.readTail(p);
  },
  contextUsage(entries, sid) {
    return transcript.contextUsage(entries, sid);
  },
  lastAssistantText(entries, sid) {
    return transcript.lastAssistantText(entries, sid);
  },
};

module.exports = provider;
