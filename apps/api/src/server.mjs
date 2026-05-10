import http from "node:http";
import crypto from "node:crypto";
import { config } from "../../../packages/core/src/config.mjs";
import { logger } from "../../../packages/core/src/logger.mjs";
import { closeDb } from "../../../packages/core/src/db.mjs";
import { createQueue, QUEUE_NAMES, closeQueues } from "../../../packages/core/src/queues.mjs";
import { normalizeSpanishPhone } from "../../../packages/core/src/phone.mjs";
import {
  createExtractionJob,
  createManualBusiness,
  findBusinessById,
  persistNebrijaWebhookEvent,
  updateBusinessFromCallReport,
  upsertVoiceCallReport
} from "../../../packages/core/src/repositories.mjs";
import { parseEndOfCallReport } from "../../../packages/core/src/vapiReport.mjs";

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

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
