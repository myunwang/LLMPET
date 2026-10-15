'use strict';

// Execution outcomes deliberately live outside the pet's expiring mood states.
function classifyError(value) {
  const error = value && (value.error || (value.reason && typeof value.reason === 'object' ? value.reason : value)) || {};
  const info = error.codexErrorInfo || error.codex_error_info || error.code || error.type || '';
  const code = typeof info === 'string' ? info : Object.keys(info)[0] || '';
  const message = String(error.message || error.reason || (typeof value === 'string' ? value : '')).slice(0, 1600);
  const text = `${code} ${message}`;
  if (/usage.?limit.?exceeded|insufficient_quota|quota.?(?:exceeded|exhausted)|usage limit|out of (?:usage|credits)|额度.*(?:耗尽|用尽)/i.test(text)) return { kind: 'quota_exhausted', code, message };
  const details = typeof info === 'object' && info ? (info[code] || info) : error;
  const status = details && (details.httpStatusCode || details.http_status_code) || error.httpStatusCode;
  if (status >= 400 && status < 500 && status !== 429) return { kind: 'failed', code, message };
  if (/unauthorized|authentication|invalid.?api.?key|forbidden|bad.?request|context.?window|sandbox|permission.?denied/i.test(text)) return { kind: 'failed', code, message };
  if (/connection|stream.?disconnect|stream.?connection|timeout|timed.?out|network|internal.?server|server.?error|overloaded.?error|server.?overload|too.?many.?failed.?attempt|rate.?limit|ECONN|ENOTFOUND|\b(?:429|502|503|504)\b/i.test(text)) return { kind: 'transient_error', code, message };
  return { kind: 'failed', code, message };
}

function normalizeQuota(raw, at = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  function window(v) {
    if (!v || typeof v !== 'object') return null;
    const used = v.used_percent ?? v.usedPercent;
    if (!Number.isFinite(used) || used < 0 || used > 100) return null;
    const reset = v.resets_at ?? v.resetsAt;
    return { usedPercent: used, windowMinutes: v.window_minutes ?? v.windowDurationMins ?? null,
      resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null };
  }
  const primary = window(raw.primary), secondary = window(raw.secondary);
  if (!primary && !secondary) return null;
  return { limitId: String(raw.limit_id || raw.limitId || 'codex'), primary, secondary, at,
    quotaProvider: typeof raw.model_provider === 'string' ? raw.model_provider : '',
    reachedType: raw.rate_limit_reached_type ?? raw.rateLimitReachedType ?? null,
    spendControlReached: raw.spend_control_reached === true, source: 'rollout' };
}

function quotaAvailable(quota, since, now = Date.now()) {
  if (!quota || quota.at <= since || now - quota.at > 120000 || quota.at > now + 5000
      || quota.reachedType || quota.spendControlReached) return false;
  // Some custom-provider rollouts still contain cached ChatGPT account limits.
  // Session metadata alone does not prove those limits belong to that provider.
  if (quota.provider && quota.provider !== 'openai' && quota.providerVerified !== true) return false;
  const windows = [quota.primary, quota.secondary].filter(Boolean);
  // Passing a reset timestamp is never evidence of recovery. Expired snapshots
  // must be refreshed, including the long window and the correct bucket.
  return windows.length > 0 && windows.every(w => w.usedPercent < 100
    && (!w.resetsAt || w.resetsAt > now));
}

module.exports = { classifyError, normalizeQuota, quotaAvailable };
