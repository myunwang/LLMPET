'use strict';

const assert = require('assert');
const config = require('../backend/config');
const { createAgentStartup } = require('../backend/agent-startup');
const { cliProcessPids, isInteractiveCliCommand } = require('../backend/launch');

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
  assert.deepStrictEqual(config.DEFAULTS.agentStartup, { claude: true, codex: true });
  assert.deepStrictEqual(config.sanitize({ agentStartup: { claude: false, codex: true } }).agentStartup,
    { claude: false, codex: true });
  assert.deepStrictEqual(config.sanitize({ agentStartup: {} }).agentStartup,
    { claude: true, codex: true });
  console.log('  ✓ 旧配置自动获得默认值，两个 Agent 可独立控制');

  console.log('agent startup checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
