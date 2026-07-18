'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Agent Provider Interface (abstraction layer for multi-agent support)
// ─────────────────────────────────────────────────────────────────────────────
//
// The original Octopus was built for Claude Code only. To support CodeWhale (and
// other coding agents later) WITHOUT hard-forking, we introduce a "provider"
// abstraction. Each provider encapsulates everything agent-specific:
//
//   • where the agent stores its settings / hooks config
//   • the hook event vocabulary + the stdin JSON shape each event delivers
//   • how the agent's events map to the pet's internal state words
//   • where the agent writes session transcripts and what format they use
//   • how the agent asks for permission (blocking HTTP vs. decision-on-stdout)
//   • how to launch a fresh agent session in a terminal
//   • how token usage / cost is sourced (transcript scan vs. turn_end hook)
//
// The core (state machine, adapter, server, transport, metering aggregator) is
// agent-agnostic: it speaks the INTERNAL body shape produced by
// provider.parseHookStdin(). Adding a new agent = implementing this interface.
//
// This file is a CONTRACT + a couple of helpers. It does not run anything.
// Round 1 ships two providers:
//   • providers/claude.js   — wraps the EXISTING backend/* logic unchanged
//   • providers/codewhale.js — descriptor + stubs, filled in over later rounds
//
// Capability flags let the core gracefully degrade per provider (e.g. codewhale
// has no blocking permission HTTP hook, so it uses tool_call_before decisions).

/**
 * @typedef {Object} Provider
 * @property {string} id                       — 'claude' | 'codewhale' | ...
 * @property {string} displayName              — human label for UI / logs
 * @property {Object} dirs
 * @property {string} dirs.settingsFile        — agent's settings/hooks config file
 * @property {'json'|'toml'} dirs.settingsFormat
 * @property {string} dirs.dataHome            — agent's data root (transcripts/sessions)
 * @property {string} dirs.configDir           — agent's config dir (for reference)
 * @property {string} hookScript               — absolute path to this provider's hook script
 * @property {string} hookMarker               — substring used to recognize our hook entry
 * @property {string[]} hookEvents             — event names this provider emits
 * @property {Object<string,string>} eventToPetState — agent event → pet state word
 * @property {Object} stdinShape               — doc/shape of the hook stdin JSON
 * @property {Object} permission
 * @property {'blocking-http'|'tool_call_before_decision'} permission.mechanism
 * @property {Object} transcript
 * @property {string} transcript.rootGlob      — glob under dataHome for transcripts
 * @property {Object} pricing
 * @property {'litellm-sync'|'turn-end-hook'|'builtin-estimate'} pricing.source
 * @property {Object} capabilities             — feature flags
 * @property {boolean} capabilities.permissionBubble
 * @property {boolean} capabilities.metering
 * @property {boolean} capabilities.sessionList
 * @property {boolean} capabilities.transcriptBubble
 * @property {boolean} capabilities.focus
 * @property {boolean} capabilities.launch
 *
 * @property {function(Object=):Object} installHooks      — (port?) → {added,updated,...}
 * @property {function(Object=):Object} uninstallHooks    — ({backup?}) → {removed,...}
 * @property {function():boolean} markerPresent            — is our hook registered?
 * @property {function(string, Object):Object|null} parseHookStdin — (event, payload) → internal body
 * @property {function(Object=):Promise<Object>} launch    — ({cwd?}) → {ok, terminal?}
 * @property {function(string):Object|null} readTranscriptTail — (path) → entries[]
 * @property {function(Object[],string=):Object|null} contextUsage — (entries, sid?)
 * @property {function(Object[],string=):string|null} lastAssistantText — (entries, sid?)
 */

'use strict';

const STATES = Object.freeze([
  'idle', 'thinking', 'working', 'juggling', 'sweeping', 'talking',
  'waiting', 'needsinput', 'attention', 'happy', 'greet', 'error',
  'notification', 'loafing', 'roam', 'sleeping',
]);

// The internal hook-body shape every provider MUST produce from parseHookStdin.
// This is exactly what octopus-hook.js::buildBody already emits for Claude Code,
// so the core/adapter never have to know which agent produced it.
//
//   { state, event, session_id, cwd?, transcript_path?, tool_name?, model?,
//     api_error_type?, background_tasks_count, session_crons_count,
//     session_source?, context_usage?, session_title?, assistant_last_output?,
//     user_emotion?, assistant_emotion?, source_pid?, pid_chain?, editor?,
//     tmux_socket?, headless?, provider: '<id>' }
const INTERNAL_BODY_FIELDS = Object.freeze([
  'state', 'event', 'session_id', 'provider',
  'cwd', 'transcript_path', 'tool_name', 'model',
  'api_error_type', 'background_tasks_count', 'session_crons_count',
  'session_source', 'context_usage', 'session_title', 'assistant_last_output',
  'user_emotion', 'assistant_emotion',
  'source_pid', 'pid_chain', 'editor', 'tmux_socket', 'headless',
]);

function makeNotImplemented(providerId, fnName) {
  return function () {
    const err = new Error(`[provider:${providerId}] ${fnName} not implemented yet`);
    err.code = 'ENOTIMPL';
    err.provider = providerId;
    err.fn = fnName;
    throw err;
    };
}

// Validate that a provider object quacks like a Provider. Returns a list of
// missing required fields (empty = ok). Used by the registry at load time so a
// half-finished provider fails loudly instead of silently breaking the app.
const REQUIRED_FIELDS = Object.freeze([
  'id', 'displayName', 'dirs', 'hookScript', 'hookEvents', 'eventToPetState',
  'permission', 'transcript', 'pricing', 'capabilities',
  'installHooks', 'uninstallHooks', 'parseHookStdin',
]);

function validateProvider(p) {
  if (!p || typeof p !== 'object') return ['<not an object>'];
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    if (p[f] === undefined) missing.push(f);
  }
  if (!Array.isArray(p.hookEvents) || !p.hookEvents.length) missing.push('hookEvents(non-empty)');
  return missing;
}

module.exports = {
  STATES,
  INTERNAL_BODY_FIELDS,
  REQUIRED_FIELDS,
  validateProvider,
  makeNotImplemented,
};
