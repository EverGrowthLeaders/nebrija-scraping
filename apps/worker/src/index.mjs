import { config } from "../../../packages/core/src/config.mjs";
import { logger } from "../../../packages/core/src/logger.mjs";
import { closeDb } from "../../../packages/core/src/db.mjs";
import { ensureRuntimeSchema } from "../../../packages/core/src/migrations.mjs";
import { createQueue, createWorker, QUEUE_NAMES, closeQueues } from "../../../packages/core/src/queues.mjs";
import { FirecrawlClient } from "../../../packages/core/src/firecrawl.mjs";
import { ApifyClient } from "../../../packages/core/src/apify.mjs";
import { GooglePlacesClient } from "../../../packages/core/src/googlePlaces.mjs";
import { buildGoogleDiscoveryQueries } from "../../../packages/core/src/googleDiscoveryQueries.mjs";
import { NebrijaClient } from "../../../packages/core/src/nebrija.mjs";
import { buildVariableValues } from "../../../packages/core/src/leadVariables.mjs";
import { extractLeadSignals, selectBusinessUrls, sha256 } from "../../../packages/core/src/extractors.mjs";
import { enrichBusinessAds } from "../../../packages/core/src/adsEnrichment.mjs";
import { enrichDecisionMaker } from "../../../packages/core/src/decisionMakerEnrichment.mjs";
import { verifiedDecisionMakerForStorage } from "../../../packages/core/src/decisionMakerStoragePolicy.mjs";
import { explainLeadScore, nextOutreachChannel } from "../../../packages/core/src/scoring.mjs";
import {
  createCrawlerRun,
  createVoiceCallFromDispatch,
  deleteContactsByKindAndSource,
  findBusinessById,
  findBusinessDetail,
  findCallableBusinessById,
  findBusinessVoiceContext,
  findExtractionJob,
  getEffectiveNebrijaSettings,
  getTenantScoringRules,
  persistCrawledPage,
  recordProvenance,
  updateBusinessEnrichment,
  updateBusinessAdsEnrichment,
  updateBusinessDecisionMaker,
  updateBusinessScore,
  updateCrawlerRun,
  updateExtractionJob,
  upsertBusinessFromGoogleCandidate,
  upsertContact,
  upsertGoogleCandidate
} from "../../../packages/core/src/repositories.mjs";

const firecrawl = new FirecrawlClient();
const apify = new ApifyClient();
const googlePlaces = new GooglePlacesClient();
await ensureRuntimeSchema();

const queues = {
  webDiscovery: createQueue(QUEUE_NAMES.webDiscovery),
  businessCrawl: createQueue(QUEUE_NAMES.businessCrawl),
  scoring: createQueue(QUEUE_NAMES.scoring),
  adsEnrichment: createQueue(QUEUE_NAMES.adsEnrichment),
  decisionMakerEnrichment: createQueue(QUEUE_NAMES.decisionMakerEnrichment),
  voiceCall: createQueue(QUEUE_NAMES.voiceCall)
};

const workers = [
  createWorker(QUEUE_NAMES.googleDiscovery, runGoogleDiscovery),
  createWorker(QUEUE_NAMES.webDiscovery, runWebDiscovery),
  createWorker(QUEUE_NAMES.businessCrawl, runBusinessCrawl),
  createWorker(QUEUE_NAMES.scoring, runScoring),
  createWorker(QUEUE_NAMES.adsEnrichment, runAdsEnrichment, { concurrency: 2 }),
  createWorker(QUEUE_NAMES.decisionMakerEnrichment, runDecisionMakerEnrichment, { concurrency: 2 }),
  createWorker(QUEUE_NAMES.voiceCall, runVoiceCall, { concurrency: 2 })
];

for (const worker of workers) {
  worker.on("completed", (job) => logger.info({ queue: worker.name, jobId: job.id }, "job completed"));
  worker.on("failed", (job, error) =>
    logger.error({ queue: worker.name, jobId: job?.id, error }, "job failed")
  );
}

logger.info(
  {
    queues: Object.values(QUEUE_NAMES),
    firecrawlBaseUrl: config.firecrawl.baseUrl,
    apifyMetaAdsEnabled: apify.enabled,
    adsApifyFallbackMode: config.adsEnrichment.apifyFallbackMode,
    adsActivityAiMode: config.adsActivityAi.mode,
    adsActivityAiModel: config.adsActivityAi.model,
    decisionMakerAiMode: config.decisionMakerAi.mode,
    decisionMakerAiModel: config.decisionMakerAi.model,
    crawlerProvider: config.crawler.provider
  },
  "worker started"
);

async function runGoogleDiscovery(job) {
  const { extractionJobId } = job.data;
  const extractionJob = await findExtractionJob(extractionJobId, { tenantId: job.data.tenantId });
  if (!extractionJob) throw new Error(`extraction job not found: ${extractionJobId}`);
  const tenantId = extractionJob.tenant_id;
  const enrichAds = Boolean(job.data.enrichAds);

  await updateExtractionJob(extractionJobId, {
    status: "running",
    started_at: new Date()
  });

  const requestedLimit = positiveInt(extractionJob.requested_limit, 20);
  const queries = buildGoogleQueries(extractionJob, { requestedLimit });
  const seenPlaceIds = new Set();
  let candidateCount = 0;
  let businessCount = 0;

  try {
    for (const queryText of queries) {
      if (businessCount >= requestedLimit) break;
      const places = await googlePlaces.searchText({ query: queryText });
      candidateCount += places.length;
      for (const place of places) {
        if (!place.placeId) continue;
        if (seenPlaceIds.has(place.placeId)) continue;
        seenPlaceIds.add(place.placeId);
        await upsertGoogleCandidate({
          tenantId,
          extractionJobId,
          place,
          queryText,
          city: extractionJob.city,
          niche: extractionJob.niche
        });
        const business = await upsertBusinessFromGoogleCandidate({
          tenantId,
          extractionJobId,
          place,
          city: extractionJob.city,
          niche: extractionJob.niche,
          sourceUrl: place.sourceUrl
        });
        businessCount += 1;
        if (place.website) {
          await recordProvenance({
            businessId: business.id,
            fieldName: "website",
            sourceType: "google_places",
            sourceUrl: place.sourceUrl,
            sourceRecordId: place.placeId,
            observedValue: place.website
          });
        }
        if (place.phoneE164) {
          await upsertContact({
            businessId: business.id,
            kind: "phone",
            value: place.phoneE164,
            confidence: 0.9,
            sourceUrl: place.sourceUrl
          });
          await recordProvenance({
            businessId: business.id,
            fieldName: "phone_e164",
            sourceType: "google_places",
            sourceUrl: place.sourceUrl,
            sourceRecordId: place.placeId,
            observedValue: place.phoneE164
          });
        }
        await queues.webDiscovery.add("discover", {
          tenantId,
          businessId: business.id,
          extractionJobId,
          enrichAds
        });
        await queues.decisionMakerEnrichment.add("enrich", {
          tenantId,
          businessId: business.id,
          extractionJobId,
          source: "google_places"
        });
        if (businessCount >= requestedLimit) break;
      }
    }

    await updateExtractionJob(extractionJobId, {
      status: "completed",
      finished_at: new Date(),
      metrics: {
        queries: queries.length,
        candidateCount,
        businessCount,
        enrichAdsQueued: enrichAds
      }
    });
    return { queries: queries.length, candidateCount, businessCount };
  } catch (error) {
    await updateExtractionJob(extractionJobId, {
      status: "failed",
      finished_at: new Date(),
      error: error.message,
      metrics: {
        queries: queries.length,
        candidateCount,
        businessCount
      }
    });
    throw error;
  }
}

async function runWebDiscovery(job) {
  const { businessId } = job.data;
  const business = await findBusinessById(businessId, { tenantId: job.data.tenantId });
  if (!business) throw new Error(`business not found: ${businessId}`);
  const tenantId = business.tenant_id;
  const enrichAds = Boolean(job.data.enrichAds);

  if (business.website) {
    await queues.businessCrawl.add("crawl", {
      tenantId,
      businessId,
      rootUrl: business.website,
      extractionJobId: job.data.extractionJobId,
      enrichAds
    });
    return { website: business.website, source: "existing" };
  }

  const query = [`"${business.name}"`, business.city, business.niche, "web oficial"].filter(Boolean).join(" ");
  const results = await firecrawl.search(query, { limit: 5 });
  const website = chooseOfficialWebsite(results, business);
  if (!website) {
    if (business.phone_e164) await queues.scoring.add("score", { tenantId, businessId: business.id });
    if (enrichAds) {
      await queues.adsEnrichment.add("enrich", {
        tenantId,
        businessId: business.id,
        campaignId: job.data.extractionJobId,
        autoFromCampaign: true,
        skippedWebDiscovery: true
      });
    }
    return { website: null, results: results.length };
  }

  await updateBusinessEnrichment({
    businessId,
    patch: {
      website
    }
  });
  await recordProvenance({
    businessId,
    fieldName: "website",
    sourceType: "firecrawl_search",
    sourceUrl: website,
    observedValue: website
  });
  await queues.businessCrawl.add("crawl", {
    tenantId,
    businessId,
    rootUrl: website,
    extractionJobId: job.data.extractionJobId,
    enrichAds
  });
  return { website, results: results.length };
}

async function runBusinessCrawl(job) {
  const { businessId, rootUrl } = job.data;
  const business = businessId ? await findBusinessById(businessId, { tenantId: job.data.tenantId }) : null;
  const tenantId = business?.tenant_id || job.data.tenantId;
  const crawlerRun = await createCrawlerRun({
    tenantId,
    businessId: business?.id,
    provider: config.crawler.provider,
    rootUrl
  });

  await updateCrawlerRun(crawlerRun.id, {
    status: "running",
    started_at: new Date()
  });

  let pageUrls = [rootUrl];
  let pagesSucceeded = 0;
  let pagesFailed = 0;
  const aggregate = {
    emails: new Set(),
    phones: new Set(),
    socials: {},
    signals: {
      hasOnlineBooking: false,
      hasChatbot: false,
      hasWhatsapp: false,
      hasContactForm: false
    }
  };

  try {
    const mappedLinks = await firecrawl.map(rootUrl, { limit: 80 });
    pageUrls = selectBusinessUrls(rootUrl, mappedLinks, config.crawler.maxPagesPerBusiness);
  } catch (error) {
    logger.warn({ error, rootUrl, businessId }, "firecrawl map failed; falling back to root URL");
  }

  await updateCrawlerRun(crawlerRun.id, {
    pages_requested: pageUrls.length
  });

  for (const url of pageUrls) {
    try {
      const page = await firecrawl.scrape(url, {
        formats: ["markdown", "html", "links"]
      });
      const extracted = extractLeadSignals(page);
      for (const email of extracted.emails) aggregate.emails.add(email);
      for (const phone of extracted.phones) {
        if (aggregate.phones.size < 8) aggregate.phones.add(phone);
      }
      aggregate.socials = { ...aggregate.socials, ...extracted.socials };
      aggregate.signals.hasOnlineBooking ||= extracted.signals.hasOnlineBooking;
      aggregate.signals.hasChatbot ||= extracted.signals.hasChatbot;
      aggregate.signals.hasWhatsapp ||= extracted.signals.hasWhatsapp;
      aggregate.signals.hasContactForm ||= extracted.signals.hasContactForm;

      await persistCrawledPage({
        tenantId,
        crawlerRunId: crawlerRun.id,
        businessId: business?.id,
        url,
        statusCode: 200,
        contentHash: sha256(`${page.markdown}\n${page.html}`),
        title: page.metadata?.title,
        markdown: page.markdown,
        extracted
      });
      pagesSucceeded += 1;
    } catch (error) {
      logger.warn({ error, url, businessId }, "page scrape failed");
      pagesFailed += 1;
    }
  }

  if (business?.id) {
    for (const email of aggregate.emails) {
      await upsertContact({ businessId: business.id, kind: "email", value: email, confidence: 0.8, sourceUrl: rootUrl });
      await recordProvenance({
        businessId: business.id,
        fieldName: "email",
        sourceType: "business_website",
        sourceUrl: rootUrl,
        observedValue: email
      });
    }
    await deleteContactsByKindAndSource({ businessId: business.id, kind: "phone", sourceUrl: rootUrl });
    for (const phone of aggregate.phones) {
      await upsertContact({ businessId: business.id, kind: "phone", value: phone, confidence: 0.85, sourceUrl: rootUrl });
      await recordProvenance({
        businessId: business.id,
        fieldName: "phone_e164",
        sourceType: "business_website",
        sourceUrl: rootUrl,
        observedValue: phone
      });
    }
    for (const [field, value] of Object.entries(aggregate.socials)) {
      await upsertContact({ businessId: business.id, kind: field, value, confidence: 0.75, sourceUrl: rootUrl });
      await recordProvenance({
        businessId: business.id,
        fieldName: field,
        sourceType: "business_website",
        sourceUrl: rootUrl,
        observedValue: value
      });
    }

    const [firstPhone] = aggregate.phones;
    await updateBusinessEnrichment({
      businessId: business.id,
      patch: {
        phoneE164: firstPhone,
        website: business.website || rootUrl,
        instagram: aggregate.socials.instagram,
        facebook: aggregate.socials.facebook,
        hasOnlineBooking: aggregate.signals.hasOnlineBooking,
        hasChatbot: aggregate.signals.hasChatbot
      }
    });
    await queues.scoring.add("score", { tenantId, businessId: business.id });
  }

  await updateCrawlerRun(crawlerRun.id, {
    status: pagesSucceeded > 0 ? "completed" : "failed",
    pages_succeeded: pagesSucceeded,
    pages_failed: pagesFailed,
    finished_at: new Date(),
    metrics: {
      emails: aggregate.emails.size,
      phones: aggregate.phones.size,
      socials: Object.keys(aggregate.socials).length,
      signals: aggregate.signals
    }
  });

  if (business?.id && job.data.enrichAds) {
    await queues.adsEnrichment.add("enrich", {
      tenantId,
      businessId: business.id,
      campaignId: job.data.extractionJobId,
      autoFromCampaign: true
    });
  }

  return { pagesSucceeded, pagesFailed };
}

async function runScoring(job) {
  const business = await findCallableBusinessById(job.data.businessId, { tenantId: job.data.tenantId });
  if (!business) throw new Error(`business not found: ${job.data.businessId}`);
  const scoring = await getTenantScoringRules({ tenantId: business.tenant_id });
  const breakdown = explainLeadScore(business, scoring.rules);
  const score = breakdown.score;
  await updateBusinessScore({ tenantId: business.tenant_id, businessId: business.id, score, breakdown });
  const channel = nextOutreachChannel({
    score,
    phone_e164: business.phone_e164,
    email_count: business.email_count
  });
  if (config.queues.autoDispatchVoice && ["voice", "voice_then_email"].includes(channel)) {
    await queues.voiceCall.add("call", { tenantId: business.tenant_id, businessId: business.id });
  }
  return { score, channel };
}

async function runAdsEnrichment(job) {
  const business = await findBusinessById(job.data.businessId, { tenantId: job.data.tenantId });
  if (!business) throw new Error(`business not found: ${job.data.businessId}`);
  const enrichment = await enrichBusinessAds({ business, firecrawl, apify: apify.enabled ? apify : null });
  const updated = await updateBusinessAdsEnrichment({
    tenantId: business.tenant_id,
    businessId: business.id,
    enrichment
  });
  if (updated) {
    await queues.scoring.add("score", { tenantId: business.tenant_id, businessId: business.id });
  }
  return {
    meta: enrichment.meta?.status,
    google: enrichment.google?.status,
    funnel: enrichment.classification?.type,
    checkedAt: enrichment.checkedAt
  };
}

async function runDecisionMakerEnrichment(job) {
  const detail = await findBusinessDetail(job.data.businessId, { tenantId: job.data.tenantId });
  const business = detail?.business;
  if (!business) throw new Error(`business not found: ${job.data.businessId}`);

  const enrichment = await enrichDecisionMaker({ business, contacts: detail.contacts || [], searchClient: firecrawl });
  const updated = await updateBusinessDecisionMaker({
    tenantId: business.tenant_id,
    businessId: business.id,
    enrichment
  });
  if (!updated) throw new Error(`business decision maker update failed: ${business.id}`);

  const decisionMaker = verifiedDecisionMakerForStorage(enrichment) || {};
  const linkedinCompany = enrichment.linkedinCompany || {};
  const recommendedAccessContact = enrichment.recommendedAccessContact || {};
  if (decisionMaker.linkedinUrl) {
    await upsertContact({
      businessId: business.id,
      kind: "linkedin_decision_maker",
      value: decisionMaker.linkedinUrl,
      confidence: decisionMaker.confidence || 0.75,
      sourceUrl: decisionMaker.linkedinUrl
    });
    if (decisionMaker.fullName) {
      await upsertContact({
        businessId: business.id,
        kind: "decision_maker_name",
        value: decisionMaker.fullName,
        confidence: decisionMaker.confidence || 0.75,
        sourceUrl: decisionMaker.linkedinUrl
      });
    }
    if (decisionMaker.role) {
      await upsertContact({
        businessId: business.id,
        kind: "decision_maker_role",
        value: decisionMaker.role,
        confidence: decisionMaker.confidence || 0.75,
        sourceUrl: decisionMaker.linkedinUrl
      });
    }
    await recordProvenance({
      businessId: business.id,
      fieldName: "linkedin_decision_maker",
      sourceType: "google_dork_linkedin",
      sourceUrl: decisionMaker.linkedinUrl,
      observedValue: JSON.stringify({
        query: enrichment.query,
        fullName: decisionMaker.fullName,
        role: decisionMaker.role,
        linkedinUrl: decisionMaker.linkedinUrl,
        confidence: decisionMaker.confidence
      })
    });
  }
  if (linkedinCompany.linkedinUrl) {
    await upsertContact({
      businessId: business.id,
      kind: "linkedin_company",
      value: linkedinCompany.linkedinUrl,
      confidence: linkedinCompany.confidence || 0.74,
      sourceUrl: linkedinCompany.linkedinUrl
    });
    await recordProvenance({
      businessId: business.id,
      fieldName: "linkedin_company",
      sourceType: "google_dork_linkedin_company",
      sourceUrl: linkedinCompany.linkedinUrl,
      observedValue: JSON.stringify({
        queries: enrichment.queries || [],
        linkedinUrl: linkedinCompany.linkedinUrl,
        confidence: linkedinCompany.confidence
      })
    });
  }
  if (recommendedAccessContact.value) {
    await upsertContact({
      businessId: business.id,
      kind: "recommended_access_contact",
      value: `${recommendedAccessContact.kind}:${recommendedAccessContact.value}`,
      confidence: recommendedAccessContact.confidence || 0.7,
      sourceUrl: recommendedAccessContact.sourceUrl || recommendedAccessContact.value
    });
  }

  return {
    found: enrichment.found,
    decisionStatus: enrichment.decisionStatus,
    reason: enrichment.reason,
    linkedinUrl: decisionMaker.linkedinUrl,
    linkedinCompanyUrl: linkedinCompany.linkedinUrl,
    accessContact: recommendedAccessContact.value,
    fullName: decisionMaker.fullName,
    confidence: decisionMaker.confidence
  };
}

async function runVoiceCall(job) {
  const business = await findBusinessVoiceContext(job.data.businessId, { tenantId: job.data.tenantId });
  if (!business) throw new Error(`business not found: ${job.data.businessId}`);
  if (!business.phone_e164) throw new Error(`business has no phone_e164: ${business.id}`);

  const settings = await getEffectiveNebrijaSettings({ tenantId: business.tenant_id });
  const nebrija = new NebrijaClient({
    baseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    phoneNumberId: settings.defaultPhoneNumberId
  });
  const variableValues = buildVariableValues(
    business,
    business.voice_variable_map || {},
    business.voice_assistant_variables || []
  );
  const response = await nebrija.createOutboundCall({
    customerNumber: business.phone_e164,
    assistantId: business.voice_assistant_id,
    phoneNumberId: business.voice_phone_number_id || settings.defaultPhoneNumberId,
    testId: job.data.testId,
    variableValues
  });
  if (!response?.id && !response?.callId) {
    throw new Error("Nebrija response did not include a call id");
  }
  const call = await createVoiceCallFromDispatch({ business, nebrijaResponse: response });
  return { providerCallId: call.provider_call_id };
}

function buildGoogleQueries(extractionJob, options = {}) {
  return buildGoogleDiscoveryQueries(extractionJob, options);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function chooseOfficialWebsite(results, business) {
  const blocked = [
    "google.",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "youtube.com",
    "yelp.",
    "tripadvisor.",
    "doctoralia.",
    "paginasamarillas.",
    "axesor.",
    "einforma.",
    "empresite."
  ];
  const normalizedName = normalizeForMatch(business.name);
  const normalizedCity = normalizeForMatch(business.city || "");
  let best = null;
  let bestScore = -Infinity;

  for (const result of results) {
    if (!result.url) continue;
    let parsed;
    try {
      parsed = new URL(result.url);
    } catch {
      continue;
    }
    const host = parsed.hostname.replace(/^www\./, "");
    if (blocked.some((domain) => host.includes(domain))) continue;

    const haystack = normalizeForMatch(`${result.url} ${result.title || ""} ${result.description || ""}`);
    let score = 0;
    for (const token of normalizedName.split(" ").filter((token) => token.length > 2)) {
      if (haystack.includes(token)) score += 5;
    }
    if (normalizedCity && haystack.includes(normalizedCity)) score += 4;
    if (parsed.pathname === "/" || parsed.pathname === "") score += 2;
    if ([".es", ".com"].some((suffix) => host.endsWith(suffix))) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = `${parsed.protocol}//${host}/`;
    }
  }

  return bestScore >= 5 ? best : null;
}

function normalizeForMatch(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    logger.info({ signal }, "worker shutdown");
    await closeQueues([...workers, ...Object.values(queues)]);
    await closeDb();
    process.exit(0);
  });
}
