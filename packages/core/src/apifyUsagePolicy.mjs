export function createApifyUsageStats(mode = "off") {
  return {
    mode: normalizeApifyMode(mode),
    metaCalls: 0,
    googleCalls: 0,
    totalCalls: 0,
    calls: []
  };
}

export function recordApifyCall(stats, provider, input = {}) {
  if (!stats) return;
  const normalizedProvider = provider === "google" ? "google" : "meta";
  if (normalizedProvider === "google") stats.googleCalls += 1;
  else stats.metaCalls += 1;
  stats.totalCalls += 1;
  stats.calls.push({
    provider: normalizedProvider,
    urls: Array.isArray(input.urls) ? input.urls.map((item) => item?.url || item).filter(Boolean).slice(0, 4) : [],
    searchTerms: Array.isArray(input.searchTerms) ? input.searchTerms.slice(0, 8) : [],
    resultsLimit: input.resultsLimit ?? input.count ?? input.limitPerSource ?? null
  });
}

export function summarizeApifyUsage(stats = {}) {
  return {
    mode: normalizeApifyMode(stats.mode),
    metaCalls: Number(stats.metaCalls) || 0,
    googleCalls: Number(stats.googleCalls) || 0,
    totalCalls: Number(stats.totalCalls) || 0,
    calls: Array.isArray(stats.calls) ? stats.calls.slice(0, 12) : []
  };
}

export function validateApifyUsage({ expectedAds = {}, stats = {}, fallbackMode = "off", label = "business" } = {}) {
  const summary = summarizeApifyUsage({ ...stats, mode: stats.mode || fallbackMode });
  const mode = normalizeApifyMode(fallbackMode || summary.mode);
  const failures = [];
  const maxTotal = numberOrNull(expectedAds.maxApifyCalls ?? expectedAds.max_apify_calls);
  const maxMeta = numberOrNull(expectedAds.maxMetaApifyCalls ?? expectedAds.max_meta_apify_calls);
  const maxGoogle = numberOrNull(expectedAds.maxGoogleApifyCalls ?? expectedAds.max_google_apify_calls);

  if (mode === "off" && summary.totalCalls > 0) {
    failures.push({
      case: label,
      area: "ads.apify",
      reason: "apify_called_while_disabled",
      actual: summary.totalCalls,
      calls: summary.calls
    });
  }
  if (maxTotal != null && summary.totalCalls > maxTotal) {
    failures.push({
      case: label,
      area: "ads.apify",
      reason: "apify_total_calls_exceeded",
      expectedMax: maxTotal,
      actual: summary.totalCalls,
      calls: summary.calls
    });
  }
  if (maxMeta != null && summary.metaCalls > maxMeta) {
    failures.push({
      case: label,
      area: "ads.apify.meta",
      reason: "apify_meta_calls_exceeded",
      expectedMax: maxMeta,
      actual: summary.metaCalls,
      calls: summary.calls.filter((call) => call.provider === "meta")
    });
  }
  if (maxGoogle != null && summary.googleCalls > maxGoogle) {
    failures.push({
      case: label,
      area: "ads.apify.google",
      reason: "apify_google_calls_exceeded",
      expectedMax: maxGoogle,
      actual: summary.googleCalls,
      calls: summary.calls.filter((call) => call.provider === "google")
    });
  }
  return failures;
}

function normalizeApifyMode(value) {
  const mode = String(value || "off").toLowerCase();
  if (["always", "all"].includes(mode)) return "always";
  if (["1", "true", "yes", "on", "enabled", "on_unknown", "unknown"].includes(mode)) return "on_unknown";
  return "off";
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
