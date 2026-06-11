export function validateReformasMadridBatchReport({
  report = {},
  expectedLimit = 100,
  requireDecisionMaker = false,
  apifyFallbackMode = "off",
  requireAdsVerification = true,
  requireDecisionMakerVerification = true
} = {}) {
  const failures = [];
  const results = Array.isArray(report.results) ? report.results : [];
  const summary = report.summary || {};
  const target = report.target || {};
  const expected = positiveInt(expectedLimit, 100);

  if (target.city !== "Madrid") failures.push(batchFailure("batch.target", "target_city_not_madrid", { actual: target.city || null }));
  if (target.niche !== "empresas de reformas") failures.push(batchFailure("batch.target", "target_niche_not_reformas", { actual: target.niche || null }));
  if (Number(target.requestedLimit) !== expected) {
    failures.push(batchFailure("batch.target", "requested_limit_mismatch", { expected, actual: Number(target.requestedLimit) || null }));
  }
  if (results.length !== expected) {
    failures.push(batchFailure("batch.results", "result_count_mismatch", { expected, actual: results.length }));
  }
  if (Number(summary.processed) !== results.length) {
    failures.push(batchFailure("batch.summary", "processed_count_mismatch", { expected: results.length, actual: Number(summary.processed) || null }));
  }
  if (Number(summary.ok) !== results.filter((row) => row?.ok === true).length) {
    failures.push(batchFailure("batch.summary", "ok_count_mismatch", {
      expected: results.filter((row) => row?.ok === true).length,
      actual: Number(summary.ok) || null
    }));
  }
  if (Number(summary.failed || 0) !== results.filter((row) => row?.ok !== true).length) {
    failures.push(batchFailure("batch.summary", "failed_count_mismatch", {
      expected: results.filter((row) => row?.ok !== true).length,
      actual: Number(summary.failed) || 0
    }));
  }
  if (results.some((row) => row?.ok !== true)) {
    failures.push(batchFailure("batch.results", "rows_not_ok", {
      rows: results.filter((row) => row?.ok !== true).map((row) => row?.index || row?.business?.name || null).slice(0, 25)
    }));
  }

  failures.push(...validateUniqueBusinesses(results));
  for (const row of results) {
    failures.push(...validateBatchRow({
      row,
      requireDecisionMaker,
      requireAdsVerification,
      requireDecisionMakerVerification
    }));
  }

  const apify = summary.apify || {};
  if (String(apifyFallbackMode || "off").toLowerCase() === "off" && Number(apify.totalCalls || 0) > 0) {
    failures.push(batchFailure("batch.apify", "apify_called_while_disabled", {
      actual: Number(apify.totalCalls) || 0,
      calls: Array.isArray(apify.calls) ? apify.calls.slice(0, 20) : []
    }));
  }
  if (!summary.deepseek || !Array.isArray(summary.deepseek.items) || !summary.deepseek.items.length) {
    failures.push(batchFailure("batch.deepseek", "missing_deepseek_cost_summary"));
  }
  return failures;
}

function validateBatchRow({ row = {}, requireDecisionMaker, requireAdsVerification, requireDecisionMakerVerification }) {
  const businessName = row.business?.name || `row_${row.index || "unknown"}`;
  const failures = [];
  if (!row.business?.name) failures.push(rowFailure(businessName, "business", "missing_business_name"));
  if (row.business?.city !== "Madrid") failures.push(rowFailure(businessName, "business", "business_city_not_madrid", { actual: row.business?.city || null }));
  if (!/reforma/i.test(String(row.business?.niche || row.business?.category || ""))) {
    failures.push(rowFailure(businessName, "business", "business_not_reformas_niche", {
      niche: row.business?.niche || null,
      category: row.business?.category || null
    }));
  }

  const ads = row.summary?.ads || {};
  failures.push(...validateProviderSummary({ businessName, provider: "meta", ads, requireAdsVerification }));
  failures.push(...validateProviderSummary({ businessName, provider: "google", ads, requireAdsVerification }));

  const hasActiveAds = ads.metaActive === true || ads.googleActive === true;
  if (hasActiveAds) {
    if (ads.funnelAiStatus !== "classified") {
      failures.push(rowFailure(businessName, "ads.funnel", "active_ads_funnel_not_ai_classified", {
        actual: ads.funnelAiStatus || null
      }));
    }
    if (!ads.funnelType || ads.funnelType === "unknown") {
      failures.push(rowFailure(businessName, "ads.funnel", "active_ads_funnel_type_unknown", {
        actual: ads.funnelType || null
      }));
    }
  }

  const decisionMaker = row.summary?.decisionMaker || {};
  if (decisionMaker.searchAiStatus !== "planned") {
    failures.push(rowFailure(businessName, "decision_maker.search", "decision_maker_search_not_ai_planned", {
      actual: decisionMaker.searchAiStatus || null
    }));
  }
  if (!["resolved", "resolved_no_match"].includes(decisionMaker.aiStatus)) {
    failures.push(rowFailure(businessName, "decision_maker", "decision_maker_not_ai_resolved", {
      actual: decisionMaker.aiStatus || null
    }));
  }
  if (decisionMaker.found === true) {
    if (!isPersonalLinkedInUrl(decisionMaker.linkedinUrl)) {
      failures.push(rowFailure(businessName, "decision_maker", "decision_maker_missing_personal_linkedin", {
        actual: decisionMaker.linkedinUrl || null
      }));
    }
    if (requireDecisionMakerVerification && decisionMaker.verificationStatus !== "confirmed") {
      failures.push(rowFailure(businessName, "decision_maker", "decision_maker_not_ai_verified", {
        actual: decisionMaker.verificationStatus || null
      }));
    }
  }
  if (requireDecisionMaker && decisionMaker.found !== true) {
    failures.push(rowFailure(businessName, "decision_maker", "decision_maker_required_but_not_found", {
      actual: decisionMaker.status || null
    }));
  }

  if (!row.summary?.deepseek?.items?.length) {
    failures.push(rowFailure(businessName, "deepseek", "missing_row_deepseek_cost_summary"));
  }
  return failures;
}

function validateProviderSummary({ businessName, provider, ads = {}, requireAdsVerification }) {
  const failures = [];
  const activeKey = provider === "meta" ? "metaActive" : "googleActive";
  const aiKey = provider === "meta" ? "metaAiStatus" : "googleAiStatus";
  const verificationKey = provider === "meta" ? "metaVerificationStatus" : "googleVerificationStatus";
  if (ads[aiKey] !== "resolved") {
    failures.push(rowFailure(businessName, `ads.${provider}`, `${provider}_not_ai_resolved`, {
      actual: ads[aiKey] || null
    }));
  }
  if (typeof ads[activeKey] !== "boolean") {
    failures.push(rowFailure(businessName, `ads.${provider}`, `${provider}_active_not_boolean`, {
      actual: ads[activeKey] ?? null
    }));
  }
  if (typeof ads[activeKey] === "boolean" && requireAdsVerification && ads[verificationKey] !== "confirmed") {
    failures.push(rowFailure(businessName, `ads.${provider}`, `${provider}_not_ai_verified`, {
      actual: ads[verificationKey] || null
    }));
  }
  return failures;
}

function validateUniqueBusinesses(results) {
  const failures = [];
  const seen = new Map();
  for (const row of results) {
    const key = businessKey(row?.business);
    if (!key) continue;
    if (seen.has(key)) {
      failures.push(batchFailure("batch.discovery", "duplicate_business", {
        key,
        firstIndex: seen.get(key),
        duplicateIndex: row.index || null
      }));
    } else {
      seen.set(key, row.index || null);
    }
  }
  return failures;
}

function businessKey(business = {}) {
  return business.place_id || normalizeKey(`${business.name || ""} ${business.address || ""}`);
}

function batchFailure(area, reason, extra = {}) {
  return { case: "reformas-madrid-batch", area, reason, ...extra };
}

function rowFailure(business, area, reason, extra = {}) {
  return { business, area, reason, ...extra };
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPersonalLinkedInUrl(value) {
  return /(^https?:\/\/)?([a-z]+\.)?linkedin\.com\/in\//i.test(String(value || ""));
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
