import { query, withTransaction } from "./db.mjs";

export async function createExtractionJob({ niche, city, sourceType, bbox, gridStep, requestedLimit }) {
  const result = await query(
    `INSERT INTO extraction_jobs (niche, city, source_type, bbox, grid_step, requested_limit)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [niche, city, sourceType || "open_web", bbox || null, gridStep || null, requestedLimit || null]
  );
  return result.rows[0];
}

export async function findExtractionJob(id) {
  const result = await query(`SELECT * FROM extraction_jobs WHERE id = $1`, [id]);
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

export async function upsertGoogleCandidate({ extractionJobId, place, queryText, city, niche }) {
  const result = await query(
    `INSERT INTO google_place_candidates
       (extraction_job_id, place_id, query, city, niche, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (place_id, query)
     DO UPDATE SET raw_payload = EXCLUDED.raw_payload, expires_at = NOW() + INTERVAL '7 days'
     RETURNING *`,
    [extractionJobId, place.placeId, queryText, city, niche, place.raw || {}]
  );
  return result.rows[0];
}

export async function upsertBusinessFromGoogleCandidate({ place, city, niche, sourceUrl }) {
  const syntheticKey = place.placeId || stableBusinessKey(place);
  const result = await query(
    `INSERT INTO businesses
       (place_id, external_source, name, address, city, niche, latitude, longitude, source_url, raw_payload, status)
     VALUES ($1, 'google_places_candidate', $2, $3, $4, $5, $6, $7, $8, $9, 'scraped')
     ON CONFLICT (place_id)
     DO UPDATE SET
       name = COALESCE(EXCLUDED.name, businesses.name),
       address = COALESCE(EXCLUDED.address, businesses.address),
       city = COALESCE(EXCLUDED.city, businesses.city),
       niche = COALESCE(EXCLUDED.niche, businesses.niche),
       latitude = COALESCE(EXCLUDED.latitude, businesses.latitude),
       longitude = COALESCE(EXCLUDED.longitude, businesses.longitude),
       raw_payload = businesses.raw_payload || EXCLUDED.raw_payload,
       updated_at = NOW()
     RETURNING *`,
    [
      syntheticKey,
      place.name || "Unknown business",
      place.address || null,
      city || null,
      niche || null,
      place.latitude ?? null,
      place.longitude ?? null,
      sourceUrl || null,
      place.raw || {}
    ]
  );
  return result.rows[0];
}

export async function findBusinessById(id) {
  const result = await query(`SELECT * FROM businesses WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

export async function findCallableBusinessById(id) {
  const result = await query(
    `SELECT b.*,
            COUNT(c.id) FILTER (WHERE c.kind = 'email')::int AS email_count
       FROM businesses b
       LEFT JOIN business_contacts c ON c.business_id = b.id
      WHERE b.id = $1
      GROUP BY b.id`,
    [id]
  );
  return result.rows[0] || null;
}

export async function createCrawlerRun({ businessId, provider, rootUrl }) {
  const result = await query(
    `INSERT INTO crawler_runs (business_id, provider, root_url, status)
     VALUES ($1, $2, $3, 'queued')
     RETURNING *`,
    [businessId || null, provider, rootUrl]
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

export async function persistCrawledPage({ crawlerRunId, businessId, url, statusCode, contentHash, title, markdown, extracted }) {
  const result = await query(
    `INSERT INTO crawled_pages
       (crawler_run_id, business_id, url, status_code, content_hash, title, markdown, extracted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (crawler_run_id, url)
     DO UPDATE SET
       status_code = EXCLUDED.status_code,
       content_hash = EXCLUDED.content_hash,
       title = EXCLUDED.title,
       markdown = EXCLUDED.markdown,
       extracted = EXCLUDED.extracted,
       scraped_at = NOW()
     RETURNING *`,
    [crawlerRunId, businessId || null, url, statusCode || null, contentHash, title || null, markdown || "", extracted || {}]
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
       (external_source, name, website, phone, phone_e164, address, city, niche, category, source_url, raw_payload, status)
     VALUES
       ('manual_or_imported', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new')
     RETURNING *`,
    [
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

export async function updateBusinessScore({ businessId, score }) {
  const result = await query(`UPDATE businesses SET score = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [
    businessId,
    score
  ]);
  return result.rows[0] || null;
}

export async function createVoiceCallFromDispatch({ business, nebrijaResponse }) {
  const providerCallId = nebrijaResponse?.id || nebrijaResponse?.callId;
  return withTransaction(async (client) => {
    const callResult = await client.query(
      `INSERT INTO voice_calls
         (business_id, provider, provider_call_id, assistant_id, phone_number_id, customer_number, status, raw_report)
       VALUES ($1, 'nebrijaai', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider_call_id)
       DO UPDATE SET raw_report = voice_calls.raw_report || EXCLUDED.raw_report
       RETURNING *`,
      [
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
         (business_id, channel, status, provider, provider_id, raw_payload)
       VALUES ($1, 'voice', $2, 'nebrijaai', $3, $4)`,
      [business.id, nebrijaResponse?.status || "initiated", providerCallId || null, nebrijaResponse || {}]
    );
    await client.query(`UPDATE businesses SET status = 'called', updated_at = NOW() WHERE id = $1`, [business.id]);
    return callResult.rows[0];
  });
}

export async function persistNebrijaWebhookEvent({ eventType, providerCallId, signatureValid, payload }) {
  const result = await query(
    `INSERT INTO webhook_events
       (provider, event_type, provider_call_id, signature_valid, payload)
     VALUES ('nebrijaai', $1, $2, $3, $4)
     RETURNING *`,
    [eventType, providerCallId || null, signatureValid, payload]
  );
  return result.rows[0];
}

export async function upsertVoiceCallReport(report) {
  const result = await query(
    `INSERT INTO voice_calls
       (provider, provider_call_id, customer_number, status, started_at, ended_at, duration_seconds,
        cost, ended_reason, transcript, summary, outcome, qualified, recording_url, structured_data, raw_report)
     VALUES
       ('nebrijaai', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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

export async function listExtractionJobs({ limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const result = await query(
    `SELECT j.*,
            (SELECT COUNT(*)::int FROM google_place_candidates c WHERE c.extraction_job_id = j.id) AS candidates_count,
            (SELECT COUNT(*)::int FROM businesses b
              WHERE b.niche = j.niche AND b.city = j.city AND b.created_at >= j.created_at) AS leads_count
       FROM extraction_jobs j
      ORDER BY j.created_at DESC
      LIMIT $1 OFFSET $2`,
    [safeLimit, safeOffset]
  );
  const totalRow = await query(`SELECT COUNT(*)::int AS total FROM extraction_jobs`);
  return { rows: result.rows, total: totalRow.rows[0]?.total || 0 };
}

export async function findExtractionJobDetail(id) {
  const job = await query(`SELECT * FROM extraction_jobs WHERE id = $1`, [id]);
  if (!job.rows[0]) return null;
  const stats = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM google_place_candidates c WHERE c.extraction_job_id = $1) AS candidates_count,
        (SELECT COUNT(*)::int FROM businesses b
          WHERE b.niche = $2 AND b.city = $3 AND b.created_at >= $4) AS leads_count`,
    [id, job.rows[0].niche, job.rows[0].city, job.rows[0].created_at]
  );
  return { ...job.rows[0], ...stats.rows[0] };
}

export async function listBusinesses({ limit = 50, offset = 0, status, niche, city, search } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = [];
  const params = [];
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
    `SELECT id, name, niche, city, website, phone_e164, status, score, has_online_booking, has_chatbot,
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

export async function findBusinessDetail(id) {
  const business = await query(`SELECT * FROM businesses WHERE id = $1`, [id]);
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

export async function listVoiceCalls({ limit = 50, offset = 0, outcome, qualified } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = [];
  const params = [];
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

export async function findVoiceCallDetail(id) {
  const result = await query(
    `SELECT vc.*, b.id AS business_id, b.name AS business_name, b.city AS business_city,
            b.niche AS business_niche, b.website AS business_website
       FROM voice_calls vc
       LEFT JOIN businesses b ON b.id = vc.business_id
      WHERE vc.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function getDashboardMetrics() {
  const result = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM businesses) AS total_leads,
      (SELECT COUNT(*)::int FROM businesses WHERE status = 'qualified') AS qualified_leads,
      (SELECT COUNT(*)::int FROM businesses WHERE status = 'called') AS called_leads,
      (SELECT COUNT(*)::int FROM businesses WHERE created_at > NOW() - INTERVAL '24 hours') AS leads_last_24h,
      (SELECT COUNT(*)::int FROM extraction_jobs WHERE status IN ('queued', 'running')) AS active_campaigns,
      (SELECT COUNT(*)::int FROM extraction_jobs) AS total_campaigns,
      (SELECT COUNT(*)::int FROM voice_calls) AS total_calls,
      (SELECT COUNT(*)::int FROM voice_calls WHERE qualified = TRUE) AS qualified_calls,
      (SELECT COUNT(*)::int FROM voice_calls WHERE created_at > NOW() - INTERVAL '24 hours') AS calls_last_24h,
      (SELECT COALESCE(SUM(cost), 0)::numeric FROM voice_calls) AS total_cost,
      (SELECT COALESCE(SUM(duration_seconds), 0)::int FROM voice_calls) AS total_duration_seconds
  `);
  return result.rows[0];
}
