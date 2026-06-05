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
    await run(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS scoring_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb`);
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
    await run(`CREATE INDEX IF NOT EXISTS idx_lead_lists_tenant_created ON lead_lists(tenant_id, created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_lead_list_members_business ON lead_list_members(business_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_extraction_job ON businesses(tenant_id, extraction_job_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_status_city_niche ON businesses(tenant_id, status, city, niche)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_score ON businesses(tenant_id, score DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_ads_checked ON businesses(tenant_id, ads_last_checked_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_businesses_tenant_ads_funnel ON businesses(tenant_id, ads_funnel_type, ads_funnel_last_checked_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_extraction_jobs_tenant_created ON extraction_jobs(tenant_id, created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_voice_calls_tenant_created ON voice_calls(tenant_id, created_at DESC)`);
  });
}
