'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createPipeClient, pipeCandidates, probeDesktop, createDesktopExecutor } = require('../backend/codex-desktop');
const { createCodexExecutor } = require('../backend/codex-control');
const SID = '019f5103-921c-7ac1-9a8d-c4f8ff8a67aa';
const names = ['read_thread', 'send_message_to_thread', 'wait_threads', 'list_projects', 'create_thread'];
const tools = new Map(names.map(name => [name, { name, namespace: 'codex_app' }]));
const envelope = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });

function fixture(options = {}) {
  let sent = 0, waits = 0, closed = false;
  const prompt = 'Continue only unfinished work <test> & verify';
  const job = { sessionId: SID, action: 'continue', cwd: process.cwd(), prompt };
  const client = { close() { closed = true; }, async request(method, params) {
    assert.strictEqual(method, 'tools/call'); assert.strictEqual(params.namespace, 'codex_app');
    const delegated = { type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app',
      output: { text: `<codex_delegation>\n<source_thread_id>${SID}</source_thread_id>\n<input>${prompt}</input>\n</codex_delegation>` } };
    const actual = { id: 'new-turn', status: options.runningOnce && waits < 2 ? 'inProgress' : 'completed', items: [delegated] };
    const prior = { id: 'old-turn', status: 'completed', items: [delegated] };
    if (params.tool === 'read_thread') return envelope({ thread: { status: { type: options.active ? 'active' : 'idle' } }, turns: sent && !options.noDelivery ? [actual, prior] : [prior] });
    if (params.tool === 'send_message_to_thread') { sent++; if (options.ackError) throw new Error('Acknowledgement failed after delivery'); return envelope({ threadId: SID }); }
    if (params.tool === 'wait_threads') {
      waits++;
      if (options.waitError) throw new Error('Wait unavailable');
      return envelope({ timedOut: false, polls: [{ thread: { id: SID }, cursor: String(waits), latestTurn: sent && !options.noDelivery ? actual : prior }] });
    }
    if (params.tool === 'list_projects') return envelope({ projects: [{ projectId: 'project', hostId: 'local', path: process.cwd() }] });
    if (params.tool === 'create_thread') { sent++; return envelope({ threadId: SID }); }
    throw new Error(`Unexpected tool: ${params.tool}`);
  } };
  const executor = createDesktopExecutor({ probe: async () => ({ running: true, client, tools }), pollMs: 0, idleDelayMs: 1, maxWaitMs: options.noDelivery ? 30 : 1000 });
  return { job, executor, stats: () => ({ sent, waits, closed }) };
}

(async () => {
  assert.deepStrictEqual(pipeCandidates({ platform: 'win32', env: { CODEX_APP_TOOLS_PIPE_PATH: 'stale' }, readdir: () => ['other', 'codex-app-tools-current'] }), ['stale', '\\\\.\\pipe\\codex-app-tools-current']);
  const probed = [];
  const probe = await probeDesktop({ pipeCandidates: () => ['stale', 'live'], isRunning: () => { throw Error('Should not need process discovery'); },
    createClient: p => ({ close() { probed.push(`closed:${p}`); }, async request() { probed.push(p); if (p === 'stale') throw Error('closed'); return { tools: [...tools.values()] }; } }) });
  assert(probe.running && probe.client); assert(probed.includes('closed:stale'));
  {
    // Real framing seam: one response split across header and payload chunks.
    const socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; };
    socket.write = (frame, cb) => {
      const request = JSON.parse(frame.subarray(4));
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      setImmediate(() => { socket.emit('data', header.subarray(0, 2)); socket.emit('data', Buffer.concat([header.subarray(2), body.subarray(0, 3)])); socket.emit('data', body.subarray(3)); }); cb?.();
    };
    const client = createPipeClient('test', { connect: () => { setImmediate(() => socket.emit('connect')); return socket; } });
    assert.deepStrictEqual(await client.request('tools/list', {}), { ok: true }); client.close();
  }
  for (const options of [{}, { ackError: true }, { ackError: true, waitError: true }, { runningOnce: true }]) {
    const f = fixture(options), result = await f.executor.runIfAvailable(f.job);
    assert(result.ok, JSON.stringify({ options, result })); assert.strictEqual(result.executorRoute, 'desktop'); assert.strictEqual(result.desktopTurnId, 'new-turn');
    assert.strictEqual(f.stats().sent, 1, 'never resend after an acknowledgement failure'); assert(f.stats().closed);
    if (options.runningOnce) assert(f.stats().waits >= 2, 'submission alone is not successful completion');
  }
  {
    const f = fixture({ active: true }), result = await f.executor.runIfAvailable(f.job);
    assert.strictEqual(result.kind, 'session_busy'); assert.strictEqual(f.stats().sent, 0, 'leave active user turns alone');
  }
  {
    const f = fixture({ noDelivery: true, ackError: true }), result = await f.executor.runIfAvailable(f.job);
    assert(!result.ok); assert.strictEqual(result.kind, 'submission_unknown');
    assert.strictEqual(f.stats().sent, 1, 'an old identical prompt must not prove delivery of a new request');
  }
  {
    const f = fixture(), result = await f.executor.runIfAvailable({ ...f.job, action: 'new_task' });
    assert(result.ok); assert.strictEqual(f.stats().sent, 1);
  }
  {
    const desktop = createDesktopExecutor({ probe: async () => ({ running: true }) });
    const result = await createCodexExecutor({ desktopExecutor: desktop, spawn: () => { throw Error('Must not fall back to CLI while desktop runs'); } }).run(fixture().job);
    assert.strictEqual(result.kind, 'desktop_unavailable');
  }
  {
    let spawned = 0;
    const desktop = createDesktopExecutor({ probe: async () => ({ running: false }) });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('finish', () => { child.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n'); child.emit('close', 0); });
    const result = await createCodexExecutor({ desktopExecutor: desktop, findCli: () => 'codex.exe', spawn: () => { spawned++; return child; } }).run(fixture().job);
    assert(result.ok); assert.strictEqual(result.executorRoute, 'cli'); assert.strictEqual(spawned, 1);
  }
  console.log('Codex desktop: native IPC framing/discovery, active-turn protection, delivery reconciliation, one send, completion verification, new tasks and CLI fallback passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
