'use strict';

// Shared normalization for Codex App Server quota responses. The main process
// consumes the normalized object; the renderer only needs the weekly remainder.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CodexRateLimits = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  function finite(...values) {
    for (const value of values) {
      if (value == null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function pickBucket(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.rateLimits && typeof payload.rateLimits === 'object') return payload.rateLimits;
    if (payload.rate_limits && typeof payload.rate_limits === 'object') return payload.rate_limits;
    const byId = payload.rateLimitsByLimitId || payload.rate_limits_by_limit_id;
    if (byId && typeof byId === 'object') {
      if (byId.codex && typeof byId.codex === 'object') return byId.codex;
      const first = Object.values(byId).find((value) => value && typeof value === 'object');
      if (first) return first;
    }
    return payload.primary || payload.secondary ? payload : null;
  }

  function normalizeAppServerRateLimits(payload, now = Date.now()) {
    const bucket = pickBucket(payload);
    if (!bucket) return null;
    const primary = bucket.primary || {};
    const secondary = bucket.secondary || {};
    const out = { ts: now, source: 'app-server' };
    const primaryUsed = finite(primary.usedPercent, primary.used_percent);
    const secondaryUsed = finite(secondary.usedPercent, secondary.used_percent);
    if (primaryUsed != null) {
      out.usedPercent = primaryUsed;
      out.windowMinutes = finite(primary.windowDurationMins, primary.window_minutes);
      const reset = finite(primary.resetsAt, primary.resets_at);
      out.resetsAt = reset == null ? null : reset * 1000;
    }
    if (secondaryUsed != null) {
      out.secondaryUsedPercent = secondaryUsed;
      out.secondaryWindowMinutes = finite(secondary.windowDurationMins, secondary.window_minutes);
      const reset = finite(secondary.resetsAt, secondary.resets_at);
      out.secondaryResetsAt = reset == null ? null : reset * 1000;
    }
    const planType = bucket.planType || bucket.plan_type || payload.planType || payload.plan_type;
    if (typeof planType === 'string' && planType) out.planType = planType;
    return out.usedPercent != null || out.secondaryUsedPercent != null ? out : null;
  }

  function weeklyUsedPercent(limits) {
    if (!limits) return null;
    const primary = finite(limits.usedPercent);
    const secondary = finite(limits.secondaryUsedPercent);
    const primaryWindow = finite(limits.windowMinutes);
    const secondaryWindow = finite(limits.secondaryWindowMinutes);
    const weeklyWindow = 6 * 24 * 60;
    // Current Codex plans can expose the seven-day bucket as primary with no
    // secondary bucket; older Plus responses commonly put it in secondary.
    if (secondary != null && secondaryWindow != null && secondaryWindow >= weeklyWindow) return secondary;
    if (primary != null && primaryWindow != null && primaryWindow >= weeklyWindow) return primary;
    if (secondary != null) return secondary; // legacy payloads without duration
    return null;
  }

  function weeklyRemainingPercent(limits) {
    const used = weeklyUsedPercent(limits);
    if (used == null) return null;
    return Math.round(100 - Math.max(0, Math.min(100, used)));
  }

  return { normalizeAppServerRateLimits, weeklyUsedPercent, weeklyRemainingPercent };
});
