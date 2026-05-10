import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../../packages/core/src/config.mjs";
import { logger } from "../../../packages/core/src/logger.mjs";
import { closeDb } from "../../../packages/core/src/db.mjs";
import { isAuthorizedApiKey } from "../../../packages/core/src/auth.mjs";
import { createQueue, QUEUE_NAMES, closeQueues } from "../../../packages/core/src/queues.mjs";
import { normalizeSpanishPhone } from "../../../packages/core/src/phone.mjs";
import {
  createExtractionJob,
  createManualBusiness,
  findBusinessById,
  findBusinessDetail,
  findExtractionJobDetail,
  findVoiceCallDetail,
  getDashboardMetrics,
  listBusinesses,
  listExtractionJobs,
  listVoiceCalls,
  persistNebrijaWebhookEvent,
  updateBusinessFromCallReport,
  upsertVoiceCallReport
} from "../../../packages/core/src/repositories.mjs";
import { parseEndOfCallReport } from "../../../packages/core/src/vapiReport.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "../../web/public");
const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const queues = {
  googleDiscovery: createQueue(QUEUE_NAMES.googleDiscovery),
  webDiscovery: createQueue(QUEUE_NAMES.webDiscovery),
  businessCrawl: createQueue(QUEUE_NAMES.businessCrawl),
  scoring: createQueue(QUEUE_NAMES.scoring),
  voiceCall: createQueue(QUEUE_NAMES.voiceCall)
};

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, method: req.method, url: req.url });
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, service: "api" });
    }

    if (req.method === "GET" && url.pathname === "/api/metrics") {
      const metrics = await getDashboardMetrics();
      return sendJson(res, 200, { metrics });
    }

    if (req.method === "GET" && url.pathname === "/api/campaigns") {
      const result = await listExtractionJobs(parsePaging(url));
      return sendJson(res, 200, result);
    }

    const campaignDetailMatch = matchPath(url.pathname, /^\/api\/campaigns\/([^/]+)$/);
    if (req.method === "GET" && campaignDetailMatch) {
      const job = await findExtractionJobDetail(campaignDetailMatch[1]);
      if (!job) return sendJson(res, 404, { error: "campaign_not_found" });
      return sendJson(res, 200, { job });
    }

    if (req.method === "GET" && url.pathname === "/api/businesses") {
      const result = await listBusinesses({
        ...parsePaging(url),
        status: url.searchParams.get("status") || undefined,
        niche: url.searchParams.get("niche") || undefined,
        city: url.searchParams.get("city") || undefined,
        search: url.searchParams.get("search") || undefined
      });
      return sendJson(res, 200, result);
    }

    const businessDetailMatch = matchPath(url.pathname, /^\/api\/businesses\/([^/]+)$/);
    if (req.method === "GET" && businessDetailMatch) {
      const detail = await findBusinessDetail(businessDetailMatch[1]);
      if (!detail) return sendJson(res, 404, { error: "business_not_found" });
      return sendJson(res, 200, detail);
    }

    if (req.method === "GET" && url.pathname === "/api/calls") {
      const result = await listVoiceCalls({
        ...parsePaging(url),
        outcome: url.searchParams.get("outcome") || undefined,
        qualified: url.searchParams.get("qualified") || undefined
      });
      return sendJson(res, 200, result);
    }

    const callDetailMatch = matchPath(url.pathname, /^\/api\/calls\/([^/]+)$/);
    if (req.method === "GET" && callDetailMatch) {
      const call = await findVoiceCallDetail(callDetailMatch[1]);
      if (!call) return sendJson(res, 404, { error: "call_not_found" });
      return sendJson(res, 200, { call });
    }

    if (url.pathname.startsWith("/api/test-jobs")) {
      requireTestJobAuth(req);

      if (req.method === "GET" && url.pathname === "/api/test-jobs/health") {
        const queueCounts = await getQueueCounts();
        return sendJson(res, 200, {
          ok: true,
          service: "test-jobs",
          firecrawl: {
            configured: Boolean(config.firecrawl.baseUrl),
            baseUrl: config.firecrawl.baseUrl,
            apiKeyConfigured: Boolean(config.firecrawl.apiKey)
          },
          googlePlaces: {
            apiKeyConfigured: Boolean(config.google.apiKey)
          },
          nebrija: {
            apiKeyConfigured: Boolean(config.nebrija.apiKey),
            assistantConfigured: Boolean(config.nebrija.assistantId),
            phoneNumberConfigured: Boolean(config.nebrija.phoneNumberId)
          },
          queues: queueCounts
        });
      }

      if (req.method === "POST" && url.pathname === "/api/test-jobs") {
        const { json } = await readJson(req);
        const type = json.type || json.kind || "business_crawl";
        const testId = json.testId || json.test_id || `codex-${Date.now()}`;

        if (type === "business_crawl") {
          const website = json.website || "https://example.com";
          const business = await createManualBusiness({
            name: json.name || `Codex Firecrawl Smoke ${new Date().toISOString()}`,
            website,
            phone: json.phone,
            phoneE164: json.phoneE164 || json.phone_e164 || normalizeSpanishPhone(json.phone),
            city: json.city || "Madrid",
            niche: json.niche || "firecrawl smoke test",
            category: json.category || "test",
            sourceUrl: website,
            rawPayload: { testJob: true, testId, type }
          });
          const queueJob = await queues.businessCrawl.add("crawl", {
            businessId: business.id,
            rootUrl: website,
            testId
          });
          return sendJson(res, 202, {
            testJob: {
              id: business.id,
              type,
              testId,
              statusUrl: `/api/test-jobs/businesses/${business.id}`,
              queue: { name: QUEUE_NAMES.businessCrawl, id: queueJob.id }
            },
            business
          });
        }

        if (type === "web_discovery") {
          validateRequired(json, ["name"]);
          const business = await createManualBusiness({
            name: json.name,
            city: json.city || "Madrid",
            niche: json.niche || "web discovery smoke test",
            category: json.category || "test",
            rawPayload: { testJob: true, testId, type }
          });
          const queueJob = await queues.webDiscovery.add("discover", {
            businessId: business.id,
            testId
          });
          return sendJson(res, 202, {
            testJob: {
              id: business.id,
              type,
              testId,
              statusUrl: `/api/test-jobs/businesses/${business.id}`,
              queue: { name: QUEUE_NAMES.webDiscovery, id: queueJob.id }
            },
            business
          });
        }

        if (type === "campaign") {
          validateRequired(json, ["niche", "city"]);
          const job = await createExtractionJob({
            niche: json.niche,
            city: json.city,
            sourceType: json.sourceType || json.source_type || "google_places_api",
            bbox: json.bbox,
            gridStep: json.gridStep || json.grid_step,
            requestedLimit: json.requestedLimit || json.requested_limit || 5
          });
          const queueJob = await queues.googleDiscovery.add("run", {
            extractionJobId: job.id,
            testId
          });
          return sendJson(res, 202, {
            testJob: {
              id: job.id,
              type,
              testId,
              statusUrl: `/api/test-jobs/campaigns/${job.id}`,
              queue: { name: QUEUE_NAMES.googleDiscovery, id: queueJob.id }
            },
            campaign: job
          });
        }

        return sendJson(res, 400, {
          error: "unsupported_test_job_type",
          supportedTypes: ["business_crawl", "web_discovery", "campaign"]
        });
      }

      const testBusinessMatch = matchPath(url.pathname, /^\/api\/test-jobs\/businesses\/([^/]+)$/);
      if (req.method === "GET" && testBusinessMatch) {
        const detail = await findBusinessDetail(testBusinessMatch[1]);
        if (!detail) return sendJson(res, 404, { error: "business_not_found" });
        return sendJson(res, 200, {
          type: "business_crawl",
          done: isBusinessTestDone(detail),
          ...detail
        });
      }

      const testCampaignMatch = matchPath(url.pathname, /^\/api\/test-jobs\/campaigns\/([^/]+)$/);
      if (req.method === "GET" && testCampaignMatch) {
        const job = await findExtractionJobDetail(testCampaignMatch[1]);
        if (!job) return sendJson(res, 404, { error: "campaign_not_found" });
        return sendJson(res, 200, {
          type: "campaign",
          done: ["completed", "failed"].includes(job.status),
          job
        });
      }

      const queueMatch = matchPath(url.pathname, /^\/api\/test-jobs\/queues\/([^/]+)\/([^/]+)$/);
      if (req.method === "GET" && queueMatch) {
        const queueName = queueMatch[1];
        const jobId = queueMatch[2];
        const queue = Object.values(queues).find((item) => item.name === queueName);
        if (!queue) return sendJson(res, 404, { error: "queue_not_found" });
        const job = await queue.getJob(jobId);
        if (!job) return sendJson(res, 404, { error: "job_not_found" });
        return sendJson(res, 200, {
          queue: queueName,
          jobId,
          state: await job.getState(),
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          returnvalue: job.returnvalue
        });
      }

      return sendJson(res, 404, { error: "test_job_route_not_found" });
    }

    if (req.method === "POST" && url.pathname === "/campaigns") {
      const { json } = await readJson(req);
      validateRequired(json, ["niche", "city"]);

      const sourceType = json.sourceType || json.source_type || "google_places_api";
      const job = await createExtractionJob({
        niche: json.niche,
        city: json.city,
        sourceType,
        bbox: json.bbox,
        gridStep: json.gridStep || json.grid_step,
        requestedLimit: json.requestedLimit || json.requested_limit
      });

      if (sourceType === "google_places_api") {
        await queues.googleDiscovery.add("run", {
          extractionJobId: job.id
        });
      }

      return sendJson(res, 201, { job });
    }

    if (req.method === "POST" && url.pathname === "/businesses") {
      const { json } = await readJson(req);
      validateRequired(json, ["name"]);
      const business = await createManualBusiness({
        ...json,
        phoneE164: json.phoneE164 || json.phone_e164 || normalizeSpanishPhone(json.phone)
      });
      if (business.website) {
        await queues.businessCrawl.add("crawl", {
          businessId: business.id,
          rootUrl: business.website
        });
      }
      return sendJson(res, 201, { business });
    }

    const crawlMatch = matchPath(url.pathname, /^\/businesses\/([^/]+)\/crawl$/);
    if (req.method === "POST" && crawlMatch) {
      const businessId = crawlMatch[1];
      const { json } = await readJson(req);
      const business = await findBusinessById(businessId);
      if (!business) return sendJson(res, 404, { error: "business_not_found" });
      const rootUrl = json.rootUrl || json.root_url || business.website;
      if (!rootUrl) return sendJson(res, 400, { error: "business_has_no_website" });
      const job = await queues.businessCrawl.add("crawl", { businessId, rootUrl });
      return sendJson(res, 202, { jobId: job.id });
    }

    const scoreMatch = matchPath(url.pathname, /^\/businesses\/([^/]+)\/score$/);
    if (req.method === "POST" && scoreMatch) {
      const job = await queues.scoring.add("score", { businessId: scoreMatch[1] });
      return sendJson(res, 202, { jobId: job.id });
    }

    const callMatch = matchPath(url.pathname, /^\/businesses\/([^/]+)\/call$/);
    if (req.method === "POST" && callMatch) {
      const { json } = await readJson(req);
      const job = await queues.voiceCall.add("call", {
        businessId: callMatch[1],
        testId: json.testId || json.test_id
      });
      return sendJson(res, 202, { jobId: job.id });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/nebrija/calls") {
      const { json, raw } = await readJson(req);
      const signatureValid = verifyWebhookSignature(raw, req.headers, config.nebrija.webhookSecret);
      const report = parseEndOfCallReport(json);

      await persistNebrijaWebhookEvent({
        eventType: report.type || json?.type || json?.message?.type || "unknown",
        providerCallId: report.providerCallId,
        signatureValid,
        payload: json
      });

      if (report.isEndOfCallReport && report.providerCallId) {
        await upsertVoiceCallReport(report);
        await updateBusinessFromCallReport({
          providerCallId: report.providerCallId,
          outcome: report.outcome,
          qualified: report.qualified
        });
      }

      return sendJson(res, 200, { ok: true, signatureValid });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const served = await serveStatic(url.pathname, res);
      if (served) return;
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    log.error({ error }, "request failed");
    const status = error.statusCode || 500;
    return sendJson(res, status, {
      error: status === 500 ? "internal_error" : error.message,
      requestId
    });
  }
});

server.listen(config.server.port, () => {
  logger.info({ port: config.server.port }, "api listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    logger.info({ signal }, "api shutdown");
    server.close();
    await closeQueues(Object.values(queues));
    await closeDb();
    process.exit(0);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (!raw.length) return { raw, json: {} };
  try {
    return { raw, json: JSON.parse(raw.toString("utf8")) };
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}

function validateRequired(body, fields) {
  for (const field of fields) {
    if (!body?.[field]) {
      const error = new Error(`missing_${field}`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function matchPath(pathname, regex) {
  const match = pathname.match(regex);
  return match || null;
}

function verifyWebhookSignature(raw, headers, secret) {
  if (!secret) return false;
  const signature =
    headers["x-nebrija-signature"] ||
    headers["x-signature"] ||
    headers["vapi-signature"] ||
    headers["x-vapi-signature"];
  if (!signature) return false;

  const digest = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const expectedValues = [`sha256=${digest}`, digest];
  return expectedValues.some((expected) => safeEqual(String(signature), expected));
}

function requireTestJobAuth(req) {
  if (!config.testJobs.apiKeys.length) {
    const error = new Error("test_jobs_api_key_not_configured");
    error.statusCode = 503;
    throw error;
  }
  if (!isAuthorizedApiKey(req.headers, config.testJobs.apiKeys)) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

async function getQueueCounts() {
  const entries = await Promise.all(
    Object.values(queues).map(async (queue) => [
      queue.name,
      await queue.getJobCounts("waiting", "active", "delayed", "completed", "failed")
    ])
  );
  return Object.fromEntries(entries);
}

function isBusinessTestDone(detail) {
  const latestRun = detail.crawlerRuns?.[0];
  if (!latestRun) return false;
  return ["completed", "failed"].includes(latestRun.status);
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parsePaging(url) {
  return {
    limit: url.searchParams.get("limit") || undefined,
    offset: url.searchParams.get("offset") || undefined
  };
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requested).replace(/^([\\/]+)/, "");
  const fullPath = path.join(WEB_ROOT, safePath);
  if (!fullPath.startsWith(WEB_ROOT)) return false;

  let buffer;
  try {
    buffer = await fs.readFile(fullPath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      if (path.extname(safePath) === "") {
        try {
          buffer = await fs.readFile(path.join(WEB_ROOT, "index.html"));
          res.writeHead(200, { "content-type": STATIC_MIME[".html"] });
          res.end(buffer);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    throw error;
  }
  const mime = STATIC_MIME[path.extname(safePath).toLowerCase()] || "application/octet-stream";
  const headers = { "content-type": mime };
  if (path.extname(safePath) !== ".html") {
    headers["cache-control"] = "public, max-age=300";
  }
  res.writeHead(200, headers);
  res.end(buffer);
  return true;
}
