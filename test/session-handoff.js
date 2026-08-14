'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildHandoffPacket,
  claudeMessages,
  codexMessages,
  createSessionTakeover,
  nativeArgs,
  providerOf,
  redactSecrets,
} = require('../backend/session-handoff');

(async () => {
  console.log('[HO1] transcript extraction and redaction');
  const claudeId = '11111111-1111-4111-8111-111111111111';
  const claudeRows = [
    { type: 'user', sessionId: claudeId, message: { content: '先检查失败路径，api_key=super-secret-value' } },
    { type: 'assistant', sessionId: claudeId, message: { content: [{ type: 'text', text: '我会检查，Bearer abcdefghijklmnopqrstuvwxyz' }] } },
    { type: 'assistant', sessionId: claudeId, isSidechain: true, message: { content: 'subagent noise' } },
  ];
  const claude = claudeMessages(claudeRows, claudeId);
  assert.strictEqual(claude.length, 2);
  assert(claude[0].text.includes('api_key=[REDACTED]'));
  assert(claude[1].text.includes('Bearer [REDACTED]'));
  assert(!JSON.stringify(claude).includes('subagent noise'));

  const codexRows = [
    { type: 'event_msg', payload: { type: 'user_message', message: '继续修复真实问题' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续修复真实问题' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '正在核查' } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '已完成第一轮检查' } },
  ];
  const codex = codexMessages(codexRows);
  assert.deepStrictEqual(codex.map((item) => item.role), ['user', 'assistant', 'assistant']);
  assert.strictEqual(redactSecrets('Authorization=abc123456789 password:hello'), 'Authorization=[REDACTED] password=[REDACTED]');
  console.log('  ✓ source transcripts become a compact, secret-redacted dialogue');

  console.log('[HO2] deterministic cross-provider handoff packet');
  const packet = buildHandoffPacket({
    id: claudeId,
    agentId: 'claude-code',
    cwd: '/tmp/example-project',
    sessionTitle: '修复接管功能',
  }, {
    target: 'codex',
    locale: 'zh',
    entries: claudeRows,
    repository: 'Git status:\n## feat/session-takeover\n M renderer/pet.js',
  });
  assert(packet.includes('Provider: claude'));
  assert(packet.includes('Target provider: codex'));
  assert(packet.includes('[USER]'));
  assert(packet.includes('不要把源代理声称的“已完成”当成事实'));
  assert(packet.includes('M renderer/pet.js'));
  assert(!packet.includes('super-secret-value'));
  assert.strictEqual(providerOf({}), 'claude', 'missing agentId keeps the legacy Claude default');
  assert.strictEqual(providerOf({ agentId: 'claude-code' }), 'claude');
  assert.strictEqual(providerOf({ agentId: 'codex' }), 'codex');
  assert.strictEqual(providerOf({ agentId: 'dsh' }), 'dsh');
  assert.strictEqual(providerOf({ agentId: 'future-agent' }), 'unknown');
  console.log('  ✓ packet identifies provenance, current worktree, and verification boundaries');

  console.log('[HO3] official native resume/fork argument routing');
  assert.deepStrictEqual(nativeArgs('claude', claudeId, false), ['--resume', claudeId]);
  assert.deepStrictEqual(nativeArgs('claude', claudeId, true), ['--resume', claudeId, '--fork-session']);
  assert.deepStrictEqual(nativeArgs('codex', claudeId, false), ['resume', claudeId]);
  assert.deepStrictEqual(nativeArgs('codex', claudeId, true), ['fork', claudeId]);

  const projectRoot = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'renderer', 'pet.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(projectRoot, 'renderer', 'pet.js'), 'utf8');
  const preload = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  assert(html.includes('id="sl-takeover-view"'));
  assert(renderer.includes("window.pet.takeOverSession(source.sessionId || '', target)"));
  assert(preload.includes("ipcRenderer.invoke('session-takeover', sessionId, targetAgent)"));
  assert(main.includes("ipcMain.handle('session-takeover'"));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-handoff-test-'));
  const transcriptPath = path.join(root, 'source.jsonl');
  fs.writeFileSync(transcriptPath, claudeRows.map((row) => JSON.stringify(row)).join('\n'));
  const launches = [];
  const cleanupCallbacks = [];
  const takeover = createSessionTakeover({
    findCli: (name) => name,
    tmpdir: () => root,
    setTimeout: (callback, ms) => {
      cleanupCallbacks.push({ callback, ms });
      return { unref() {} };
    },
    launchCli: async (name, options) => {
      launches.push({
        name,
        options,
        prompt: options.promptFile ? fs.readFileSync(options.promptFile, 'utf8') : '',
      });
      return { ok: true, terminal: 'test' };
    },
  });

  const rejectedUnknown = await takeover.takeOver({
    id: claudeId,
    agentId: 'future-agent',
    state: 'idle',
    cwd: root,
  }, 'claude');
  assert.deepStrictEqual(rejectedUnknown, {
    ok: false,
    code: 'invalid-source-provider',
    source: 'unknown',
  });
  assert.strictEqual(launches.length, 0, 'unknown provider must be rejected before any native launch');
  assert.strictEqual(cleanupCallbacks.length, 0, 'unknown provider must not create a handoff temp file');

  const resumed = await takeover.takeOver({
    id: claudeId, agentId: 'codex', state: 'sleeping', cwd: root,
  }, 'codex');
  assert.strictEqual(resumed.code, 'native-resume');
  assert.deepStrictEqual(launches[0].options.args, ['resume', claudeId]);
  assert.strictEqual(launches[0].options.promptFile, undefined);

  const forked = await takeover.takeOver({
    id: claudeId, agentId: 'claude-code', state: 'working', cwd: root,
  }, 'claude');
  assert.strictEqual(forked.code, 'native-fork');
  assert.deepStrictEqual(launches[1].options.args, ['--resume', claudeId, '--fork-session']);

  const crossed = await takeover.takeOver({
    id: claudeId,
    agentId: 'claude-code',
    state: 'idle',
    cwd: root,
    transcriptPath,
    sessionTitle: 'cross test',
  }, 'codex', { locale: 'en' });
  assert.strictEqual(crossed.code, 'handoff-launched');
  assert.strictEqual(crossed.mode, 'structured-handoff');
  assert.strictEqual(launches[2].name, 'codex');
  assert.deepStrictEqual(launches[2].options.args, []);
  assert(launches[2].prompt.includes('LLMPET session handoff'));
  assert(launches[2].prompt.includes('not the other provider\'s native transcript'));
  assert.strictEqual(cleanupCallbacks.length, 1);
  assert.strictEqual(cleanupCallbacks[0].ms, 2 * 60 * 1000);
  cleanupCallbacks[0].callback();
  assert(!fs.existsSync(path.dirname(launches[2].options.promptFile)));

  const dshTranscriptPath = path.join(root, 'dsh.jsonl');
  const dshRows = [
    { type: 'session', version: 0, id: 'dsh-source-session', cwd: root },
    {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'DSH user request' }],
      },
    },
    {
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'DSH assistant answer' }],
        },
      },
    },
  ];
  fs.writeFileSync(dshTranscriptPath, dshRows.map((row) => JSON.stringify(row)).join('\n'));
  const dshSession = {
    id: 'dsh-source-session',
    agentId: 'dsh',
    state: 'idle',
    cwd: root,
    transcriptPath: dshTranscriptPath,
    sessionTitle: 'dsh source',
  };
  const dshHandoff = await takeover.takeOver(dshSession, 'claude', { locale: 'en' });
  assert.strictEqual(dshHandoff.code, 'handoff-launched');
  assert.strictEqual(dshHandoff.source, 'dsh');
  assert.strictEqual(dshHandoff.target, 'claude');
  assert.strictEqual(launches[3].name, 'claude');
  assert(launches[3].prompt.includes('Provider: dsh'));
  assert(launches[3].prompt.includes('DSH user request'));
  assert(launches[3].prompt.includes('DSH assistant answer'));
  assert.strictEqual(cleanupCallbacks.length, 2);
  cleanupCallbacks[1].callback();
  assert(!fs.existsSync(path.dirname(launches[3].options.promptFile)));

  const rejectedDshTarget = await takeover.takeOver(dshSession, 'dsh');
  assert.deepStrictEqual(rejectedDshTarget, { ok: false, code: 'invalid-provider' });
  assert.strictEqual(launches.length, 4, 'dsh remains a source, never a takeover target');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('  ✓ native sessions fork safely; dsh is a handoff source; unknown and dsh targets fail closed');

  console.log('session handoff checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
