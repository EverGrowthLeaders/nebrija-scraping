import { query, withTransaction } from "./db.mjs";
import { config } from "./config.mjs";
import { adsEnrichmentForStorage, aiBackedAdsActiveForStorage } from "./adsStoragePolicy.mjs";
import { decisionMakerEnrichmentForStorage } from "./decisionMakerStoragePolicy.mjs";
import { DEFAULT_SCORING_RULES, normalizeScoringRules } from "./scoring.mjs";

export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const CRM_STATUS_OPTIONS = [
  "Nuevo",
  "Aplazado",
  "Interesado",
  "Cita Concertada",
  "Seguimiento",
  "No contesta",
  "Descartado"
];
export const CRM_CHECKPOINT_OPTIONS = ["Secretaria", "Inicio", "Pitch", "Agendado", "No lo coge", "Objeción inicial"];
export const CRM_OBJECTION_OPTIONS = [
  "No puedo ahora",
  "Estamos bien",
  "Ya tenemos proveedor",
  "Quién eres",
  "Puedes enviar esto por email"
];
export const DEFAULT_ANALYTICS_SETTINGS = {
  offerPrice: 3000,
  firstMonthPrice: 1000,
  revenueTarget: 10000,
  appointmentRate: null,
  qualificationRate: 70,
  closeRate: 30,
  showUpRate: 80
};

export async function findSessionByTokenHash(tokenHash) {
  const result = await query(
    `SELECT s.id, s.tenant_id, s.user_id, s.expires_at, u.email, u.name, u.avatar_url, u.role,
            t.name AS tenant_name, t.slug AS tenant_slug, t.google_domain AS tenant_google_domain
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()`,
    [tokenHash]
  );
  const session = result.rows[0] || null;
  if (session) {
    await query(`UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1`, [session.id]);
  }
  return session;
}

export async function upsertGoogleUser({ profile }) {
  const emailDomain = profile.email.split("@").pop()?.toLowerCase() || "google";
  const hostedDomain = profile.hostedDomain?.toLowerCase() || "";
  const consumerGoogleAccount = !hostedDomain && ["gmail.com", "googlemail.com"].includes(emailDomain);
  const tenantSlug = consumerGoogleAccount
    ? profile.email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : (hostedDomain || emailDomain).toLowerCase();
  const tenantName = consumerGoogleAccount ? `${profile.email} Workspace` : tenantSlug;
  const googleDomain = consumerGoogleAccount ? null : hostedDomain || emailDomain;

  return withTransaction(async (client) => {
    const tenant = await upsertTenantForFirstLogin(client, {
      name: tenantName,
      slug: tenantSlug,
      googleDomain
    });

    const user = await client.query(
      `INSERT INTO users (tenant_id, google_sub, email, name, avatar_url, last_login_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (google_sub)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         last_login_at = NOW(),
         updated_at = NOW()
       RETURNING *`,
      [tenant.id, profile.sub, profile.email, profile.name, profile.picture]
    );

    return { tenant, user: user.rows[0] };
  });
}

async function upsertTenantForFirstLogin(client, { name, slug, googleDomain }) {
  const existing = await client.query(`SELECT * FROM tenants WHERE slug = $1`, [slug]);
  if (existing.rows[0]) return existing.rows[0];
  if (googleDomain) {
    const existingDomain = await client.query(`SELECT * FROM tenants WHERE google_domain = $1`, [googleDomain]);
    if (existingDomain.rows[0]) return existingDomain.rows[0];
  }

  const userCount = await client.query(`SELECT COUNT(*)::int AS count FROM users`);
  if (userCount.rows[0]?.count === 0) {
    const claimedDefault = await client.query(
      `UPDATE tenants
          SET name = $2,
              slug = $3,
              google_domain = $4,
              updated_at = NOW()
        WHERE id = $1
          AND slug = 'default'
        RETURNING *`,
      [DEFAULT_TENANT_ID, name, slug, googleDomain]
    );
    if (claimedDefault.rows[0]) return claimedDefault.rows[0];
  }

  const created = await client.query(
    `INSERT INTO tenants (name, slug, google_domain)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug)
     DO UPDATE SET
       name = COALESCE(tenants.name, EXCLUDED.name),
       google_domain = COALESCE(tenants.google_domain, EXCLUDED.google_domain),
       updated_at = NOW()
     RETURNING *`,
    [name, slug, googleDomain]
  );
  return created.rows[0];
}

export async function createUserSession({ tenantId, userId, tokenHash, expiresAt, userAgent, ipAddress }) {
  const result = await query(
    `INSERT INTO user_sessions (tenant_id, user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [tenantId, userId, tokenHash, expiresAt, userAgent || null, ipAddress || null]
  );
  return result.rows[0];
}

export async function revokeSession(tokenHash) {
  await query(`UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash]);
}

export async function getTenantNebrijaSettings({ tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT tenant_id, provider, api_base_url, api_key_last4, default_phone_number_id, settings, created_at, updated_at
       FROM tenant_integrations
      WHERE tenant_id = $1 AND provider = 'nebrijaai'`,
    [tenantId]
  );
  return result.rows[0] || null;
}

export async function getEffectiveNebrijaSettings({ tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT api_base_url, api_key, api_key_last4, default_phone_number_id, settings
       FROM tenant_integrations
      WHERE tenant_id = $1 AND provider = 'nebrijaai'`,
    [tenantId]
  );
  const row = result.rows[0] || {};
  const apiKey = row.api_key || config.nebrija.apiKey || "";
  return {
    apiBaseUrl: row.api_base_url || config.nebrija.apiBaseUrl,
    apiKey,
    apiKeyLast4: row.api_key_last4 || (apiKey ? apiKey.slice(-4) : ""),
    defaultPhoneNumberId: row.default_phone_number_id || config.nebrija.phoneNumberId,
    settings: row.settings || {},
    configured: Boolean(apiKey)
  };
}

export async function upsertTenantNebrijaSettings({
  tenantId = DEFAULT_TENANT_ID,
  apiBaseUrl,
  apiKey,
  defaultPhoneNumberId,
  settings
}) {
  const existing = await query(
    `SELECT api_key, api_key_last4 FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'nebrijaai'`,
    [tenantId]
  );
  const nextApiKey = apiKey === undefined ? existing.rows[0]?.api_key || null : apiKey || null;
  const nextLast4 = nextApiKey ? nextApiKey.slice(-4) : existing.rows[0]?.api_key_last4 || null;
  const result = await query(
    `INSERT INTO tenant_integrations
       (tenant_id, provider, api_base_url, api_key, api_key_last4, default_phone_number_id, settings)
     VALUES ($1, 'nebrijaai', $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, provider)
     DO UPDATE SET
       api_base_url = EXCLUDED.api_base_url,
       api_key = COALESCE(EXCLUDED.api_key, tenant_integrations.api_key),
       api_key_last4 = COALESCE(EXCLUDED.api_key_last4, tenant_integrations.api_key_last4),
       default_phone_number_id = EXCLUDED.default_phone_number_id,
       settings = tenant_integrations.settings || EXCLUDED.settings,
       updated_at = NOW()
     RETURNING tenant_id, provider, api_base_url, api_key_last4, default_phone_number_id, settings, created_at, updated_at`,
    [tenantId, apiBaseUrl || null, nextApiKey, nextLast4, defaultPhoneNumberId || null, settings || {}]
  );
  return result.rows[0];
}

export async function listTenantApiKeys({ tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT id, name, key_prefix, key_last4, scopes, created_at, last_used_at, revoked_at
       FROM tenant_api_keys
      WHERE tenant_id = $1
      ORDER BY revoked_at NULLS FIRST, created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

export async function createTenantApiKey({
  tenantId = DEFAULT_TENANT_ID,
  name,
  keyHash,
  keyPrefix,
  keyLast4,
  scopes = ["test_jobs"],
  createdBy
}) {
  const result = await query(
    `INSERT INTO tenant_api_keys (tenant_id, name, key_hash, key_prefix, key_last4, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id, name, key_prefix, key_last4, scopes, created_at, last_used_at, revoked_at`,
    [
      tenantId,
      String(name || "Production API Key").trim().slice(0, 120) || "Production API Key",
      keyHash,
      keyPrefix,
      keyLast4,
      JSON.stringify(scopes),
      createdBy || null
    ]
  );
  return result.rows[0];
}

export async function findActiveTenantApiKeyByHash(keyHash) {
  const result = await query(
    `SELECT k.id, k.tenant_id, k.name, k.key_prefix, k.key_last4, k.scopes, k.created_at, k.last_used_at,
            t.name AS tenant_name, t.slug AS tenant_slug, t.google_domain AS tenant_google_domain
       FROM tenant_api_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = $1
        AND k.revoked_at IS NULL`,
    [keyHash]
  );
  return result.rows[0] || null;
}

export async function markTenantApiKeyUsed(id) {
  await query(`UPDATE tenant_api_keys SET last_used_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [id]);
}

export async function revokeTenantApiKey({ tenantId = DEFAULT_TENANT_ID, keyId }) {
  const result = await query(
    `UPDATE tenant_api_keys
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE tenant_id = $1
        AND id = $2
      RETURNING id, name, key_prefix, key_last4, scopes, created_at, last_used_at, revoked_at`,
    [tenantId, keyId]
  );
  return result.rows[0] || null;
}

export async function getTenantAnalyticsSettings({ tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT settings, updated_at
       FROM tenant_integrations
      WHERE tenant_id = $1 AND provider = 'analytics_forecast'`,
    [tenantId]
  );
  const row = result.rows[0];
  return {
    settings: normalizeAnalyticsSettings(row?.settings || {}),
    updatedAt: row?.updated_at || null,
    stored: Boolean(row)
  };
}

export async function upsertTenantAnalyticsSettings({ tenantId = DEFAULT_TENANT_ID, settings }) {
  const current = await getTenantAnalyticsSettings({ tenantId });
  const next = normalizeAnalyticsSettings({ ...current.settings, ...(settings || {}) });
  const result = await query(
    `INSERT INTO tenant_integrations (tenant_id, provider, settings)
     VALUES ($1, 'analytics_forecast', $2)
     ON CONFLICT (tenant_id, provider)
     DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
     RETURNING settings, updated_at`,
    [tenantId, next]
  );
  return {
    settings: normalizeAnalyticsSettings(result.rows[0]?.settings || {}),
    updatedAt: result.rows[0]?.updated_at || null,
    stored: true
  };
}

function normalizeAnalyticsSettings(settings = {}) {
  return {
    offerPrice: positiveNumber(settings.offerPrice ?? settings.offer_price, DEFAULT_ANALYTICS_SETTINGS.offerPrice),
    firstMonthPrice: positiveNumber(
      settings.firstMonthPrice ?? settings.first_month_price,
      DEFAULT_ANALYTICS_SETTINGS.firstMonthPrice
    ),
    revenueTarget: positiveNumber(
      settings.revenueTarget ?? settings.revenue_target,
      DEFAULT_ANALYTICS_SETTINGS.revenueTarget
    ),
    appointmentRate: nullablePercent(settings.appointmentRate ?? settings.appointment_rate),
    qualificationRate: percentNumber(
      settings.qualificationRate ?? settings.qualification_rate,
      DEFAULT_ANALYTICS_SETTINGS.qualificationRate
    ),
    closeRate: percentNumber(settings.closeRate ?? settings.close_rate, DEFAULT_ANALYTICS_SETTINGS.closeRate),
    showUpRate: percentNumber(settings.showUpRate ?? settings.show_up_rate, DEFAULT_ANALYTICS_SETTINGS.showUpRate)
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function percentNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, 0.1), 100);
}

function nullablePercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, 0.1), 100);
}

export async function getTenantScoringRules({ tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT tenant_id, rules, created_at, updated_at
       FROM tenant_scoring_rules
      WHERE tenant_id = $1`,
    [tenantId]
  );
  const row = result.rows[0];
  return {
    tenantId,
    rules: normalizeScoringRules(row?.rules?.length ? row.rules : DEFAULT_SCORING_RULES),
    updatedAt: row?.updated_at || null,
    stored: Boolean(row)
  };
}

export async function upsertTenantScoringRules({ tenantId = DEFAULT_TENANT_ID, rules }) {
  const normalized = normalizeScoringRules(rules);
  const result = await query(
    `INSERT INTO tenant_scoring_rules (tenant_id, rules)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id)
     DO UPDATE SET rules = EXCLUDED.rules, updated_at = NOW()
     RETURNING tenant_id, rules, created_at, updated_at`,
    [tenantId, normalized]
  );
  return {
    tenantId,
    rules: normalizeScoringRules(result.rows[0].rules),
    updatedAt: result.rows[0].updated_at,
    stored: true
  };
}

export async function createExtractionJob({
  tenantId = DEFAULT_TENANT_ID,
  niche,
  city,
  sourceType,
  bbox,
  gridStep,
  requestedLimit,
  voiceAssistantId,
  voiceAssistantName,
  voicePhoneNumberId,
  voiceVariableMap,
  voiceAssistantVariables
}) {
  const result = await query(
    `INSERT INTO extraction_jobs
       (tenant_id, niche, city, source_type, bbox, grid_step, requested_limit,
        voice_assistant_id, voice_assistant_name, voice_phone_number_id, voice_variable_map, voice_assistant_variables)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      tenantId,
      niche,
      city,
      sourceType || "google_places_api",
      bbox || null,
      gridStep || null,
      requestedLimit || null,
      voiceAssistantId || null,
      voiceAssistantName || null,
      voicePhoneNumberId || null,
      voiceVariableMap || {},
      voiceAssistantVariables || []
    ]
  );
  return result.rows[0];
}

export async function findExtractionJob(id, { tenantId } = {}) {
  const params = [id];
  const tenantClause = tenantId ? `AND tenant_id = $2` : "";
  if (tenantId) params.push(tenantId);
  const result = await query(`SELECT * FROM extraction_jobs WHERE id = $1 ${tenantClause}`, params);
  return result.rows[0] || null;
}

export async function updateExtractionJob(id, fields) {
  const allowed = ["status", "started_at", "finished_at", "error", "metrics"];
  const updates = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    values.push(value);
    updates.push(`${key} = $${values.length}`);
  }
  if (!updates.length) return null;
  values.push(id);
  const result = await query(
    `UPDATE extraction_jobs SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function updateExtractionJobVoiceSettings(
  id,
  {
    tenantId = DEFAULT_TENANT_ID,
    voiceAssistantId,
    voiceAssistantName,
    voicePhoneNumberId,
    voiceVariableMap,
    voiceAssistantVariables
  } = {}
) {
  const result = await query(
    `UPDATE extraction_jobs
        SET voice_assistant_id = $1,
            voice_assistant_name = $2,
            voice_phone_number_id = $3,
            voice_variable_map = $4,
            voice_assistant_variables = $5
      WHERE id = $6 AND tenant_id = $7
      RETURNING *`,
    [
      voiceAssistantId || null,
      voiceAssistantName || null,
      voicePhoneNumberId || null,
      voiceVariableMap || {},
      voiceAssistantVariables || [],
      id,
      tenantId
    ]
  );
  return result.rows[0] || null;
}

export async function upsertGoogleCandidate({ tenantId = DEFAULT_TENANT_ID, extractionJobId, place, queryText, city, niche }) {
  const result = await query(
    `INSERT INTO google_place_candidates
       (tenant_id, extraction_job_id, place_id, query, city, niche, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, place_id, query)
     DO UPDATE SET
       extraction_job_id = EXCLUDED.extraction_job_id,
       city = EXCLUDED.city,
       niche = EXCLUDED.niche,
       raw_payload = EXCLUDED.raw_payload,
       expires_at = NOW() + INTERVAL '7 days'
     RETURNING *`,
    [tenantId, extractionJobId, place.placeId, queryText, city, niche, place.raw || {}]
  );
  return result.rows[0];
}

export async function upsertBusinessFromGoogleCandidate({ tenantId = DEFAULT_TENANT_ID, extractionJobId, place, city, niche, sourceUrl }) {
  const syntheticKey = place.placeId || stableBusinessKey(place);
  const status = place.website || place.phoneE164 ? "enriched" : "enrichment_pending";
  const result = await query(
    `INSERT INTO businesses
       (tenant_id, extraction_job_id, place_id, external_source, name, phone, phone_e164, website, address, city, niche,
        latitude, longitude, rating, review_count, source_url, raw_payload, status)
     VALUES ($1, $2, $3, 'google_places_candidate', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::lead_status)
     ON CONFLICT (tenant_id, place_id) WHERE place_id IS NOT NULL
     DO UPDATE SET
       extraction_job_id = COALESCE(businesses.extraction_job_id, EXCLUDED.extraction_job_id),
       name = COALESCE(EXCLUDED.name, businesses.name),
       phone = COALESCE(EXCLUDED.phone, businesses.phone),
       phone_e164 = COALESCE(EXCLUDED.phone_e164, businesses.phone_e164),
       website = COALESCE(EXCLUDED.website, businesses.website),
       address = COALESCE(EXCLUDED.address, businesses.address),
       city = COALESCE(EXCLUDED.city, businesses.city),
       niche = COALESCE(EXCLUDED.niche, businesses.niche),
       latitude = COALESCE(EXCLUDED.latitude, businesses.latitude),
       longitude = COALESCE(EXCLUDED.longitude, businesses.longitude),
       rating = COALESCE(EXCLUDED.rating, businesses.rating),
       review_count = COALESCE(EXCLUDED.review_count, businesses.review_count),
       source_url = COALESCE(businesses.source_url, EXCLUDED.source_url),
       raw_payload = businesses.raw_payload || EXCLUDED.raw_payload,
       status = CASE
         WHEN businesses.status IN ('new', 'scraped', 'enrichment_pending')
              AND (EXCLUDED.website IS NOT NULL OR EXCLUDED.phone_e164 IS NOT NULL)
           THEN 'enriched'::lead_status
         WHEN businesses.status = 'scraped'
           THEN 'enrichment_pending'::lead_status
         ELSE businesses.status
       END,
       updated_at = NOW()
     RETURNING *`,
    [
      tenantId,
      extractionJobId || null,
      syntheticKey,
      place.name || "Unknown business",
      place.phone || null,
      place.phoneE164 || null,
      place.website || null,
      place.address || null,
      city || null,
      niche || null,
      place.latitude ?? null,
      place.longitude ?? null,
      place.rating ?? null,
      place.reviewCount ?? null,
      sourceUrl || place.sourceUrl || null,
      place.raw || {},
      status
    ]
  );
  return result.rows[0];
}

export async function findBusinessById(id, { tenantId } = {}) {
  const params = [id];
  const tenantClause = tenantId ? `AND tenant_id = $2` : "";
  if (tenantId) params.push(tenantId);
  const result = await query(`SELECT * FROM businesses WHERE id = $1 ${tenantClause}`, params);
  return result.rows[0] || null;
}

export async function deleteBusinessForTenant(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `DELETE FROM businesses
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, name`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

export async function findBusinessVoiceContext(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT b.*,
            j.voice_assistant_id,
            j.voice_assistant_name,
            j.voice_phone_number_id,
            j.voice_variable_map,
            j.voice_assistant_variables
       FROM businesses b
       LEFT JOIN extraction_jobs j ON j.id = b.extraction_job_id AND j.tenant_id = b.tenant_id
      WHERE b.id = $1 AND b.tenant_id = $2`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

export async function findCallableBusinessById(id, { tenantId } = {}) {
  const params = [id];
  const tenantClause = tenantId ? `AND b.tenant_id = $2` : "";
  if (tenantId) params.push(tenantId);
  const result = await query(
    `SELECT b.*,
            COUNT(c.id) FILTER (WHERE c.kind = 'email')::int AS email_count
       FROM businesses b
       LEFT JOIN business_contacts c ON c.business_id = b.id
      WHERE b.id = $1 ${tenantClause}
      GROUP BY b.id`,
    params
  );
  return result.rows[0] || null;
}

export async function createCrawlerRun({ tenantId = DEFAULT_TENANT_ID, businessId, provider, rootUrl }) {
  const result = await query(
    `INSERT INTO crawler_runs (tenant_id, business_id, provider, root_url, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING *`,
    [tenantId, businessId || null, provider, rootUrl]
  );
  return result.rows[0];
}

export async function updateCrawlerRun(id, fields) {
  const allowed = [
    "status",
    "pages_requested",
    "pages_succeeded",
    "pages_failed",
    "started_at",
    "finished_at",
    "error",
    "metrics"
  ];
  const updates = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    values.push(value);
    updates.push(`${key} = $${values.length}`);
  }
  values.push(id);
  const result = await query(
    `UPDATE crawler_runs SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function persistCrawledPage({ tenantId = DEFAULT_TENANT_ID, crawlerRunId, businessId, url, statusCode, contentHash, title, markdown, extracted }) {
  const result = await query(
    `INSERT INTO crawled_pages
       (tenant_id, crawler_run_id, business_id, url, status_code, content_hash, title, markdown, extracted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (crawler_run_id, url)
     DO UPDATE SET
       status_code = EXCLUDED.status_code,
       content_hash = EXCLUDED.content_hash,
       title = EXCLUDED.title,
       markdown = EXCLUDED.markdown,
       extracted = EXCLUDED.extracted,
       scraped_at = NOW()
     RETURNING *`,
    [tenantId, crawlerRunId, businessId || null, url, statusCode || null, contentHash, title || null, markdown || "", extracted || {}]
  );
  return result.rows[0];
}

export async function upsertContact({ businessId, kind, value, confidence, sourceUrl }) {
  const result = await query(
    `INSERT INTO business_contacts (business_id, kind, value, confidence, source_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, kind, value)
     DO UPDATE SET
       confidence = GREATEST(business_contacts.confidence, EXCLUDED.confidence),
       source_url = COALESCE(business_contacts.source_url, EXCLUDED.source_url)
     RETURNING *`,
    [businessId, kind, value, confidence, sourceUrl || null]
  );
  return result.rows[0];
}

export async function deleteContactsByKindAndSource({ businessId, kind, sourceUrl }) {
  const result = await query(
    `DELETE FROM business_contacts
      WHERE business_id = $1
        AND kind = $2
        AND source_url IS NOT DISTINCT FROM $3
      RETURNING id`,
    [businessId, kind, sourceUrl || null]
  );
  return result.rowCount || 0;
}

export async function recordProvenance({ businessId, fieldName, sourceType, sourceUrl, sourceRecordId, observedValue }) {
  const result = await query(
    `INSERT INTO data_provenance
       (business_id, field_name, source_type, source_url, source_record_id, observed_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [businessId, fieldName, sourceType, sourceUrl || null, sourceRecordId || null, observedValue || null]
  );
  return result.rows[0];
}

export async function updateBusinessEnrichment({ businessId, patch }) {
  const result = await query(
    `UPDATE businesses SET
       phone_e164 = COALESCE($2, phone_e164),
       website = COALESCE($3, website),
       instagram = COALESCE($4, instagram),
       facebook = COALESCE($5, facebook),
       has_online_booking = has_online_booking OR $6,
       has_chatbot = has_chatbot OR $7,
       status = CASE
         WHEN status IN ('new', 'scraped', 'enrichment_pending') THEN 'enriched'::lead_status
         ELSE status
       END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      businessId,
      patch.phoneE164 || null,
      patch.website || null,
      patch.instagram || null,
      patch.facebook || null,
      Boolean(patch.hasOnlineBooking),
      Boolean(patch.hasChatbot)
    ]
  );
  return result.rows[0] || null;
}

export async function updateBusinessDecisionMaker({ businessId, tenantId = DEFAULT_TENANT_ID, enrichment }) {
  const storedEnrichment = decisionMakerEnrichmentForStorage(enrichment);
  const result = await query(
    `UPDATE businesses
        SET custom_fields = jsonb_set(
              COALESCE(custom_fields, '{}'::jsonb),
              '{decision_maker}',
              $3::jsonb,
              true
            ),
            status = CASE
              WHEN status IN ('new', 'scraped', 'enrichment_pending') THEN 'enriched'::lead_status
              ELSE status
            END,
            updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [businessId, tenantId, storedEnrichment]
  );
  return result.rows[0] || null;
}

export async function createManualBusiness({
  tenantId = DEFAULT_TENANT_ID,
  extractionJobId,
  name,
  website,
  phone,
  phoneE164,
  address,
  city,
  niche,
  category,
  instagram,
  facebook,
  postalCode,
  scoringNotes,
  sourceUrl,
  customFields,
  rawPayload
}) {
  const result = await query(
    `INSERT INTO businesses
       (tenant_id, extraction_job_id, external_source, name, website, phone, phone_e164, address, city, postal_code,
        niche, category, instagram, facebook, scoring_notes, source_url, custom_fields, raw_payload, status)
     VALUES
       ($1, $2, 'manual_or_imported', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'new')
     RETURNING *`,
    [
      tenantId,
      extractionJobId || null,
      name,
      website || null,
      phone || null,
      phoneE164 || null,
      address || null,
      city || null,
      postalCode || null,
      niche || null,
      category || null,
      instagram || null,
      facebook || null,
      scoringNotes || null,
      sourceUrl || null,
      customFields || {},
      rawPayload || {}
    ]
  );
  return result.rows[0];
}

export async function updateBusinessAdsEnrichment({ businessId, tenantId, enrichment }) {
  const storedEnrichment = adsEnrichmentForStorage(enrichment);
  const checkedAt = storedEnrichment?.checkedAt ? new Date(storedEnrichment.checkedAt) : new Date();
  const classification = storedEnrichment?.classification || {};
  const classifiedAt = classification.checkedAt ? new Date(classification.checkedAt) : checkedAt;
  const metaEstimate = storedEnrichment?.meta?.spendEstimate || null;
  const estimateCheckedAt = metaEstimate?.checkedAt ? new Date(metaEstimate.checkedAt) : checkedAt;
  const result = await query(
    `UPDATE businesses
        SET ads_meta_active = $3,
            ads_google_active = $4,
            ads_last_checked_at = $5,
            ads_enrichment = $6,
            ads_funnel_type = $7,
            ads_funnel_confidence = $8,
            ads_funnel_landing_url = $9,
            ads_funnel_last_checked_at = $10,
            meta_ads_impressions_min = $11,
            meta_ads_impressions_max = $12,
            meta_ads_estimated_spend_min = $13,
            meta_ads_estimated_spend_max = $14,
            meta_ads_estimate_currency = $15,
            meta_ads_estimate_confidence = $16,
            meta_ads_estimate_source = $17,
            meta_ads_estimate_cpm = $18,
            meta_ads_estimate_checked_at = $19,
            status = CASE
              WHEN status IN ('new', 'scraped', 'enrichment_pending') THEN 'enriched'::lead_status
              ELSE status
            END,
            updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [
      businessId,
      tenantId,
      aiBackedAdsActiveForStorage(storedEnrichment?.meta),
      aiBackedAdsActiveForStorage(storedEnrichment?.google),
      checkedAt,
      storedEnrichment,
      classification.type || null,
      classification.confidence ?? null,
      classification.landingUrl || null,
      classifiedAt,
      metaEstimate?.impressionsMin ?? null,
      metaEstimate?.impressionsMax ?? null,
      metaEstimate?.estimatedSpendMin ?? null,
      metaEstimate?.estimatedSpendMax ?? null,
      metaEstimate?.currency || null,
      metaEstimate?.confidence ?? null,
      metaEstimate?.source || null,
      metaEstimate?.cpm ?? null,
      metaEstimate ? estimateCheckedAt : null
    ]
  );
  return result.rows[0] || null;
}

export async function updateBusinessScore({ businessId, score, tenantId, breakdown }) {
  const params = [businessId, score, breakdown || {}];
  if (tenantId) params.push(tenantId);
  const result = await query(
    `UPDATE businesses
        SET score = $2,
            scoring_breakdown = $3,
            updated_at = NOW()
      WHERE id = $1 ${tenantId ? "AND tenant_id = $4" : ""}
      RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

export async function updateBusinessScoringNotes({ businessId, tenantId, scoringNotes }) {
  const result = await query(
    `UPDATE businesses
        SET scoring_notes = $3, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [businessId, tenantId, scoringNotes || null]
  );
  return result.rows[0] || null;
}

export async function updateBusinessStatusForTenant({ businessId, tenantId, status }) {
  const result = await query(
    `UPDATE businesses SET status = $3::lead_status, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [businessId, tenantId, status]
  );
  return result.rows[0] || null;
}

export async function createVoiceCallFromDispatch({ business, nebrijaResponse }) {
  const providerCallId = nebrijaResponse?.id || nebrijaResponse?.callId;
  return withTransaction(async (client) => {
    const callResult = await client.query(
      `INSERT INTO voice_calls
         (tenant_id, business_id, provider, provider_call_id, assistant_id, phone_number_id, customer_number, status, raw_report)
       VALUES ($1, $2, 'nebrijaai', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider_call_id)
       DO UPDATE SET raw_report = voice_calls.raw_report || EXCLUDED.raw_report
       RETURNING *`,
      [
        business.tenant_id || DEFAULT_TENANT_ID,
        business.id,
        providerCallId || null,
        nebrijaResponse?.assistantId || business.assistant_id || null,
        nebrijaResponse?.phoneNumberId || null,
        business.phone_e164,
        nebrijaResponse?.status || "initiated",
        nebrijaResponse || {}
      ]
    );
    await client.query(
      `INSERT INTO outreach_attempts
         (tenant_id, business_id, channel, status, provider, provider_id, raw_payload)
       VALUES ($1, $2, 'voice', $3, 'nebrijaai', $4, $5)`,
      [business.tenant_id || DEFAULT_TENANT_ID, business.id, nebrijaResponse?.status || "initiated", providerCallId || null, nebrijaResponse || {}]
    );
    await client.query(`UPDATE businesses SET status = 'called', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`, [
      business.id,
      business.tenant_id || DEFAULT_TENANT_ID
    ]);
    return callResult.rows[0];
  });
}

export async function persistNebrijaWebhookEvent({ tenantId = DEFAULT_TENANT_ID, eventType, providerCallId, signatureValid, payload }) {
  const result = await query(
    `INSERT INTO webhook_events
       (tenant_id, provider, event_type, provider_call_id, signature_valid, payload)
     VALUES ($1, 'nebrijaai', $2, $3, $4, $5)
     RETURNING *`,
    [tenantId, eventType, providerCallId || null, signatureValid, payload]
  );
  return result.rows[0];
}

export async function upsertVoiceCallReport(report, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `INSERT INTO voice_calls
       (tenant_id, provider, provider_call_id, customer_number, status, started_at, ended_at, duration_seconds,
        cost, ended_reason, transcript, summary, outcome, qualified, recording_url, structured_data, raw_report)
     VALUES
       ($1, 'nebrijaai', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (provider_call_id)
     DO UPDATE SET
       customer_number = COALESCE(EXCLUDED.customer_number, voice_calls.customer_number),
       status = COALESCE(EXCLUDED.status, voice_calls.status),
       started_at = COALESCE(EXCLUDED.started_at, voice_calls.started_at),
       ended_at = COALESCE(EXCLUDED.ended_at, voice_calls.ended_at),
       duration_seconds = COALESCE(EXCLUDED.duration_seconds, voice_calls.duration_seconds),
       cost = COALESCE(EXCLUDED.cost, voice_calls.cost),
       ended_reason = COALESCE(EXCLUDED.ended_reason, voice_calls.ended_reason),
       transcript = COALESCE(EXCLUDED.transcript, voice_calls.transcript),
       summary = COALESCE(EXCLUDED.summary, voice_calls.summary),
       outcome = COALESCE(EXCLUDED.outcome, voice_calls.outcome),
       qualified = COALESCE(EXCLUDED.qualified, voice_calls.qualified),
       recording_url = COALESCE(EXCLUDED.recording_url, voice_calls.recording_url),
       structured_data = EXCLUDED.structured_data,
       raw_report = EXCLUDED.raw_report,
       updated_at = NOW()
     RETURNING *`,
    [
      tenantId,
      report.providerCallId,
      report.customerNumber,
      report.status,
      report.startedAt,
      report.endedAt,
      report.durationSeconds,
      report.cost,
      report.endedReason,
      report.transcript,
      report.summary,
      report.outcome,
      report.qualified,
      report.recordingUrl,
      report.structuredData || {},
      report.rawReport || {}
    ]
  );
  return result.rows[0];
}

export async function updateBusinessFromCallReport({ providerCallId, outcome, qualified }) {
  const status = qualified ? "qualified" : outcome === "callback" ? "callback" : "disqualified";
  const result = await query(
    `UPDATE businesses b
        SET status = $2::lead_status, updated_at = NOW()
       FROM voice_calls vc
      WHERE vc.provider_call_id = $1
        AND vc.business_id = b.id
      RETURNING b.*`,
    [providerCallId, status]
  );
  return result.rows[0] || null;
}

function stableBusinessKey(place) {
  return [place.name, place.address, place.latitude, place.longitude].filter(Boolean).join("|");
}

export async function listExtractionJobs({ tenantId = DEFAULT_TENANT_ID, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const result = await query(
    `SELECT j.*,
            (SELECT COUNT(*)::int FROM google_place_candidates c WHERE c.extraction_job_id = j.id) AS candidates_count,
            (SELECT COUNT(*)::int FROM businesses b
              WHERE b.tenant_id = j.tenant_id AND b.extraction_job_id = j.id) AS leads_count
       FROM extraction_jobs j
      WHERE j.tenant_id = $1
      ORDER BY j.created_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, safeLimit, safeOffset]
  );
  const totalRow = await query(`SELECT COUNT(*)::int AS total FROM extraction_jobs WHERE tenant_id = $1`, [tenantId]);
  return { rows: result.rows, total: totalRow.rows[0]?.total || 0 };
}

export async function getColdCallingAnalytics({
  tenantId = DEFAULT_TENANT_ID,
  scopeType = "all",
  scopeId,
  from,
  to
} = {}) {
  const where = ["ll.tenant_id = $1", "lm.first_contact_at IS NOT NULL"];
  const params = [tenantId];
  if (scopeType === "list" && scopeId) {
    params.push(scopeId);
    where.push(`lm.lead_list_id = $${params.length}`);
  } else if (scopeType === "campaign" && scopeId) {
    params.push(scopeId);
    where.push(`b.extraction_job_id = $${params.length}`);
  }
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
    params.push(from);
    where.push(`lm.first_contact_at >= $${params.length}::date`);
  }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    params.push(to);
    where.push(`lm.first_contact_at <= $${params.length}::date`);
  }
  const checkpoint = `NULLIF(CASE WHEN lm.checkpoint = 'Objeción' THEN 'Objeción inicial' ELSE lm.checkpoint END, '')`;
  const result = await query(
    `SELECT
        COUNT(*)::int AS total_calls,
        COUNT(*) FILTER (WHERE ${checkpoint} IS NOT NULL AND ${checkpoint} <> 'No lo coge')::int AS answered_calls,
        COUNT(*) FILTER (
          WHERE ${checkpoint} IS NOT NULL
            AND ${checkpoint} NOT IN ('No lo coge', 'Secretaria')
        )::int AS decision_maker_calls,
        COUNT(*) FILTER (WHERE ${checkpoint} IN ('Pitch', 'Agendado'))::int AS pitch_calls,
        COUNT(*) FILTER (
          WHERE ${checkpoint} = 'Agendado'
             OR lm.crm_status = 'Cita Concertada'
        )::int AS scheduled_calls,
        COUNT(*) FILTER (WHERE ${checkpoint} = 'Secretaria')::int AS secretary_calls,
        COUNT(*) FILTER (WHERE ${checkpoint} = 'No lo coge')::int AS no_answer_calls,
        COUNT(*) FILTER (WHERE ${checkpoint} = 'Objeción inicial')::int AS initial_objection_calls,
        COUNT(DISTINCT lm.lead_list_id)::int AS lists_count,
        COUNT(DISTINCT b.extraction_job_id) FILTER (WHERE b.extraction_job_id IS NOT NULL)::int AS campaigns_count,
        MIN(lm.first_contact_at) AS first_contact_from,
        MAX(lm.first_contact_at) AS first_contact_to
       FROM lead_list_members lm
       JOIN lead_lists ll ON ll.id = lm.lead_list_id
       JOIN businesses b ON b.id = lm.business_id AND b.tenant_id = ll.tenant_id
      WHERE ${where.join(" AND ")}`,
    params
  );
  const row = result.rows[0] || {};
  const total = Number(row.total_calls) || 0;
  const counts = {
    totalCalls: total,
    answeredCalls: Number(row.answered_calls) || 0,
    decisionMakerCalls: Number(row.decision_maker_calls) || 0,
    pitchCalls: Number(row.pitch_calls) || 0,
    scheduledCalls: Number(row.scheduled_calls) || 0,
    secretaryCalls: Number(row.secretary_calls) || 0,
    noAnswerCalls: Number(row.no_answer_calls) || 0,
    initialObjectionCalls: Number(row.initial_objection_calls) || 0
  };
  return {
    scope: { type: scopeType, id: scopeId || null },
    period: { from: from || null, to: to || null },
    counts,
    rates: {
      answeredRate: ratio(counts.answeredCalls, total),
      decisionMakerRate: ratio(counts.decisionMakerCalls, total),
      pitchRate: ratio(counts.pitchCalls, total),
      scheduledRate: ratio(counts.scheduledCalls, total)
    },
    meta: {
      listsCount: Number(row.lists_count) || 0,
      campaignsCount: Number(row.campaigns_count) || 0,
      firstContactFrom: row.first_contact_from || null,
      firstContactTo: row.first_contact_to || null
    },
    steps: [
      { key: "totalCalls", label: "Total llamadas", count: counts.totalCalls },
      { key: "answeredCalls", label: "Llamadas atendidas", count: counts.answeredCalls },
      { key: "decisionMakerCalls", label: "Atendidas por decisor", count: counts.decisionMakerCalls },
      { key: "pitchCalls", label: "Pitchs", count: counts.pitchCalls }
    ]
  };
}

function ratio(part, total) {
  return total > 0 ? Number(part || 0) / total : 0;
}

export async function findExtractionJobDetail(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const job = await query(`SELECT * FROM extraction_jobs WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!job.rows[0]) return null;
  const stats = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM google_place_candidates c WHERE c.extraction_job_id = $1) AS candidates_count,
        (SELECT COUNT(*)::int FROM businesses b
          WHERE b.tenant_id = $2 AND b.extraction_job_id = $1) AS leads_count`,
    [id, tenantId]
  );
  return { ...job.rows[0], ...stats.rows[0] };
}

export async function auditAdsCampaigns({
  tenantId = DEFAULT_TENANT_ID,
  search,
  city,
  limit = 10
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const params = [tenantId];
  const where = ["j.tenant_id = $1"];
  const patterns = searchPatterns(search);
  if (patterns.length) {
    params.push(patterns);
    where.push(`(
      lower(coalesce(j.niche, '')) LIKE ANY($${params.length}::text[])
      OR lower(coalesce(j.city, '')) LIKE ANY($${params.length}::text[])
      OR j.id::text LIKE ANY($${params.length}::text[])
    )`);
  }
  if (city) {
    params.push(`%${String(city).toLowerCase()}%`);
    where.push(`lower(coalesce(j.city, '')) LIKE $${params.length}`);
  }
  params.push(safeLimit);
  const result = await query(
    `SELECT j.id,
            j.niche,
            j.city,
            j.source_type,
            j.status,
            j.requested_limit,
            j.created_at,
            j.started_at,
            j.finished_at,
            j.metrics,
            COUNT(b.id)::int AS leads_count,
            COUNT(b.id) FILTER (WHERE b.ads_meta_active IS TRUE)::int AS meta_active_count,
            COUNT(b.id) FILTER (WHERE b.ads_google_active IS TRUE)::int AS google_active_count,
            COUNT(b.id) FILTER (WHERE b.ads_meta_active IS TRUE AND b.ads_google_active IS TRUE)::int AS both_active_count,
            COUNT(b.id) FILTER (WHERE b.ads_last_checked_at IS NOT NULL)::int AS ads_checked_count,
            MAX(b.ads_last_checked_at) AS last_ads_checked_at
       FROM extraction_jobs j
       LEFT JOIN businesses b ON b.extraction_job_id = j.id AND b.tenant_id = j.tenant_id
      WHERE ${where.join(" AND ")}
      GROUP BY j.id
      ORDER BY j.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function auditAdsCampaignLeads({
  tenantId = DEFAULT_TENANT_ID,
  campaignId,
  limit = 1200
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1200, 1), 5000);
  const result = await query(
    `SELECT b.id,
            b.name,
            b.website,
            b.city,
            b.niche,
            b.category,
            b.phone_e164,
            b.ads_meta_active,
            b.ads_google_active,
            b.ads_last_checked_at,
            b.ads_enrichment,
            b.ads_funnel_type,
            b.ads_funnel_confidence,
            b.ads_funnel_landing_url,
            b.created_at,
            b.updated_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'kind', c.kind,
                  'value', c.value,
                  'confidence', c.confidence,
                  'sourceUrl', c.source_url
                )
              ) FILTER (WHERE c.id IS NOT NULL),
              '[]'::json
            ) AS contacts
       FROM businesses b
       LEFT JOIN business_contacts c ON c.business_id = b.id
      WHERE b.tenant_id = $1
        AND b.extraction_job_id = $2
      GROUP BY b.id
      ORDER BY b.created_at ASC
      LIMIT $3`,
    [tenantId, campaignId, safeLimit]
  );
  return result.rows;
}

export async function listCampaignLeadsForExport({ tenantId = DEFAULT_TENANT_ID, campaignId }) {
  const result = await query(
    `SELECT b.id,
            b.place_id,
            b.external_source,
            b.name,
            b.category,
            b.phone,
            b.phone_e164,
            b.website,
            b.address,
            b.city,
            b.postal_code,
            b.latitude,
            b.longitude,
            b.rating,
            b.review_count,
            b.instagram,
            b.facebook,
            b.has_online_booking,
            b.has_chatbot,
            b.ads_meta_active,
            b.ads_google_active,
            b.ads_last_checked_at,
            b.ads_enrichment,
            b.ads_funnel_type,
            b.ads_funnel_confidence,
            b.ads_funnel_landing_url,
            b.ads_funnel_last_checked_at,
            b.score,
            b.scoring_notes,
            b.niche,
            b.status,
            b.source_url,
            b.custom_fields,
            b.created_at,
            b.updated_at,
            COALESCE(array_agg(DISTINCT c.value) FILTER (WHERE c.kind = 'email'), ARRAY[]::text[]) AS emails
       FROM businesses b
       LEFT JOIN business_contacts c ON c.business_id = b.id
      WHERE b.tenant_id = $1
        AND b.extraction_job_id = $2
      GROUP BY b.id
      ORDER BY b.score DESC, b.updated_at DESC`,
    [tenantId, campaignId]
  );
  return result.rows;
}

function searchPatterns(search) {
  const blocked = new Set(["empresas", "empresa", "para", "con", "los", "las", "del", "una", "unos", "unas"]);
  return [...new Set(String(search || "")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúüñ]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !blocked.has(token))
    .map((token) => `%${token}%`))];
}

export async function listBusinesses({
  tenantId = DEFAULT_TENANT_ID,
  limit = 50,
  offset = 0,
  status,
  niche,
  city,
  search,
  extractionJobId,
  extractionJobIds,
  listId,
  listIds,
  phoneType,
  adsActive,
  adsFunnelType,
  hasMetaAdsEstimate,
  metaAdsEstimateMin,
  metaAdsEstimateMax
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = ["b.tenant_id = $1"];
  const params = [tenantId];
  if (status) {
    params.push(status);
    where.push(`b.status = $${params.length}::lead_status`);
  }
  if (niche) {
    params.push(niche);
    where.push(`b.niche = $${params.length}`);
  }
  if (city) {
    params.push(city);
    where.push(`b.city = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(b.name ILIKE $${params.length} OR b.website ILIKE $${params.length} OR b.address ILIKE $${params.length})`);
  }
  if (extractionJobId) {
    params.push(extractionJobId);
    where.push(`b.extraction_job_id = $${params.length}`);
  }
  const campaignIds = Array.isArray(extractionJobIds)
    ? [...new Set(extractionJobIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  if (campaignIds.length) {
    params.push(campaignIds);
    where.push(`b.extraction_job_id = ANY($${params.length}::uuid[])`);
  }
  if (listId) {
    params.push(listId);
    where.push(`EXISTS (
      SELECT 1
        FROM lead_list_members lm
        JOIN lead_lists ll ON ll.id = lm.lead_list_id
       WHERE lm.business_id = b.id
         AND lm.lead_list_id = $${params.length}
         AND ll.tenant_id = b.tenant_id
    )`);
  }
  const selectedListIds = Array.isArray(listIds)
    ? [...new Set(listIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  if (selectedListIds.length) {
    params.push(selectedListIds);
    where.push(`EXISTS (
      SELECT 1
        FROM lead_list_members lm
        JOIN lead_lists ll ON ll.id = lm.lead_list_id
       WHERE lm.business_id = b.id
         AND lm.lead_list_id = ANY($${params.length}::uuid[])
         AND ll.tenant_id = b.tenant_id
    )`);
  }
  const phoneDigitsExpr = `regexp_replace(COALESCE(NULLIF(b.phone_e164, ''), NULLIF(b.phone, ''), ''), '[^0-9]', '', 'g')`;
  const localPhoneExpr = `(CASE
    WHEN ${phoneDigitsExpr} LIKE '0034%' THEN substring(${phoneDigitsExpr} from 5)
    WHEN ${phoneDigitsExpr} LIKE '34%' AND length(${phoneDigitsExpr}) = 11 THEN substring(${phoneDigitsExpr} from 3)
    ELSE ${phoneDigitsExpr}
  END)`;
  if (phoneType) {
    if (phoneType === "mobile") where.push(`${localPhoneExpr} ~ '^[67]'`);
    else if (phoneType === "fixed") where.push(`${localPhoneExpr} ~ '^[89]'`);
    else if (phoneType === "with_phone") where.push(`${localPhoneExpr} <> ''`);
    else if (phoneType === "without_phone") where.push(`${localPhoneExpr} = ''`);
    else if (phoneType === "unknown") where.push(`${localPhoneExpr} <> '' AND ${localPhoneExpr} !~ '^[6789]'`);
  }
  if (adsActive) {
    const platforms = String(adsActive)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (platforms.includes("both")) {
      // "Ambas a la vez" → must advertise on Meta AND Google
      where.push(`(b.ads_meta_active IS TRUE AND b.ads_google_active IS TRUE)`);
    } else {
      // multi-select: match leads active on ANY of the selected platforms (OR)
      const conditions = [];
      if (platforms.includes("any")) conditions.push(`(b.ads_meta_active IS TRUE OR b.ads_google_active IS TRUE)`);
      if (platforms.includes("meta")) conditions.push(`b.ads_meta_active IS TRUE`);
      if (platforms.includes("google")) conditions.push(`b.ads_google_active IS TRUE`);
      if (conditions.length) where.push(`(${conditions.join(" OR ")})`);
    }
  }
  if (adsFunnelType) {
    if (adsFunnelType === "not_ecommerce") {
      where.push(`COALESCE(b.ads_funnel_type, 'unknown') <> 'ecommerce'`);
    } else {
      params.push(adsFunnelType);
      where.push(`COALESCE(b.ads_funnel_type, 'unknown') = $${params.length}`);
    }
  }
  if (hasMetaAdsEstimate === "true" || hasMetaAdsEstimate === true) {
    where.push(`b.meta_ads_estimated_spend_max IS NOT NULL`);
  } else if (hasMetaAdsEstimate === "false" || hasMetaAdsEstimate === false) {
    where.push(`b.meta_ads_estimated_spend_max IS NULL`);
  }
  if (metaAdsEstimateMin !== undefined && metaAdsEstimateMin !== null && metaAdsEstimateMin !== "") {
    const value = Number(metaAdsEstimateMin);
    if (Number.isFinite(value)) {
      params.push(value);
      where.push(`b.meta_ads_estimated_spend_max >= $${params.length}`);
    }
  }
  if (metaAdsEstimateMax !== undefined && metaAdsEstimateMax !== null && metaAdsEstimateMax !== "") {
    const value = Number(metaAdsEstimateMax);
    if (Number.isFinite(value)) {
      params.push(value);
      where.push(`COALESCE(b.meta_ads_estimated_spend_min, b.meta_ads_estimated_spend_max) <= $${params.length}`);
    }
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(safeLimit);
  params.push(safeOffset);
  const result = await query(
    `SELECT b.id, b.name, b.niche, b.city, b.website, b.phone, b.phone_e164, b.status, b.score, b.scoring_notes,
            b.has_online_booking, b.has_chatbot, b.ads_meta_active, b.ads_google_active, b.ads_last_checked_at,
            b.ads_funnel_type, b.ads_funnel_confidence, b.ads_funnel_landing_url, b.ads_funnel_last_checked_at,
            b.meta_ads_impressions_min, b.meta_ads_impressions_max,
            b.meta_ads_estimated_spend_min, b.meta_ads_estimated_spend_max,
            b.meta_ads_estimate_currency, b.meta_ads_estimate_confidence,
            b.meta_ads_estimate_source, b.meta_ads_estimate_cpm, b.meta_ads_estimate_checked_at,
            b.custom_fields, b.extraction_job_id, b.created_at, b.updated_at,
            j.niche AS campaign_niche,
            j.city AS campaign_city,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', ll.id, 'name', ll.name, 'color', ll.color))
              FILTER (WHERE ll.id IS NOT NULL), '[]'::jsonb) AS lists
       FROM businesses b
       LEFT JOIN extraction_jobs j ON j.id = b.extraction_job_id AND j.tenant_id = b.tenant_id
       LEFT JOIN lead_list_members lm_all ON lm_all.business_id = b.id
       LEFT JOIN lead_lists ll ON ll.id = lm_all.lead_list_id AND ll.tenant_id = b.tenant_id
       ${whereClause}
      GROUP BY b.id, j.id, j.niche, j.city
      ORDER BY b.score DESC, b.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRow = await query(
    `SELECT COUNT(*)::int AS total FROM businesses b ${whereClause}`,
    params.slice(0, params.length - 2)
  );
  return { rows: result.rows, total: totalRow.rows[0]?.total || 0 };
}

export async function listBusinessIdsForCampaign({ tenantId = DEFAULT_TENANT_ID, campaignId, limit = 1000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const result = await query(
    `SELECT id
       FROM businesses
      WHERE tenant_id = $1 AND extraction_job_id = $2
      ORDER BY updated_at DESC
      LIMIT $3`,
    [tenantId, campaignId, safeLimit]
  );
  return result.rows.map((row) => row.id);
}

export async function listBusinessIdsForTenant({ tenantId = DEFAULT_TENANT_ID, limit = 5000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
  const result = await query(
    `SELECT id
       FROM businesses
      WHERE tenant_id = $1
      ORDER BY updated_at DESC
      LIMIT $2`,
    [tenantId, safeLimit]
  );
  return result.rows.map((row) => row.id);
}

export async function listLeadLists({ tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT ll.id, ll.name, ll.description, ll.color, ll.created_at, ll.updated_at,
            COUNT(lm.business_id)::int AS leads_count
       FROM lead_lists ll
       LEFT JOIN lead_list_members lm ON lm.lead_list_id = ll.id
      WHERE ll.tenant_id = $1
      GROUP BY ll.id
      ORDER BY ll.created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

export async function findLeadList(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT ll.id, ll.name, ll.description, ll.color, ll.created_at, ll.updated_at,
            COUNT(lm.business_id)::int AS leads_count
       FROM lead_lists ll
       LEFT JOIN lead_list_members lm ON lm.lead_list_id = ll.id
      WHERE ll.id = $1 AND ll.tenant_id = $2
      GROUP BY ll.id`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

export async function createLeadList({ tenantId = DEFAULT_TENANT_ID, name, description, color }) {
  const result = await query(
    `INSERT INTO lead_lists (tenant_id, name, description, color)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, name)
     DO UPDATE SET
       description = COALESCE(EXCLUDED.description, lead_lists.description),
       color = EXCLUDED.color,
       updated_at = NOW()
     RETURNING *`,
    [tenantId, String(name || "").trim(), description || null, normalizeListColor(color)]
  );
  return result.rows[0];
}

export async function updateLeadList({ tenantId = DEFAULT_TENANT_ID, id, name, description, color }) {
  const result = await query(
    `UPDATE lead_lists
        SET name = COALESCE($3, name),
            description = $4,
            color = COALESCE($5, color),
            updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId, name ? String(name).trim() : null, description || null, color ? normalizeListColor(color) : null]
  );
  return result.rows[0] || null;
}

export async function addBusinessToLeadList({ tenantId = DEFAULT_TENANT_ID, listId, businessId }) {
  return withTransaction(async (client) => {
    const list = await client.query(`SELECT id FROM lead_lists WHERE id = $1 AND tenant_id = $2`, [listId, tenantId]);
    if (!list.rows[0]) return null;
    const business = await client.query(`SELECT id FROM businesses WHERE id = $1 AND tenant_id = $2`, [businessId, tenantId]);
    if (!business.rows[0]) return null;
    const result = await client.query(
      `INSERT INTO lead_list_members (lead_list_id, business_id)
       VALUES ($1, $2)
       ON CONFLICT (lead_list_id, business_id)
       DO UPDATE SET added_at = lead_list_members.added_at
       RETURNING *`,
      [listId, businessId]
    );
    return result.rows[0];
  });
}

export async function removeBusinessFromLeadList({ tenantId = DEFAULT_TENANT_ID, listId, businessId }) {
  const result = await query(
    `DELETE FROM lead_list_members lm
      USING lead_lists ll, businesses b
      WHERE lm.lead_list_id = ll.id
        AND lm.business_id = b.id
        AND ll.id = $1
        AND b.id = $2
        AND ll.tenant_id = $3
        AND b.tenant_id = $3
      RETURNING lm.*`,
    [listId, businessId, tenantId]
  );
  return result.rows[0] || null;
}

const CRM_ROW_SELECT = `
  SELECT
    lm.lead_list_id,
    lm.business_id,
    lm.added_at,
    to_char(lm.first_contact_at, 'YYYY-MM-DD') AS first_contact_at,
    lm.decision_maker_name,
    lm.decision_maker_email,
    lm.answered_by,
    COALESCE(NULLIF(lm.crm_status, ''), 'Nuevo') AS crm_status,
    to_char(lm.follow_up_date, 'YYYY-MM-DD') AS follow_up_date,
    to_char(lm.follow_up_time, 'HH24:MI') AS follow_up_time,
    lm.next_action,
    lm.observations,
    CASE WHEN lm.checkpoint = 'Objeción' THEN 'Objeción inicial' ELSE lm.checkpoint END AS checkpoint,
    lm.objection,
    lm.crm_updated_at,
    b.id,
    b.name,
    b.website,
    b.phone,
    b.phone_e164,
    b.address,
    b.city,
    b.niche,
    b.category,
    b.status AS lead_status,
    b.score,
    b.ads_meta_active,
    b.ads_google_active,
    b.ads_funnel_type,
    b.ads_funnel_confidence,
    b.ads_funnel_landing_url,
    b.meta_ads_impressions_min,
    b.meta_ads_impressions_max,
    b.meta_ads_estimated_spend_min,
    b.meta_ads_estimated_spend_max,
    b.meta_ads_estimate_currency,
    b.meta_ads_estimate_confidence,
    b.meta_ads_estimate_source,
    b.meta_ads_estimate_cpm,
    b.meta_ads_estimate_checked_at,
    email_contact.value AS fallback_email
  FROM lead_list_members lm
  JOIN lead_lists ll ON ll.id = lm.lead_list_id
  JOIN businesses b ON b.id = lm.business_id AND b.tenant_id = ll.tenant_id
  LEFT JOIN LATERAL (
    SELECT c.value
      FROM business_contacts c
     WHERE c.business_id = b.id
       AND c.kind = 'email'
     ORDER BY c.confidence DESC, c.created_at DESC
     LIMIT 1
  ) email_contact ON TRUE
`;

export async function listLeadListCrmEntries({ tenantId = DEFAULT_TENANT_ID, listId }) {
  const result = await query(
    `${CRM_ROW_SELECT}
      WHERE ll.id = $1 AND ll.tenant_id = $2
      ORDER BY
        CASE WHEN COALESCE(NULLIF(lm.crm_status, ''), 'Nuevo') = 'Descartado' THEN 1 ELSE 0 END,
        lm.crm_updated_at DESC,
        lm.added_at DESC`,
    [listId, tenantId]
  );
  return result.rows;
}

export async function listCampaignCrmEntries({ tenantId = DEFAULT_TENANT_ID, campaignId }) {
  const result = await query(
    `SELECT
        lm.lead_list_id,
        b.id AS business_id,
        COALESCE(lm.added_at, b.created_at) AS added_at,
        to_char(lm.first_contact_at, 'YYYY-MM-DD') AS first_contact_at,
        lm.decision_maker_name,
        lm.decision_maker_email,
        lm.answered_by,
        COALESCE(NULLIF(lm.crm_status, ''), 'Nuevo') AS crm_status,
        to_char(lm.follow_up_date, 'YYYY-MM-DD') AS follow_up_date,
        to_char(lm.follow_up_time, 'HH24:MI') AS follow_up_time,
        lm.next_action,
        lm.observations,
        CASE WHEN lm.checkpoint = 'Objeción' THEN 'Objeción inicial' ELSE lm.checkpoint END AS checkpoint,
        lm.objection,
        lm.crm_updated_at,
        b.id,
        b.name,
        b.website,
        b.phone,
        b.phone_e164,
        b.address,
        b.city,
        b.niche,
        b.category,
        b.status AS lead_status,
        b.score,
        b.ads_meta_active,
        b.ads_google_active,
        b.ads_funnel_type,
        b.ads_funnel_confidence,
        b.ads_funnel_landing_url,
        b.meta_ads_impressions_min,
        b.meta_ads_impressions_max,
        b.meta_ads_estimated_spend_min,
        b.meta_ads_estimated_spend_max,
        b.meta_ads_estimate_currency,
        b.meta_ads_estimate_confidence,
        b.meta_ads_estimate_source,
        b.meta_ads_estimate_cpm,
        b.meta_ads_estimate_checked_at,
        email_contact.value AS fallback_email
       FROM businesses b
       LEFT JOIN LATERAL (
         SELECT lm.*
           FROM lead_list_members lm
           JOIN lead_lists ll ON ll.id = lm.lead_list_id
          WHERE lm.business_id = b.id
            AND ll.tenant_id = b.tenant_id
          ORDER BY lm.crm_updated_at DESC, lm.added_at DESC
          LIMIT 1
       ) lm ON TRUE
       LEFT JOIN LATERAL (
         SELECT c.value
           FROM business_contacts c
          WHERE c.business_id = b.id
            AND c.kind = 'email'
          ORDER BY c.confidence DESC, c.created_at DESC
          LIMIT 1
       ) email_contact ON TRUE
      WHERE b.tenant_id = $1
        AND b.extraction_job_id = $2
      ORDER BY
        CASE WHEN COALESCE(NULLIF(lm.crm_status, ''), 'Nuevo') = 'Descartado' THEN 1 ELSE 0 END,
        lm.crm_updated_at DESC NULLS LAST,
        b.updated_at DESC`,
    [tenantId, campaignId]
  );
  return result.rows;
}

export async function findLeadListCrmEntry({ tenantId = DEFAULT_TENANT_ID, listId, businessId }) {
  const result = await query(
    `${CRM_ROW_SELECT}
      WHERE ll.id = $1 AND ll.tenant_id = $2 AND b.id = $3`,
    [listId, tenantId, businessId]
  );
  return result.rows[0] || null;
}

export async function updateLeadListCrmEntry({ tenantId = DEFAULT_TENANT_ID, listId, businessId, patch }) {
  const allowed = {
    firstContactAt: ["first_contact_at", normalizeCrmDate],
    first_contact_at: ["first_contact_at", normalizeCrmDate],
    decisionMakerName: ["decision_maker_name", normalizeCrmText],
    decision_maker_name: ["decision_maker_name", normalizeCrmText],
    decisionMakerEmail: ["decision_maker_email", normalizeCrmText],
    decision_maker_email: ["decision_maker_email", normalizeCrmText],
    answeredBy: ["answered_by", normalizeCrmText],
    answered_by: ["answered_by", normalizeCrmText],
    crmStatus: ["crm_status", normalizeCrmStatus],
    crm_status: ["crm_status", normalizeCrmStatus],
    status: ["crm_status", normalizeCrmStatus],
    followUpDate: ["follow_up_date", normalizeCrmDate],
    follow_up_date: ["follow_up_date", normalizeCrmDate],
    followUpTime: ["follow_up_time", normalizeCrmTime],
    follow_up_time: ["follow_up_time", normalizeCrmTime],
    nextAction: ["next_action", normalizeCrmText],
    next_action: ["next_action", normalizeCrmText],
    observations: ["observations", normalizeCrmText],
    checkpoint: ["checkpoint", normalizeCrmCheckpoint],
    objection: ["objection", normalizeCrmText]
  };
  const sets = [];
  const values = [];
  const seenColumns = new Set();
  for (const [key, rawValue] of Object.entries(patch || {})) {
    const field = allowed[key];
    if (!field) continue;
    const [column, normalize] = field;
    if (seenColumns.has(column)) continue;
    seenColumns.add(column);
    values.push(normalize(rawValue));
    sets.push(`${column} = $${values.length + 3}`);
  }
  if (!sets.length) return findLeadListCrmEntry({ tenantId, listId, businessId });

  await query(
    `UPDATE lead_list_members lm
        SET ${sets.join(", ")},
            crm_updated_at = NOW()
       FROM lead_lists ll, businesses b
      WHERE lm.lead_list_id = ll.id
        AND lm.business_id = b.id
        AND ll.id = $1
        AND b.id = $2
        AND ll.tenant_id = $3
        AND b.tenant_id = $3`,
    [listId, businessId, tenantId, ...values]
  );
  return findLeadListCrmEntry({ tenantId, listId, businessId });
}

function normalizeCrmText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeCrmStatus(value) {
  return normalizeCrmText(value) || "Nuevo";
}

function normalizeCrmCheckpoint(value) {
  const text = normalizeCrmText(value);
  return text === "Objeción" ? "Objeción inicial" : text;
}

function normalizeCrmDate(value) {
  const text = normalizeCrmText(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeCrmTime(value) {
  const text = normalizeCrmText(value);
  if (!text) return null;
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function normalizeListColor(color) {
  const safe = String(color || "gold").trim().toLowerCase();
  return ["gold", "green", "cyan", "burgundy", "zinc"].includes(safe) ? safe : "gold";
}

export async function findBusinessDetail(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const business = await query(`SELECT * FROM businesses WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!business.rows[0]) return null;
  const [contacts, calls, crawlerRuns, lists] = await Promise.all([
    query(
      `SELECT id, kind, value, confidence, source_url, created_at
         FROM business_contacts WHERE business_id = $1
         ORDER BY confidence DESC, created_at DESC`,
      [id]
    ),
    query(
      `SELECT id, status, outcome, qualified, started_at, ended_at, duration_seconds, summary, recording_url, created_at
         FROM voice_calls WHERE business_id = $1
         ORDER BY created_at DESC LIMIT 25`,
      [id]
    ),
    query(
      `SELECT id, provider, status, root_url, pages_succeeded, pages_failed, started_at, finished_at, created_at
         FROM crawler_runs WHERE business_id = $1
         ORDER BY created_at DESC LIMIT 10`,
      [id]
    ),
    query(
      `SELECT ll.id, ll.name, ll.description, ll.color, lm.added_at
         FROM lead_list_members lm
         JOIN lead_lists ll ON ll.id = lm.lead_list_id
        WHERE lm.business_id = $1 AND ll.tenant_id = $2
        ORDER BY lm.added_at DESC`,
      [id, tenantId]
    )
  ]);
  return {
    business: business.rows[0],
    contacts: contacts.rows,
    calls: calls.rows,
    crawlerRuns: crawlerRuns.rows,
    lists: lists.rows
  };
}

export async function listVoiceCalls({ tenantId = DEFAULT_TENANT_ID, limit = 50, offset = 0, outcome, qualified } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = ["vc.tenant_id = $1"];
  const params = [tenantId];
  if (outcome) {
    params.push(outcome);
    where.push(`vc.outcome = $${params.length}`);
  }
  if (qualified === "true" || qualified === true) {
    where.push(`vc.qualified = TRUE`);
  } else if (qualified === "false" || qualified === false) {
    where.push(`vc.qualified = FALSE`);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(safeLimit);
  params.push(safeOffset);
  const result = await query(
    `SELECT vc.id, vc.provider_call_id, vc.status, vc.outcome, vc.qualified, vc.duration_seconds, vc.cost,
            vc.started_at, vc.ended_at, vc.summary, vc.recording_url, vc.created_at,
            b.id AS business_id, b.name AS business_name, b.city AS business_city, b.niche AS business_niche
       FROM voice_calls vc
       LEFT JOIN businesses b ON b.id = vc.business_id
       ${whereClause}
      ORDER BY vc.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRow = await query(
    `SELECT COUNT(*)::int AS total FROM voice_calls vc ${whereClause}`,
    params.slice(0, params.length - 2)
  );
  return { rows: result.rows, total: totalRow.rows[0]?.total || 0 };
}

export async function findVoiceCallDetail(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(
    `SELECT vc.*, b.id AS business_id, b.name AS business_name, b.city AS business_city,
            b.niche AS business_niche, b.website AS business_website
       FROM voice_calls vc
       LEFT JOIN businesses b ON b.id = vc.business_id
      WHERE vc.id = $1 AND vc.tenant_id = $2`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

export async function getDashboardMetrics({ tenantId = DEFAULT_TENANT_ID } = {}) {
  const result = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM businesses WHERE tenant_id = $1) AS total_leads,
      (SELECT COUNT(*)::int FROM businesses WHERE tenant_id = $1 AND status = 'qualified') AS qualified_leads,
      (SELECT COUNT(*)::int FROM businesses WHERE tenant_id = $1 AND status = 'called') AS called_leads,
      (SELECT COUNT(*)::int FROM businesses WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours') AS leads_last_24h,
      (SELECT COUNT(*)::int FROM extraction_jobs WHERE tenant_id = $1 AND status IN ('queued', 'running')) AS active_campaigns,
      (SELECT COUNT(*)::int FROM extraction_jobs WHERE tenant_id = $1) AS total_campaigns,
      (SELECT COUNT(*)::int FROM voice_calls WHERE tenant_id = $1) AS total_calls,
      (SELECT COUNT(*)::int FROM voice_calls WHERE tenant_id = $1 AND qualified = TRUE) AS qualified_calls,
      (SELECT COUNT(*)::int FROM voice_calls WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours') AS calls_last_24h,
      (SELECT COALESCE(SUM(cost), 0)::numeric FROM voice_calls WHERE tenant_id = $1) AS total_cost,
      (SELECT COALESCE(SUM(duration_seconds), 0)::int FROM voice_calls WHERE tenant_id = $1) AS total_duration_seconds
  `, [tenantId]);
  return result.rows[0];
}
