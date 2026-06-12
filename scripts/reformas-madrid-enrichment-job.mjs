#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

await loadDotEnv(path.resolve(process.cwd(), ".env"));

const { config } = await import("../packages/core/src/config.mjs");
const { ApifyClient } = await import("../packages/core/src/apify.mjs");
const {
  createApifyUsageStats,
  recordApifyCall,
  summarizeApifyUsage
} = await import("../packages/core/src/apifyUsagePolicy.mjs");
const {
  summarizeDeepseekCostItems,
  summarizeDeepseekEnrichmentCosts,
  validateDeepseekCostBudget
} = await import("../packages/core/src/aiUsage.mjs");
const { enrichBusinessAds } = await import("../packages/core/src/adsEnrichment.mjs");
const { enrichDecisionMaker } = await import("../packages/core/src/decisionMakerEnrichment.mjs");
const { validateReformasMadridBatchReport } = await import("../packages/core/src/enrichmentBatchReportPolicy.mjs");
const { FirecrawlClient } = await import("../packages/core/src/firecrawl.mjs");
const { GooglePlacesClient } = await import("../packages/core/src/googlePlaces.mjs");

const DEFAULT_LIMIT = 100;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_OUT_DIR = "reports";
const REFORMAS_MADRID_QUERIES = [
  "empresas de reformas Madrid",
  "reformas integrales Madrid",
  "empresa reformas viviendas Madrid",
  "reformas pisos Madrid",
  "reformas cocina Madrid",
  "reformas banos Madrid",
  "reforma local comercial Madrid",
  "reformas oficinas Madrid",
  "constructora reformas Madrid",
  "rehabilitacion viviendas Madrid",
  "reformas integrales Chamberi Madrid",
  "reformas integrales Salamanca Madrid",
  "reformas integrales Retiro Madrid",
  "reformas integrales Chamartin Madrid",
  "reformas integrales Arganzuela Madrid",
  "reformas integrales Moncloa Madrid",
  "reformas integrales Carabanchel Madrid",
  "reformas integrales Usera Madrid",
  "reformas integrales Vallecas Madrid",
  "reformas integrales Hortaleza Madrid",
  "reformas integrales Latina Madrid",
  "reformas integrales Tetuan Madrid",
  "reformas integrales Centro Madrid",
  "reformas vivienda Madrid norte",
  "reformas vivienda Madrid sur",
  "reformas vivienda Madrid este",
  "reformas vivienda Madrid oeste"
];

if (isCliRun()) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runReformasMadridEnrichmentJob({
      limit: args.limit,
      requireDecisionMaker: args.requireDecisionMaker,
      concurrency: args.concurrency,
      maxDeepseekUsd: args.maxDeepseekUsd,
      maxDeepseekUsdPerBusiness: args.maxDeepseekUsdPerBusiness,
      apifyFallbackMode: args.apifyFallbackMode,
      apifyMetaMaxSources: args.apifyMetaMaxSources,
      metaApifyFirst: args.metaApifyFirst,
      googleApifyFallbackEnabled: args.googleApifyFallbackEnabled,
      outputPath: args.out
    });
    if (report.failures.length) {
      console.error(`\n[job] FAIL ${report.summary?.ok || 0}/${report.summary?.processed || 0} passed. Report: ${report.outputPath}`);
      console.error(JSON.stringify(report.failures.slice(0, 20), null, 2));
      process.exit(1);
    }
    console.log(`\n[job] PASS ${report.summary.ok}/${report.summary.processed} passed. Report: ${report.outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === "missing_required_env" ? 2 : 1);
  }
}

export async function runReformasMadridEnrichmentJob(options = {}) {
  const limit = positiveInt(options.limit, DEFAULT_LIMIT);
  const concurrency = boundedConcurrency(options.concurrency, DEFAULT_CONCURRENCY);
  const requireDecisionMaker = Boolean(options.requireDecisionMaker);
  const maxDeepseekUsd = numberOrNull(options.maxDeepseekUsd);
  const maxDeepseekUsdPerBusiness = numberOrNull(options.maxDeepseekUsdPerBusiness);
  const apifyFallbackMode = normalizeApifyFallbackMode(options.apifyFallbackMode || config.adsEnrichment.apifyFallbackMode || "off");
  const metaApifyFirst = Boolean(options.metaApifyFirst);
  const googleApifyFallbackEnabled = options.googleApifyFallbackEnabled === true;
  const apifyMetaMaxSources = positiveInt(options.apifyMetaMaxSources, null);
  const outputPath = options.outputPath
    ? path.resolve(process.cwd(), options.outputPath)
    : path.resolve(process.cwd(), DEFAULT_OUT_DIR, `reformas-madrid-enrichment-${timestampForFile()}.json`);
  const logger = options.logger === false ? null : options.logger || console;
  const missing = requiredEnv();

  if (missing.length) {
    const error = new Error(`Missing required env for reformas Madrid enrichment job: ${missing.join(", ")}`);
    error.code = "missing_required_env";
    error.missing = missing;
    throw error;
  }

  const googlePlaces = new GooglePlacesClient();
  const firecrawl = new FirecrawlClient();
  const businesses = await discoverBusinesses({
    googlePlaces,
    limit,
    logger,
    onProgress: async (discovery) => {
      await options.onProgress?.(buildDiscoveryReport({
        limit,
        outputPath,
        discovery,
        requireDecisionMaker,
        apifyFallbackMode,
        apifyMetaMaxSources,
        metaApifyFirst,
        concurrency
      }), null);
    }
  });

  if (businesses.length < limit) {
    logger?.error?.(`[job] Only discovered ${businesses.length}/${limit} unique reformas businesses in Madrid.`);
    const report = {
      generatedAt: new Date().toISOString(),
      outputPath,
      target: { niche: "empresas de reformas", city: "Madrid", requestedLimit: limit },
      status: "failed_discovery_shortfall",
      summary: { processed: 0, ok: 0, failed: 0 },
      failures: [{
        area: "discovery",
        reason: "discovery_shortfall",
        expected: limit,
        actual: businesses.length
      }],
      businesses
    };
    await writeReport(outputPath, report);
    return report;
  }

  const selectedBusinesses = businesses.slice(0, limit);
  const results = [];
  const failures = [];

  logger?.log?.(`[job] Processing ${selectedBusinesses.length} reformas businesses in Madrid with concurrency=${concurrency}.`);
  await options.onProgress?.(buildProgressReport({
    limit,
    selectedBusinesses,
    results,
    failures,
    maxDeepseekUsd,
    requireDecisionMaker,
    apifyFallbackMode,
    apifyMetaMaxSources,
    metaApifyFirst,
    concurrency,
    outputPath,
    active: {
      step: "enrichment_start",
      message: `Processing ${selectedBusinesses.length} businesses`
    }
  }), null);

  let nextIndex = 0;
  async function processOne(index) {
    const business = selectedBusinesses[index];
    const label = `${index + 1}/${selectedBusinesses.length} ${business.name}`;
    logger?.log?.(`\n[job] ${label}`);
    const { apify, apifyStats } = createCountingApifyClient(apifyFallbackMode, {
      googleApifyFallbackEnabled,
      apifyMetaMaxSources
    });
    const startedAt = new Date().toISOString();

    try {
      await options.onProgress?.(buildProgressReport({
        limit,
        selectedBusinesses,
        results,
        failures,
        maxDeepseekUsd,
        requireDecisionMaker,
        apifyFallbackMode,
        apifyMetaMaxSources,
        metaApifyFirst,
        concurrency,
        outputPath,
        active: {
          step: "ads",
          index: index + 1,
          business: business.name
        }
      }), { index: index + 1, business, step: "ads" });
      const ads = await enrichBusinessAds({
        business,
        firecrawl,
        apify,
        country: "ES",
        apifyFallbackMode,
        metaApifyFirst
      });
      await options.onProgress?.(buildProgressReport({
        limit,
        selectedBusinesses,
        results,
        failures,
        maxDeepseekUsd,
        requireDecisionMaker,
        apifyFallbackMode,
        apifyMetaMaxSources,
        metaApifyFirst,
        concurrency,
        outputPath,
        active: {
          step: "decision_maker",
          index: index + 1,
          business: business.name
        }
      }), { index: index + 1, business, step: "decision_maker" });
      const decisionMaker = await enrichDecisionMaker({
        business,
        contacts: contactsForBusiness(business),
        searchClient: firecrawl
      });
      const deepseek = summarizeDeepseekEnrichmentCosts({ ads, decisionMaker });
      const validationFailures = validateOperationalResult({
        business,
        ads,
        decisionMaker,
        apifyStats,
        deepseek,
        requireDecisionMaker,
        maxDeepseekUsdPerBusiness,
        apifyFallbackMode
      });
      failures.push(...validationFailures);
      const row = {
        index: index + 1,
        business,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: validationFailures.length === 0,
        failures: validationFailures,
        summary: summarizeBusinessResult({ ads, decisionMaker, apifyStats, deepseek }),
        ads,
        decisionMaker
      };
      results[index] = row;
      logger?.log?.(JSON.stringify(row.summary, null, 2));
    } catch (error) {
      const failure = {
        business: business.name,
        area: "job",
        reason: "enrichment_exception",
        message: error.message
      };
      failures.push(failure);
      results[index] = {
        index: index + 1,
        business,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: false,
        failures: [failure]
      };
      logger?.error?.(JSON.stringify(failure, null, 2));
    }

    const partialReport = buildReport({
      limit,
      selectedBusinesses,
      results: orderedResults(results),
      failures,
      maxDeepseekUsd,
      requireDecisionMaker,
      apifyFallbackMode,
      apifyMetaMaxSources,
      metaApifyFirst,
      concurrency
    });
    partialReport.outputPath = outputPath;
    await writeReport(outputPath, partialReport);
    await options.onProgress?.(partialReport, results[index]);
  }

  async function worker() {
    while (nextIndex < selectedBusinesses.length) {
      const index = nextIndex;
      nextIndex += 1;
      await processOne(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, selectedBusinesses.length) }, () => worker()));

  const report = buildReport({
    limit,
    selectedBusinesses,
    results: orderedResults(results),
    failures,
    maxDeepseekUsd,
    requireDecisionMaker,
    apifyFallbackMode,
    apifyMetaMaxSources,
    metaApifyFirst,
    concurrency
  });
  report.outputPath = outputPath;
  await writeReport(outputPath, report);
  return report;
}

async function discoverBusinesses({ googlePlaces, limit, logger = console, onProgress }) {
  const byKey = new Map();
  const errors = [];
  for (let index = 0; index < REFORMAS_MADRID_QUERIES.length; index += 1) {
    const query = REFORMAS_MADRID_QUERIES[index];
    if (byKey.size >= limit) break;
    logger?.log?.(`[discover] ${query}`);
    await onProgress?.({
      phase: "discovery",
      query,
      queryIndex: index + 1,
      queryTotal: REFORMAS_MADRID_QUERIES.length,
      discovered: byKey.size,
      errors
    });
    let places = [];
    try {
      places = await googlePlaces.searchText({ query, maxResultCount: 20 });
    } catch (error) {
      const failure = {
        query,
        message: error.message,
        status: error.status || null
      };
      errors.push(failure);
      logger?.error?.(`[discover] ${query} failed: ${error.message}`);
      await onProgress?.({
        phase: "discovery",
        query,
        queryIndex: index + 1,
        queryTotal: REFORMAS_MADRID_QUERIES.length,
        discovered: byKey.size,
        errors
      });
      continue;
    }
    for (const place of places) {
      const business = businessFromPlace(place, query);
      if (!business.name) continue;
      const key = place.placeId || normalizeKey(`${business.name} ${business.address || ""}`);
      if (!byKey.has(key)) byKey.set(key, business);
      if (byKey.size >= limit) break;
    }
    await onProgress?.({
      phase: "discovery",
      query,
      queryIndex: index + 1,
      queryTotal: REFORMAS_MADRID_QUERIES.length,
      discovered: byKey.size,
      errors
    });
  }
  return [...byKey.values()];
}

function buildProgressReport({
  limit,
  selectedBusinesses,
  results,
  failures,
  maxDeepseekUsd,
  requireDecisionMaker,
  apifyFallbackMode,
  apifyMetaMaxSources,
  metaApifyFirst,
  concurrency,
  outputPath,
  active
}) {
  const report = buildReport({
    limit,
    selectedBusinesses,
    results: orderedResults(results),
    failures,
    maxDeepseekUsd,
    requireDecisionMaker,
    apifyFallbackMode,
    apifyMetaMaxSources,
    metaApifyFirst,
    concurrency
  });
  report.outputPath = outputPath;
  report.status = "running_enrichment";
  report.phase = "enrichment";
  report.active = active || null;
  return report;
}

function buildDiscoveryReport({ limit, outputPath, discovery, requireDecisionMaker, apifyFallbackMode, apifyMetaMaxSources, metaApifyFirst, concurrency }) {
  return {
    generatedAt: new Date().toISOString(),
    outputPath,
    target: {
      niche: "empresas de reformas",
      city: "Madrid",
      requestedLimit: limit,
      processedLimit: 0,
      requireDecisionMaker,
      apifyFallbackMode,
      apifyMetaMaxSources: apifyMetaMaxSources || null,
      metaApifyFirst: metaApifyFirst === true,
      concurrency: concurrency || null
    },
    status: "running_discovery",
    phase: "discovery",
    discovery,
    summary: {
      processed: 0,
      ok: 0,
      failed: 0,
      discovered: discovery?.discovered || 0
    },
    failures: [],
    results: []
  };
}

function businessFromPlace(place = {}, discoveryQuery) {
  return {
    place_id: place.placeId || null,
    name: place.name,
    city: "Madrid",
    niche: "empresas de reformas",
    category: "reformas",
    website: place.website || null,
    phone: place.phone || null,
    phone_e164: place.phoneE164 || null,
    address: place.address || null,
    source_url: place.sourceUrl || null,
    custom_fields: {
      discoveryQuery,
      googlePlaceId: place.placeId || null,
      rating: place.rating ?? null,
      reviewCount: place.reviewCount ?? null
    }
  };
}

function contactsForBusiness(business = {}) {
  const contacts = [];
  if (business.phone_e164) contacts.push({ kind: "phone", value: business.phone_e164, confidence: 0.9, sourceUrl: business.source_url });
  else if (business.phone) contacts.push({ kind: "phone", value: business.phone, confidence: 0.75, sourceUrl: business.source_url });
  if (business.website) contacts.push({ kind: "website", value: business.website, confidence: 0.8, sourceUrl: business.website });
  return contacts;
}

function createCountingApifyClient(mode = config.adsEnrichment.apifyFallbackMode || "off", options = {}) {
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
      get metaMaxSources() {
        return options.apifyMetaMaxSources || client.metaMaxSources;
      },
      get googleFallbackEnabled() {
        return options.googleApifyFallbackEnabled === true;
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

function validateOperationalResult({ business, ads, decisionMaker, apifyStats, deepseek, requireDecisionMaker, maxDeepseekUsdPerBusiness, apifyFallbackMode }) {
  const label = business.name || "business";
  const failures = [];
  if (ads.discoveryPlan?.ai?.status !== "planned") {
    failures.push({
      business: label,
      area: "ads.discovery",
      reason: "ads_discovery_not_ai_planned",
      actual: ads.discoveryPlan?.ai?.status || null
    });
  }
  failures.push(...validateProvider({ business: label, provider: "meta", result: ads.meta }));
  failures.push(...validateProvider({ business: label, provider: "google", result: ads.google }));
  if ((ads.meta?.active === true || ads.google?.active === true) && ads.classification?.ai?.status !== "classified") {
    failures.push({
      business: label,
      area: "ads.funnel",
      reason: "active_ads_funnel_not_ai_classified",
      actual: ads.classification?.ai?.status || null,
      type: ads.classification?.type || null
    });
  }
  if (decisionMaker.searchPlan?.ai?.status !== "planned") {
    failures.push({
      business: label,
      area: "decision_maker.search",
      reason: "decision_maker_search_not_ai_planned",
      actual: decisionMaker.searchPlan?.ai?.status || null
    });
  }
  if (!["resolved", "resolved_no_match"].includes(decisionMaker.ai?.status)) {
    failures.push({
      business: label,
      area: "decision_maker",
      reason: "decision_maker_not_ai_resolved",
      actual: decisionMaker.ai?.status || null,
      decisionStatus: decisionMaker.decisionStatus || null
    });
  }
  if (decisionMaker.found === true && !isPersonalLinkedInUrl(decisionMaker.decisionMaker?.linkedinUrl)) {
    failures.push({
      business: label,
      area: "decision_maker",
      reason: "decision_maker_missing_personal_linkedin",
      actual: decisionMaker.decisionMaker?.linkedinUrl || null
    });
  }
  if (decisionMaker.found === true && decisionMakerVerificationRequired() && decisionMaker.ai?.verification?.status !== "confirmed") {
    failures.push({
      business: label,
      area: "decision_maker",
      reason: "decision_maker_not_ai_verified",
      actual: decisionMaker.ai?.verification?.status || null
    });
  }
  if (requireDecisionMaker && decisionMaker.found !== true) {
    failures.push({
      business: label,
      area: "decision_maker",
      reason: "decision_maker_required_but_not_found",
      actual: decisionMaker.decisionStatus || null
    });
  }
  const apify = summarizeApifyUsage(apifyStats);
  if ((apifyFallbackMode || config.adsEnrichment.apifyFallbackMode || "off") === "off" && apify.totalCalls > 0) {
    failures.push({
      business: label,
      area: "ads.apify",
      reason: "apify_called_while_disabled",
      actual: apify.totalCalls,
      calls: apify.calls
    });
  }
  failures.push(...validateDeepseekCostBudget({
    summary: deepseek,
    maxUsd: maxDeepseekUsdPerBusiness,
    label,
    area: "deepseek.business"
  }));
  return failures;
}

function validateProvider({ business, provider, result = {} }) {
  const failures = [];
  if (result.ai?.status !== "resolved") {
    failures.push({
      business,
      area: `ads.${provider}`,
      reason: `${provider}_not_ai_resolved`,
      actual: result.ai?.status || null
    });
  }
  if (typeof result.active === "boolean" && adsVerificationRequired() && result.ai?.verification?.status !== "confirmed") {
    failures.push({
      business,
      area: `ads.${provider}`,
      reason: `${provider}_not_ai_verified`,
      actual: result.ai?.verification?.status || null
    });
  }
  return failures;
}

function adsVerificationRequired() {
  return !["never", "off", "false", "0"].includes(String(config.adsActivityAi.verifyMode || "always").toLowerCase());
}

function decisionMakerVerificationRequired() {
  return !["never", "off", "false", "0"].includes(String(config.decisionMakerAi.verifyMode || "always").toLowerCase());
}

function summarizeBusinessResult({ ads, decisionMaker, apifyStats, deepseek }) {
  return {
    ads: {
      discoveryAiStatus: ads.discoveryPlan?.ai?.status || null,
      metaActive: ads.meta?.active ?? null,
      metaAiStatus: ads.meta?.ai?.status || null,
      metaVerificationStatus: ads.meta?.ai?.verification?.status || null,
      googleActive: ads.google?.active ?? null,
      googleAiStatus: ads.google?.ai?.status || null,
      googleVerificationStatus: ads.google?.ai?.verification?.status || null,
      funnelType: ads.classification?.type || null,
      funnelAiStatus: ads.classification?.ai?.status || null
    },
    decisionMaker: {
      found: decisionMaker.found === true,
      status: decisionMaker.decisionStatus || null,
      searchAiStatus: decisionMaker.searchPlan?.ai?.status || null,
      aiStatus: decisionMaker.ai?.status || null,
      verificationStatus: decisionMaker.ai?.verification?.status || null,
      fullName: decisionMaker.decisionMaker?.fullName || null,
      linkedinUrl: decisionMaker.decisionMaker?.linkedinUrl || null
    },
    apify: summarizeApifyUsage(apifyStats),
    deepseek
  };
}

function buildReport({ limit, selectedBusinesses, results, failures, maxDeepseekUsd, requireDecisionMaker, apifyFallbackMode, apifyMetaMaxSources, metaApifyFirst, concurrency }) {
  const deepseek = summarizeDeepseekCostItems(
    results.flatMap((row) => (row.summary?.deepseek?.items || []).map((item) => ({
      ...item,
      area: `${row.index}.${item.area}`
    })))
  );
  const budgetFailures = validateDeepseekCostBudget({
    summary: deepseek,
    maxUsd: maxDeepseekUsd,
    label: "reformas-madrid-batch",
    area: "deepseek.batch"
  });
  const baseFailures = dedupeFailures([...failures, ...budgetFailures]);
  const report = {
    generatedAt: new Date().toISOString(),
    target: {
      niche: "empresas de reformas",
      city: "Madrid",
      requestedLimit: limit,
      processedLimit: selectedBusinesses.length,
      requireDecisionMaker,
      apifyFallbackMode,
      apifyMetaMaxSources: apifyMetaMaxSources || null,
      metaApifyFirst: metaApifyFirst === true,
      concurrency: concurrency || null
    },
    summary: {
      processed: results.length,
      ok: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok).length,
      metaActive: results.filter((row) => row.summary?.ads?.metaActive === true).length,
      googleActive: results.filter((row) => row.summary?.ads?.googleActive === true).length,
      decisionMakersFound: results.filter((row) => row.summary?.decisionMaker?.found === true).length,
      apify: summarizeBatchApify(results, apifyFallbackMode),
      deepseek
    },
    failures: baseFailures,
    results
  };
  const reportFailures = validateReformasMadridBatchReport({
    report,
    expectedLimit: limit,
    requireDecisionMaker,
    apifyFallbackMode: apifyFallbackMode || config.adsEnrichment.apifyFallbackMode,
    requireAdsVerification: adsVerificationRequired(),
    requireDecisionMakerVerification: decisionMakerVerificationRequired()
  });
  return {
    ...report,
    failures: dedupeFailures([...baseFailures, ...reportFailures])
  };
}

function isCliRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function summarizeBatchApify(results, apifyFallbackMode = config.adsEnrichment.apifyFallbackMode || "off") {
  const calls = results.flatMap((row) => row.summary?.apify?.calls || []);
  return {
    mode: apifyFallbackMode,
    metaCalls: results.reduce((total, row) => total + (row.summary?.apify?.metaCalls || 0), 0),
    googleCalls: results.reduce((total, row) => total + (row.summary?.apify?.googleCalls || 0), 0),
    totalCalls: results.reduce((total, row) => total + (row.summary?.apify?.totalCalls || 0), 0),
    calls: calls.slice(0, 100)
  };
}

function dedupeFailures(failures = []) {
  const seen = new Set();
  const deduped = [];
  for (const failure of failures) {
    const key = JSON.stringify(failure);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(failure);
  }
  return deduped;
}

function orderedResults(results = []) {
  return results.filter(Boolean).sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
}

async function writeReport(filePath, report) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function requiredEnv() {
  const missing = [];
  if (!config.google.apiKey) missing.push("GOOGLE_MAPS_API_KEY");
  if (requiresFirecrawlApiKey() && !config.firecrawl.apiKey) missing.push("FIRECRAWL_API_KEY");
  if (!config.adsActivityAi.apiKey) missing.push("DEEPINFRA_API_KEY");
  if (!config.adsFunnelAi.apiKey) missing.push("DEEPINFRA_API_KEY");
  if (!config.decisionMakerAi.apiKey) missing.push("DEEPINFRA_API_KEY");
  return [...new Set(missing)];
}

function requiresFirecrawlApiKey() {
  return /(^https?:\/\/)?api\.firecrawl\.dev\b/i.test(String(config.firecrawl.baseUrl || ""));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      parsed.limit = argv[index + 1];
      index += 1;
    } else if (arg === "--out") {
      parsed.out = argv[index + 1];
      index += 1;
    } else if (arg === "--max-deepseek-usd") {
      parsed.maxDeepseekUsd = argv[index + 1];
      index += 1;
    } else if (arg === "--max-deepseek-usd-per-business") {
      parsed.maxDeepseekUsdPerBusiness = argv[index + 1];
      index += 1;
    } else if (arg === "--require-decision-maker") {
      parsed.requireDecisionMaker = true;
    } else if (arg === "--concurrency") {
      parsed.concurrency = argv[index + 1];
      index += 1;
    } else if (arg === "--apify-fallback-mode") {
      parsed.apifyFallbackMode = argv[index + 1];
      index += 1;
    } else if (arg === "--apify-meta-max-sources") {
      parsed.apifyMetaMaxSources = argv[index + 1];
      index += 1;
    } else if (arg === "--meta-apify-first") {
      parsed.metaApifyFirst = true;
    } else if (arg === "--google-apify-fallback-enabled") {
      parsed.googleApifyFallbackEnabled = true;
    }
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedConcurrency(value, fallback) {
  const parsed = positiveInt(value, fallback);
  return Math.min(10, Math.max(1, parsed));
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeApifyFallbackMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  return ["off", "on_unknown", "always"].includes(mode) ? mode : "off";
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

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function unquoteEnv(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
