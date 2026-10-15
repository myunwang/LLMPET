'use strict';

const fs = require('fs');

// Codex paginated-history writers can append while preserving filesystem mtime.
// Cache by size AND mtime, and use bounded tail timestamps for startup discovery.
function activityTime(fp, stat, cache, now = Date.now()) {
  const prior = cache.get(fp);
  if (prior && prior.size === stat.size && prior.mtime === stat.mtimeMs) return prior.at;
  let at = stat.mtimeMs;
  let fd;
  try {
    const length = Math.min(stat.size, 128 * 1024);
    const buf = Buffer.alloc(length);
    fd = fs.openSync(fp, 'r');
    fs.readSync(fd, buf, 0, length, stat.size - length);
    const lines = buf.toString('utf8').split('\n');
    if (stat.size > length) lines.shift();
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const time = Date.parse(row.timestamp || row.time);
      if (Number.isFinite(time) && time <= now + 5000) at = Math.max(at, time);
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  if (prior && stat.size > prior.size) at = Math.max(at, now);
  cache.set(fp, { size: stat.size, mtime: stat.mtimeMs, at });
  return at;
}

module.exports = { activityTime };
