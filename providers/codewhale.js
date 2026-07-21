'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CodeWhale provider — R2-updated descriptor + working parseHookStdin.
// ─────────────────────────────────────────────────────────────────────────────
//
// UPDATED for R2 source-code facts (see worklog "附录 R2"):
//   • 11 known hook variants; Octopus registers 10 lifecycle events
//   • tool_call_before sends ENV VARS, not stdin (R2.2)
//   • Session IDs are bare UUIDs, not sess_ prefixed (R2.6)
//   • Session storage is pretty JSON <UUID>.json, not jsonl (R2.7)
//   • PATH is NOT stripped (R2.5) — no absolute node path needed
//   • Native timeout semantics may allow; Octopus bridge therefore fails closed-to-native as `ask`
//   • background=true hooks cannot deny (R2.10)
//   • Global config uses [[hooks.hooks]], project uses [[hooks]] (R2.8)

const path = require('path');
const os = require('os');
const fs = require('fs');
const { makeNotImplemented } = require('./base');
const { textFromContent, clean } = require('../backend/transcript');
const { quotePosix } = require('../backend/shell-quote');

const ID = 'codewhale';

function resolveDataHome() {
  if (process.env.CODEWHALE_HOME) return process.env.CODEWHALE_HOME;
  return path.join(os.homedir(), '.codewhale');
}
const DATA_HOME = resolveDataHome();
const LEGACY_DATA_HOME = path.join(os.homedir(), '.deepseek');

const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'codewhale-hook.js');
const HOOK_MARKER = 'codewhale-hook.js';

// ── Events (R2.1: 11 known HookEvent variants; we register 10) ───────────
// session_start / session_end give us native greet/sleep (previously thought
// impossible).  on_error gives us native error state.  mode_change is optional.
// tool_call_after is defined but turn_loop never calls it.  shell_env is
// exec_shell-only env injector, not a lifecycle hook. We skip shell_env only.
const HOOK_EVENTS = Object.freeze([
  'session_start',
  'session_end',
  'message_submit',
  'tool_call_before',
  'tool_call_after',   // W18: clear working state after each tool runs
  'turn_end',
  'subagent_spawn',
  'subagent_complete',
  'on_error',
  'mode_change',       // W23: register for mode_change (plan/agent/operate switch)
]);

// CodeWhale native event → (internal Claude-equivalent event, pet state).
// Updated per R2.1 findings.
const EVENT_MAP = Object.freeze({
  session_start:    { internal: 'SessionStart',    state: 'idle' },      // greet handled by adapter
  session_end:      { internal: 'SessionEnd',      state: 'sleeping' },
  message_submit:   { internal: 'UserPromptSubmit', state: 'thinking' },
  tool_call_before: { internal: 'PreToolUse',      state: 'working' },   // + permission gate (R3)
  tool_call_after:  { internal: 'PostToolUse',     state: 'working' },   // W18: tool finished, still working (turn continues)
  turn_end:         { internal: 'Stop',            state: 'attention' },
  subagent_spawn:   { internal: 'SubagentStart',   state: 'juggling' },
  subagent_complete: { internal: 'SubagentStop',    state: 'working' },
  on_error:         { internal: 'StopFailure',     state: 'error' },
  // mode_change is registered for forward compatibility. It does not imply a
  // task transition, so it maps to a neutral Notification/idle event.
  mode_change:      { internal: 'Notification',    state: 'idle' },
});

const eventToPetState = {};
for (const [ev, m] of Object.entries(EVENT_MAP)) eventToPetState[ev] = m.state;

// ── tool_call_before: env vars, NOT stdin (R2.2) ──────────────────────────
// CodeWhale hooks.rs:882 execute_sync() does NOT write stdin for this event.
// The hook process reads these environment variables instead:
const TCB_ENV_VARS = Object.freeze([
  'DEEPSEEK_TOOL_NAME',     // tool name (string)
  'DEEPSEEK_TOOL_ARGS',     // tool input (JSON string)
  'DEEPSEEK_MODE',          // plan | agent | operate
  'DEEPSEEK_WORKSPACE',     // workspace path
  'DEEPSEEK_MODEL',         // model name
  'DEEPSEEK_SESSION_ID',    // bare UUID (R2.6)
]);

// ── stdin shapes per event (R2.3, R2.4) ─────────────────────────────────────
const STDIN_COMMON = Object.freeze([
  'event', 'session_id', 'workspace', 'mode', 'model', 'total_tokens',
]);

// ── parseHookStdin ──────────────────────────────────────────────────────────
// Pure data transform.  For tool_call_before the caller (codewhale-hook.js)
// must assemble a synthetic payload from env vars before calling this.
// Returns null for unknown events or missing session_id.
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
  if (typeof p.workspace === 'string' && p.workspace) body.cwd = p.workspace;
  if (typeof p.model === 'string' && p.model) body.model = p.model;
  if (typeof p.mode === 'string' && p.mode) body.agent_mode = p.mode;

  switch (event) {
    case 'session_start': {
      // CodeWhale TUI startup (ui.rs:1139).  Treat as startup (not resume);
      // the core adapter handles greet debouncing.
      body.session_source = 'startup';
      break;
    }
    case 'session_end': {
      // Graceful shutdown (ui.rs:1172).  source/reason not provided by CW.
      break;
    }
    case 'message_submit': {
      if (typeof p.text === 'string' && p.text.trim()) {
        body.user_prompt = p.text;
      }
      break;
    }
    case 'tool_call_before': {
      // tool_name comes from DEEPSEEK_TOOL_NAME (assembled by hook script
      // from env vars, then passed as payload.tool_name).
      if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
      // tool_input_json stored for permission bridge (Round 3).
      if (p.tool_input_json) body.tool_input_json = p.tool_input_json;
      break;
    }
    case 'turn_end': {
      // Full accounting (R2.3 — 4 extra fields vs docs).
      const u = p.usage && typeof p.usage === 'object' ? p.usage : null;
      const t = p.totals && typeof p.totals === 'object' ? p.totals : null;
      if (u) {
        body.turn_usage = {
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cache_read: Number(u.prompt_cache_hit_tokens) || 0,
          cache_create: Number(u.prompt_cache_miss_tokens) || 0,
          cache_write: Number(u.prompt_cache_write_tokens) || 0,   // R2.3
          reasoning: Number(u.reasoning_tokens) || 0,
          reasoning_replay: Number(u.reasoning_replay_tokens) || 0, // R2.3
        };
      }
      if (t && Number(t.conversation_tokens) >= 0) {
        body.context_usage = {
          used: Number(t.conversation_tokens) || 0,
          limit: null,       // resolved from bundled catalog in Round 4 (R2.14)
          percent: null,
          source: 'codewhale',
        };
      }
      if (typeof p.provider === 'string') body.billing_provider = p.provider;
      if (typeof p.billing_surface === 'string') body.billing_surface = p.billing_surface; // R2.3
      if (typeof p.turn_id === 'string') body.turn_id = p.turn_id;
      if (typeof p.duration_ms === 'number') body.turn_duration_ms = p.duration_ms;
      if (typeof p.tool_count === 'number') body.tool_count = p.tool_count;

      const status = typeof p.status === 'string' ? p.status : '';
      if (status === 'failed' || status === 'interrupted') {
        body.state = 'error';
        body.event = 'StopFailure';
        body.api_error_type = (typeof p.error === 'string' && p.error) ? p.error : status;
      }
      break;
    }
    case 'on_error': {
      // Engine error (ui.rs:7075).  Payload shape not fully documented;
      // accept error/reason fields if present.
      if (typeof p.error === 'string' && p.error) body.api_error_type = p.error;
      else if (typeof p.reason === 'string' && p.reason) body.api_error_type = p.reason;
      break;
    }
    case 'tool_call_after':
      // W18: tool finished executing. State stays 'working' (turn continues),
      // but this event lets the pet know the tool call completed — useful for
      // clearing "stuck on tool_call_before" if turn_end never arrives.
      // tool_name may come from stdin (future CW versions) or env vars.
      if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
      break;
    case 'subagent_spawn':
      // W22: carry agent_id so core/adapter can track subagent identity.
      // session_id here is the PARENT session (the one that spawned the subagent),
      // so the pet updates the parent to 'juggling' — no session split.
      if (typeof p.agent_id === 'string' && p.agent_id) body.agent_id = p.agent_id;
      if (typeof p.prompt_preview === 'string' && p.prompt_preview) body.user_prompt = p.prompt_preview;
      break;
    case 'subagent_complete':
      // W22: carry agent_id + status for the same reason.
      if (typeof p.agent_id === 'string' && p.agent_id) body.agent_id = p.agent_id;
      if (typeof p.status === 'string' && p.status) body.api_error_type = p.status === 'failed' ? p.status : null;
      break;
    case 'mode_change': {
      // W23: CW mode switch (plan/agent/operate). State stays idle (no pet
      // state transition), but carry the new mode so the panel can show it.
      if (typeof p.to_mode === 'string' && p.to_mode) body.agent_mode = p.to_mode;
      break;
    }
    default:
      break;
  }
  return body;
}

// ── Transcript readers (R4) ────────────────────────────────────────────────
// CodeWhale sessions are pretty JSON files: <sessions_dir>/<UUID>.json
// Structure: { metadata: {...}, messages: [{role, content, ...}, ...] }
// Messages follow Anthropic API format (same as Claude's transcript entries).
// R2.7: session_manager.rs, serde_json::to_string_pretty.

const ASSISTANT_MAX = 2200;
const SESSIONS_DIR = path.join(DATA_HOME, 'sessions');
const MAX_SESSION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_LIST = 50;
const MAX_SESSION_CANDIDATES = 100;
const MAX_SESSION_SCAN_BYTES = 64 * 1024 * 1024;

// Read a CodeWhale session JSON file and return its messages array.
// path can be either the full path or just the session_id (UUID).
function resolveSessionFile(sessionPathOrId) {
  let filePath;
  if (typeof sessionPathOrId === 'string' && path.isAbsolute(sessionPathOrId)) {
    filePath = sessionPathOrId;
  } else {
    const sid = String(sessionPathOrId || '').trim();
    if (!sid || !/^[A-Za-z0-9_-]{1,256}$/.test(sid)) return null;
    filePath = path.join(SESSIONS_DIR, sid + '.json');
  }
  const base = path.resolve(SESSIONS_DIR);
  const resolved = path.resolve(filePath);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return null;
  try {
    const st = fs.lstatSync(resolved);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_SESSION_FILE_BYTES) return null;
  } catch { return null; }
  return resolved;
}

function cwReadTranscriptTail(sessionPathOrId) {
  const filePath = resolveSessionFile(sessionPathOrId);
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const msgs = data.messages;
    if (!Array.isArray(msgs)) return null;
    return msgs;
  } catch {
    return null;
  }
}

// Find the last assistant message text from a messages array.
// Reuses textFromContent/clean from backend/transcript.js (Claude's helpers).
// CodeWhale messages: {role: "assistant", content: [{type:"text", text:"..."}, ...]}
function cwLastAssistantText(entries, sid) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role !== 'assistant') continue;
    const txt = clean(textFromContent(msg.content));
    if (!txt) continue;
    return txt.length > ASSISTANT_MAX ? txt.slice(0, ASSISTANT_MAX) + '…' : txt;
  }
  return null;
}

// ── Launch (R5) ────────────────────────────────────────────────────────
// Find codewhale binary and open a terminal. R2.15: `codewhale` or `codewhale -C <workspace>`.
const { execFileSync } = require('child_process');

function findCodeWhale() {
  const candidates = ['codewhale', 'codew'];
  const plat = process.platform;

  // Windows: `command -v` doesn't exist; use built-in `where`.
  // CodeWhale npm package ships .cmd shim + .exe; NSIS installer drops .exe.
  if (plat === 'win32') {
    for (const name of candidates) {
      try {
        const out = execFileSync('where', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true });
        // Prefer .cmd/.exe over .ps1 (ps1 needs PowerShell, more friction).
        const line = out.split(/\r?\n/).map((s) => s.trim())
          .find((s) => s && !/\.ps1$/i.test(s));
        if (line) return line;
      } catch {}
    }
    // Common Windows install locations.
    const winPaths = [
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'codewhale.cmd'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'CodeWhale', 'bin', 'codewhale.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'codewhale.cmd'),
    ].filter(Boolean);
    for (const p of winPaths) { try { fs.accessSync(p); return p; } catch {} }
    return 'codewhale';
  }

  // Unix: `command` is a shell built-in, not an executable. Calling it via
  // execFileSync('command', ...) always fails on normal macOS/Linux systems.
  // Run the fixed candidate names through a POSIX shell instead and preserve
  // the caller's PATH (important for npm/nvm/homebrew installations).
  const shells = [...new Set([process.env.SHELL, '/bin/sh'].filter(Boolean))];
  for (const name of candidates) {
    for (const shell of shells) {
      try {
        const out = execFileSync(shell, ['-c', `command -v ${name} 2>/dev/null`], {
          encoding: 'utf8', timeout: 3000,
        });
        const line = out.trim().split(/\r?\n/).pop();
        if (line && path.isAbsolute(line)) return line;
      } catch {}
    }
  }
  const home = os.homedir();
  const paths = [
    path.join(home, '.npm-global', 'bin', 'codewhale'),
    path.join(home, '.local', 'bin', 'codewhale'),
    '/usr/local/bin/codewhale',
    '/opt/homebrew/bin/codewhale',
  ];
  for (const p of paths) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return 'codewhale';
}

async function cwLaunch(opts = {}) {
  const { buildCandidates, trySpawn } = require('../backend/launch');
  const bin = findCodeWhale();
  const workDir = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  for (const [cmd, args] of buildCandidates(bin, workDir)) {
    if (await trySpawn(cmd, args, { cwd: workDir })) return { ok: true, terminal: cmd };
  }
  return { ok: false, message: 'could not open a terminal for codewhale' };
}

// ── Session list (R5) ──────────────────────────────────────────────────
// Scan sessions/*.json and return metadata for each. R2.7: each file is a
// SavedSession with { metadata: { id, title, created_at, updated_at, ... } }.
function boundedMetaNumber(value, max = 1e15) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

function cleanSessionCost(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['total', 'input', 'output', 'cacheRead', 'cacheWrite']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = boundedMetaNumber(value[key], 1e12);
  }
  return Object.keys(out).length ? out : null;
}

function cwListSessions() {
  const dir = SESSIONS_DIR;
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  // Avoid synchronously parsing an unbounded directory on the Electron main
  // thread. Prefer recently modified files, reject symlinks/oversized JSON, and
  // parse at most a bounded candidate set before returning the newest 50.
  const candidates = [];
  for (const f of names) {
    try {
      const full = path.join(dir, f);
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_SESSION_FILE_BYTES) continue;
      candidates.push({ f, full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions = [];
  let bytesParsed = 0;
  const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : null;
  for (const { f, full, size } of candidates.slice(0, MAX_SESSION_CANDIDATES)) {
    if (bytesParsed + size > MAX_SESSION_SCAN_BYTES) continue;
    bytesParsed += size;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const meta = data && data.metadata;
      if (!meta || typeof meta !== 'object') continue;
      sessions.push({
        id: text(meta.id, 256) || f.replace(/\.json$/, ''),
        title: text(meta.title, 512),
        workspace: text(meta.workspace, 4096),
        model: text(meta.model, 256),
        mode: text(meta.mode, 64),
        messageCount: Math.floor(boundedMetaNumber(meta.message_count, 1e12)),
        totalTokens: Math.floor(boundedMetaNumber(meta.total_tokens, 1e15)),
        createdAt: text(meta.created_at, 128),
        updatedAt: text(meta.updated_at, 128),
        cost: cleanSessionCost(meta.cost),
      });
    } catch {}
  }
  sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return sessions.slice(0, MAX_SESSION_LIST);
}

const provider = {
  id: ID,
  displayName: 'CodeWhale',

  dirs: {
    settingsFile: path.join(DATA_HOME, 'config.toml'),
    settingsFormat: 'toml',
    dataHome: DATA_HOME,
    legacyDataHome: LEGACY_DATA_HOME,
    configDir: DATA_HOME,
    envOverride: 'CODEWHALE_HOME',
    sessionsDir: path.join(DATA_HOME, 'sessions'),
    composerStash: path.join(DATA_HOME, 'composer_stash.jsonl'),
    tasksDir: process.env.DEEPSEEK_TASKS_DIR || path.join(DATA_HOME, 'tasks'),
  },

  hookScript: HOOK_SCRIPT,
  hookMarker: HOOK_MARKER,
  hookEvents: HOOK_EVENTS,
  eventToPetState,

  stdinShape: {
    common: STDIN_COMMON,
    perEvent: {
      session_start:    STDIN_COMMON.concat(['session_source']),         // W23: startup|resume (was TBI, now documented)
      session_end:      [],
      message_submit:   STDIN_COMMON.concat(['text']),                  // R2.4
      tool_call_before: [],                                              // ★ R2.2: NO stdin — uses env vars
      tool_call_after:  STDIN_COMMON.concat(['tool_name', 'tool_result', 'status']), // W18: tool finished
      turn_end:         STDIN_COMMON.concat([                            // R2.3
        'created_at', 'model_backed', 'provider', 'billing_surface',
        'turn_id', 'status', 'error', 'duration_ms',
        'usage', 'totals', 'tool_count', 'queued_message_count',
        'stop_hook_active',
      ]),
      subagent_spawn:   STDIN_COMMON.concat(['agent_id', 'prompt_preview', 'prompt_truncated']), // R2.4
      subagent_complete: STDIN_COMMON.concat(['agent_id', 'status', 'result_preview', 'result_truncated']),
      on_error:         STDIN_COMMON.concat(['error', 'reason']),
      mode_change:      STDIN_COMMON.concat(['from_mode', 'to_mode']),   // W22: CW may fire this (plan/agent/operate)
    },
    // tool_call_before env vars (R2.2) — read by hook script, not parseHookStdin
    tcbEnvVars: TCB_ENV_VARS,
    notes: 'session_id is bare UUID (R2.6). workspace ≈ Claude cwd. tool_call_before uses env vars, not stdin.',
  },

  permission: {
    mechanism: 'tool_call_before_decision',
    decisionSchema: {
      decision: 'allow | deny | ask',
      reason: 'string (deny message to model)',
      updated_input: 'object (replaces tool input)',
      additional_context: 'string (appended to tool result)',
    },
    // R2.9: deny blocks all modes; ask suppressed by Full Access.
    // R2.10: MUST be background=false.
    // R2.11: timeout = Allow, so we must actively decide before timeout.
    blockingStrategy: 'local-http-then-stdout-json',
    endpoint: '/codewhale-permission',
    timeoutSec: 600,
    defaultDecision: 'deny',    // conservative: if pet times out, deny (R2.11 correction)
  },

  transcript: {
    // R2.7: sessions/<UUID>.json — pretty JSON, not jsonl
    rootGlob: 'sessions/*.json',
    format: 'pretty-json',
    maxSessions: 50,            // R2.7: MAX_SESSIONS
    readTail: cwReadTranscriptTail,
    lastAssistantText: cwLastAssistantText,
    contextUsage: (entries, sid) => null, // turn_end supplies this directly
  },

  pricing: {
    // R2.13: use bundled model catalog directly
    source: 'bundled-catalog',
    catalogPath: null,           // set at runtime if /tmp/CodeWhale exists
    notes: 'usage fields from turn_end × bundled catalog unit prices. No transcript scan needed.',
  },

  capabilities: {
    permissionBubble: true,    // via tool_call_before blocking bridge (round 3)
    metering: true,            // via turn_end usage aggregation (round 4)
    sessionList: true,         // via sessions/*.json scan (round 5)
    transcriptBubble: true,    // sessions/<UUID>.json messages[] (round 4, R2.7)
    focus: process.platform === 'darwin',
    launch: true,
    greetSleep: true,          // R2.1: session_start/session_end hooks exist
  },

  // ── TOML hook installer (Round 2c) ─────────────────────────────────────────
  // Delegates to backend/toml-hooks.js (merge-safe [[hooks.hooks]] manipulation).
  installHooks() {
    const tomlHooks = require('../backend/toml-hooks');
    return tomlHooks.registerHooks();
  },
  uninstallHooks(opts) {
    const tomlHooks = require('../backend/toml-hooks');
    return tomlHooks.unregisterHooks(opts || {});
  },
  markerPresent() {
    const tomlHooks = require('../backend/toml-hooks');
    return tomlHooks.markerPresent();
  },
  launch: cwLaunch,
  readTranscriptTail: cwReadTranscriptTail,
  lastAssistantText: cwLastAssistantText,

  parseHookStdin,

  // ── TOML hook entries (data-driven, for toml-hooks.js) ────────────────────
  // R2.5: PATH is NOT stripped, so `node /abs/path/codewhale-hook.js <event>`
  // is sufficient (no resolveNodeBin needed). R2.8: global uses [[hooks.hooks]].
  // R2.10: tool_call_before MUST be background=false for permission bridge.
  // W6 (Windows fix): MUST prefix with `node` — on Windows, `.js` files are
  // associated with Windows Script Host (WScript/JScript) by default, not Node.
  // Without the `node` prefix, CodeWhale's shell spawns codewhale-hook.js via
  // WScript → "无效字符" (invalid character) JScript compilation error.
  // `node` is guaranteed in PATH because CodeWhale itself requires Node.js.
  // The script path is double-quoted (handles spaces) and the whole command is
  // serialized as a TOML literal string (single quotes) in toml-hooks.js so the
  // inner double quotes don't need escaping.
  hookTomlSchema: Object.freeze({
    entries: HOOK_EVENTS.map((ev) => {
      const isPerm = ev === 'tool_call_before';
      return {
        event: ev,
        // `node` prefix is mandatory on Windows (W6). Forward slashes work in
        // Node on all platforms and avoid TOML `\` escape issues (W2).
        command: process.platform === 'win32'
          ? 'node "' + HOOK_SCRIPT.split(path.sep).join('/') + '" ' + ev
          : `${quotePosix('node')} ${quotePosix(HOOK_SCRIPT)} ${quotePosix(ev)}`,
        timeout_secs: isPerm ? 600 : 5,
        background: false,          // R2.10: must be foreground for perm
        continue_on_error: ev === 'turn_end' || ev === 'on_error',
        name: 'octopus',
      };
    }),
  }),
};

provider.listSessions = cwListSessions;
provider.findCodeWhale = findCodeWhale;

module.exports = provider;