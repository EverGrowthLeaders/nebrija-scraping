import { parseApiKeys } from "./auth.mjs";

const intFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
};

const boolFromEnv = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const trimTrailingSlash = (value) => value.replace(/\/+$/, "");

export const config = {
  env: process.env.NODE_ENV || "development",
  server: {
    port: intFromEnv("PORT", 3000),
    publicBaseUrl: trimTrailingSlash(process.env.PUBLIC_BASE_URL || "http://localhost:3000")
  },
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://lexington:lexington_dev_password@localhost:5432/lexington",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  queues: {
    prefix: process.env.QUEUE_PREFIX || "lexington",
    concurrency: intFromEnv("WORKER_CONCURRENCY", 4),
    autoDispatchVoice: boolFromEnv("AUTO_DISPATCH_VOICE", false)
  },
  testJobs: {
    apiKeys: parseApiKeys(process.env.TEST_JOBS_API_KEYS || process.env.INTERNAL_API_KEYS)
  },
  crawler: {
    provider: process.env.CRAWLER_PROVIDER || "firecrawl",
    maxPagesPerBusiness: intFromEnv("CRAWLER_MAX_PAGES_PER_BUSINESS", 8),
    requestTimeoutMs: intFromEnv("CRAWLER_REQUEST_TIMEOUT_MS", 45000),
    respectRobots: boolFromEnv("CRAWLER_RESPECT_ROBOTS", true)
  },
  firecrawl: {
    baseUrl: trimTrailingSlash(process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev/v2"),
    apiKey: process.env.FIRECRAWL_API_KEY || "",
    originHeader: process.env.FIRECRAWL_ORIGIN_HEADER || ""
  },
  apify: {
    apiKey: process.env.APIFY_API_KEY || "",
    baseUrl: trimTrailingSlash(process.env.APIFY_BASE_URL || "https://api.apify.com/v2"),
    facebookAdsActorId:
      process.env.APIFY_FACEBOOK_ADS_ACTOR_ID || "curious_coder~facebook-ads-library-scraper",
    requestTimeoutMs: intFromEnv("APIFY_REQUEST_TIMEOUT_MS", 120000),
    runTimeoutSecs: intFromEnv("APIFY_RUN_TIMEOUT_SECS", 90),
    maxChargedResults: intFromEnv("APIFY_MAX_CHARGED_RESULTS", 10)
  },
  google: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    placesBaseUrl: trimTrailingSlash(
      process.env.GOOGLE_PLACES_BASE_URL || "https://places.googleapis.com/v1"
    ),
    defaultFieldMask:
      process.env.GOOGLE_PLACES_FIELD_MASK ||
      "places.id,places.displayName,places.formattedAddress,places.location"
  },
  auth: {
    googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    sessionCookieName: process.env.SESSION_COOKIE_NAME || "lex_session",
    sessionTtlDays: intFromEnv("SESSION_TTL_DAYS", 14)
  },
  nebrija: {
    apiBaseUrl: trimTrailingSlash(process.env.NEBRIJA_API_BASE_URL || "https://nebrijaai.com/api/v1"),
    apiKey: process.env.NEBRIJA_API_KEY || "",
    assistantId: process.env.NEBRIJA_ASSISTANT_ID || "",
    phoneNumberId: process.env.NEBRIJA_PHONE_NUMBER_ID || "",
    webhookSecret: process.env.NEBRIJA_WEBHOOK_SECRET || ""
  }
};

export function requireEnv(value, name) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
