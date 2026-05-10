import { query, withTransaction } from "./db.mjs";

export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

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

export async function createExtractionJob({ tenantId = DEFAULT_TENANT_ID, niche, city, sourceType, bbox, gridStep, requestedLimit }) {
  const result = await query(
    `INSERT INTO extraction_jobs (tenant_id, niche, city, source_type, bbox, grid_step, requested_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, niche, city, sourceType || "google_places_api", bbox || null, gridStep || null, requestedLimit || null]
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

export async function upsertBusinessFromGoogleCandidate({ tenantId = DEFAULT_TENANT_ID, place, city, niche, sourceUrl }) {
  const syntheticKey = place.placeId || stableBusinessKey(place);
  const status = place.website || place.phoneE164 ? "enriched" : "enrichment_pending";
  const result = await query(
    `INSERT INTO businesses
       (tenant_id, place_id, external_source, name, phone, phone_e164, website, address, city, niche,
        latitude, longitude, rating, review_count, source_url, raw_payload, status)
     VALUES ($1, $2, 'google_places_candidate', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::lead_status)
     ON CONFLICT (tenant_id, place_id) WHERE place_id IS NOT NULL
     DO UPDATE SET
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

export async function createManualBusiness({
  tenantId = DEFAULT_TENANT_ID,
  name,
  website,
  phone,
  phoneE164,
  address,
  city,
  niche,
  category,
  sourceUrl,
  rawPayload
}) {
  const result = await query(
    `INSERT INTO businesses
       (tenant_id, external_source, name, website, phone, phone_e164, address, city, niche, category, source_url, raw_payload, status)
     VALUES
       ($1, 'manual_or_imported', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'new')
     RETURNING *`,
    [
      tenantId,
      name,
      website || null,
      phone || null,
      phoneE164 || null,
      address || null,
      city || null,
      niche || null,
      category || null,
      sourceUrl || null,
      rawPayload || {}
    ]
  );
  return result.rows[0];
}

export async function updateBusinessScore({ businessId, score, tenantId }) {
  const params = [businessId, score];
  const tenantClause = tenantId ? `AND tenant_id = $3` : "";
  if (tenantId) params.push(tenantId);
  const result = await query(`UPDATE businesses SET score = $2, updated_at = NOW() WHERE id = $1 ${tenantClause} RETURNING *`, params);
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
              WHERE b.tenant_id = j.tenant_id AND b.niche = j.niche AND b.city = j.city AND b.updated_at >= j.created_at) AS leads_count
       FROM extraction_jobs j
      WHERE j.tenant_id = $1
      ORDER BY j.created_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, safeLimit, safeOffset]
  );
  const totalRow = await query(`SELECT COUNT(*)::int AS total FROM extraction_jobs WHERE tenant_id = $1`, [tenantId]);
  return { rows: result.rows, total: totalRow.rows[0]?.total || 0 };
}

export async function findExtractionJobDetail(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const job = await query(`SELECT * FROM extraction_jobs WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!job.rows[0]) return null;
  const stats = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM google_place_candidates c WHERE c.extraction_job_id = $1) AS candidates_count,
        (SELECT COUNT(*)::int FROM businesses b
          WHERE b.tenant_id = $2 AND b.niche = $3 AND b.city = $4 AND b.updated_at >= $5) AS leads_count`,
    [id, tenantId, job.rows[0].niche, job.rows[0].city, job.rows[0].created_at]
  );
  return { ...job.rows[0], ...stats.rows[0] };
}

export async function listBusinesses({ tenantId = DEFAULT_TENANT_ID, limit = 50, offset = 0, status, niche, city, search } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = ["tenant_id = $1"];
  const params = [tenantId];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}::lead_status`);
  }
  if (niche) {
    params.push(niche);
    where.push(`niche = $${params.length}`);
  }
  if (city) {
    params.push(city);
    where.push(`city = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(name ILIKE $${params.length} OR website ILIKE $${params.length} OR address ILIKE $${params.length})`);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(safeLimit);
  params.push(safeOffset);
  const result = await query(
    `SELECT id, name, niche, city, website, phone_e164, status, score, scoring_notes, has_online_booking, has_chatbot,
            created_at, updated_at
       FROM businesses
       ${whereClause}
      ORDER BY score DESC, updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRow = await query(
    `SELECT COUNT(*)::int AS total FROM businesses ${whereClause}`,
    params.slice(0, params.length - 2)
  );
  return { rows: result.rows, total: totalRow.rows[0]?.total || 0 };
}

export async function findBusinessDetail(id, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const business = await query(`SELECT * FROM businesses WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!business.rows[0]) return null;
  const [contacts, calls, crawlerRuns] = await Promise.all([
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
    )
  ]);
  return {
    business: business.rows[0],
    contacts: contacts.rows,
    calls: calls.rows,
    crawlerRuns: crawlerRuns.rows
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
