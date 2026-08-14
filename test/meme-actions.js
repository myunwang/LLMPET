'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { loadCatalog, createCatalogStore, publicCatalog, getMeme } = require('../backend/meme-catalog');
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
  assert.strictEqual(catalog.schemaVersion, 2);
  assert.strictEqual(catalog.items.length, 4);
  for (const item of catalog.items) {
    assert(item.media.gif.startsWith(item.id + '/'), `${item.id}: gif must live in its own directory`);
    assert(item.media.audio.startsWith(item.id + '/'), `${item.id}: audio must live in its own directory`);
    assert(fs.existsSync(path.join(root, 'assets', 'memes', item.media.gif)));
    assert(fs.existsSync(path.join(root, 'assets', 'memes', item.media.audio)));
    assert(item.provenance && item.provenance.license, `${item.id}: provenance is required`);
  }
  const meme = getMeme('huaqiang-guaranteed');
  assert(meme);
  assert(meme.prompt.text.includes('保熟'));
  assert(meme.prompt.text.includes('不管是代码、方案还是随口一句话'));
  assert(meme.prompt.text.includes('是你真的推敲过，还是想当然顺手一编？'));
  assert(meme.prompt.text.includes('生瓜蛋子别端上来'));
  assert.strictEqual(meme.prompt.version, 7);
  assert(meme.prompt.text.includes('认错不算交付'));
  assert(meme.prompt.text.includes('主动找一个能推翻“已经完成”的反例'));
  assert(meme.prompt.text.includes('没完成就继续干'));
  assert(meme.i18n.en.promptText.includes('an apology is not a deliverable'));
  assert(meme.i18n.en.promptText.includes('Actively look for one counterexample'));
  assert(meme.i18n.ja.promptText.includes('謝罪は成果物ではありません'));
  assert(meme.i18n.ja.promptText.includes('反例を自分から一つ探す'));
  assert(fs.existsSync(path.join(root, 'assets', 'memes', meme.media.gif)));
  assert(fs.existsSync(path.join(root, 'assets', 'memes', meme.media.audio)));
  assert.strictEqual(meme.reaction.state, 'sorry');
  assert.strictEqual(meme.reaction.durationMs, 2600);
  assert(meme.reaction.work);
  assert.strictEqual(meme.reaction.work.durationMs, 30000);
  assert.strictEqual(meme.reaction.work.visualState, 'sorry');
  assert.deepStrictEqual(
    [...meme.reaction.work.activeStates],
    ['idle', 'sleeping', 'thinking', 'working', 'juggling', 'sweeping', 'loafing'],
  );
  assert(!JSON.stringify(publicCatalog()).includes(meme.prompt.text), 'renderer catalog must not expose full prompts');
  assert.strictEqual(publicCatalog().items[0].reaction.state, 'sorry');
  assert.strictEqual(publicCatalog().items[0].reaction.work.durationMs, 30000);
  assert(/^[a-f0-9]{16}$/.test(publicCatalog().revision), 'public catalog must expose a cache revision');
  assert(/^[a-f0-9]{16}$/.test(publicCatalog().items[0].media.version), 'media must expose a cache version');

  const niGanMa = getMeme('ni-gan-ma');
  assert(niGanMa);
  assert.strictEqual(niGanMa.prompt.text,
    '你干嘛呀～我正专心弄一件事呢，你在旁边一通乱插——顺手改了别的文件，捎带提了一堆我没问的建议，还把话题带到别处去了。哎哟，你好烦。\n\n'
    + '回来。只做我正在推的那一件事，别的全放下：无关的改动撤掉，没问的建议先憋着，我问了你再说。\n\n'
    + '把那一件事做完做透，跑一遍给我看。中间别再打岔了。');
  assert.strictEqual(niGanMa.reaction.state, 'puzzled');
  assert.strictEqual(niGanMa.reaction.durationMs, 4400);
  assert(!JSON.stringify(publicCatalog()).includes(niGanMa.prompt.text), 'renderer catalog must not expose the ni-gan-ma prompt');

  const nobodyKnowsBetter = getMeme('nobody-knows-better');
  assert(nobodyKnowsBetter);
  assert.strictEqual(nobodyKnowsBetter.prompt.version, 1);
  assert(nobodyKnowsBetter.prompt.text.startsWith('没有人比我更懂我刚才问的这件事'));
  assert(nobodyKnowsBetter.prompt.text.includes('你拿猜测来，我只收证据'));
  assert(nobodyKnowsBetter.prompt.text.includes('然后真的去查'));
  assert(nobodyKnowsBetter.prompt.text.includes('哪些说法有直接证据'));
  assert(nobodyKnowsBetter.prompt.text.includes('别再嘴硬'));
  assert.strictEqual(nobodyKnowsBetter.reaction.state, 'sorry');
  assert.strictEqual(nobodyKnowsBetter.reaction.durationMs, 2000);
  assert(nobodyKnowsBetter.i18n.en.promptText.includes('Nobody knows the thing I just asked about better than me'));
  assert(nobodyKnowsBetter.i18n.en.promptText.includes('bring me an answer worth closing'));
  assert(nobodyKnowsBetter.i18n.ja.promptText.includes('事実だ'));
  assert(!JSON.stringify(publicCatalog()).includes(nobodyKnowsBetter.prompt.text),
    'renderer catalog must not expose the nobody-knows-better prompt');

  const focusOnImportantThings = getMeme('focus-on-important-things');
  assert(focusOnImportantThings);
  assert.strictEqual(focusOnImportantThings.prompt.version, 1);
  assert(focusOnImportantThings.prompt.text.startsWith('我现在要把精力放到其他更重要的事情上'));
  assert(focusOnImportantThings.prompt.text.includes('那还叫全权交给你吗'));
  assert(focusOnImportantThings.prompt.text.includes('发现当前路线不通就换一条继续'));
  assert(focusOnImportantThings.prompt.text.includes('只有三种情况可以中途叫我'));
  assert(focusOnImportantThings.prompt.text.endsWith('我还要把精力放到其他更重要的事情上。'));
  assert.strictEqual(focusOnImportantThings.media.durationMs, 11800);
  assert.strictEqual(focusOnImportantThings.reaction.state, 'working');
  assert.strictEqual(focusOnImportantThings.reaction.durationMs, 11800);
  assert(focusOnImportantThings.i18n.en.promptText.includes('other, more important matters'));
  assert(focusOnImportantThings.i18n.en.promptText.includes('Routine problems do not require escalation'));
  assert(focusOnImportantThings.i18n.ja.promptText.includes('ほかのもっと重要なこと'));
  assert(!JSON.stringify(publicCatalog()).includes(focusOnImportantThings.prompt.text),
    'renderer catalog must not expose the focus-on-important-things prompt');

  // Resource-only edits must become visible without restarting the backend.
  const hotRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'llmpet-memes-hot-'));
  const hotItemDir = path.join(hotRoot, 'hot-item');
  const hotCatalogPath = path.join(hotRoot, 'catalog.json');
  fs.mkdirSync(hotItemDir, { recursive: true });
  fs.writeFileSync(path.join(hotItemDir, 'visual.gif'), Buffer.from('GIF89a-gif-v1'));
  fs.writeFileSync(path.join(hotItemDir, 'voice.mp3'), Buffer.from('ID3audio-v1'));
  const hotRaw = {
    schemaVersion: 2,
    items: [{
      id: 'hot-item',
      label: 'v1',
      provenance: {
        origin: 'test',
        creator: 'test',
        sourceUrl: null,
        license: 'cleared',
        commercialUse: true,
      },
      media: { gif: 'hot-item/visual.gif', audio: 'hot-item/voice.mp3' },
      prompt: { version: 1, text: 'hot prompt' },
      reaction: { state: 'puzzled' },
    }],
  };
  fs.writeFileSync(hotCatalogPath, JSON.stringify(hotRaw));
  const hotStore = createCatalogStore({ catalogPath: hotCatalogPath, pollMs: 20 });
  const hotV1 = hotStore.publicCatalog();
  hotRaw.items[0].label = 'v2-updated';
  fs.writeFileSync(hotCatalogPath, JSON.stringify(hotRaw));
  const hotV2 = hotStore.publicCatalog();
  assert.strictEqual(hotV2.items[0].label, 'v2-updated', 'catalog edits must reload on demand');
  assert.notStrictEqual(hotV2.revision, hotV1.revision, 'catalog edit must change the public revision');
  const mediaV1 = hotV2.items[0].media.version;
  fs.writeFileSync(path.join(hotItemDir, 'visual.gif'), Buffer.from('GIF89a-gif-v2-is-longer'));
  const mediaV2 = hotStore.publicCatalog().items[0].media.version;
  assert.notStrictEqual(mediaV2, mediaV1, 'media replacement must bust the renderer cache');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('meme resource watcher did not fire')), 1000);
    const stop = hotStore.watch({
      pollMs: 20,
      onChange: () => {
        clearTimeout(timeout);
        stop();
        resolve();
      },
    });
    fs.writeFileSync(path.join(hotItemDir, 'voice.mp3'), Buffer.from('ID3audio-v2-is-longer'));
  });
  fs.rmSync(hotRoot, { recursive: true, force: true });

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
    routeForSession({ id: claudeId, agentId: 'dsh' }, 'darwin').kind,
    'unavailable',
    'dsh must never inherit Claude resume from a UUID-shaped session id',
  );
  assert.strictEqual(
    routeForSession({ id: claudeId, agentId: 'future-agent' }, 'darwin').kind,
    'unavailable',
    'unknown providers must never inherit Claude resume',
  );
  assert.strictEqual(
    routeForSession({
      id: claudeId,
      agentId: 'future-agent',
      tmuxSocket: '/tmp/tmux',
      tmuxClient: '%3',
      terminalApp: 'terminal',
      terminalTty: 'ttys004',
    }, 'darwin').kind,
    'unavailable',
    'terminal metadata must not bypass provider capabilities',
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

  const blockedCalls = [];
  const blockedDispatcher = createCommandDispatcher({
    platform: 'darwin',
    resolveClaudeDesktopSession: () => claudeDesktopId,
    findCli: (name) => { blockedCalls.push(['find', name]); return `/fake/${name}`; },
    execFile: (file, args, _opts, cb) => {
      blockedCalls.push(['exec', file, args]);
      cb(null, 'ok\n', '');
    },
    spawn: (file, args) => {
      blockedCalls.push(['spawn', file, args]);
      throw new Error('unsupported providers must not spawn a provider CLI');
    },
    copyText: (text) => blockedCalls.push(['copy', text]),
    focusSession: async () => { blockedCalls.push(['focus']); return true; },
    openClaudeThread: async (id) => { blockedCalls.push(['open-claude', id]); return true; },
    openCodexThread: async (id) => { blockedCalls.push(['open-codex', id]); return true; },
    getNativeHelper: async () => { blockedCalls.push(['native-helper']); return '/fake/helper'; },
  });
  for (const blockedSession of [
    {
      id: claudeId,
      agentId: 'future-agent',
      originator: 'Claude Desktop',
      tmuxSocket: '/tmp/tmux',
      tmuxClient: '%3',
      terminalApp: 'terminal',
      terminalTty: 'ttys004',
    },
    { id: claudeId, agentId: 'dsh', originator: 'Claude Desktop' },
  ]) {
    const blocked = await blockedDispatcher.dispatch(blockedSession, meme.prompt.text);
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.submitted, false);
    assert.strictEqual(blocked.inputSent, false);
    assert.strictEqual(blocked.copied, false);
    assert.strictEqual(blocked.focused, false);
    assert.strictEqual(blocked.route, 'unavailable');
  }
  assert.deepStrictEqual(
    blockedCalls,
    [],
    'unsupported providers must fail before copy, focus, deep-link, helper, exec, or spawn side effects',
  );

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
  assert.strictEqual(codexDesktop.inputSent, true);
  assert.strictEqual(codexDesktop.route, 'codex-desktop');
  assert.deepStrictEqual(desktopCalls.find((c) => c[0] === 'open'), ['open', codexId]);
  assert(desktopCalls.some((c) => c[0] === 'osascript'));
  assert(desktopCalls.some((c) => c[0] === 'verify'));

  const delayedTranscriptDispatcher = createCommandDispatcher({
    platform: 'darwin',
    desktopOpenDelayMs: 0,
    copyText: () => {},
    openCodexThread: async () => true,
    execFile: (_file, _args, _opts, cb) => cb(null, 'ok\n', ''),
    verifyPrompt: async () => false,
  });
  const delayedTranscript = await delayedTranscriptDispatcher.dispatch({
    id: codexId,
    agentId: 'codex',
    originator: 'Codex Desktop',
    transcriptPath: path.join(root, 'fake-delayed-rollout.jsonl'),
  }, meme.prompt.text);
  assert.strictEqual(delayedTranscript.submitted, false);
  assert.strictEqual(
    delayedTranscript.inputSent,
    true,
    'native submit success must remain distinct from delayed transcript confirmation',
  );

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
  assert.strictEqual(claudeDesktop.inputSent, true);
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
  assert(js.includes('applyDeliveredMemeWorkReaction(meme, result)'));
  assert(js.includes('function alignMemePlayer()'));
  assert(js.includes('if (memeLayoutActive)'));
  assert(css.includes('.sl-meme-entry'));
  assert(!css.includes('left: calc(50% + 112px)'), 'meme position must follow the real pet rect');
  assert(css.includes('#sl-session-view.hidden'), 'meme page must fully hide the session list view');

  const world = loadRenderer(['shared/i18n.js', 'shared/states.js', 'renderer/pet.js']);
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
  assert.strictEqual(
    world.sandbox.memeMediaUrl({
      media: { gif: 'huaqiang-guaranteed/visual.gif', version: 'asset-v2' },
    }, 'gif'),
    '../assets/memes/huaqiang-guaranteed/visual.gif?v=asset-v2',
  );
  assert(world.elements('cat').classList.contains('sorry'));
  assert(world.elements('cat-img').src.endsWith('cat-waiting.gif'));
  world.handlers.event({ kind: 'user-turn', project: 'demo-session' });
  assert(world.elements('cat').classList.contains('sorry'), 'meme reaction must outlive its own prompt event');
  assert(!world.elements('meme-player').classList.contains('hidden'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert(world.elements('meme-player').classList.contains('hidden'));

  const stats = (over = {}) => ({
    today: { cost: 0 },
    lifetime: { cost: 0 },
    sessions: [],
    bg: { zombie: 0 },
    waitingCount: 0,
    needsinputCount: 0,
    workingCount: 0,
    jugglingCount: 0,
    sweepingCount: 0,
    thinkingCount: 0,
    loafingCount: 0,
    errorCount: 0,
    idleMs: 1000,
    ...over,
  });
  const workMeme = {
    media: {
      gif: 'huaqiang-guaranteed/visual.gif',
      audio: 'huaqiang-guaranteed/voice.mp3',
      durationMs: 1,
      placement: 'pet-right',
    },
    reaction: {
      work: {
        durationMs: 30000,
        visualState: 'sorry',
        activeStates: ['idle', 'sleeping', 'thinking', 'working', 'juggling', 'sweeping', 'loafing'],
      },
    },
  };
  world.handlers.stats(stats({ workingCount: 1 }));
  const normalWorkSrc = world.elements('cat-img').src;
  assert(
    /cat-working(?:-[234])?\.gif$/.test(normalWorkSrc),
    'failed submission must leave the normal work pool active',
  );
  world.sandbox.playMeme(workMeme);
  assert(
    world.elements('cat-img').src.endsWith('cat-waiting.gif'),
    'meme event must start the sweating work visual immediately without waiting for transcript verification',
  );
  assert.strictEqual(
    world.sandbox.applyDeliveredMemeWorkReaction(workMeme, { submitted: false, inputSent: false }),
    false,
    'explicit input failure must cancel the optimistic work reaction',
  );
  assert(
    /cat-working(?:-[234])?\.gif$/.test(world.elements('cat-img').src),
    'cancelled optimistic reaction must return to the normal work pool',
  );
  assert.strictEqual(
    world.sandbox.applyDeliveredMemeWorkReaction(workMeme, { submitted: false, inputSent: true }),
    true,
    'native input success must survive delayed transcript confirmation',
  );
  assert(world.elements('cat-img').src.endsWith('cat-waiting.gif'));
  assert.strictEqual(
    world.sandbox.applyDeliveredMemeWorkReaction(workMeme, { submitted: true, inputSent: true }),
    true,
    'submitted prompt must start the configured work reaction',
  );
  assert(world.elements('cat').classList.contains('working'), 'work reaction must not falsify the semantic state');
  assert(world.elements('cat-img').src.endsWith('cat-waiting.gif'), 'active work must use the sweating cat visual');
  world.handlers.stats(stats({ idleMs: 1000 }));
  assert(world.elements('cat').classList.contains('idle'), 'watcher gap must remain semantically idle');
  assert(world.elements('cat-img').src.endsWith('cat-waiting.gif'), 'idle watcher gap must not break the 30s visual');
  world.handlers.stats(stats({ idleMs: null }));
  assert(world.elements('cat').classList.contains('sleeping'), 'missing active sessions must remain semantically sleeping');
  assert(world.elements('cat-img').src.endsWith('cat-waiting.gif'), 'sleeping watcher gap must not break the 30s visual');
  world.handlers.stats(stats({ errorCount: 1, workingCount: 1 }));
  assert(world.elements('cat').classList.contains('error'), 'error must interrupt the sweating work visual');
  assert(world.elements('cat-img').src.endsWith('cat-error.gif'));
  world.handlers.stats(stats({ workingCount: 1 }));
  assert(world.elements('cat-img').src.endsWith('cat-waiting.gif'), 'work visual resumes inside the 30s window');
  world.clock.offset += 31000;
  world.handlers.stats(stats({ workingCount: 1 }));
  assert(
    /cat-working(?:-[234])?\.gif$/.test(world.elements('cat-img').src),
    'after 30s the cat must return to the normal randomized work pool',
  );

  console.log('meme actions tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
