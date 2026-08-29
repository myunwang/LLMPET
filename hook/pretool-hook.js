#!/usr/bin/env node
'use strict';

// Claude Code PreToolUse gate: auto-allows one narrow class of single
// read-only Bash commands. Everything else prints nothing and exits 0 —
// "no opinion" — leaving the normal permission flow (including the
// PermissionRequest HTTP hook that surfaces the pet bubble) in charge.
//
// Output protocol (Claude Code >= v1.0.59, verified against the official
// hooks reference): the decision MUST be nested under
//   hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision,
//                         permissionDecisionReason }
// A flat top-level `permissionDecision` is silently ignored by Claude Code.
// Exit 2 would hard-deny regardless of stdout and is deliberately not used:
// this hook only ever *allows*; denial stays with the user-facing flow.

const { isSafeReadOnlyCommand } = require('../backend/command-safety');

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_REASON_CHARS = 2000; // mirrors Claude Code's documented reason cap

function buildPreToolUseOutput(permissionDecision, reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
    },
  };
  if (reason) output.hookSpecificOutput.permissionDecisionReason = String(reason).slice(0, MAX_REASON_CHARS);
  return output;
}

function decide(payload) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return null;
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (tool === 'Bash' && isSafeReadOnlyCommand(input.command)) {
    return buildPreToolUseOutput('allow', 'LLMPET: single read-only command');
  }
  return null;
}

async function main() {
  // Collect raw Buffers and decode ONCE at the end — `raw += chunk` decodes
  // each TCP chunk separately, so a multi-byte UTF-8 char split across a
  // chunk boundary (common for CJK) became U+FFFD and killed JSON.parse.
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) return; // oversized → no opinion
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  const output = decide(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

if (require.main === module) main().catch(() => {});
module.exports = { buildPreToolUseOutput, decide };
