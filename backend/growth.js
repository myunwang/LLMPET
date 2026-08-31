'use strict';

// Token-driven progression shared by travel and the whole local machine.
//
// A trip advances quickly (10k token per paw) so each return feels visible.
// Whole-machine usage is several orders of magnitude larger, so it uses
// 10M token per paw. Both ladders keep the same QQ-style 4-to-1 promotion:
// paw -> star -> moon -> sun -> crown.

const TRAVEL_RANK_UNIT_TOKENS = 10_000;
const MACHINE_RANK_UNIT_TOKENS = 10_000_000;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function rankFor(totalTokens, unitTokens = TRAVEL_RANK_UNIT_TOKENS) {
  const tokens = number(totalTokens);
  const unit = Math.max(1, number(unitTokens) || TRAVEL_RANK_UNIT_TOKENS);
  const units = Math.floor(tokens / unit);
  return {
    unitTokens: unit,
    units,
    crown: Math.floor(units / 256),
    sun: Math.floor((units % 256) / 64),
    moon: Math.floor((units % 64) / 16),
    star: Math.floor((units % 16) / 4),
    leaf: units % 4, // persisted/API name kept for compatibility; UI renders paws.
    progressTokens: tokens % unit,
    nextTokens: unit,
  };
}

function machineGrowth(claudeStats, codexStats, codewhaleStats) {
  const claudeTokens = number(claudeStats && claudeStats.lifetime && claudeStats.lifetime.tokens);
  const codexTokens = number(codexStats && codexStats.lifetime && codexStats.lifetime.tokens);
  const codewhaleTokens = number(codewhaleStats && codewhaleStats.lifetime && codewhaleStats.lifetime.tokens);
  const totalTokens = claudeTokens + codexTokens + codewhaleTokens;
  return {
    totalTokens,
    claudeTokens,
    codexTokens,
    codewhaleTokens,
    rank: rankFor(totalTokens, MACHINE_RANK_UNIT_TOKENS),
  };
}

module.exports = {
  MACHINE_RANK_UNIT_TOKENS,
  TRAVEL_RANK_UNIT_TOKENS,
  machineGrowth,
  rankFor,
};
