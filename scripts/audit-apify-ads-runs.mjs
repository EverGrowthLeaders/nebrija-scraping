#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const token = args.token || process.env.APIFY_API_KEY;
const baseUrl = String(args["base-url"] || process.env.APIFY_BASE_URL || "https://api.apify.com/v2").replace(/\/+$/, "");
const actors = [
  {
    provider: "meta",
    actorId: args["facebook-actor-id"] || process.env.APIFY_FACEBOOK_ADS_ACTOR_ID || "curious_coder~facebook-ads-library-scraper"
  },
  {
    provider: "google",
    actorId: args["google-actor-id"] || process.env.APIFY_GOOGLE_ADS_ACTOR_ID || "solidcode~ads-transparency-scraper"
  }
].filter((actor) => !args.provider || args.provider === actor.provider);

if (!token) {
  console.error("Missing APIFY_API_KEY. Pass --token <token> or set APIFY_API_KEY.");
  process.exit(1);
}

const startedAfter = args["started-after"] || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const startedBefore = args["started-before"] || "";
const runLimit = clampInt(args.limit, 1000, 1, 1000);
const itemLimit = clampInt(args["item-limit"], 50, 1, 1000);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function apifyJson(path, search = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json"
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Apify HTTP ${response.status} for ${redact(url.toString())}: ${JSON.stringify(body)}`);
  return body;
}

function redact(value) {
  return String(value || "").replace(/([?&](?:token|api[-_]?key|authorization)=)[^&]+/gi, "$1[redacted]");
}

function encodeActorId(actorId) {
  return encodeURIComponent(actorId).replace(/%7E/gi, "~");
}

async function listRuns(actorId) {
  const all = [];
  let offset = 0;
  while (all.length < runLimit) {
    const page = await apifyJson(`/actors/${encodeActorId(actorId)}/runs`, {
      limit: Math.min(1000, runLimit - all.length),
      offset,
      desc: 1,
      status: "SUCCEEDED",
      startedAfter,
      startedBefore
    });
    const items = page?.data?.items || [];
    all.push(...items);
    if (!items.length || all.length >= (page?.data?.total || 0)) break;
    offset += items.length;
  }
  return all;
}

async function getInput(run) {
  if (!run.defaultKeyValueStoreId) return null;
  try {
    return await apifyJson(`/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`);
  } catch (error) {
    return { error: error.message };
  }
}

async function getDatasetItems(run) {
  if (!run.defaultDatasetId) return [];
  return await apifyJson(`/datasets/${run.defaultDatasetId}/items`, {
    clean: 1,
    format: "json",
    limit: itemLimit
  });
}

function runQuery(provider, input = {}) {
  if (provider === "google") return input.searchQuery || input.searchTerms?.[0] || "";
  const url = input.urls?.[0]?.url || "";
  if (url) {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get("q") || parsed.searchParams.get("page_id") || parsed.searchParams.get("view_all_page_id") || url;
    } catch {
      return url;
    }
  }
  return input.searchTerms?.[0] || "";
}

function itemStrings(item = {}) {
  const values = [];
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 30).forEach(visit);
      return;
    }
    if (typeof value === "object") {
      Object.values(value).slice(0, 50).forEach(visit);
    }
  };
  visit(item);
  return values;
}

function looksActive(provider, item = {}) {
  const text = itemStrings(item).join("\n").toLowerCase();
  if (provider === "google") {
    return /\b(last shown|first shown|creative|ad creative|cr\d{8,})\b/i.test(text);
  }
  return /\b(active|currently running|library id|ad_archive_id|ad archive)\b/i.test(text);
}

function summarizeItems(provider, items = []) {
  const activeItems = items.filter((item) => looksActive(provider, item));
  return {
    returned: items.length,
    activeLike: activeItems.length,
    samples: activeItems.slice(0, 5).map((item) => {
      const strings = itemStrings(item).filter((value) => value.length >= 4);
      return strings.slice(0, 12);
    })
  };
}

const output = {
  startedAfter,
  startedBefore: startedBefore || null,
  actors: []
};

for (const actor of actors) {
  const runs = await listRuns(actor.actorId);
  const actorOutput = {
    provider: actor.provider,
    actorId: actor.actorId,
    runs: []
  };
  for (const run of runs) {
    const input = await getInput(run);
    const items = await getDatasetItems(run);
    actorOutput.runs.push({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      usageTotalUsd: run.usageTotalUsd ?? null,
      defaultDatasetId: run.defaultDatasetId || null,
      defaultKeyValueStoreId: run.defaultKeyValueStoreId || null,
      query: runQuery(actor.provider, input),
      input,
      items: summarizeItems(actor.provider, Array.isArray(items) ? items : [])
    });
  }
  output.actors.push(actorOutput);
}

console.log(JSON.stringify(output, null, 2));
