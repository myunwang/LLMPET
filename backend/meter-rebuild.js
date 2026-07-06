'use strict';

// Recompute usage history with the current (fixed) price table.
//
// Past aggregates stored cost at whatever price was in effect then — so models
// priced wrong before (e.g. claude-fable-5 billed at the sonnet default) are
// wrong in the calendar. The transcripts are the source of truth, so this clears
// the aggregates and re-scans from byte 0, re-pricing everything correctly.
//
//   node backend/meter-rebuild.js            # sync latest prices, then rebuild
//   node backend/meter-rebuild.js --no-sync  # rebuild with cached/built-in prices
//   OCTOPUS_NO_NET=1 node backend/meter-rebuild.js   # never touches the network

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMetering } = require('./metering');
const { createPricingSync } = require('./pricing-sync');

const USAGE = path.join(os.homedir(), '.octopus', 'usage.json');

function oldTotals() {
  try {
    const s = JSON.parse(fs.readFileSync(USAGE, 'utf8'));
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
  console.log('② 重扫 transcript 重算历史…');
  const m = createMetering();
  const after = await m.rebuild();

  const ids = [...new Set([...Object.keys(before.byModel), ...Object.keys(after.byModel)])].sort();
  console.log('\n按模型 · 全期花费（旧 → 新）');
  for (const id of ids) {
    const o = before.byModel[id] || 0;
    const n = after.byModel[id] || 0;
    const mark = Math.abs(n - o) > 0.005 ? '  ← 变化' : '';
    console.log(`  ${id.padEnd(24)} $${o.toFixed(2).padStart(10)} → $${n.toFixed(2).padStart(10)}${mark}`);
  }
  const delta = after.cost - before.cost;
  console.log(`\n合计  $${before.cost.toFixed(2)} → $${after.cost.toFixed(2)}  (${delta >= 0 ? '+' : ''}$${delta.toFixed(2)})`);
  console.log('已写回 ~/.octopus/usage.json —— 重开 Octopus 详情面板即见新数字。');
}

main().catch((e) => { console.error('rebuild 失败:', e); process.exit(1); });
