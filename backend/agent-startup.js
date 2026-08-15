'use strict';

// LLMPET's unified local-agent entrance. Startup is additive: it starts only
// the selected interactive CLIs that are not already running. A missing or
// broken provider never prevents the pet or the other provider from starting.

const { cliInstalled, isCliRunning, launchClaude, launchCodex, launchDsh } = require('./launch');

const AGENTS = ['claude', 'codex', 'dsh'];
const TITLES = {
  claude: 'LLMPET · Claude Code',
  codex: 'LLMPET · Codex',
  dsh: 'LLMPET · dsh',
};

function createAgentStartup(options = {}) {
  const getSettings = options.getSettings || (() => ({ claude: true, codex: true, dsh: false }));
  const installed = options.installed || cliInstalled;
  const running = options.running || isCliRunning;
  const launchers = options.launchers || { claude: launchClaude, codex: launchCodex, dsh: launchDsh };
  const onResult = options.onResult || (() => {});
  const pause = options.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pauseMs = Number.isFinite(options.pauseMs) ? Math.max(0, options.pauseMs) : 280;
  let inFlight = null;

  async function ensure(agent) {
    if (!AGENTS.includes(agent)) return { agent, status: 'invalid' };
    if (!installed(agent)) return { agent, status: 'not-installed' };
    if (await running(agent)) return { agent, status: 'already-running' };
    try {
      const result = await launchers[agent]({ terminalTitle: TITLES[agent] });
      return result && result.ok
        ? { agent, status: 'launched', terminal: result.terminal || '' }
        : { agent, status: 'failed', message: result && result.message || 'launch failed' };
    } catch (error) {
      return { agent, status: 'failed', message: error && error.message || String(error) };
    }
  }

  function run(runOptions = {}) {
    if (inFlight) return inFlight;
    const settings = getSettings() || {};
    const requested = Array.isArray(runOptions.agents)
      ? runOptions.agents.filter((agent) => AGENTS.includes(agent))
      : AGENTS.filter((agent) => settings[agent] === true);
    const agents = [...new Set(requested)];
    inFlight = (async () => {
      const results = [];
      for (let index = 0; index < agents.length; index += 1) {
        // Sequential launches keep Terminal.app from racing two AppleScripts
        // into duplicate or half-created windows.
        // eslint-disable-next-line no-await-in-loop
        const result = await ensure(agents[index]);
        results.push(result);
        onResult(result);
        if (index < agents.length - 1 && pauseMs > 0) {
          // eslint-disable-next-line no-await-in-loop
          await pause(pauseMs);
        }
      }
      return results;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { run, ensure };
}

module.exports = { createAgentStartup, AGENTS, TITLES };
