#!/usr/bin/env node
'use strict';

// PreToolUse hook — runs BEFORE Claude Code's permission system on PreToolUse.
//
// Purpose: intercept tool calls before CC asks for permission, auto-allow
// low-risk tools via `{ permissionDecision: "allow" }` stdout, and let
// high-risk tools pass through to CC's normal PermissionRequest flow.
//
// This is the SECOND layer of defense (PreToolUse command hook), complementing
// the PermissionRequest HTTP hook.  Low-risk tools short-circuit here;
// high-risk tools pass through to PermissionRequest where the user decides
// in the pet bubble.
//
// CC hook protocol for PreToolUse:
//   - Empty stdout (or no JSON) → CC proceeds with normal permission check
//   - { "permissionDecision": "allow" } → CC skips permission check, allows tool
//   - { "permissionDecision": "deny" } → CC skips permission check, denies tool
//
// Must be fast and never throw — Claude Code waits on it.
// Same passthrough lists as backend/permission.js to stay in sync.

const PASSTHROUGH_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
  'Read', 'Glob', 'Grep', 'LS',
  'WebSearch', 'TodoWrite',
]);

function checkConditionalPassthrough(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  if (toolName === 'WebFetch') {
    const url = String(input.url || '').trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return true;
    return false;
  }

  if (toolName === 'Bash') {
    const cmd = String(input.command || '').trim();
    if (!cmd) return null;
    const SAFE_PATTERNS = [
      /^(ls|cat|head|tail|less|wc|pwd|echo|date|whoami|uname|which|type|du|df|env|printenv|arch|hostname)\b/,
      /^(find|grep|rg|ag|fd|locate|tree)\b/,
      /^(git\s+(status|log|diff|show|branch|remote|describe|rev-parse|config|help))\b/,
    ];
    return SAFE_PATTERNS.some((re) => re.test(cmd)) ? true : null;
  }

  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    };
    process.stdin.on('data', (c) => {
      bytes += c.length;
      if (bytes > 16384) { chunks.length = 0; finish(); return; }
      chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 300);
  });
}

async function main() {
  const event = process.argv[2];
  // Only act on PreToolUse; all other events → pass through (no stdout).
  if (event !== 'PreToolUse') process.exit(0);

  const payload = await readStdin();
  const toolName = String(payload.tool_name || '').trim();
  const toolInput = payload.tool_input || {};

  // Passthrough tools → auto-allow (no bubble, no terminal prompt).
  if (PASSTHROUGH_TOOLS.has(toolName)) {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    process.exit(0);
  }

  // Conditional passthrough: check tool + input.
  const condResult = checkConditionalPassthrough(toolName, toolInput);
  if (condResult === true) {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    process.exit(0);
  }
  if (condResult === false) {
    process.stdout.write(JSON.stringify({ permissionDecision: 'deny' }));
    process.exit(0);
  }

  // High-risk / unknown tool → no stdout, let PermissionRequest hook handle it.
  process.exit(0);
}

if (require.main === module) main().catch(() => process.exit(0));
module.exports = { PASSTHROUGH_TOOLS, checkConditionalPassthrough };
