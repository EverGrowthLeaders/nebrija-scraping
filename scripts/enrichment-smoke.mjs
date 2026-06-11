#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

await loadDotEnv(path.resolve(process.cwd(), ".env"));

const { config } = await import("../packages/core/src/config.mjs");
const { ApifyClient } = await import("../packages/core/src/apify.mjs");
const {
  createApifyUsageStats,
  recordApifyCall,
  summarizeApifyUsage,
  validateApifyUsage
} = await import("../packages/core/src/apifyUsagePolicy.mjs");
const {
  summarizeDeepseekEnrichmentCosts,
  validateDeepseekCostBudget
} = await import("../packages/core/src/aiUsage.mjs");
const { enrichBusinessAds } = await import("../packages/core/src/adsEnrichment.mjs");
const { enrichDecisionMaker } = await import("../packages/core/src/decisionMakerEnrichment.mjs");
const { FirecrawlClient } = await import("../packages/core/src/firecrawl.mjs");

const args = parseArgs(process.argv.slice(2));
const cases = await loadCases(args.cases);
const missing = requiredEnv();
if (missing.length) {
  console.error(`Missing required env for live enrichment smoke: ${missing.join(", ")}`);
  process.exit(2);
}
if (!cases.length) {
  console.error("No smoke cases supplied. Use --cases path/to/cases.json or SMOKE_CASES_JSON.");
  process.exit(2);
}

const firecrawl = new FirecrawlClient();
const failures = [];
const summaries = [];

for (const smokeCase of cases) {
  const label = `${smokeCase.name || smokeCase.business?.name || "business"} (${smokeCase.city || smokeCase.business?.city || "no-city"})`;
  const business = normalizeBusiness(smokeCase);
  if (!business.name) {
    failures.push({ case: label, reason: "missing_business_name" });
    continue;
  }

  console.log(`\n[smoke] ${label}`);
  const { apify, apifyStats } = createCountingApifyClient();
  const ads = await enrichBusinessAds({
    business,
    firecrawl,
    apify,
    country: smokeCase.country || "ES"
  });
  const decisionMaker = await enrichDecisionMaker({
    business,
    contacts: smokeCase.contacts || [],
    searchClient: firecrawl
  });
  const deepseek = summarizeDeepseekEnrichmentCosts({ ads, decisionMaker });

  const summary = {
    case: label,
    deepseek,
    ads: {
      discoveryAiStatus: ads.discoveryPlan?.ai?.status || null,
      metaActive: ads.meta?.active ?? null,
      metaReason: ads.meta?.reason || null,
      metaAiStatus: ads.meta?.ai?.status || null,
      metaVerificationStatus: ads.meta?.ai?.verification?.status || null,
      googleActive: ads.google?.active ?? null,
      googleReason: ads.google?.reason || null,
      googleAiStatus: ads.google?.ai?.status || null,
      googleVerificationStatus: ads.google?.ai?.verification?.status || null,
      funnelType: ads.classification?.type || null,
      funnelReason: ads.classification?.reason || null,
      funnelAiStatus: ads.classification?.ai?.status || null,
      apify: summarizeApifyUsage(apifyStats)
    },
    decisionMaker: {
      found: decisionMaker.found === true,
      status: decisionMaker.decisionStatus || null,
      reason: decisionMaker.reason || null,
      searchAiStatus: decisionMaker.searchPlan?.ai?.status || null,
      fullName: decisionMaker.decisionMaker?.fullName || null,
      linkedinUrl: decisionMaker.decisionMaker?.linkedinUrl || null,
      aiStatus: decisionMaker.ai?.status || null,
      verificationStatus: decisionMaker.ai?.verification?.status || null
    }
  };
  summaries.push(summary);
  console.log(JSON.stringify(summary, null, 2));

  failures.push(...validateAds({ smokeCase, ads, label, apifyStats }));
  failures.push(...validateDecisionMaker({ smokeCase, decisionMaker, label }));
  failures.push(...validateDeepseekBudgets({ smokeCase, deepseek, label }));
}

if (failures.length) {
  console.error("\n[smoke] FAIL");
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

console.log("\n[smoke] PASS");
console.log(JSON.stringify(summaries, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cases") {
      parsed.cases = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

async function loadCases(casesPath) {
  if (casesPath) {
    return normalizeCases(JSON.parse(await fs.readFile(path.resolve(process.cwd(), casesPath), "utf8")));
  }
  if (process.env.SMOKE_CASES_JSON) {
    return normalizeCases(JSON.parse(process.env.SMOKE_CASES_JSON));
  }
  return [];
}

function normalizeCases(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.cases)) return value.cases;
  return [];
}

function requiredEnv() {
  const missing = [];
  if (requiresFirecrawlApiKey() && !config.firecrawl.apiKey) missing.push("FIRECRAWL_API_KEY");
  if (!config.adsActivityAi.apiKey) missing.push("DEEPINFRA_API_KEY");
  if (!config.adsFunnelAi.apiKey) missing.push("DEEPINFRA_API_KEY");
  if (!config.decisionMakerAi.apiKey) missing.push("DEEPINFRA_API_KEY");
  return [...new Set(missing)];
}

function requiresFirecrawlApiKey() {
  return /(^https?:\/\/)?api\.firecrawl\.dev\b/i.test(String(config.firecrawl.baseUrl || ""));
}

function normalizeBusiness(smokeCase = {}) {
  const source = smokeCase.business || smokeCase;
  return {
    name: source.name,
    city: source.city,
    niche: source.niche || source.category,
    category: source.category,
    website: source.website,
    phone: source.phone,
    phone_e164: source.phone_e164 || source.phoneE164,
    instagram: source.instagram,
    facebook: source.facebook,
    source_url: source.source_url || source.sourceUrl,
    custom_fields: source.custom_fields || source.customFields || {}
  };
}

function createCountingApifyClient() {
  const mode = config.adsEnrichment.apifyFallbackMode || "off";
  const stats = createApifyUsageStats(mode);
  if (mode === "off" || !config.apify.apiKey) return { apify: null, apifyStats: stats };

  const client = new ApifyClient();
  return {
    apify: {
      get enabled() {
        return client.enabled;
      },
      get facebookAdsActorId() {
        return client.facebookAdsActorId;
      },
      get googleAdsActorId() {
        return client.googleAdsActorId;
      },
      get maxChargedResults() {
        return client.maxChargedResults;
      },
      async runFacebookAdsLibrary(input = {}, options = {}) {
        recordApifyCall(stats, "meta", input);
        return client.runFacebookAdsLibrary(input, options);
      },
      async runGoogleAdsTransparency(input = {}, options = {}) {
        recordApifyCall(stats, "google", input);
        return client.runGoogleAdsTransparency(input, options);
      }
    },
    apifyStats: stats
  };
}

function validateAds({ smokeCase, ads, label, apifyStats }) {
  const expected = smokeCase.expectedAds || smokeCase.expected_ads;
  if (!expected) return [{ case: label, area: "ads", reason: "missing_expected_ads" }];
  const failures = [];
  failures.push(...validateApifyUsage({
    expectedAds: expected,
    stats: apifyStats,
    fallbackMode: config.adsEnrichment.apifyFallbackMode,
    label
  }));
  if (ads.discoveryPlan?.ai?.status !== "planned") {
    failures.push({
      case: label,
      area: "ads.discovery",
      reason: "ads_discovery_not_ai_planned",
      actual: ads.discoveryPlan?.ai?.status || null
    });
  }
  if (ads.meta?.ai?.status !== "resolved") {
    failures.push({
      case: label,
      area: "ads.meta",
      reason: "meta_not_ai_resolved",
      actual: ads.meta?.ai?.status || null
    });
  }
  if (typeof ads.meta?.active === "boolean" && adsVerificationRequired() && ads.meta?.ai?.verification?.status !== "confirmed") {
    failures.push({
      case: label,
      area: "ads.meta",
      reason: "meta_not_ai_verified",
      actual: ads.meta?.ai?.verification?.status || null
    });
  }
  if (ads.google?.ai?.status !== "resolved") {
    failures.push({
      case: label,
      area: "ads.google",
      reason: "google_not_ai_resolved",
      actual: ads.google?.ai?.status || null
    });
  }
  if (typeof ads.google?.active === "boolean" && adsVerificationRequired() && ads.google?.ai?.verification?.status !== "confirmed") {
    failures.push({
      case: label,
      area: "ads.google",
      reason: "google_not_ai_verified",
      actual: ads.google?.ai?.verification?.status || null
    });
  }
  const hasActiveAds = ads.meta?.active === true || ads.google?.active === true;
  if (hasActiveAds && ads.classification?.type !== "unknown" && ads.classification?.ai?.status !== "classified") {
    failures.push({
      case: label,
      area: "ads.funnel",
      reason: "funnel_not_ai_classified",
      actual: ads.classification?.ai?.status || null,
      type: ads.classification?.type || null
    });
  }
  if (expected.funnelType && ads.classification?.type !== expected.funnelType) {
    failures.push({
      case: label,
      area: "ads.funnel",
      reason: "funnel_type_mismatch",
      expected: expected.funnelType,
      actual: ads.classification?.type || null,
      ai: ads.classification?.ai || null
    });
  }
  if (typeof expected.metaActive !== "boolean") {
    failures.push({ case: label, area: "ads.meta", reason: "missing_expected_meta_active" });
  } else if (ads.meta?.active !== expected.metaActive) {
    failures.push({
      case: label,
      area: "ads.meta",
      reason: "meta_active_mismatch",
      expected: expected.metaActive,
      actual: ads.meta?.active ?? null,
      ai: ads.meta?.ai || null
    });
  }
  if (typeof expected.googleActive !== "boolean") {
    failures.push({ case: label, area: "ads.google", reason: "missing_expected_google_active" });
  } else if (ads.google?.active !== expected.googleActive) {
    failures.push({
      case: label,
      area: "ads.google",
      reason: "google_active_mismatch",
      expected: expected.googleActive,
      actual: ads.google?.active ?? null,
      ai: ads.google?.ai || null
    });
  }
  return failures;
}

function validateDecisionMaker({ smokeCase, decisionMaker, label }) {
  const expected = smokeCase.expectedDecisionMaker || smokeCase.expected_decision_maker;
  if (!expected) return [{ case: label, area: "decision_maker", reason: "missing_expected_decision_maker" }];
  const failures = [];
  if (decisionMaker.searchPlan?.ai?.status !== "planned") {
    failures.push({
      case: label,
      area: "decision_maker.search",
      reason: "decision_maker_search_not_ai_planned",
      actual: decisionMaker.searchPlan?.ai?.status || null
    });
  }
  if (!["resolved", "resolved_no_match"].includes(decisionMaker.ai?.status)) {
    failures.push({
      case: label,
      area: "decision_maker",
      reason: "decision_maker_not_ai_resolved",
      actual: decisionMaker.ai?.status || null
    });
  }
  if (decisionMaker.found === true && decisionMakerVerificationRequired() && decisionMaker.ai?.verification?.status !== "confirmed") {
    failures.push({
      case: label,
      area: "decision_maker",
      reason: "decision_maker_not_ai_verified",
      actual: decisionMaker.ai?.verification?.status || null
    });
  }
  if (typeof expected.found === "boolean" && decisionMaker.found !== expected.found) {
    failures.push({
      case: label,
      area: "decision_maker",
      reason: "found_mismatch",
      expected: expected.found,
      actual: decisionMaker.found,
      ai: decisionMaker.ai || null
    });
  }
  if (expected.linkedinUrl) {
    const actual = normalizeUrl(decisionMaker.decisionMaker?.linkedinUrl);
    const wanted = normalizeUrl(expected.linkedinUrl);
    if (actual !== wanted) {
      failures.push({
        case: label,
        area: "decision_maker",
        reason: "linkedin_url_mismatch",
        expected: wanted,
        actual,
        ai: decisionMaker.ai || null
      });
    }
  }
  if (expected.fullName) {
    const actual = normalizeText(decisionMaker.decisionMaker?.fullName);
    const wanted = normalizeText(expected.fullName);
    if (!actual.includes(wanted) && !wanted.includes(actual)) {
      failures.push({
        case: label,
        area: "decision_maker",
        reason: "full_name_mismatch",
        expected: expected.fullName,
        actual: decisionMaker.decisionMaker?.fullName || null
      });
    }
  }
  return failures;
}

function validateDeepseekBudgets({ smokeCase, deepseek, label }) {
  const maxUsd =
    smokeCase.maxDeepseekUsd ??
    smokeCase.max_deepseek_usd ??
    smokeCase.expectedAi?.maxDeepseekUsd ??
    smokeCase.expected_ai?.max_deepseek_usd;
  return validateDeepseekCostBudget({
    summary: deepseek,
    maxUsd,
    label,
    area: "deepseek"
  });
}

function adsVerificationRequired() {
  return !["never", "off", "false", "0"].includes(String(config.adsActivityAi.verifyMode || "always").toLowerCase());
}

function decisionMakerVerificationRequired() {
  return !["never", "off", "false", "0"].includes(String(config.decisionMakerAi.verifyMode || "always").toLowerCase());
}

function normalizeUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value).startsWith("http") ? value : `https://${value}`);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function loadDotEnv(filePath) {
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = unquoteEnv(trimmed.slice(index + 1).trim());
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function unquoteEnv(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
