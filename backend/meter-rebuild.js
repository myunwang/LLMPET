'use strict';

// Recompute usage history with the current (fixed) price table.
//
// Past aggregates stored cost at whatever price was in effect then — so models
// priced wrong before (e.g. claude-fable-5 billed at the sonnet default, or all
// of Codex billed at $0) are wrong in the calendar. The transcripts and rollouts
// are the source of truth, so this clears the aggregates and re-scans from byte
// 0, re-pricing everything correctly. Days whose source files no longer exist
// are archived first, so a rebuild never erases history (see usage-archive.js).
//
//   node backend/meter-rebuild.js            # sync latest prices, then rebuild
//   node backend/meter-rebuild.js --no-sync  # rebuild with cached/built-in prices
//   OCTOPUS_NO_NET=1 node backend/meter-rebuild.js   # never touches the network

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMetering } = require('./metering');
const { createCodexMetering } = require('./codex-metering');
const { createPricingSync } = require('./pricing-sync');

const USAGE = path.join(os.homedir(), '.octopus', 'usage.json');
const CODEX_USAGE = path.join(os.homedir(), '.octopus', 'codex-usage.json');

function oldTotals(file = USAGE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    let cost = 0;
    const byModel = {};
    for (const day of Object.values(s.byModelByDay || {})) {
      for (const [id, v] of Object.entries(day)) {
        byModel[id] = (byModel[id] || 0) + (v.cost || 0);
        cost += v.cost || 0;
      }
    }
    return { cost, byModel };
  } catch { return { cost: 0, byModel: {} }; }
}

function reportModels(before, after) {
  const ids = [...new Set([...Object.keys(before.byModel), ...Object.keys(after.byModel)])].sort();
  for (const id of ids) {
    const o = before.byModel[id] || 0;
    const n = after.byModel[id] || 0;
    const mark = Math.abs(n - o) > 0.005 ? '  ← 变化' : '';
    console.log(`  ${id.padEnd(24)} $${o.toFixed(2).padStart(10)} → $${n.toFixed(2).padStart(10)}${mark}`);
  }
}

async function main() {
  const sync = !process.argv.includes('--no-sync') && process.env.OCTOPUS_NO_NET !== '1';
  if (sync) {
    process.stdout.write('① 同步最新价目表（LiteLLM 公开数据）… ');
    try { await createPricingSync().refresh(); console.log('ok'); }
    catch (e) { console.log('跳过（' + e.message + '），改用现有缓存 / 内置价'); }
  } else {
    console.log('① 跳过价目同步（用现有缓存 / 内置价）');
  }

  const before = oldTotals();
  console.log('② 重扫 Claude transcript 重算历史…（含 subagents/ 子目录）');
  const m = createMetering();
  const after = await m.rebuild();
  console.log('\n按模型 · 全期花费（旧 → 新）');
  reportModels(before, after);

  // Codex was metered but never priced before, so its "旧" column is $0 across
  // the board on the first run after this change.
  const codexBefore = oldTotals(CODEX_USAGE);
  console.log('\n③ 重扫 Codex rollout 重算历史…');
  const codex = createCodexMetering();
  await codex.rebuild();
  const codexAfter = oldTotals(CODEX_USAGE);
  console.log('\nCodex 按模型 · 全期花费（旧 → 新）');
  reportModels(codexBefore, codexAfter);

  const totalBefore = before.cost + codexBefore.cost;
  const totalAfter = after.cost + codexAfter.cost;
  const delta = totalAfter - totalBefore;
  console.log(`\nClaude  $${before.cost.toFixed(2)} → $${after.cost.toFixed(2)}`);
  console.log(`Codex   $${codexBefore.cost.toFixed(2)} → $${codexAfter.cost.toFixed(2)}`);
  console.log(`合计    $${totalBefore.toFixed(2)} → $${totalAfter.toFixed(2)}  (${delta >= 0 ? '+' : ''}$${delta.toFixed(2)})`);
  console.log('已写回 ~/.octopus/{usage,codex-usage}.json —— 重开 LLMPET 详情面板即见新数字。');
}

main().catch((e) => { console.error('rebuild 失败:', e); process.exit(1); });
