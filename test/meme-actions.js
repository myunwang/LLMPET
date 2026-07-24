'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { loadCatalog, publicCatalog, getMeme } = require('../backend/meme-catalog');
const {
  routeForSession,
  createCommandDispatcher,
  transcriptHasPrompt,
  resolveClaudeDesktopSessionId,
} = require('../backend/command-dispatch');
const { loadRenderer } = require('./dom-stub');

async function main() {
  const root = path.join(__dirname, '..');
  const catalog = loadCatalog();
  assert.strictEqual(catalog.schemaVersion, 1);
  assert.strictEqual(catalog.items.length, 1);
  const meme = getMeme('huaqiang-guaranteed');
  assert(meme);
  assert(meme.prompt.text.includes('保熟'));
  assert(meme.prompt.text.includes('不管是代码、方案还是随口一句话'));
  assert(meme.prompt.text.includes('是你真的推敲过，还是想当然顺手一编？'));
  assert(meme.prompt.text.includes('生瓜蛋子别端上来'));
  assert(fs.existsSync(path.join(root, 'assets', 'memes', meme.media.gif)));
  assert(fs.existsSync(path.join(root, 'assets', 'memes', meme.media.audio)));
  assert.strictEqual(meme.reaction.state, 'sorry');
  assert.strictEqual(meme.reaction.durationMs, 2600);
  assert(!JSON.stringify(publicCatalog()).includes(meme.prompt.text), 'renderer catalog must not expose full prompts');
  assert.strictEqual(publicCatalog().items[0].reaction.state, 'sorry');

  assert.deepStrictEqual(
    routeForSession({ tmuxSocket: '/tmp/tmux', tmuxClient: '%3' }, 'darwin'),
    { kind: 'tmux', label: '精确直发 · tmux', exact: true },
  );
  assert.strictEqual(
    routeForSession({ terminalApp: 'terminal', terminalTty: 'ttys004' }, 'darwin').kind,
    'mac-terminal',
  );
  assert.strictEqual(routeForSession({ sourcePid: 123 }, 'darwin').kind, 'manual');
  const claudeId = '11111111-1111-4111-8111-111111111111';
  const codexId = '22222222-2222-4222-8222-222222222222';
  assert.strictEqual(routeForSession({ id: claudeId, agentId: 'claude-code' }, 'darwin').kind, 'claude-resume');
  assert.strictEqual(routeForSession({ id: claudeId, agentId: 'claude-code' }, 'linux').kind, 'claude-resume');
  assert.strictEqual(routeForSession({ id: codexId, agentId: 'codex' }, 'darwin').kind, 'codex-resume');
  assert.strictEqual(
    routeForSession({ id: codexId, agentId: 'codex', originator: 'Codex Desktop' }, 'darwin').kind,
    'codex-desktop',
  );
  assert.strictEqual(
    transcriptHasPrompt(
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: meme.prompt.text + '\n' } }),
      meme.prompt.text,
    ),
    true,
  );
  assert.strictEqual(
    transcriptHasPrompt(
      JSON.stringify({ type: 'user', message: { role: 'user', content: meme.prompt.text + '\n' } }),
      meme.prompt.text,
    ),
    true,
  );

  const claudeDesktopRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'llmpet-claude-sessions-'));
  const claudeDesktopId = 'local_33333333-3333-4333-8333-333333333333';
  const claudeDesktopDir = path.join(claudeDesktopRoot, 'account', 'workspace');
  fs.mkdirSync(claudeDesktopDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDesktopDir, `${claudeDesktopId}.json`),
    JSON.stringify({ sessionId: claudeDesktopId, cliSessionId: claudeId }),
  );
  assert.strictEqual(resolveClaudeDesktopSessionId(claudeId, claudeDesktopRoot), claudeDesktopId);

  const calls = [];
  const dispatcher = createCommandDispatcher({
    platform: 'darwin',
    execFile: (file, args, _opts, cb) => {
      calls.push([file, args]);
      cb(null, file === 'osascript' ? 'ok\n' : '', '');
    },
    copyText: (text) => calls.push(['copy', text]),
    focusSession: async () => true,
  });
  const exact = await dispatcher.dispatch({ terminalApp: 'terminal', terminalTty: 'ttys004' }, meme.prompt.text);
  assert.strictEqual(exact.submitted, true);
  assert.strictEqual(exact.route, 'mac-terminal');
  assert(calls.some((c) => c[0] === 'copy'));
  assert(calls.some((c) => c[0] === 'osascript'));

  const fallback = await dispatcher.dispatch({ sourcePid: 123 }, meme.prompt.text);
  assert.strictEqual(fallback.ok, true);
  assert.strictEqual(fallback.submitted, false);
  assert.strictEqual(fallback.copied, true);

  const resumeCalls = [];
  const resumeDispatcher = createCommandDispatcher({
    platform: 'linux',
    resumeProbeMs: 1,
    findCli: (name) => `/fake/${name}`,
    execFile: (file, args, _opts, cb) => {
      if (file === '/fake/claude' && args[0] === 'auth') {
        cb(null, JSON.stringify({ loggedIn: true }), '');
        return;
      }
      cb(null, '', '');
    },
    verifyPrompt: async () => true,
    spawn: (file, args, opts) => {
      resumeCalls.push([file, args, opts]);
      const child = new EventEmitter();
      child.pid = 4321;
      child.exitCode = null;
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
  });
  const claudeResume = await resumeDispatcher.dispatch({ id: claudeId, agentId: 'claude-code', cwd: root }, meme.prompt.text);
  assert.strictEqual(claudeResume.submitted, true);
  assert.strictEqual(claudeResume.route, 'claude-resume');
  assert.deepStrictEqual(resumeCalls[0][1].slice(0, 4), ['--print', '--resume', claudeId, '--output-format']);
  assert.strictEqual(resumeCalls[0][2].env.LLMPET_MEME_RESUME, '1');
  const codexResume = await resumeDispatcher.dispatch({ id: codexId, agentId: 'codex', cwd: root }, meme.prompt.text);
  assert.strictEqual(codexResume.submitted, true);
  assert.strictEqual(codexResume.route, 'codex-resume');
  assert.deepStrictEqual(resumeCalls[1][1].slice(0, 5), ['exec', 'resume', '--json', '--skip-git-repo-check', codexId]);

  let loggedOutClaudeSpawned = false;
  const loggedOutClaudeDispatcher = createCommandDispatcher({
    platform: 'darwin',
    findCli: () => '/fake/claude',
    execFile: (_file, _args, _opts, cb) => {
      cb(null, JSON.stringify({ loggedIn: false, authMethod: 'none' }), '');
    },
    spawn: () => {
      loggedOutClaudeSpawned = true;
      throw new Error('logged-out Claude must not start a background CLI');
    },
    copyText: () => {},
    focusSession: async () => true,
  });
  const loggedOutClaudeFallback = await loggedOutClaudeDispatcher.dispatch(
    { id: claudeId, agentId: 'claude-code', cwd: root },
    meme.prompt.text,
  );
  assert.strictEqual(loggedOutClaudeFallback.submitted, false);
  assert.strictEqual(loggedOutClaudeFallback.route, 'manual');
  assert.strictEqual(loggedOutClaudeSpawned, false);

  const desktopCalls = [];
  const desktopDispatcher = createCommandDispatcher({
    platform: 'darwin',
    desktopOpenDelayMs: 0,
    copyText: (text) => desktopCalls.push(['copy', text]),
    openCodexThread: async (id) => { desktopCalls.push(['open', id]); return true; },
    execFile: (file, args, _opts, cb) => {
      desktopCalls.push([file, args]);
      cb(null, 'ok\n', '');
    },
    verifyPrompt: async (_session, prompt) => {
      desktopCalls.push(['verify', prompt]);
      return true;
    },
  });
  const codexDesktop = await desktopDispatcher.dispatch({
    id: codexId,
    agentId: 'codex',
    originator: 'Codex Desktop',
    transcriptPath: path.join(root, 'fake-rollout.jsonl'),
  }, meme.prompt.text);
  assert.strictEqual(codexDesktop.submitted, true);
  assert.strictEqual(codexDesktop.route, 'codex-desktop');
  assert.deepStrictEqual(desktopCalls.find((c) => c[0] === 'open'), ['open', codexId]);
  assert(desktopCalls.some((c) => c[0] === 'osascript'));
  assert(desktopCalls.some((c) => c[0] === 'verify'));

  const claudeDesktopCalls = [];
  const claudeDesktopDispatcher = createCommandDispatcher({
    platform: 'darwin',
    desktopOpenDelayMs: 0,
    openClaudeThread: async (id) => { claudeDesktopCalls.push(['open-claude', id]); return true; },
    resolveClaudeDesktopSession: () => claudeDesktopId,
    getNativeHelper: async () => '/fake/drag-window',
    execFile: (file, args, _opts, cb) => {
      claudeDesktopCalls.push([file, args]);
      cb(null, 'ok\n', '');
    },
    verifyPrompt: async (_session, prompt) => {
      claudeDesktopCalls.push(['verify-claude', prompt]);
      return true;
    },
  });
  const originalResolver = resolveClaudeDesktopSessionId;
  const claudeDesktop = await claudeDesktopDispatcher.dispatch({
    id: claudeId,
    agentId: 'claude-code',
    transcriptPath: path.join(root, 'fake-claude-transcript.jsonl'),
  }, meme.prompt.text);
  // The injected resolver upgrades this UUID to the exact Desktop route even
  // when the developer machine has no matching real metadata.
  assert.strictEqual(typeof originalResolver, 'function');
  assert.strictEqual(claudeDesktop.submitted, true);
  assert.strictEqual(claudeDesktop.route, 'claude-desktop');
  assert.deepStrictEqual(
    claudeDesktopCalls.find((c) => c[0] === 'open-claude'),
    ['open-claude', claudeDesktopId],
  );
  const claudeHelperCall = claudeDesktopCalls.find((c) => c[0] === '/fake/drag-window');
  assert(claudeHelperCall);
  assert.deepStrictEqual(
    claudeHelperCall[1],
    ['--set-claude-prompt', meme.prompt.text, 'submit'],
  );
  assert(claudeDesktopCalls.some((c) => c[0] === 'verify-claude'));
  const nativeHelperSource = fs.readFileSync(path.join(root, 'backend', 'drag-window.swift'), 'utf8');
  assert(nativeHelperSource.includes('windowCommand == "--set-claude-prompt"'));
  assert(nativeHelperSource.includes('kAXTextAreaRole'));
  assert(nativeHelperSource.includes('kAXDescriptionAttribute as CFString) == "Prompt"'));
  assert(nativeHelperSource.includes('SLEventPostToPid(pid, down)'));

  const html = fs.readFileSync(path.join(root, 'renderer', 'pet.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'renderer', 'pet.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'pet.css'), 'utf8');
  assert(html.includes('id="sl-meme-view"'));
  assert(html.includes('id="meme-player"'));
  assert(js.includes('window.pet.triggerMeme(target.sessionId, meme.id)'));
  assert(js.includes('function alignMemePlayer()'));
  assert(js.includes('if (memeLayoutActive)'));
  assert(css.includes('.sl-meme-entry'));
  assert(!css.includes('left: calc(50% + 112px)'), 'meme position must follow the real pet rect');
  assert(css.includes('#sl-session-view.hidden'), 'meme page must fully hide the session list view');

  const world = loadRenderer(['shared/states.js', 'renderer/pet.js']);
  assert.strictEqual(typeof world.handlers.meme, 'function');
  world.handlers.config({ skin: 'cat', muted: true });
  world.handlers.meme({
    id: 'huaqiang-guaranteed',
    label: '你这瓜保熟吗？',
    project: 'demo-session',
    media: {
      gif: 'huaqiang-guaranteed/visual.gif',
      audio: 'huaqiang-guaranteed/voice.mp3',
      durationMs: 1,
      placement: 'pet-right',
    },
    reaction: { state: 'sorry', durationMs: 1, label: '汗流浃背，马上复验' },
  });
  assert(world.calls.some((c) => c[0] === 'setPetSize' && c[1][0] === 760));
  assert.strictEqual(world.elements('meme-image').src, '../assets/memes/huaqiang-guaranteed/visual.gif');
  assert(world.elements('cat').classList.contains('sorry'));
  assert(world.elements('cat-img').src.endsWith('cat-waiting.gif'));
  world.handlers.event({ kind: 'user-turn', project: 'demo-session' });
  assert(world.elements('cat').classList.contains('sorry'), 'meme reaction must outlive its own prompt event');
  assert(!world.elements('meme-player').classList.contains('hidden'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert(world.elements('meme-player').classList.contains('hidden'));

  console.log('meme actions tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
