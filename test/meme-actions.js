'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadCatalog, publicCatalog, getMeme } = require('../backend/meme-catalog');
const { routeForSession, createCommandDispatcher } = require('../backend/command-dispatch');
const { loadRenderer } = require('./dom-stub');

async function main() {
  const root = path.join(__dirname, '..');
  const catalog = loadCatalog();
  assert.strictEqual(catalog.schemaVersion, 1);
  assert.strictEqual(catalog.items.length, 1);
  const meme = getMeme('huaqiang-guaranteed');
  assert(meme);
  assert(meme.prompt.text.includes('保熟'));
  assert(meme.prompt.text.includes('真实环境'));
  assert(fs.existsSync(path.join(root, 'assets', 'memes', meme.media.gif)));
  assert(fs.existsSync(path.join(root, 'assets', 'memes', meme.media.audio)));
  assert(!JSON.stringify(publicCatalog()).includes(meme.prompt.text), 'renderer catalog must not expose full prompts');

  assert.deepStrictEqual(
    routeForSession({ tmuxSocket: '/tmp/tmux', tmuxClient: '%3' }, 'darwin'),
    { kind: 'tmux', label: '精确直发 · tmux', exact: true },
  );
  assert.strictEqual(
    routeForSession({ terminalApp: 'terminal', terminalTty: 'ttys004' }, 'darwin').kind,
    'mac-terminal',
  );
  assert.strictEqual(routeForSession({ sourcePid: 123 }, 'darwin').kind, 'manual');

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

  const html = fs.readFileSync(path.join(root, 'renderer', 'pet.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'renderer', 'pet.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'pet.css'), 'utf8');
  assert(html.includes('id="sl-meme-view"'));
  assert(html.includes('id="meme-player"'));
  assert(js.includes('window.pet.triggerMeme(target.sessionId, meme.id)'));
  assert(css.includes('.sl-meme-entry'));
  assert(css.includes('left: calc(50% + 112px)'));
  assert(css.includes('#sl-session-view.hidden'), 'meme page must fully hide the session list view');

  const world = loadRenderer(['shared/states.js', 'renderer/pet.js']);
  assert.strictEqual(typeof world.handlers.meme, 'function');
  world.handlers.meme({
    id: 'huaqiang-guaranteed',
    label: '你这瓜保熟吗？',
    project: 'demo-session',
    media: { gif: 'huaqiang-guaranteed/visual.gif', audio: 'huaqiang-guaranteed/voice.mp3', durationMs: 1 },
  });
  assert(world.calls.some((c) => c[0] === 'setPetSize' && c[1][0] === 760));
  assert.strictEqual(world.elements('meme-image').src, '../assets/memes/huaqiang-guaranteed/visual.gif');
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
