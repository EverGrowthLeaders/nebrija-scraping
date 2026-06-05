const DEFAULT_COUNTRY = "ES";

export async function enrichBusinessAds({ business, firecrawl, country = DEFAULT_COUNTRY, now = new Date() }) {
  if (!firecrawl) throw new Error("firecrawl_client_required");
  const socialDiscovery = await discoverSocialsForAds({ business, firecrawl });
  const enrichedBusiness = mergeDiscoveredSocials(business, socialDiscovery);
  const meta = await inspectMetaAds({ business: enrichedBusiness, firecrawl, country, now, socialDiscovery });
  const google = await inspectGoogleAds({ business, firecrawl, country, now });
  return {
    checkedAt: now.toISOString(),
    meta,
    google
  };
}

export function buildMetaAdsLibraryUrl({ query, country = DEFAULT_COUNTRY, searchType = "keyword_unordered" }) {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.searchParams.set("active_status", "active");
  url.searchParams.set("ad_type", "all");
  url.searchParams.set("country", country);
  url.searchParams.set("is_targeted_country", "false");
  url.searchParams.set("media_type", "all");
  url.searchParams.set("q", query);
  url.searchParams.set("search_type", searchType);
  return url.toString();
}

export function buildGoogleAdsTransparencyUrl({ domain, country = DEFAULT_COUNTRY }) {
  const url = new URL("https://adstransparency.google.com/");
  url.searchParams.set("region", country);
  if (domain) url.searchParams.set("domain", domain);
  return url.toString();
}

export function inferAdsActivity({ provider, text, now = new Date(), sourceUrl, context = {} }) {
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
  const hasMetaLibraryId = /\blibrary\s+id\s*[:#]?\s*\d{6,}\b/i.test(text) || /"ad_archive_id"\s*:\s*"?\d{6,}"?/i.test(text);
  const activePhrases = provider === "meta"
    ? [
        "active ads",
        "active ad",
        "currently running ads",
        "page is running ads",
        "this page is running ads",
        "this page is currently running ads",
        "anuncios activos",
        "anuncio activo",
        "esta publicando anuncios",
        "está publicando anuncios"
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
  if (provider === "meta" && (hasActiveCopy || hasMetaLibraryId) && !normalized.includes("0 results")) {
    return evidence({
      provider,
      status: "active",
      active: true,
      confidence: metaConfidence(context, hasMetaLibraryId ? 0.84 : 0.7),
      sourceUrl,
      reason: hasMetaLibraryId ? "meta_library_id_found" : "active_ad_library_copy",
      context
    });
  }
  if (hasActiveCopy) {
    return evidence({ provider, status: "unknown", active: null, confidence: 0.45, sourceUrl, reason: "generic_ad_library_copy" });
  }
  return evidence({ provider, status: "unknown", active: null, confidence: 0.2, sourceUrl, reason: "no_strong_signal" });
}

export async function discoverSocialsForAds({ business = {}, firecrawl }) {
  if (!firecrawl || !business.website) return null;
  try {
    const page = await firecrawl.scrape(business.website, {
      formats: ["markdown", "html", "links"],
      onlyMainContent: false,
      waitFor: 2500
    });
    const links = extractSocialLinks(page);
    if (!links.instagram && !links.facebook) return { status: "not_found", sourceUrl: business.website };
    return {
      status: "found",
      sourceUrl: business.website,
      instagram: links.instagram || null,
      facebook: links.facebook || null
    };
  } catch (error) {
    return {
      status: "error",
      sourceUrl: business.website,
      error: error.message
    };
  }
}

async function inspectMetaAds({ business, firecrawl, country, now, socialDiscovery }) {
  const probes = buildMetaAdProbes(business);
  const countries = unique([country, "ALL"]);
  const attempts = [];
  let fallback = null;

  for (const metaCountry of countries) {
    for (const probe of probes) {
      const context = { ...probe, country: metaCountry };
      const url = buildMetaAdsLibraryUrl({ query: probe.query, country: metaCountry, searchType: probe.searchType });
      try {
        const page = await firecrawl.scrape(url, {
          formats: ["markdown", "html"],
          onlyMainContent: false,
          waitFor: 5000
        });
        const result = inferAdsActivity({
          provider: "meta",
          text: pageText(page),
          now,
          sourceUrl: url,
          context
        });
        attempts.push(metaAttempt(context, result, url));
        fallback = betterMetaFallback(fallback, result);
        if (result.active === true) return withAttempts(result, attempts, socialDiscovery);
      } catch (error) {
        const result = evidence({
          provider: "meta",
          status: "error",
          active: null,
          confidence: 0,
          sourceUrl: url,
          error: error.message,
          context
        });
        attempts.push(metaAttempt(context, result, url));
        fallback = betterMetaFallback(fallback, result);
      }
    }
  }

  return withAttempts(
    fallback || evidence({ provider: "meta", status: "unknown", active: null, confidence: 0.2, reason: "no_meta_probe_matched" }),
    attempts,
    socialDiscovery
  );
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

export function buildMetaAdProbes(business = {}) {
  const probes = [];
  const domain = extractDomain(business.website);
  const rootDomain = rootDomainToken(domain);
  const facebook = firstValue(business.facebook, business.custom_fields?.facebook, business.custom_fields?.facebook_url, business.custom_fields?.fb);
  const instagram = firstValue(business.instagram, business.custom_fields?.instagram, business.custom_fields?.instagram_url, business.custom_fields?.ig);
  const facebookHandle = extractSocialHandle(facebook, "facebook");
  const instagramHandle = extractSocialHandle(instagram, "instagram");

  addProbe(probes, "website_domain", domain, "keyword_unordered", 0.84);
  addProbe(probes, "facebook_url", facebook, "keyword_unordered", 0.9);
  addProbe(probes, "facebook_handle", facebookHandle, "keyword_unordered", 0.88);
  addProbe(probes, "facebook_page", facebookHandle, "page", 0.88);
  addProbe(probes, "instagram_url", instagram, "keyword_unordered", 0.9);
  addProbe(probes, "instagram_handle", instagramHandle ? `@${instagramHandle}` : "", "keyword_unordered", 0.88);
  addProbe(probes, "instagram_account", instagramHandle, "keyword_unordered", 0.84);
  addProbe(probes, "business_name_city", adSearchQuery(business), "keyword_unordered", 0.68);
  addProbe(probes, "business_name", business.name, "keyword_unordered", 0.62);
  addProbe(probes, "website_brand", rootDomain, "keyword_unordered", 0.7);

  return uniqueProbes(probes);
}

function evidence({ provider, status, active, confidence, sourceUrl, reason, latestDetectedDate, error, context }) {
  return {
    provider,
    status,
    active,
    confidence,
    sourceUrl,
    reason: reason || null,
    latestDetectedDate: latestDetectedDate || null,
    error: error || null,
    strategy: context?.strategy || null,
    query: context?.query || null,
    searchType: context?.searchType || null,
    country: context?.country || null
  };
}

function metaConfidence(context, fallback) {
  return Math.max(fallback, Number(context?.confidence || 0));
}

function metaAttempt(probe, result, url) {
  return {
    strategy: probe.strategy,
    query: probe.query,
    searchType: probe.searchType,
    country: probe.country || null,
    status: result.status,
    active: result.active,
    confidence: result.confidence,
    reason: result.reason,
    sourceUrl: url
  };
}

function withAttempts(result, attempts, socialDiscovery) {
  return {
    ...result,
    socialDiscovery: socialDiscovery || null,
    attempts: attempts.slice(0, 20)
  };
}

function betterMetaFallback(current, next) {
  if (!current) return next;
  if (next.active === false && current.active !== false) return next;
  if ((next.confidence || 0) > (current.confidence || 0)) return next;
  return current;
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

function mergeDiscoveredSocials(business, socialDiscovery) {
  if (!socialDiscovery || socialDiscovery.status !== "found") return business;
  return {
    ...business,
    instagram: firstValue(business.instagram, business.custom_fields?.instagram, business.custom_fields?.instagram_url, socialDiscovery.instagram),
    facebook: firstValue(business.facebook, business.custom_fields?.facebook, business.custom_fields?.facebook_url, socialDiscovery.facebook)
  };
}

function extractSocialLinks(page) {
  const candidates = [
    ...(page?.links || []).map((link) => link.url),
    ...Array.from(pageText(page).matchAll(/https?:\/\/(?:www\.)?(?:instagram\.com|facebook\.com|fb\.com)\/[^"'\s<>)]+/gi)).map((match) => match[0])
  ];
  const socials = {};
  for (const value of candidates) {
    const clean = cleanSocialUrl(value);
    if (!clean) continue;
    const host = hostname(clean);
    if (!socials.instagram && host.endsWith("instagram.com")) socials.instagram = clean;
    if (!socials.facebook && (host.endsWith("facebook.com") || host.endsWith("fb.com"))) socials.facebook = clean;
  }
  return socials;
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

function cleanSocialUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value).trim());
    parsed.hash = "";
    const blockedParts = new Set([
      "accounts",
      "ads",
      "business",
      "connect",
      "dialog",
      "events",
      "explore",
      "intent",
      "login",
      "p",
      "permalink",
      "photos",
      "plugins",
      "posts",
      "privacy",
      "reel",
      "reels",
      "share.php",
      "sharer",
      "stories",
      "tr",
      "tr.php",
      "watch"
    ]);
    const parts = parsed.pathname.split("/").map((part) => part.trim()).filter(Boolean);
    if (!parts.length || blockedParts.has(parts[0].toLowerCase())) return "";
    parsed.pathname = `/${parts.slice(0, 2).join("/")}`;
    parsed.search = parsed.pathname === "/profile.php" ? parsed.search : "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
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

function addProbe(probes, strategy, query, searchType, confidence) {
  const cleaned = cleanQuery(query);
  if (!cleaned) return;
  probes.push({ strategy, query: cleaned, searchType, confidence });
}

function uniqueProbes(probes) {
  const seen = new Set();
  return probes.filter((probe) => {
    const key = `${probe.searchType}:${normalizeText(probe.query)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanQuery(value) {
  return String(value || "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .trim()
    .slice(0, 120);
}

function firstValue(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function extractSocialHandle(value, provider) {
  if (!value) return "";
  const raw = String(value).trim();
  if (raw.startsWith("@")) return sanitizeHandle(raw.slice(1));
  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = parsed.hostname.replace(/^www\./, "");
    const facebookHosts = ["facebook.com", "m.facebook.com", "fb.com"];
    const instagramHosts = ["instagram.com"];
    if (provider === "facebook" && !facebookHosts.some((item) => host.endsWith(item))) return sanitizeHandle(raw);
    if (provider === "instagram" && !instagramHosts.some((item) => host.endsWith(item))) return sanitizeHandle(raw);
    if (provider === "facebook" && parsed.pathname === "/profile.php") return sanitizeHandle(parsed.searchParams.get("id") || "");
    const parts = parsed.pathname.split("/").map((part) => part.trim()).filter(Boolean);
    const blocked = new Set(["ads", "business", "dialog", "events", "groups", "marketplace", "pages", "people", "plugins", "reel", "share", "stories"]);
    return sanitizeHandle(parts.find((part) => !blocked.has(part.toLowerCase())) || "");
  } catch {
    return sanitizeHandle(raw);
  }
}

function sanitizeHandle(value) {
  return String(value || "")
    .replace(/^@/, "")
    .replace(/[?#].*$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 80);
}

function rootDomainToken(domain) {
  if (!domain) return "";
  const parts = domain.split(".").filter(Boolean);
  if (parts.length <= 2) return parts[0] || "";
  return parts[parts.length - 2] || "";
}
