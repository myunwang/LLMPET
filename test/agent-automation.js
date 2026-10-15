'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createAgentAutomation } = require('../backend/codex-automation');
const { createAgentExecutor } = require('../backend/agent-control');
const { createClaudeActivityAdapter } = require('../backend/agent-events');
const { createCodexWatch } = require('../backend/codex-watch');
const { createDshWatch } = require('../backend/dsh-watch');
const { createCore } = require('../backend/core');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-multi-agent-'));
const sid = '019f5103-921c-7ac1-9a8d-c4f8ff8a67aa';
const settle = () => new Promise(r => setImmediate(r));
const make = name => createAgentAutomation({ statePath: path.join(root, `${name}.json`) });
const rule = (agent, patch = {}) => ({ agent, sessionId: agent === 'dsh' ? 'ses_test' : sid,
  trigger: 'ended', action: 'shutdown', enabled: true, ...patch });
const event = (agent, patch = {}) => ({ agent, sessionId: agent === 'dsh' ? 'ses_test' : sid,
  kind: 'completed', turnId: 'turn-1', at: Date.now(), cwd: root, ...patch });
function fakeChild() { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.kill = () => {}; return c; }

(async () => {
  const engine = make('identities');
  for (const agent of ['codex', 'claude', 'dsh']) { engine.saveRule(rule(agent)); engine.observe(event(agent)); }
  assert.strictEqual(engine.snapshot().sessions.length, 3);
  assert.strictEqual(engine.snapshot().jobs.length, 3, 'same UUID in different agents must not collide');
  engine.observe(event('claude', { kind: 'running', turnId: 'turn-2' }));
  assert.strictEqual(engine.snapshot().jobs.find(j => j.agent === 'claude').status, 'cancelled');
  assert.strictEqual(engine.snapshot().jobs.find(j => j.agent === 'codex').status, 'scheduled');
  assert.throws(() => engine.saveRule(rule('dsh', { action: 'wait_quota', trigger: 'quota_exhausted' })), /Quota recovery/);
  const legacyPath = path.join(root, 'legacy.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, rules: [{ ...rule('codex'), agent: undefined }], jobs: [], history: [], seen: [], counts: {}, quotas: {} }));
  assert.strictEqual(createAgentAutomation({ statePath: legacyPath }).snapshot().rules[0].agent, 'codex', 'old rules migrate without deleting user settings');

  {
    const e = make('claude-hooks'); const observe = createClaudeActivityAdapter(x => e.observe(x));
    const core = createCore({ onActivity: observe }); e.saveRule(rule('claude', { maxRuns: 5 }));
    core.updateSession(sid, 'thinking', 'UserPromptSubmit', { agentId: 'claude-code', cwd: root });
    core.updateSession(sid, 'error', 'PostToolUseFailure', { agentId: 'claude-code' });
    core.updateSession(sid, 'error', 'ApiError', { agentId: 'claude-code' });
    assert.strictEqual(e.snapshot().jobs.length, 0, 'tool/API errors do not prove terminal failure');
    core.updateSession(sid, 'attention', 'Stop', { agentId: 'claude-code', stopHookActive: true });
    assert.strictEqual(e.snapshot().jobs.length, 0, 'stop-hook continuation is not completion');
    core.updateSession(sid, 'attention', 'Stop', { agentId: 'claude-code', stopHookActive: false });
    assert.strictEqual(e.snapshot().jobs.length, 1);
    assert.strictEqual(e.snapshot().jobs[0].agent, 'claude');
    core.updateSession(sid, 'thinking', 'UserPromptSubmit', { agentId: 'claude-code' });
    core.updateSession(sid, 'error', 'StopFailure', { agentId: 'claude-code', errorType: 'server_error' });
    assert.strictEqual(e.snapshot().jobs[0].trigger, 'transient_error', 'native Claude StopFailure is a terminal API failure, not a user interruption');
    core.updateSession(sid, 'thinking', 'UserPromptSubmit', { agentId: 'claude-code' });
    core.updateSession(sid, 'error', 'ApiError', { agentId: 'claude-code', errorType: 'insufficient_quota', apiErrorTerminal: true });
    assert.strictEqual(e.snapshot().jobs[0].trigger, 'quota_exhausted', 'Stop hook enrichment preserves terminal quota failures');
  }
  {
    const sessions = path.join(root, 'stale-mtime');
    const day = new Date(); const dir = path.join(sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `rollout-frozen-${sid}.jsonl`);
    const line = obj => JSON.stringify({ timestamp: new Date().toISOString(), ...obj }) + '\n';
    fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: sid, cwd: root } })
      + line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'active' } })
      + line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }));
    const old = new Date(Date.now() - 3 * 3600000); fs.utimesSync(file, old, old);
    const core = createCore(), events = [];
    const watcher = createCodexWatch({ core, sessionsDir: sessions, onStatus: e => events.push(e) }); watcher.tick();
    assert.strictEqual(core.sessions.get(sid).state, 'working', 'fresh log events override frozen filesystem mtime at startup');
    assert(events.every(e => e.seed), 'startup recovery is silent');
    fs.appendFileSync(file, line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'active' } })); fs.utimesSync(file, old, old);
    watcher.tick(); assert(events.some(e => e.kind === 'completed' && !e.seed));
    assert.strictEqual(core.sessions.get(sid).state, 'idle');
    assert(core.sessions.get(sid).transcriptActiveAt > old.getTime());
  }
  {
    const dir = path.join(root, 'dsh', 'project', 'ses_test'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 0, id: 'ses_test', cwd: root }) + '\n');
    const e = make('dsh-events'); e.saveRule(rule('dsh'));
    const w = createDshWatch({ core: createCore(), sessionsDir: path.join(root, 'dsh'), onStatus: x => e.observe(x) }); w.tick();
    const append = (type, data, seq) => fs.appendFileSync(file, JSON.stringify({ type, data, seq, time: new Date().toISOString() }) + '\n');
    append('turn/start', { turn: 1 }, 1); append('llm/retry', { message: 'network' }, 2); w.tick();
    assert.strictEqual(e.snapshot().jobs.length, 0);
    append('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3); w.tick();
    assert.strictEqual(e.snapshot().jobs.length, 1); assert.strictEqual(e.snapshot().jobs[0].agent, 'dsh');
  }
  for (const agent of ['claude', 'dsh']) {
    const child = fakeChild(); let args;
    const executor = createAgentExecutor({ findCli: name => `${name}.exe`, spawn: (_bin, a) => { args = a; return child; } });
    const p = executor.run({ agent, sessionId: agent === 'claude' ? sid : 'ses_test', action: 'continue', cwd: root, prompt: 'continue' });
    if (agent === 'claude') child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid }) + '\n');
    else child.stdout.write(JSON.stringify({ type: 'session', sessionId: 'ses_test' }) + '\n'
      + JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }) + '\n' + JSON.stringify({ type: 'final', text: '' }) + '\n');
    child.emit('close', 0); assert((await p).ok);
    assert(args.includes(agent === 'claude' ? '--resume' : '--session-id'));
    assert(!args.some(a => /bypass|skip-permissions/.test(a)));
    const failed = fakeChild(); const x = createAgentExecutor({ findCli: () => `${agent}.exe`, spawn: () => failed });
    const result = x.run({ agent, sessionId: sid, action: 'new_task', cwd: root, prompt: 'test' });
    failed.stdout.write(JSON.stringify({ type: 'final', text: 'unconfirmed' }) + '\n'); failed.emit('close', 0);
    assert(!(await result).ok, 'zero exit / final text alone is insufficient');
  }
  await settle();
  console.log('Agent automation: frozen-mtime recovery, namespace isolation, legacy rules, Claude hooks, DSH logs and native CLI outcomes passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
