import { withTransaction } from "./db.mjs";

export async function ensureRuntimeSchema() {
  await withTransaction(async (client) => {
    const run = (statement, params) => client.query(statement, params);

    await run(`SELECT pg_advisory_xact_lock(hashtext('lexington_runtime_schema_v1'))`);
    await run(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await run(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      google_domain TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

    await run(`
    INSERT INTO tenants (id, name, slug, google_domain)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Default Workspace', 'default', NULL)
    ON CONFLICT (id) DO NOTHING
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'owner',
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, email)
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      ip_address TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS tenant_integrations (
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      api_base_url TEXT,
      api_key TEXT,
      api_key_last4 TEXT,
      default_phone_number_id TEXT,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, provider)
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS tenant_api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      key_last4 TEXT NOT NULL,
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `);

    const tenantTables = [
      "businesses",
      "extraction_jobs",
      "google_place_candidates",
      "crawler_runs",
      "crawled_pages",
      "outreach_attempts",
      "voice_calls",
      "webhook_events"
    ];

    for (const table of tenantTables) {
      await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id)`);
      await run(`UPDATE ${table} SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL`);
      await run(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001'`);
      await run(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`);
    }

    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS scoring_notes TEXT`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS extraction_job_id UUID REFERENCES extraction_jobs(id) ON DELETE SET NULL`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_meta_active BOOLEAN`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_google_active BOOLEAN`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_last_checked_at TIMESTAMPTZ`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_enrichment JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_funnel_type TEXT`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_funnel_confidence DOUBLE PRECISION`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_funnel_landing_url TEXT`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_funnel_last_checked_at TIMESTAMPTZ`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_impressions_min INTEGER`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_impressions_max INTEGER`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_estimated_spend_min NUMERIC`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_estimated_spend_max NUMERIC`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_estimate_currency TEXT`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_estimate_confidence DOUBLE PRECISION`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_estimate_source TEXT`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_estimate_cpm NUMERIC`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_ads_estimate_checked_at TIMESTAMPTZ`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS scoring_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_company JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_employee_count INTEGER`);
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin_company_checked_at TIMESTAMPTZ`);
    await run(`ALTER TABLE extraction_jobs ALTER COLUMN source_type SET DEFAULT 'google_places_api'`);
    await run(`ALTER TABLE extraction_jobs ADD COLUMN IF NOT EXISTS voice_assistant_id TEXT`);
    await run(`ALTER TABLE extraction_jobs ADD COLUMN IF NOT EXISTS voice_assistant_name TEXT`);
    await run(`ALTER TABLE extraction_jobs ADD COLUMN IF NOT EXISTS voice_phone_number_id TEXT`);
    await run(`ALTER TABLE extraction_jobs ADD COLUMN IF NOT EXISTS voice_variable_map JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await run(`ALTER TABLE extraction_jobs ADD COLUMN IF NOT EXISTS voice_assistant_variables JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await run(`ALTER TABLE voice_calls ALTER COLUMN assistant_id TYPE TEXT USING assistant_id::TEXT`);
    await run(`ALTER TABLE voice_calls ALTER COLUMN phone_number_id TYPE TEXT USING phone_number_id::TEXT`);

    await run(`
    CREATE TABLE IF NOT EXISTS tenant_scoring_rules (
      tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      rules JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS lead_lists (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL DEFAULT 'gold',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, name)
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS lead_list_members (
      lead_list_id UUID NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (lead_list_id, business_id)
    )
  `);

    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS first_contact_at DATE`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS decision_maker_name TEXT`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS decision_maker_email TEXT`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS answered_by TEXT`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS crm_status TEXT NOT NULL DEFAULT 'Nuevo'`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS follow_up_date DATE`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS follow_up_time TIME`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS next_action TEXT`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS observations TEXT`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS checkpoint TEXT`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS objection TEXT`);
    await run(`ALTER TABLE lead_list_members ADD COLUMN IF NOT EXISTS crm_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await run(`UPDATE lead_list_members SET checkpoint = 'Objeción inicial' WHERE checkpoint = 'Objeción'`);

    await run(`ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_place_id_key`);
    await run(`ALTER TABLE google_place_candidates DROP CONSTRAINT IF EXISTS google_place_candidates_place_id_query_key`);
    await run(`DROP INDEX IF EXISTS idx_businesses_place_id`);
    await run(`DROP INDEX IF EXISTS businesses_place_id_key`);
    await run(`DROP INDEX IF EXISTS google_place_candidates_place_id_query_key`);

    await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_tenant_place_id_unique
      ON businesses(tenant_id, place_id)
      WHERE place_id IS NOT NULL
  `);

    await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_google_candidates_tenant_place_query_unique
      ON google_place_candidates(tenant_id, place_id, query)
  `);

    await run(`CREATE INDEX IF NOT EXISTS idx_tenants_google_domain ON tenants(google_domain) WHERE google_domain IS NOT NULL`);
    await run(`CREATE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_tenant_integrations_provider ON tenant_integrations(provider)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_hash ON tenant_api_keys(key_hash) WHERE revoked_at IS NULL`);
    await run(`CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant_created ON tenant_api_keys(tenant_id, created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_lead_lists_tenant_created ON lead_lists(tenant_id, created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_lead_list_members_business ON lead_list_members(business_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_lead_list_members_first_contact ON lead_list_members(first_contact_at)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_extraction_job ON businesses(tenant_id, extraction_job_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_status_city_niche ON businesses(tenant_id, status, city, niche)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_score ON businesses(tenant_id, score DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_ads_checked ON businesses(tenant_id, ads_last_checked_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_ads_funnel ON businesses(tenant_id, ads_funnel_type, ads_funnel_last_checked_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_meta_ads_estimate ON businesses(tenant_id, meta_ads_estimated_spend_max DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_extraction_jobs_tenant_created ON extraction_jobs(tenant_id, created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_voice_calls_tenant_created ON voice_calls(tenant_id, created_at DESC)`);

    await run(`
      DELETE FROM business_contacts c
      USING (
        SELECT business_id, source_url
          FROM business_contacts
         WHERE kind = 'phone'
           AND source_url IS NOT NULL
           AND source_url NOT ILIKE '%google.%'
         GROUP BY business_id, source_url
        HAVING COUNT(*) > 20
      ) noisy
      WHERE c.business_id = noisy.business_id
        AND c.kind = 'phone'
        AND c.source_url IS NOT DISTINCT FROM noisy.source_url
    `);
  });
}
