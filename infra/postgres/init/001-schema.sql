CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_status') THEN
    CREATE TYPE lead_status AS ENUM (
      'new',
      'scraped',
      'enrichment_pending',
      'enriched',
      'queued_for_call',
      'called',
      'connected',
      'qualified',
      'disqualified',
      'callback',
      'failed',
      'suppressed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM (
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id TEXT UNIQUE,
  external_source TEXT NOT NULL DEFAULT 'open_web_or_licensed_source',
  name TEXT NOT NULL,
  category TEXT,
  phone TEXT,
  phone_e164 TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  postal_code TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  rating DOUBLE PRECISION,
  review_count INTEGER,
  instagram TEXT,
  facebook TEXT,
  has_online_booking BOOLEAN DEFAULT FALSE,
  has_chatbot BOOLEAN DEFAULT FALSE,
  score INTEGER NOT NULL DEFAULT 0,
  niche TEXT,
  status lead_status NOT NULL DEFAULT 'new',
  source_url TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  source_url TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, kind, value)
);

CREATE TABLE IF NOT EXISTS extraction_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  niche TEXT NOT NULL,
  city TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'open_web',
  bbox JSONB,
  grid_step DOUBLE PRECISION,
  status job_status NOT NULL DEFAULT 'queued',
  requested_limit INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_place_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_job_id UUID REFERENCES extraction_jobs(id) ON DELETE SET NULL,
  place_id TEXT NOT NULL,
  query TEXT,
  city TEXT,
  niche TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (place_id, query)
);

CREATE TABLE IF NOT EXISTS data_provenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  source_record_id TEXT,
  observed_value TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crawler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  root_url TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  pages_requested INTEGER NOT NULL DEFAULT 0,
  pages_succeeded INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crawled_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crawler_run_id UUID NOT NULL REFERENCES crawler_runs(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  status_code INTEGER,
  content_hash TEXT,
  title TEXT,
  markdown TEXT,
  extracted JSONB NOT NULL DEFAULT '{}'::jsonb,
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (crawler_run_id, url)
);

CREATE TABLE IF NOT EXISTS outreach_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_id TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  response TEXT,
  notes TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS voice_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'nebrijaai',
  provider_call_id TEXT UNIQUE,
  assistant_id UUID,
  phone_number_id UUID,
  customer_number TEXT,
  status TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  cost NUMERIC(12, 6),
  ended_reason TEXT,
  transcript TEXT,
  summary TEXT,
  outcome TEXT,
  qualified BOOLEAN,
  recording_url TEXT,
  structured_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_event_id TEXT,
  provider_call_id TEXT,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  payload JSONB NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_place_id
  ON businesses(place_id)
  WHERE place_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_status_city_niche
  ON businesses(status, city, niche);

CREATE INDEX IF NOT EXISTS idx_businesses_score
  ON businesses(score DESC);

CREATE INDEX IF NOT EXISTS idx_business_contacts_lookup
  ON business_contacts(kind, value);

CREATE INDEX IF NOT EXISTS idx_voice_calls_provider_call_id
  ON voice_calls(provider_call_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_call_id
  ON webhook_events(provider, provider_call_id);

CREATE INDEX IF NOT EXISTS idx_google_place_candidates_expiry
  ON google_place_candidates(expires_at);

CREATE INDEX IF NOT EXISTS idx_data_provenance_business_field
  ON data_provenance(business_id, field_name);

CREATE INDEX IF NOT EXISTS idx_crawler_runs_business
  ON crawler_runs(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crawled_pages_business
  ON crawled_pages(business_id, scraped_at DESC);
