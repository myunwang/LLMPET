'use strict';

const assert = require('assert');
const config = require('../backend/config');
const { createAgentStartup } = require('../backend/agent-startup');
const {
  cliProcessPids,
  isInteractiveCliCommand,
  isDshWebCommand,
  dshWebProcessPids,
  ensureDshWeb,
} = require('../backend/launch');

async function main() {
  console.log('[AS1] 只把真正交互式 CLI 视为已运行');
  assert.strictEqual(isInteractiveCliCommand('/Users/me/.local/bin/codex --model gpt-5', 'codex'), true);
  assert.strictEqual(isInteractiveCliCommand('/opt/homebrew/bin/claude --resume abc', 'claude'), true);
  assert.strictEqual(isInteractiveCliCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server', 'codex'), false);
  assert.strictEqual(isInteractiveCliCommand('/Applications/Claude.app/Contents/MacOS/claude --input-format stream-json', 'claude'), false);
  assert.deepStrictEqual(cliProcessPids(`
    101 /Users/me/.local/bin/codex
    102 /Applications/ChatGPT.app/Contents/Resources/codex app-server
    103 rg codex
    101 /Users/me/.local/bin/codex
  `, 'codex'), [101]);
  assert.strictEqual(isDshWebCommand('/opt/homebrew/bin/dsh web'), true);
  assert.strictEqual(isDshWebCommand('node /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web'), true);
  assert.strictEqual(isDshWebCommand('npx @deepseek-ai/dsh web'), true);
  assert.strictEqual(isDshWebCommand('/opt/homebrew/bin/dsh --profile headless "job"'), false);
  assert.strictEqual(isDshWebCommand('/opt/homebrew/bin/dsh --profile tui --resume abc'), false);
  assert.deepStrictEqual(dshWebProcessPids(`
    201 /opt/homebrew/bin/dsh --profile headless job
    202 /opt/homebrew/bin/dsh web
    203 node /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web
  `), [202, 203]);
  console.log('  ✓ 桌面端内嵌进程不会阻止 LLMPET 补开 CLI');

  console.log('[AS2] 已运行的不重复开，未安装不拖垮另一家');
  const launched = [];
  const results = [];
  const startup = createAgentStartup({
    getSettings: () => ({ claude: true, codex: true }),
    installed: (agent) => agent === 'codex',
    running: async () => false,
    launchers: {
      claude: async () => { throw new Error('must not launch'); },
      codex: async (opts) => { launched.push(['codex', opts]); return { ok: true, terminal: 'test' }; },
    },
    onResult: (result) => results.push(result),
    pauseMs: 0,
  });
  assert.deepStrictEqual(await startup.run(), [
    { agent: 'claude', status: 'not-installed' },
    { agent: 'codex', status: 'launched', terminal: 'test' },
  ]);
  assert.strictEqual(launched.length, 1);
  assert.strictEqual(launched[0][1].terminalTitle, 'LLMPET · Codex');
  assert.strictEqual(results.length, 2);
  console.log('  ✓ 单方失败隔离，另一方仍正常启动');

  const dshLaunched = [];
  const dshStartup = createAgentStartup({
    getSettings: () => ({ claude: false, codex: false, dsh: true }),
    installed: (agent) => agent === 'dsh',
    running: async () => false,
    launchers: { dsh: async (opts) => { dshLaunched.push(opts); return { ok: true, terminal: 'test' }; } },
    pauseMs: 0,
  });
  assert.deepStrictEqual(await dshStartup.run(), [{ agent: 'dsh', status: 'launched', terminal: 'test' }]);
  assert.strictEqual(dshLaunched[0].terminalTitle, 'LLMPET · dsh');
  console.log('  ✓ dsh 遵循自己的启动开关，不依赖 Claude/Codex');

  let launchCount = 0;
  const existing = createAgentStartup({
    getSettings: () => ({ claude: true, codex: false }),
    installed: () => true,
    running: async () => true,
    launchers: { claude: async () => { launchCount += 1; return { ok: true }; } },
    pauseMs: 0,
  });
  assert.deepStrictEqual(await existing.run(), [{ agent: 'claude', status: 'already-running' }]);
  assert.strictEqual(launchCount, 0);
  console.log('  ✓ 已运行时不会新开终端，关闭的 provider 开关被尊重');

  console.log('[AS3] 重叠启动请求合并为同一轮');
  let release;
  let runningChecks = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const coalesced = createAgentStartup({
    getSettings: () => ({ claude: true, codex: false }),
    installed: () => true,
    running: async () => { runningChecks += 1; await gate; return true; },
    pauseMs: 0,
  });
  const first = coalesced.run();
  const second = coalesced.run();
  release();
  assert.deepStrictEqual(await first, await second);
  assert.strictEqual(runningChecks, 1);
  console.log('  ✓ 启动阶段重复触发不会开出双窗口');

  console.log('[AS4] 配置默认统一入口开启且可分别关闭');
  // dsh 起的是本地 web 服务（会开浏览器），默认不自动补开——只有用户显式勾选才拉起
  assert.deepStrictEqual(config.DEFAULTS.agentStartup, { claude: true, codex: true, dsh: false });
  assert.deepStrictEqual(config.sanitize({ agentStartup: { claude: false, codex: true } }).agentStartup,
    { claude: false, codex: true, dsh: false });
  assert.deepStrictEqual(config.sanitize({ agentStartup: { dsh: true } }).agentStartup,
    { claude: true, codex: true, dsh: true });
  assert.deepStrictEqual(config.sanitize({ agentStartup: {} }).agentStartup,
    { claude: true, codex: true, dsh: false });
  console.log('  ✓ 旧配置自动获得默认值，三个 Agent 可独立控制');

  console.log('[AS5] dsh Web 就绪判断不把 headless/TUI 冒充成 Web');
  let webLaunches = 0;
  const already = await ensureDshWeb({
    url: 'http://127.0.0.1:3080', running: async () => true,
    launch: async () => { webLaunches += 1; return { ok: true }; }, wait: async () => true,
  });
  assert.deepStrictEqual(already, { ok: true, status: 'already-running' });
  assert.strictEqual(webLaunches, 0);
  const opened = await ensureDshWeb({
    url: 'http://127.0.0.1:3080', running: async () => false,
    launch: async () => { webLaunches += 1; return { ok: true }; }, wait: async () => true,
  });
  assert.deepStrictEqual(opened, { ok: true, status: 'launched' });
  assert.strictEqual(webLaunches, 1);
  const notReady = await ensureDshWeb({
    url: 'http://127.0.0.1:3080', running: async () => false,
    launch: async () => ({ ok: true }), wait: async () => false,
  });
  assert.strictEqual(notReady.ok, false);
  assert.strictEqual(notReady.status, 'not-ready');
  console.log('  ✓ 只有可访问的 Web 前端才会被报告为可打开');

  console.log('agent startup checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
