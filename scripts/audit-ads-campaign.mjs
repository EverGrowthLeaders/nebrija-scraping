#!/usr/bin/env node
import { closeDb, query } from "../packages/core/src/db.mjs";

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function inc(map, key) {
  const safeKey = key == null || key === "" ? "(empty)" : String(key);
  map[safeKey] = (map[safeKey] || 0) + 1;
}

function provider(enrichment, name) {
  return enrichment && typeof enrichment === "object" && enrichment[name] && typeof enrichment[name] === "object"
    ? enrichment[name]
    : {};
}

function attempts(providerDetail) {
  return Array.isArray(providerDetail?.attempts) ? providerDetail.attempts : [];
}

function hasApifyAttempt(providerDetail) {
  return attempts(providerDetail).some((attempt) => attempt?.sourceProvider === "apify");
}

function hasActiveApifyAttempt(providerDetail) {
  return attempts(providerDetail).some((attempt) => attempt?.sourceProvider === "apify" && attempt?.active === true);
}

function hasApifyActiveCandidate(providerDetail) {
  return attempts(providerDetail).some((attempt) =>
    attempt?.sourceProvider === "apify" &&
    /active|candidate/i.test(String(attempt?.reason || attempt?.reasonSignal || ""))
  );
}

function samplePush(samples, row, providerName, detail, tag) {
  if (samples.length >= 20) return;
  samples.push({
    tag,
    provider: providerName,
    businessId: row.id,
    name: row.name,
    website: row.website,
    storedActive: row[`ads_${providerName}_active`],
    checkedAt: row.ads_last_checked_at,
    status: detail.status || null,
    reason: detail.reason || null,
    aiStatus: detail.ai?.status || null,
    verificationStatus: detail.ai?.verification?.status || null,
    sourceProvider: detail.sourceProvider || null,
    selectedAttemptIds: detail.ai?.selectedAttemptIds || detail.ai?.verification?.selectedAttemptIds || [],
    attempts: attempts(detail).slice(0, 5).map((attempt) => ({
      attemptId: attempt.attemptId || null,
      sourceProvider: attempt.sourceProvider || null,
      strategy: attempt.strategy || null,
      query: attempt.query || null,
      active: attempt.active ?? null,
      status: attempt.status || null,
      reason: attempt.reason || null,
      matchedFields: attempt.matchedFields || null,
      landingUrls: attempt.landingUrls || [],
      adArchiveId: attempt.adArchiveId || null,
      sourceUrl: attempt.sourceUrl || null
    }))
  });
}

async function findCampaign() {
  if (args["national-campaign-id"]) {
    const result = await query(`SELECT * FROM national_campaigns WHERE id = $1`, [args["national-campaign-id"]]);
    return result.rows[0] || null;
  }
  const params = [];
  const where = [];
  if (args.niche) {
    params.push(`%${args.niche}%`);
    where.push(`niche ILIKE $${params.length}`);
  }
  const result = await query(
    `SELECT *
       FROM national_campaigns
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function main() {
  const campaign = await findCampaign();
  if (!campaign) {
    console.error("No national campaign found. Pass --national-campaign-id <uuid> or --niche <text>.");
    process.exitCode = 1;
    return;
  }

  const rows = await query(
    `SELECT b.id,
            b.name,
            b.website,
            b.ads_meta_active,
            b.ads_google_active,
            b.ads_last_checked_at,
            b.ads_enrichment
       FROM businesses b
       JOIN extraction_jobs j ON j.id = b.extraction_job_id AND j.tenant_id = b.tenant_id
      WHERE j.national_campaign_id = $1
      ORDER BY b.updated_at DESC`,
    [campaign.id]
  );

  const summary = {
    campaign: {
      id: campaign.id,
      niche: campaign.niche,
      country: campaign.country,
      createdAt: campaign.created_at
    },
    total: rows.rowCount,
    checked: 0,
    unchecked: 0,
    stored: {
      meta: { true: 0, false: 0, null: 0 },
      google: { true: 0, false: 0, null: 0 }
    },
    evidence: {
      any: 0,
      metaAttempts: 0,
      googleAttempts: 0,
      metaApifyAttempts: 0,
      googleApifyAttempts: 0,
      metaApifyActiveAttempts: 0,
      googleApifyActiveAttempts: 0,
      metaApifyActiveCandidates: 0,
      googleApifyActiveCandidates: 0
    },
    reasons: {
      meta: {},
      google: {}
    },
    aiStatuses: {
      meta: {},
      google: {}
    },
    verificationStatuses: {
      meta: {},
      google: {}
    },
    samples: []
  };

  for (const row of rows.rows) {
    if (row.ads_last_checked_at) summary.checked += 1;
    else summary.unchecked += 1;

    for (const name of ["meta", "google"]) {
      const active = row[`ads_${name}_active`];
      summary.stored[name][active === true ? "true" : active === false ? "false" : "null"] += 1;
      const detail = provider(row.ads_enrichment, name);
      const detailAttempts = attempts(detail);
      if (detailAttempts.length) summary.evidence[`${name}Attempts`] += 1;
      if (hasApifyAttempt(detail)) summary.evidence[`${name}ApifyAttempts`] += 1;
      if (hasActiveApifyAttempt(detail)) {
        summary.evidence[`${name}ApifyActiveAttempts`] += 1;
        if (active == null) samplePush(summary.samples, row, name, detail, "active_apify_attempt_but_stored_null");
      }
      if (hasApifyActiveCandidate(detail)) {
        summary.evidence[`${name}ApifyActiveCandidates`] += 1;
        if (active == null) samplePush(summary.samples, row, name, detail, "apify_active_candidate_but_stored_null");
      }
      inc(summary.reasons[name], detail.reason);
      inc(summary.aiStatuses[name], detail.ai?.status);
      inc(summary.verificationStatuses[name], detail.ai?.verification?.status);
      if (active == null && detail.reason && /ai_|verification|required|failed|missing/i.test(detail.reason)) {
        samplePush(summary.samples, row, name, detail, "stored_null_ai_guardrail");
      }
    }

    if (row.ads_enrichment && Object.keys(row.ads_enrichment).length) summary.evidence.any += 1;
  }

  console.log(JSON.stringify(summary, null, 2));
}

try {
  await main();
} finally {
  await closeDb();
}
