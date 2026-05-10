import { config } from "../../../packages/core/src/config.mjs";
import { logger } from "../../../packages/core/src/logger.mjs";
import { closeDb } from "../../../packages/core/src/db.mjs";
import { createQueue, createWorker, QUEUE_NAMES, closeQueues } from "../../../packages/core/src/queues.mjs";
import { FirecrawlClient } from "../../../packages/core/src/firecrawl.mjs";
import { GooglePlacesClient } from "../../../packages/core/src/googlePlaces.mjs";
import { NebrijaClient } from "../../../packages/core/src/nebrija.mjs";
import { extractLeadSignals, selectBusinessUrls, sha256 } from "../../../packages/core/src/extractors.mjs";
import { calculateLeadScore, nextOutreachChannel } from "../../../packages/core/src/scoring.mjs";
import {
  createCrawlerRun,
  createVoiceCallFromDispatch,
  findBusinessById,
  findCallableBusinessById,
  findExtractionJob,
  persistCrawledPage,
  recordProvenance,
  updateBusinessEnrichment,
  updateBusinessScore,
  updateCrawlerRun,
  updateExtractionJob,
  upsertBusinessFromGoogleCandidate,
  upsertContact,
  upsertGoogleCandidate
} from "../../../packages/core/src/repositories.mjs";

const firecrawl = new FirecrawlClient();
const googlePlaces = new GooglePlacesClient();
const nebrija = new NebrijaClient();

const queues = {
  webDiscovery: createQueue(QUEUE_NAMES.webDiscovery),
  businessCrawl: createQueue(QUEUE_NAMES.businessCrawl),
  scoring: createQueue(QUEUE_NAMES.scoring),
  voiceCall: createQueue(QUEUE_NAMES.voiceCall)
};

const workers = [
  createWorker(QUEUE_NAMES.googleDiscovery, runGoogleDiscovery),
  createWorker(QUEUE_NAMES.webDiscovery, runWebDiscovery),
  createWorker(QUEUE_NAMES.businessCrawl, runBusinessCrawl),
  createWorker(QUEUE_NAMES.scoring, runScoring),
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
    crawlerProvider: config.crawler.provider
  },
  "worker started"
);

async function runGoogleDiscovery(job) {
  const { extractionJobId } = job.data;
  const extractionJob = await findExtractionJob(extractionJobId);
  if (!extractionJob) throw new Error(`extraction job not found: ${extractionJobId}`);

  await updateExtractionJob(extractionJobId, {
    status: "running",
    started_at: new Date()
  });

  const queries = buildGoogleQueries(extractionJob);
  let candidateCount = 0;
  let businessCount = 0;

  try {
    for (const queryText of queries) {
      const places = await googlePlaces.searchText({ query: queryText });
      candidateCount += places.length;
      for (const place of places) {
        if (!place.placeId) continue;
        await upsertGoogleCandidate({
          extractionJobId,
          place,
          queryText,
          city: extractionJob.city,
          niche: extractionJob.niche
        });
        const business = await upsertBusinessFromGoogleCandidate({
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
          businessId: business.id
        });
      }
    }

    await updateExtractionJob(extractionJobId, {
      status: "completed",
      finished_at: new Date(),
      metrics: {
        queries: queries.length,
        candidateCount,
        businessCount
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
  const business = await findBusinessById(businessId);
  if (!business) throw new Error(`business not found: ${businessId}`);

  if (business.website) {
    await queues.businessCrawl.add("crawl", { businessId, rootUrl: business.website });
    return { website: business.website, source: "existing" };
  }

  const query = [`"${business.name}"`, business.city, business.niche, "web oficial"].filter(Boolean).join(" ");
  const results = await firecrawl.search(query, { limit: 5 });
  const website = chooseOfficialWebsite(results, business);
  if (!website) {
    if (business.phone_e164) await queues.scoring.add("score", { businessId: business.id });
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
  await queues.businessCrawl.add("crawl", { businessId, rootUrl: website });
  return { website, results: results.length };
}

async function runBusinessCrawl(job) {
  const { businessId, rootUrl } = job.data;
  const business = businessId ? await findBusinessById(businessId) : null;
  const crawlerRun = await createCrawlerRun({
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
      for (const phone of extracted.phones) aggregate.phones.add(phone);
      aggregate.socials = { ...aggregate.socials, ...extracted.socials };
      aggregate.signals.hasOnlineBooking ||= extracted.signals.hasOnlineBooking;
      aggregate.signals.hasChatbot ||= extracted.signals.hasChatbot;
      aggregate.signals.hasWhatsapp ||= extracted.signals.hasWhatsapp;
      aggregate.signals.hasContactForm ||= extracted.signals.hasContactForm;

      await persistCrawledPage({
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
    await queues.scoring.add("score", { businessId: business.id });
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

  return { pagesSucceeded, pagesFailed };
}

async function runScoring(job) {
  const business = await findCallableBusinessById(job.data.businessId);
  if (!business) throw new Error(`business not found: ${job.data.businessId}`);
  const score = calculateLeadScore(business);
  await updateBusinessScore({ businessId: business.id, score });
  const channel = nextOutreachChannel({
    score,
    phone_e164: business.phone_e164,
    email_count: business.email_count
  });
  if (config.queues.autoDispatchVoice && ["voice", "voice_then_email"].includes(channel)) {
    await queues.voiceCall.add("call", { businessId: business.id });
  }
  return { score, channel };
}

async function runVoiceCall(job) {
  const business = await findCallableBusinessById(job.data.businessId);
  if (!business) throw new Error(`business not found: ${job.data.businessId}`);
  if (!business.phone_e164) throw new Error(`business has no phone_e164: ${business.id}`);

  const response = await nebrija.createOutboundCall({
    customerNumber: business.phone_e164,
    testId: job.data.testId,
    variables: {
      business_id: business.id,
      business_name: business.name,
      city: business.city,
      category: business.category || business.niche,
      rating: business.rating,
      review_count: business.review_count,
      score: business.score
    }
  });
  if (!response?.id && !response?.callId) {
    throw new Error("Nebrija response did not include a call id");
  }
  const call = await createVoiceCallFromDispatch({ business, nebrijaResponse: response });
  return { providerCallId: call.provider_call_id };
}

function buildGoogleQueries(extractionJob) {
  const base = extractionJob.niche;
  const city = extractionJob.city;
  const variants = [base, ...String(base).split(/[,/]/).map((item) => item.trim())]
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return variants.map((variant) => `${variant} en ${city}`);
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
