const DEFAULT_COUNTRY = "ES";

export async function enrichBusinessAds({ business, firecrawl, country = DEFAULT_COUNTRY, now = new Date() }) {
  if (!firecrawl) throw new Error("firecrawl_client_required");
  const meta = await inspectMetaAds({ business, firecrawl, country, now });
  const google = await inspectGoogleAds({ business, firecrawl, country, now });
  return {
    checkedAt: now.toISOString(),
    meta,
    google
  };
}

export function buildMetaAdsLibraryUrl({ query, country = DEFAULT_COUNTRY }) {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.searchParams.set("active_status", "active");
  url.searchParams.set("ad_type", "all");
  url.searchParams.set("country", country);
  url.searchParams.set("is_targeted_country", "false");
  url.searchParams.set("media_type", "all");
  url.searchParams.set("q", query);
  url.searchParams.set("search_type", "keyword_unordered");
  return url.toString();
}

export function buildGoogleAdsTransparencyUrl({ domain, country = DEFAULT_COUNTRY }) {
  const url = new URL("https://adstransparency.google.com/");
  url.searchParams.set("region", country);
  if (domain) url.searchParams.set("domain", domain);
  return url.toString();
}

export function inferAdsActivity({ provider, text, now = new Date(), sourceUrl }) {
  const normalized = normalizeText(text);
  const negative = [
    "no ads match",
    "no ads found",
    "no results",
    "currently not running ads",
    "is not currently running ads",
    "no esta publicando anuncios",
    "no está publicando anuncios",
    "sin anuncios",
    "no hay anuncios"
  ].some((phrase) => normalized.includes(normalizeText(phrase)));
  if (negative) return evidence({ provider, status: "inactive", active: false, confidence: 0.72, sourceUrl, reason: "negative_copy" });

  const recentDate = latestDateWithin(text, now, 45);
  const activePhrases = provider === "meta"
    ? [
        "active ads",
        "active ad",
        "currently running ads",
        "page is running ads",
        "anuncios activos",
        "anuncio activo",
        "biblioteca de anuncios"
      ]
    : [
        "last shown",
        "first shown",
        "total days shown",
        "ad creative",
        "details_link",
        "anuncio",
        "creative"
      ];
  const hasActiveCopy = activePhrases.some((phrase) => normalized.includes(normalizeText(phrase)));
  const hasCreativeId = /\bCR\d{8,}\b/.test(text);

  if (provider === "google" && (recentDate || hasCreativeId)) {
    return evidence({
      provider,
      status: "active",
      active: true,
      confidence: recentDate ? 0.84 : 0.68,
      sourceUrl,
      reason: recentDate ? "recent_last_shown_date" : "creative_id_found",
      latestDetectedDate: recentDate
    });
  }
  if (provider === "meta" && hasActiveCopy && !normalized.includes("0 results")) {
    return evidence({ provider, status: "active", active: true, confidence: 0.7, sourceUrl, reason: "active_ad_library_copy" });
  }
  if (hasActiveCopy) {
    return evidence({ provider, status: "unknown", active: null, confidence: 0.45, sourceUrl, reason: "generic_ad_library_copy" });
  }
  return evidence({ provider, status: "unknown", active: null, confidence: 0.2, sourceUrl, reason: "no_strong_signal" });
}

async function inspectMetaAds({ business, firecrawl, country, now }) {
  const query = adSearchQuery(business);
  const url = buildMetaAdsLibraryUrl({ query, country });
  try {
    const page = await firecrawl.scrape(url, {
      formats: ["markdown", "html"],
      onlyMainContent: false,
      waitFor: 5000
    });
    return inferAdsActivity({
      provider: "meta",
      text: pageText(page),
      now,
      sourceUrl: url
    });
  } catch (error) {
    return evidence({ provider: "meta", status: "error", active: null, confidence: 0, sourceUrl: url, error: error.message });
  }
}

async function inspectGoogleAds({ business, firecrawl, country, now }) {
  const domain = extractDomain(business.website);
  const primaryUrl = buildGoogleAdsTransparencyUrl({ domain, country });
  const candidates = [primaryUrl];

  try {
    if (domain) {
      const results = await firecrawl.search(`site:adstransparency.google.com/advertiser ${domain}`, { limit: 4 });
      for (const result of results) {
        if (result.url?.includes("adstransparency.google.com/advertiser/")) candidates.push(result.url);
      }
    }
  } catch {
    // Search is a fallback only; the direct Transparency Center scrape below still runs.
  }

  for (const url of unique(candidates)) {
    try {
      const page = await firecrawl.scrape(url, {
        formats: ["markdown", "html"],
        onlyMainContent: false,
        waitFor: 5000
      });
      const result = inferAdsActivity({
        provider: "google",
        text: pageText(page),
        now,
        sourceUrl: url
      });
      if (result.active || result.status === "inactive") return result;
    } catch (error) {
      if (url === candidates[candidates.length - 1]) {
        return evidence({ provider: "google", status: "error", active: null, confidence: 0, sourceUrl: url, error: error.message });
      }
    }
  }

  return evidence({ provider: "google", status: "unknown", active: null, confidence: 0.2, sourceUrl: primaryUrl, reason: "no_strong_signal" });
}

function evidence({ provider, status, active, confidence, sourceUrl, reason, latestDetectedDate, error }) {
  return {
    provider,
    status,
    active,
    confidence,
    sourceUrl,
    reason: reason || null,
    latestDetectedDate: latestDetectedDate || null,
    error: error || null
  };
}

function latestDateWithin(text, now, days) {
  const cutoff = now.getTime() - days * 86400_000;
  const matches = Array.from(String(text || "").matchAll(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g));
  const dates = matches
    .map((match) => new Date(`${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T00:00:00Z`))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  const latest = dates.find((date) => date.getTime() >= cutoff && date.getTime() <= now.getTime() + 86400_000);
  return latest ? latest.toISOString().slice(0, 10) : null;
}

function pageText(page) {
  return `${page?.markdown || ""}\n${page?.html || ""}\n${JSON.stringify(page?.raw || {})}`.slice(0, 250000);
}

function adSearchQuery(business) {
  return [business.name, business.city].filter(Boolean).join(" ") || extractDomain(business.website) || business.website || "";
}

function extractDomain(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value).startsWith("http") ? value : `https://${value}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return String(value).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}
