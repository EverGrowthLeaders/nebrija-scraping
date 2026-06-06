import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../../packages/core/src/config.mjs";
import { logger } from "../../../packages/core/src/logger.mjs";
import { closeDb } from "../../../packages/core/src/db.mjs";
import { isAuthorizedApiKey } from "../../../packages/core/src/auth.mjs";
import { ensureRuntimeSchema } from "../../../packages/core/src/migrations.mjs";
import { exchangeGoogleCode, getGoogleAuthUrl, verifyGoogleIdToken } from "../../../packages/core/src/googleOAuth.mjs";
import { createQueue, QUEUE_NAMES, closeQueues } from "../../../packages/core/src/queues.mjs";
import { normalizeSpanishPhone } from "../../../packages/core/src/phone.mjs";
import { LEAD_VARIABLES, defaultVariableMap } from "../../../packages/core/src/leadVariables.mjs";
import { buildImportedLeadRows, parseLeadFile, previewLeadImport } from "../../../packages/core/src/leadImport.mjs";
import {
  XLSX_CONTENT_TYPE,
  buildCampaignCsv,
  buildCampaignXlsx,
  campaignExportFilename
} from "../../../packages/core/src/exporters.mjs";
import { NebrijaClient } from "../../../packages/core/src/nebrija.mjs";
import {
  CRM_CHECKPOINT_OPTIONS,
  CRM_OBJECTION_OPTIONS,
  CRM_STATUS_OPTIONS,
  DEFAULT_TENANT_ID,
  addBusinessToLeadList,
  createLeadList,
  createExtractionJob,
  createManualBusiness,
  createUserSession,
  deleteBusinessForTenant,
  findLeadList,
  findBusinessById,
  findBusinessDetail,
  findExtractionJobDetail,
  findSessionByTokenHash,
  findVoiceCallDetail,
  getColdCallingAnalytics,
  getTenantAnalyticsSettings,
  getEffectiveNebrijaSettings,
  getDashboardMetrics,
  getTenantNebrijaSettings,
  getTenantScoringRules,
  listBusinessIdsForCampaign,
  listBusinessIdsForTenant,
  listBusinesses,
  listCampaignLeadsForExport,
  listCampaignCrmEntries,
  listExtractionJobs,
  listLeadListCrmEntries,
  listLeadLists,
  listVoiceCalls,
  persistNebrijaWebhookEvent,
  removeBusinessFromLeadList,
  revokeSession,
  updateBusinessFromCallReport,
  updateBusinessScoringNotes,
  updateExtractionJobVoiceSettings,
  updateLeadList,
  updateLeadListCrmEntry,
  upsertTenantAnalyticsSettings,
  upsertTenantScoringRules,
  upsertTenantNebrijaSettings,
  upsertContact,
  upsertGoogleUser,
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
  adsEnrichment: createQueue(QUEUE_NAMES.adsEnrichment),
  voiceCall: createQueue(QUEUE_NAMES.voiceCall)
};

await ensureRuntimeSchema();

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, method: req.method, url: req.url });
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, service: "api" });
    }

    if (req.method === "GET" && url.pathname === "/auth/google/status") {
      return sendJson(res, 200, {
        configured: Boolean(config.auth.googleClientId && config.auth.googleClientSecret)
      });
    }

    if (req.method === "GET" && url.pathname === "/auth/google/start") {
      requireGoogleOAuthConfig();
      const state = crypto.randomBytes(24).toString("base64url");
      setCookie(req, res, "oauth_state", state, { maxAge: 600, httpOnly: true, sameSite: "Lax" });
      return redirect(res, getGoogleAuthUrl({ state, redirectUri: googleRedirectUri(req) }));
    }

    if (req.method === "GET" && url.pathname === "/auth/google/callback") {
      requireGoogleOAuthConfig();
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const expectedState = readCookies(req).oauth_state;
      clearCookie(req, res, "oauth_state");
      if (!state || !expectedState || !safeEqual(state, expectedState) || !code) {
        return redirect(res, "/?auth=failed");
      }
      try {
        const tokenResponse = await exchangeGoogleCode({ code, redirectUri: googleRedirectUri(req) });
        const profile = await verifyGoogleIdToken(tokenResponse.id_token);
        const { tenant, user } = await upsertGoogleUser({ profile });
        const token = crypto.randomBytes(32).toString("base64url");
        await createUserSession({
          tenantId: tenant.id,
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + config.auth.sessionTtlDays * 86400_000),
          userAgent: req.headers["user-agent"],
          ipAddress: clientIp(req)
        });
        setCookie(req, res, config.auth.sessionCookieName, token, {
          maxAge: config.auth.sessionTtlDays * 86400,
          httpOnly: true,
          sameSite: "Lax"
        });
        return redirect(res, "/");
      } catch (error) {
        log.warn({ error }, "google oauth callback failed");
        return redirect(res, `/?auth=failed&reason=${encodeURIComponent(error.message || "oauth_failed")}`);
      }
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
      const token = readCookies(req)[config.auth.sessionCookieName];
      if (token) await revokeSession(hashToken(token));
      clearCookie(req, res, config.auth.sessionCookieName);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const auth = await getSession(req);
      if (!auth) return sendJson(res, 401, { error: "unauthorized" });
      return sendJson(res, 200, { user: auth.user, tenant: auth.tenant });
    }

    const auth = await getRouteAuth(req, url);

    if (req.method === "GET" && url.pathname === "/api/settings/nebrija") {
      const stored = await getTenantNebrijaSettings({ tenantId: auth.tenantId });
      const effective = await getEffectiveNebrijaSettings({ tenantId: auth.tenantId });
      return sendJson(res, 200, {
        settings: {
          apiBaseUrl: effective.apiBaseUrl,
          configured: effective.configured,
          apiKeyLast4: effective.apiKeyLast4 || null,
          defaultPhoneNumberId: effective.defaultPhoneNumberId || "",
          stored: Boolean(stored),
          usingEnvFallback: !stored?.api_key_last4 && Boolean(config.nebrija.apiKey)
        },
        leadVariables: LEAD_VARIABLES
      });
    }

    if (req.method === "PATCH" && url.pathname === "/api/settings/nebrija") {
      const { json } = await readJson(req);
      const settings = await upsertTenantNebrijaSettings({
        tenantId: auth.tenantId,
        apiBaseUrl: json.apiBaseUrl || json.api_base_url || config.nebrija.apiBaseUrl,
        apiKey: json.apiKey === "" ? undefined : json.apiKey ?? json.api_key,
        defaultPhoneNumberId: json.defaultPhoneNumberId || json.default_phone_number_id || ""
      });
      return sendJson(res, 200, {
        settings: {
          apiBaseUrl: settings.api_base_url,
          configured: Boolean(settings.api_key_last4),
          apiKeyLast4: settings.api_key_last4,
          defaultPhoneNumberId: settings.default_phone_number_id || ""
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/settings/nebrija/assistants") {
      const settings = await getEffectiveNebrijaSettings({ tenantId: auth.tenantId });
      if (!settings.configured) return sendJson(res, 400, { error: "nebrija_api_key_not_configured" });
      const client = new NebrijaClient({
        baseUrl: settings.apiBaseUrl,
        apiKey: settings.apiKey,
        phoneNumberId: settings.defaultPhoneNumberId
      });
      const assistants = await client.listAssistants();
      return sendJson(res, 200, {
        assistants: assistants.map(({ raw, ...assistant }) => assistant),
        leadVariables: LEAD_VARIABLES
      });
    }

    if (req.method === "GET" && url.pathname === "/api/metrics") {
      const metrics = await getDashboardMetrics({ tenantId: auth.tenantId });
      return sendJson(res, 200, { metrics });
    }

    if (req.method === "GET" && url.pathname === "/api/analytics/cold-calling") {
      const scopeType = ["all", "list", "campaign"].includes(url.searchParams.get("scopeType"))
        ? url.searchParams.get("scopeType")
        : "all";
      const analytics = await getColdCallingAnalytics({
        tenantId: auth.tenantId,
        scopeType,
        scopeId: url.searchParams.get("scopeId") || null,
        from: url.searchParams.get("from") || null,
        to: url.searchParams.get("to") || null
      });
      return sendJson(res, 200, { analytics });
    }

    if (req.method === "GET" && url.pathname === "/api/analytics/settings") {
      const settings = await getTenantAnalyticsSettings({ tenantId: auth.tenantId });
      return sendJson(res, 200, settings);
    }

    if (req.method === "PATCH" && url.pathname === "/api/analytics/settings") {
      const { json } = await readJson(req);
      const settings = await upsertTenantAnalyticsSettings({
        tenantId: auth.tenantId,
        settings: json.settings || json
      });
      return sendJson(res, 200, settings);
    }

    if (req.method === "GET" && url.pathname === "/api/scoring/rules") {
      const scoring = await getTenantScoringRules({ tenantId: auth.tenantId });
      return sendJson(res, 200, scoring);
    }

    if (req.method === "PATCH" && url.pathname === "/api/scoring/rules") {
      const { json } = await readJson(req);
      const scoring = await upsertTenantScoringRules({
        tenantId: auth.tenantId,
        rules: json.rules || []
      });
      return sendJson(res, 200, scoring);
    }

    if (req.method === "POST" && url.pathname === "/api/scoring/rescore") {
      const businessIds = await listBusinessIdsForTenant({
        tenantId: auth.tenantId,
        limit: Number(url.searchParams.get("limit")) || 5000
      });
      const queueJobs = [];
      for (const businessId of businessIds) {
        queueJobs.push(await queues.scoring.add("score", { tenantId: auth.tenantId, businessId }));
      }
      return sendJson(res, 202, {
        queued: queueJobs.length,
        queue: QUEUE_NAMES.scoring,
        jobIds: queueJobs.map((queueJob) => queueJob.id)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/lead-lists") {
      const rows = await listLeadLists({ tenantId: auth.tenantId });
      return sendJson(res, 200, { rows, total: rows.length });
    }

    if (req.method === "POST" && url.pathname === "/api/lead-lists") {
      const { json } = await readJson(req);
      validateRequired(json, ["name"]);
      const list = await createLeadList({
        tenantId: auth.tenantId,
        name: json.name,
        description: json.description,
        color: json.color
      });
      return sendJson(res, 201, { list });
    }

    const leadListMatch = matchPath(url.pathname, /^\/api\/lead-lists\/([^/]+)$/);
    if (req.method === "GET" && leadListMatch) {
      const list = await findLeadList(leadListMatch[1], { tenantId: auth.tenantId });
      if (!list) return sendJson(res, 404, { error: "lead_list_not_found" });
      return sendJson(res, 200, { list });
    }

    if (req.method === "PATCH" && leadListMatch) {
      const { json } = await readJson(req);
      const list = await updateLeadList({
        tenantId: auth.tenantId,
        id: leadListMatch[1],
        name: json.name,
        description: json.description ?? null,
        color: json.color
      });
      if (!list) return sendJson(res, 404, { error: "lead_list_not_found" });
      return sendJson(res, 200, { list });
    }

    const leadListCrmMatch = matchPath(url.pathname, /^\/api\/lead-lists\/([^/]+)\/crm$/);
    if (req.method === "GET" && leadListCrmMatch) {
      const list = await findLeadList(leadListCrmMatch[1], { tenantId: auth.tenantId });
      if (!list) return sendJson(res, 404, { error: "lead_list_not_found" });
      const rows = await listLeadListCrmEntries({ tenantId: auth.tenantId, listId: leadListCrmMatch[1] });
      return sendJson(res, 200, {
        list,
        rows,
        options: buildCrmOptions(rows)
      });
    }

    const leadListBusinessMatch = matchPath(url.pathname, /^\/api\/lead-lists\/([^/]+)\/businesses$/);
    if (req.method === "POST" && leadListBusinessMatch) {
      const { json } = await readJson(req);
      const businessId = json.businessId || json.business_id;
      if (!businessId) return sendJson(res, 400, { error: "missing_required_fields", fields: ["businessId"] });
      const member = await addBusinessToLeadList({
        tenantId: auth.tenantId,
        listId: leadListBusinessMatch[1],
        businessId
      });
      if (!member) return sendJson(res, 404, { error: "lead_or_list_not_found" });
      return sendJson(res, 201, { member });
    }

    const leadListBusinessCrmMatch = matchPath(url.pathname, /^\/api\/lead-lists\/([^/]+)\/businesses\/([^/]+)\/crm$/);
    if (req.method === "PATCH" && leadListBusinessCrmMatch) {
      const { json } = await readJson(req);
      const entry = await updateLeadListCrmEntry({
        tenantId: auth.tenantId,
        listId: leadListBusinessCrmMatch[1],
        businessId: leadListBusinessCrmMatch[2],
        patch: json
      });
      if (!entry) return sendJson(res, 404, { error: "lead_or_list_not_found" });
      return sendJson(res, 200, { entry });
    }

    const leadListBusinessDeleteMatch = matchPath(url.pathname, /^\/api\/lead-lists\/([^/]+)\/businesses\/([^/]+)$/);
    if (req.method === "DELETE" && leadListBusinessDeleteMatch) {
      const member = await removeBusinessFromLeadList({
        tenantId: auth.tenantId,
        listId: leadListBusinessDeleteMatch[1],
        businessId: leadListBusinessDeleteMatch[2]
      });
      if (!member) return sendJson(res, 404, { error: "lead_or_list_not_found" });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/imports/leads/preview") {
      const { json } = await readJson(req);
      const preview = previewLeadImport({
        filename: json.filename || json.name || "leads.csv",
        contentBase64: json.contentBase64 || json.content_base64
      });
      return sendJson(res, 200, preview);
    }

    if (req.method === "POST" && url.pathname === "/api/imports/leads/commit") {
      const { json } = await readJson(req);
      const result = await commitLeadImport({
        tenantId: auth.tenantId,
        filename: json.filename || json.name || "leads.csv",
        contentBase64: json.contentBase64 || json.content_base64,
        mapping: json.mapping || json.columns || json.fieldMapping || json.field_mapping,
        enrichAds: json.enrichAds ?? json.enrich_ads ?? false,
        crmListId: json.crmListId || json.crm_list_id || json.listId || json.list_id,
        crmListName: json.crmListName || json.crm_list_name || json.listName || json.list_name
      });
      return sendJson(res, 201, result);
    }

    if (req.method === "GET" && url.pathname === "/api/campaigns") {
      const result = await listExtractionJobs({ ...parsePaging(url), tenantId: auth.tenantId });
      return sendJson(res, 200, result);
    }

    const campaignExportMatch = matchPath(url.pathname, /^\/api\/campaigns\/([^/]+)\/export\.(csv|xlsx)$/);
    if (req.method === "GET" && campaignExportMatch) {
      const job = await findExtractionJobDetail(campaignExportMatch[1], { tenantId: auth.tenantId });
      if (!job) return sendJson(res, 404, { error: "campaign_not_found" });
      const leads = await listCampaignLeadsForExport({ tenantId: auth.tenantId, campaignId: job.id });
      const format = campaignExportMatch[2];
      const filename = campaignExportFilename(job, format);
      if (format === "csv") {
        return sendAttachment(res, {
          filename,
          contentType: "text/csv; charset=utf-8",
          body: buildCampaignCsv(leads)
        });
      }
      return sendAttachment(res, {
        filename,
        contentType: XLSX_CONTENT_TYPE,
        body: buildCampaignXlsx(leads)
      });
    }

    const campaignCrmMatch = matchPath(url.pathname, /^\/api\/campaigns\/([^/]+)\/crm$/);
    if (req.method === "GET" && campaignCrmMatch) {
      const job = await findExtractionJobDetail(campaignCrmMatch[1], { tenantId: auth.tenantId });
      if (!job) return sendJson(res, 404, { error: "campaign_not_found" });
      const rows = await listCampaignCrmEntries({ tenantId: auth.tenantId, campaignId: job.id });
      return sendJson(res, 200, {
        job,
        rows,
        options: buildCrmOptions(rows)
      });
    }

    const campaignDetailMatch = matchPath(url.pathname, /^\/api\/campaigns\/([^/]+)$/);
    if (req.method === "GET" && campaignDetailMatch) {
      const job = await findExtractionJobDetail(campaignDetailMatch[1], { tenantId: auth.tenantId });
      if (!job) return sendJson(res, 404, { error: "campaign_not_found" });
      return sendJson(res, 200, { job });
    }

    if (req.method === "PATCH" && campaignDetailMatch) {
      const { json } = await readJson(req);
      const job = await updateExtractionJobVoiceSettings(campaignDetailMatch[1], {
        tenantId: auth.tenantId,
        ...parseCampaignVoiceSettings(json)
      });
      if (!job) return sendJson(res, 404, { error: "campaign_not_found" });
      return sendJson(res, 200, { job });
    }

    const campaignAdsMatch = matchPath(url.pathname, /^\/api\/campaigns\/([^/]+)\/ads-enrichment$/);
    if (req.method === "POST" && campaignAdsMatch) {
      const job = await findExtractionJobDetail(campaignAdsMatch[1], { tenantId: auth.tenantId });
      if (!job) return sendJson(res, 404, { error: "campaign_not_found" });
      const businessIds = await listBusinessIdsForCampaign({
        tenantId: auth.tenantId,
        campaignId: job.id,
        limit: Number(url.searchParams.get("limit")) || 1000
      });
      const queueJobs = [];
      for (const businessId of businessIds) {
        queueJobs.push(
          await queues.adsEnrichment.add("enrich", {
            tenantId: auth.tenantId,
            businessId,
            campaignId: job.id
          })
        );
      }
      return sendJson(res, 202, {
        queued: queueJobs.length,
        queue: QUEUE_NAMES.adsEnrichment,
        jobIds: queueJobs.map((queueJob) => queueJob.id)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/businesses") {
      const result = await listBusinesses({
        ...parsePaging(url),
        tenantId: auth.tenantId,
        status: url.searchParams.get("status") || undefined,
        niche: url.searchParams.get("niche") || undefined,
        city: url.searchParams.get("city") || undefined,
        search: url.searchParams.get("search") || undefined,
        extractionJobId: url.searchParams.get("campaignId") || url.searchParams.get("extractionJobId") || undefined,
        listId: url.searchParams.get("listId") || undefined,
        phoneType: url.searchParams.get("phoneType") || undefined,
        adsActive: url.searchParams.get("adsActive") || undefined,
        adsFunnelType: url.searchParams.get("adsFunnelType") || url.searchParams.get("adIntent") || undefined
      });
      return sendJson(res, 200, result);
    }

    const businessDetailMatch = matchPath(url.pathname, /^\/api\/businesses\/([^/]+)$/);
    if (req.method === "GET" && businessDetailMatch) {
      const detail = await findBusinessDetail(businessDetailMatch[1], { tenantId: auth.tenantId });
      if (!detail) return sendJson(res, 404, { error: "business_not_found" });
      return sendJson(res, 200, detail);
    }

    if (req.method === "DELETE" && businessDetailMatch) {
      const deleted = await deleteBusinessForTenant(businessDetailMatch[1], { tenantId: auth.tenantId });
      if (!deleted) return sendJson(res, 404, { error: "business_not_found" });
      return sendJson(res, 200, { ok: true, business: deleted });
    }

    if (req.method === "GET" && url.pathname === "/api/calls") {
      const result = await listVoiceCalls({
        ...parsePaging(url),
        tenantId: auth.tenantId,
        outcome: url.searchParams.get("outcome") || undefined,
        qualified: url.searchParams.get("qualified") || undefined
      });
      return sendJson(res, 200, result);
    }

    const callDetailMatch = matchPath(url.pathname, /^\/api\/calls\/([^/]+)$/);
    if (req.method === "GET" && callDetailMatch) {
      const call = await findVoiceCallDetail(callDetailMatch[1], { tenantId: auth.tenantId });
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
            tenantId: auth.tenantId,
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
            tenantId: auth.tenantId,
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

        if (type === "ads_enrichment") {
          validateRequired(json, ["name"]);
          const business = await createManualBusiness({
            tenantId: auth.tenantId,
            name: json.name,
            website: json.website,
            phone: json.phone,
            phoneE164: json.phoneE164 || json.phone_e164 || normalizeSpanishPhone(json.phone),
            city: json.city || "Madrid",
            niche: json.niche || "ads enrichment smoke test",
            category: json.category || "test",
            instagram: json.instagram,
            facebook: json.facebook,
            sourceUrl: json.sourceUrl || json.source_url || json.website,
            rawPayload: { testJob: true, testId, type }
          });
          const queueJob = await queues.adsEnrichment.add("enrich", {
            tenantId: auth.tenantId,
            businessId: business.id,
            testId
          });
          return sendJson(res, 202, {
            testJob: {
              id: business.id,
              type,
              testId,
              statusUrl: `/api/test-jobs/businesses/${business.id}`,
              queue: { name: QUEUE_NAMES.adsEnrichment, id: queueJob.id }
            },
            business
          });
        }

        if (type === "lead_import") {
          const filename = json.filename || "codex-import.csv";
          const contentBase64 = json.contentBase64 || json.content_base64 || Buffer.from(
            json.csv || "Nombre,Web,Email,Ciudad,Nicho\nCodex Import Demo,https://example.com,import@example.com,Madrid,test\n",
            "utf8"
          ).toString("base64");
          const preview = previewLeadImport({ filename, contentBase64 });
          const result = await commitLeadImport({
            tenantId: auth.tenantId,
            filename,
            contentBase64,
            mapping: json.mapping || preview.suggestedMapping,
            enrichAds: json.enrichAds ?? json.enrich_ads ?? false,
            crmListName: json.crmListName || json.crm_list_name || "Codex Import"
          });
          return sendJson(res, 201, {
            testJob: {
              type,
              testId,
              imported: result.imported,
              enrichAdsQueued: result.enrichAdsQueued
            },
            preview: {
              headers: preview.headers,
              totalRows: preview.totalRows,
              suggestedMapping: preview.suggestedMapping
            },
            import: result
          });
        }

        if (type === "web_discovery") {
          validateRequired(json, ["name"]);
          const business = await createManualBusiness({
            tenantId: auth.tenantId,
            name: json.name,
            city: json.city || "Madrid",
            niche: json.niche || "web discovery smoke test",
            category: json.category || "test",
            rawPayload: { testJob: true, testId, type }
          });
          const queueJob = await queues.webDiscovery.add("discover", {
            tenantId: auth.tenantId,
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
            tenantId: auth.tenantId,
            niche: json.niche,
            city: json.city,
            sourceType: json.sourceType || json.source_type || "google_places_api",
            bbox: json.bbox,
            gridStep: json.gridStep || json.grid_step,
            requestedLimit: json.requestedLimit || json.requested_limit || 5,
            ...parseCampaignVoiceSettings(json)
          });
          const queueJob = await queues.googleDiscovery.add("run", {
            tenantId: auth.tenantId,
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
          supportedTypes: ["business_crawl", "web_discovery", "ads_enrichment", "lead_import", "campaign"]
        });
      }

      const testBusinessMatch = matchPath(url.pathname, /^\/api\/test-jobs\/businesses\/([^/]+)$/);
      if (req.method === "GET" && testBusinessMatch) {
        const detail = await findBusinessDetail(testBusinessMatch[1], { tenantId: auth.tenantId });
        if (!detail) return sendJson(res, 404, { error: "business_not_found" });
        return sendJson(res, 200, {
          type: "business_crawl",
          done: isBusinessTestDone(detail),
          ...detail
        });
      }

      const testCampaignMatch = matchPath(url.pathname, /^\/api\/test-jobs\/campaigns\/([^/]+)$/);
      if (req.method === "GET" && testCampaignMatch) {
        const job = await findExtractionJobDetail(testCampaignMatch[1], { tenantId: auth.tenantId });
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
        tenantId: auth.tenantId,
        niche: json.niche,
        city: json.city,
        sourceType,
        bbox: json.bbox,
        gridStep: json.gridStep || json.grid_step,
        requestedLimit: json.requestedLimit || json.requested_limit,
        ...parseCampaignVoiceSettings(json)
      });

      if (sourceType === "google_places_api") {
        await queues.googleDiscovery.add("run", {
          tenantId: auth.tenantId,
          extractionJobId: job.id
        });
      }

      return sendJson(res, 201, { job });
    }

    if (req.method === "POST" && url.pathname === "/businesses") {
      const { json } = await readJson(req);
      validateRequired(json, ["name"]);
      const business = await createManualBusiness({
        tenantId: auth.tenantId,
        ...json,
        phoneE164: json.phoneE164 || json.phone_e164 || normalizeSpanishPhone(json.phone)
      });
      if (business.website) {
        await queues.businessCrawl.add("crawl", {
          tenantId: auth.tenantId,
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
      const business = await findBusinessById(businessId, { tenantId: auth.tenantId });
      if (!business) return sendJson(res, 404, { error: "business_not_found" });
      const rootUrl = json.rootUrl || json.root_url || business.website;
      if (!rootUrl) return sendJson(res, 400, { error: "business_has_no_website" });
      const job = await queues.businessCrawl.add("crawl", { tenantId: auth.tenantId, businessId, rootUrl });
      return sendJson(res, 202, { jobId: job.id });
    }

    const scoreMatch = matchPath(url.pathname, /^\/businesses\/([^/]+)\/score$/);
    if (req.method === "POST" && scoreMatch) {
      const business = await findBusinessById(scoreMatch[1], { tenantId: auth.tenantId });
      if (!business) return sendJson(res, 404, { error: "business_not_found" });
      const job = await queues.scoring.add("score", { tenantId: auth.tenantId, businessId: scoreMatch[1] });
      return sendJson(res, 202, { jobId: job.id });
    }

    const scoringNotesMatch = matchPath(url.pathname, /^\/api\/businesses\/([^/]+)\/scoring-notes$/);
    if (req.method === "PATCH" && scoringNotesMatch) {
      const { json } = await readJson(req);
      const business = await updateBusinessScoringNotes({
        tenantId: auth.tenantId,
        businessId: scoringNotesMatch[1],
        scoringNotes: json.scoringNotes ?? json.scoring_notes ?? ""
      });
      if (!business) return sendJson(res, 404, { error: "business_not_found" });
      return sendJson(res, 200, { business });
    }

    const adsEnrichmentMatch = matchPath(url.pathname, /^\/api\/businesses\/([^/]+)\/ads-enrichment$/);
    if (req.method === "POST" && adsEnrichmentMatch) {
      const business = await findBusinessById(adsEnrichmentMatch[1], { tenantId: auth.tenantId });
      if (!business) return sendJson(res, 404, { error: "business_not_found" });
      const job = await queues.adsEnrichment.add("enrich", {
        tenantId: auth.tenantId,
        businessId: business.id
      });
      return sendJson(res, 202, { jobId: job.id, queue: QUEUE_NAMES.adsEnrichment });
    }

    const callMatch = matchPath(url.pathname, /^\/businesses\/([^/]+)\/call$/);
    if (req.method === "POST" && callMatch) {
      const { json } = await readJson(req);
      const business = await findBusinessById(callMatch[1], { tenantId: auth.tenantId });
      if (!business) return sendJson(res, 404, { error: "business_not_found" });
      const job = await queues.voiceCall.add("call", {
        tenantId: auth.tenantId,
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

function sendAttachment(res, { filename, contentType, body }) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const asciiFilename = filename.replace(/[^\w.-]+/g, "-");
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": buffer.length,
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
  res.end(buffer);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

async function getRouteAuth(req, url) {
  if (url.pathname.startsWith("/api/test-jobs")) {
    requireTestJobAuth(req);
    return { tenantId: DEFAULT_TENANT_ID, user: null, tenant: { id: DEFAULT_TENANT_ID, slug: "default" } };
  }
  if (url.pathname === "/webhooks/nebrija/calls") {
    return { tenantId: DEFAULT_TENANT_ID, user: null, tenant: { id: DEFAULT_TENANT_ID, slug: "default" } };
  }
  if ((req.method === "GET" || req.method === "HEAD") && isStaticRequest(url.pathname)) {
    return { tenantId: DEFAULT_TENANT_ID, user: null, tenant: null, public: true };
  }

  const auth = await getSession(req);
  if (!auth) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  return auth;
}

function isStaticRequest(pathname) {
  return !pathname.startsWith("/api/") && !pathname.startsWith("/auth/");
}

async function getSession(req) {
  const token = readCookies(req)[config.auth.sessionCookieName];
  if (!token) return null;
  const session = await findSessionByTokenHash(hashToken(token));
  if (!session) return null;
  return {
    tenantId: session.tenant_id,
    userId: session.user_id,
    sessionId: session.id,
    user: {
      id: session.user_id,
      email: session.email,
      name: session.name,
      avatarUrl: session.avatar_url,
      role: session.role
    },
    tenant: {
      id: session.tenant_id,
      name: session.tenant_name,
      slug: session.tenant_slug,
      googleDomain: session.tenant_google_domain
    }
  };
}

function requireGoogleOAuthConfig() {
  if (!config.auth.googleClientId || !config.auth.googleClientSecret) {
    const error = new Error("google_oauth_not_configured");
    error.statusCode = 503;
    throw error;
  }
}

function googleRedirectUri(req) {
  return `${requestBaseUrl(req)}/auth/google/callback`;
}

function requestBaseUrl(req) {
  const configured = config.server.publicBaseUrl;
  if (configured && !/^https?:\/\/localhost(?::|$)/.test(configured)) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

function readCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function setCookie(req, res, name, value, { maxAge, httpOnly = true, sameSite = "Lax" } = {}) {
  const secure = requestIsSecure(req);
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (maxAge != null) parts.push(`Max-Age=${Math.max(0, Number(maxAge) || 0)}`);
  appendSetCookie(res, parts.join("; "));
}

function clearCookie(req, res, name) {
  appendSetCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${requestIsSecure(req) ? "; Secure" : ""}`);
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader("set-cookie");
  const values = Array.isArray(current) ? current : current ? [current] : [];
  res.setHeader("set-cookie", [...values, cookie]);
}

function requestIsSecure(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  return String(config.server.publicBaseUrl || "").startsWith("https://") || forwardedProto === "https" || Boolean(req?.socket?.encrypted);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
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

function parseCampaignVoiceSettings(json) {
  const assistantVariables = parseStringArray(
    json.voiceAssistantVariables ?? json.voice_assistant_variables ?? json.assistantVariables ?? json.assistant_variables
  );
  const suppliedMap = json.voiceVariableMap ?? json.voice_variable_map ?? json.variableMap ?? json.variable_map;
  return {
    voiceAssistantId: json.voiceAssistantId || json.voice_assistant_id || "",
    voiceAssistantName: json.voiceAssistantName || json.voice_assistant_name || "",
    voicePhoneNumberId: json.voicePhoneNumberId || json.voice_phone_number_id || "",
    voiceAssistantVariables: assistantVariables,
    voiceVariableMap:
      suppliedMap && typeof suppliedMap === "object" && !Array.isArray(suppliedMap)
        ? suppliedMap
        : defaultVariableMap(assistantVariables)
  };
}

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

async function commitLeadImport({ tenantId, filename, contentBase64, mapping, enrichAds = false, crmListId, crmListName }) {
  const parsed = parseLeadFile({ filename, contentBase64 });
  const mapped = buildImportedLeadRows(parsed.rows, mapping || parsed.headers.reduce((acc, header) => {
    acc[header] = "ignore";
    return acc;
  }, {}));
  const created = [];
  const crmList = await resolveImportCrmList({ tenantId, crmListId, crmListName, filename });
  let crmRowsImported = 0;

  for (const row of mapped.rows) {
    const business = await createManualBusiness({
      tenantId,
      ...row.business,
      customFields: row.customFields,
      rawPayload: {
        import: {
          filename,
          rowNumber: row.rowNumber,
          originalRow: row.originalRow,
          contact: row.contact || {}
        }
      }
    });
    for (const contact of row.contacts) {
      await upsertContact({
        businessId: business.id,
        kind: contact.kind,
        value: contact.value,
        confidence: contact.confidence,
        sourceUrl: business.source_url
      });
    }
    if (crmList) {
      const member = await addBusinessToLeadList({ tenantId, listId: crmList.id, businessId: business.id });
      if (member) {
        await updateLeadListCrmEntry({
          tenantId,
          listId: crmList.id,
          businessId: business.id,
          patch: buildImportCrmPatch(row)
        });
        crmRowsImported += 1;
      }
    }
    if (enrichAds) {
      await queues.adsEnrichment.add("enrich", {
        tenantId,
        businessId: business.id,
        importFilename: filename
      });
    }
    created.push(business);
  }

  return {
    imported: created.length,
    errors: mapped.errors,
    crmList: crmList ? { id: crmList.id, name: crmList.name } : null,
    crmRowsImported,
    enrichAdsQueued: enrichAds ? created.length : 0,
    leads: created.slice(0, 20).map((business) => ({
      id: business.id,
      name: business.name,
      website: business.website,
      city: business.city,
      niche: business.niche
    }))
  };
}

async function resolveImportCrmList({ tenantId, crmListId, crmListName, filename }) {
  if (crmListId) return findLeadList(crmListId, { tenantId });
  const name = String(crmListName || "").trim();
  if (!name) return null;
  return createLeadList({
    tenantId,
    name,
    description: `Importada desde ${filename || "archivo"}`,
    color: "cyan"
  });
}

function buildImportCrmPatch(row) {
  return {
    ...(row.crm || {}),
    decisionMakerName: row.crm?.decisionMakerName || row.contact?.fullName || undefined,
    decisionMakerEmail: row.crm?.decisionMakerEmail || row.contacts?.find((contact) => contact.kind === "email")?.value || undefined
  };
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
  return Boolean(detail.business?.ads_last_checked_at) || Boolean(latestRun && ["completed", "failed"].includes(latestRun.status));
}

function buildCrmOptions(rows = []) {
  return {
    statuses: CRM_STATUS_OPTIONS,
    checkpoints: CRM_CHECKPOINT_OPTIONS,
    objections: Array.from(new Set([...CRM_OBJECTION_OPTIONS, ...rows.map((row) => row.objection).filter(Boolean)]))
  };
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
  const headers = {
    "content-type": mime,
    "cache-control": path.extname(safePath) === ".html" ? "no-store" : "no-cache"
  };
  res.writeHead(200, headers);
  res.end(buffer);
  return true;
}
