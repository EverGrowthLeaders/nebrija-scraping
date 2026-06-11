#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const { validateDeepseekCostBudget } = await import("../packages/core/src/aiUsage.mjs");
const { validateReformasMadridBatchReport } = await import("../packages/core/src/enrichmentBatchReportPolicy.mjs");

const args = parseArgs(process.argv.slice(2));
const reportPath = args.report || args._[0];

if (!reportPath) {
  console.error("Usage: npm run report:validate-enrichment -- --report reports/reformas-madrid-enrichment.json");
  process.exit(2);
}

const report = JSON.parse(await fs.readFile(path.resolve(process.cwd(), reportPath), "utf8"));
const expectedLimit = positiveInt(args.expectedLimit, positiveInt(report.target?.requestedLimit, 100));
const embeddedFailures = Array.isArray(report.failures) ? report.failures : [];
const validationFailures = validateReformasMadridBatchReport({
  report,
  expectedLimit,
  requireDecisionMaker: Boolean(args.requireDecisionMaker),
  apifyFallbackMode: args.apifyFallbackMode || report.summary?.apify?.mode || "off",
  requireAdsVerification: !args.allowUnverifiedAds,
  requireDecisionMakerVerification: !args.allowUnverifiedDecisionMaker
});
const budgetFailures = validateDeepseekCostBudget({
  summary: report.summary?.deepseek || {},
  maxUsd: args.maxDeepseekUsd,
  label: "reformas-madrid-batch",
  area: "deepseek.batch"
});
const failures = dedupeFailures([...embeddedFailures, ...validationFailures, ...budgetFailures]);

if (failures.length) {
  console.error(`[report] FAIL ${failures.length} failure(s) in ${reportPath}`);
  console.error(JSON.stringify(failures.slice(0, 100), null, 2));
  process.exit(1);
}

console.log(`[report] PASS ${report.summary?.ok || 0}/${report.summary?.processed || 0} rows in ${reportPath}`);
console.log(JSON.stringify({
  target: report.target,
  summary: {
    processed: report.summary?.processed || 0,
    ok: report.summary?.ok || 0,
    failed: report.summary?.failed || 0,
    metaActive: report.summary?.metaActive || 0,
    googleActive: report.summary?.googleActive || 0,
    decisionMakersFound: report.summary?.decisionMakersFound || 0,
    apify: report.summary?.apify || null,
    deepseek: report.summary?.deepseek || null
  }
}, null, 2));

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report") {
      parsed.report = argv[index + 1];
      index += 1;
    } else if (arg === "--expected-limit") {
      parsed.expectedLimit = argv[index + 1];
      index += 1;
    } else if (arg === "--max-deepseek-usd") {
      parsed.maxDeepseekUsd = argv[index + 1];
      index += 1;
    } else if (arg === "--apify-fallback-mode") {
      parsed.apifyFallbackMode = argv[index + 1];
      index += 1;
    } else if (arg === "--require-decision-maker") {
      parsed.requireDecisionMaker = true;
    } else if (arg === "--allow-unverified-ads") {
      parsed.allowUnverifiedAds = true;
    } else if (arg === "--allow-unverified-decision-maker") {
      parsed.allowUnverifiedDecisionMaker = true;
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
