import { classifyAdsLandingIntent, extractLandingUrlsFromText } from "./adsLandingClassifier.mjs";

const DEFAULT_COUNTRY = "ES";
const GOOGLE_RECENT_DAYS = 30;
const GOOGLE_RECENT_DATE_PRESET = "Últimos 30 días";
const DEFAULT_META_CPM_EUR = 8;
const META_CPM_BY_NICHE = [
  [/abogad|legal|jurid|bufete/i, 18],
  [/dental|clinica|clínica|salud|medic|estet/i, 12],
  [/inmobili|real estate|propiedad/i, 10],
  [/formacion|curso|academy|academia|educacion|educación/i, 9],
  [/ecommerce|tienda|moda|ropa|retail|shop/i, 7]
];

export async function enrichBusinessAds({ business, firecrawl, apify, country = DEFAULT_COUNTRY, now = new Date() }) {
  if (!firecrawl) throw new Error("firecrawl_client_required");
  const socialDiscovery = await discoverSocialsForAds({ business, firecrawl });
  const enrichedBusiness = mergeDiscoveredSocials(business, socialDiscovery);
  const firecrawlMeta = await inspectMetaAds({ business: enrichedBusiness, firecrawl, country, now, socialDiscovery });
  const meta = firecrawlMeta.active === true || !apify
    ? firecrawlMeta
    : mergeMetaResults(
        firecrawlMeta,
        await inspectMetaAdsWithApify({ business: enrichedBusiness, apify, country, now, socialDiscovery })
      );
  const google = await inspectGoogleAds({ business, firecrawl, country, now });
  const classification = await classifyAdsLandingIntent({
    business: enrichedBusiness,
    enrichment: { meta, google },
    firecrawl,
    now
  });
  return {
    checkedAt: now.toISOString(),
    meta,
    google,
    classification
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

export function buildGoogleAdsTransparencyUrl({ domain, country = DEFAULT_COUNTRY, datePreset = GOOGLE_RECENT_DATE_PRESET } = {}) {
  const url = new URL("https://adstransparency.google.com/");
  url.searchParams.set("region", country);
  if (domain) url.searchParams.set("domain", domain);
  if (datePreset) url.searchParams.set("preset-date", datePreset);
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
  if (negative) return evidence({ provider, status: "inactive", active: false, confidence: 0.72, sourceUrl, reason: "negative_copy", context });

  const recentDate = latestDateWithin(text, now, GOOGLE_RECENT_DAYS);
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
  const googleDomainAds = provider === "google" ? googleDomainAdsSignal({ text, context }) : null;

  if (provider === "google" && (recentDate || googleDomainAds?.matched)) {
    const identity = googleIdentityMatch({ text, context });
    if (!identity.matched) {
      return evidence({
        provider,
        status: "unknown",
        active: null,
        confidence: 0.32,
        sourceUrl,
        reason: "google_identity_not_matched",
        latestDetectedDate: recentDate,
        context: { ...context, matchedFields: identity.fields }
      });
    }
    if (!googleSourceIsVerified({ sourceUrl, identity, googleDomainAds })) {
      return evidence({
        provider,
        status: "unknown",
        active: null,
        confidence: 0.34,
        sourceUrl,
        reason: "google_search_source_not_verified",
        latestDetectedDate: recentDate,
        context: { ...context, matchedFields: identity.fields }
      });
    }
    return evidence({
      provider,
      status: "active",
      active: true,
      confidence: googleDomainAds?.matched
        ? Math.min(0.78, identity.confidence)
        : Math.min(recentDate ? 0.84 : 0.68, identity.confidence),
      sourceUrl,
      reason: googleDomainAds?.matched ? "google_domain_ads_found" : recentDate ? "recent_last_shown_date" : "creative_id_found",
      latestDetectedDate: recentDate,
      context: {
        ...context,
        matchedFields: identity.fields,
        itemsSeen: googleDomainAds?.count ?? context.itemsSeen
      }
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
    return evidence({ provider, status: "unknown", active: null, confidence: 0.45, sourceUrl, reason: "generic_ad_library_copy", context });
  }
  return evidence({ provider, status: "unknown", active: null, confidence: 0.2, sourceUrl, reason: "no_strong_signal", context });
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
      const context = { ...probe, country: metaCountry, sourceProvider: "firecrawl" };
      const url = buildMetaAdsLibraryUrl({ query: probe.query, country: metaCountry, searchType: probe.searchType });
      try {
      const page = await firecrawl.scrape(url, {
        formats: ["markdown", "html"],
        onlyMainContent: false,
        waitFor: 5000
      });
      const text = pageText(page);
      const landingUrls = extractLandingUrlsFromText(text, { business });
      const result = inferAdsActivity({
        provider: "meta",
        text,
        now,
        sourceUrl: url,
        context: { ...context, landingUrls }
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
  const attempts = [];

  try {
    if (domain) {
      const results = await firecrawl.search(`site:adstransparency.google.com/advertiser ${domain}`, { limit: 4 });
      for (const result of results) {
        if (result.url?.includes("adstransparency.google.com/advertiser/")) candidates.push(result.url);
      }
    }
  } catch (error) {
    attempts.push(adAttempt(
      { provider: "google", strategy: "search_transparency", query: domain, sourceProvider: "firecrawl" },
      evidence({
        provider: "google",
        status: "error",
        active: null,
        confidence: 0,
        error: error.message,
        context: { strategy: "search_transparency", query: domain, sourceProvider: "firecrawl" }
      }),
      null
    ));
  }

  for (const url of unique(candidates)) {
    const context = {
      strategy: url === primaryUrl ? "direct_transparency" : "search_transparency",
      query: domain,
      domain,
      businessName: business.name,
      country,
      datePreset: url === primaryUrl ? GOOGLE_RECENT_DATE_PRESET : null,
      sourceProvider: "firecrawl"
    };
    try {
      const page = await firecrawl.scrape(url, {
        formats: ["markdown", "html"],
        onlyMainContent: false,
        waitFor: 5000
      });
      const text = pageText(page);
      const landingUrls = extractLandingUrlsFromText(text, { business });
      const result = inferAdsActivity({
        provider: "google",
        text,
        now,
        sourceUrl: url,
        context: { ...context, landingUrls }
      });
      attempts.push(adAttempt(context, result, url));
      if (result.active || result.status === "inactive") return withAttempts(result, attempts);
    } catch (error) {
      const result = evidence({
        provider: "google",
        status: "error",
        active: null,
        confidence: 0,
        sourceUrl: url,
        error: error.message,
        context
      });
      attempts.push(adAttempt(context, result, url));
      if (url === candidates[candidates.length - 1]) {
        return withAttempts(result, attempts);
      }
    }
  }

  return withAttempts(
    evidence({
      provider: "google",
      status: "unknown",
      active: null,
      confidence: 0.2,
      sourceUrl: primaryUrl,
      reason: "no_strong_signal",
      context: { strategy: "direct_transparency", query: domain, country, sourceProvider: "firecrawl" }
    }),
    attempts
  );
}

async function inspectMetaAdsWithApify({ business, apify, country, now, socialDiscovery }) {
  const sources = buildApifyMetaSources(business, country);
  const attempts = [];
  let fallback = null;

  for (const source of sources) {
    const sourceWithActor = {
      ...source,
      actorId: apify.facebookAdsActorId || null
    };
    try {
      const items = await apify.runFacebookAdsLibrary(buildApifyMetaInput(sourceWithActor, apify));
      const analyzed = inferApifyMetaActivity({ items, business, source: sourceWithActor, now });
      attempts.push(apifyAttempt(sourceWithActor, analyzed, items));
      fallback = betterMetaFallback(fallback, analyzed);
      if (analyzed.active === true && hasLandingUrls(analyzed)) return withAttempts(analyzed, attempts, socialDiscovery);
    } catch (error) {
      const result = evidence({
        provider: "meta",
        status: "error",
        active: null,
        confidence: 0,
        sourceUrl: sourceWithActor.sourceUrl,
        reason: "apify_error",
        error: error.message,
        context: sourceWithActor
      });
      attempts.push(apifyAttempt(sourceWithActor, result, []));
      fallback = betterMetaFallback(fallback, result);
    }
  }

  return withAttempts(
    fallback ||
      evidence({
        provider: "meta",
        status: "unknown",
        active: null,
        confidence: 0.2,
        reason: "apify_no_sources",
        context: { sourceProvider: "apify" }
      }),
    attempts,
    socialDiscovery
  );
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
  const landingUrls = Array.isArray(context?.landingUrls) ? context.landingUrls.filter(Boolean).slice(0, 8) : [];
  const spendEstimate = normalizeMetaSpendEstimate(context?.spendEstimate);
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
    country: context?.country || null,
    sourceProvider: context?.sourceProvider || null,
    matchedFields: context?.matchedFields || null,
    itemsSeen: context?.itemsSeen ?? null,
    total: context?.total ?? null,
    samplePageName: context?.samplePageName || null,
    adArchiveId: context?.adArchiveId || null,
    actorId: context?.actorId || null,
    spendEstimate,
    landingUrl: landingUrls[0] || null,
    landingUrls
  };
}

function metaConfidence(context, fallback) {
  return Math.max(fallback, Number(context?.confidence || 0));
}

function metaAttempt(probe, result, url) {
  return adAttempt(probe, result, url);
}

function adAttempt(probe, result, url) {
  return {
    provider: result.provider,
    sourceProvider: probe.sourceProvider || result.sourceProvider || null,
    strategy: probe.strategy,
    query: probe.query,
    searchType: probe.searchType,
    country: probe.country || null,
    status: result.status,
    active: result.active,
    confidence: result.confidence,
    reason: result.reason,
    sourceUrl: url,
    itemsSeen: result.itemsSeen ?? null,
    total: result.total ?? null,
    samplePageName: result.samplePageName || null,
    matchedFields: result.matchedFields || null,
    adArchiveId: result.adArchiveId || null,
    actorId: result.actorId || probe.actorId || null,
    spendEstimate: result.spendEstimate || null,
    landingUrl: result.landingUrl || null,
    landingUrls: Array.isArray(result.landingUrls) ? result.landingUrls.slice(0, 8) : []
  };
}

function apifyAttempt(source, result, items) {
  return adAttempt(
    source,
    {
      ...result,
      itemsSeen: result.itemsSeen ?? items.length,
      total: result.total ?? apifyTotal(items),
      samplePageName: result.samplePageName || samplePageName(items[0]),
      matchedFields: result.matchedFields || null,
      adArchiveId: result.adArchiveId || null
    },
    result.sourceUrl || source.sourceUrl
  );
}

function withAttempts(result, attempts, socialDiscovery) {
  return {
    ...result,
    socialDiscovery: socialDiscovery || null,
    attempts: attempts.slice(0, 30)
  };
}

function mergeMetaResults(firecrawlMeta, apifyMeta) {
  const attempts = [...(firecrawlMeta?.attempts || []), ...(apifyMeta?.attempts || [])].slice(0, 30);
  if (apifyMeta?.active === true) {
    return {
      ...apifyMeta,
      attempts,
      socialDiscovery: firecrawlMeta?.socialDiscovery || apifyMeta.socialDiscovery || null,
      firecrawlStatus: firecrawlMeta?.status || null,
      firecrawlReason: firecrawlMeta?.reason || null
    };
  }
  if ((apifyMeta?.confidence || 0) > (firecrawlMeta?.confidence || 0)) {
    return {
      ...apifyMeta,
      attempts,
      socialDiscovery: firecrawlMeta?.socialDiscovery || apifyMeta.socialDiscovery || null
    };
  }
  return {
    ...firecrawlMeta,
    attempts,
    apifyStatus: apifyMeta?.status || null,
    apifyReason: apifyMeta?.reason || null
  };
}

function betterMetaFallback(current, next) {
  if (!current) return next;
  if (next.active === false && current.active !== false) return next;
  if ((next.confidence || 0) > (current.confidence || 0)) return next;
  return current;
}

function buildApifyMetaSources(business, country) {
  const sources = [];
  const domain = extractDomain(business.website);
  const facebook = firstValue(business.facebook, business.custom_fields?.facebook, business.custom_fields?.facebook_url, business.custom_fields?.fb);
  const instagram = firstValue(business.instagram, business.custom_fields?.instagram, business.custom_fields?.instagram_url, business.custom_fields?.ig);
  const facebookHandle = extractSocialHandle(facebook, "facebook");
  const instagramHandle = extractSocialHandle(instagram, "instagram");
  const metaCountry = country || DEFAULT_COUNTRY;

  if (instagramHandle) {
    addApifySource(sources, {
      strategy: "instagram_handle_apify",
      query: `@${instagramHandle}`,
      searchType: "keyword_unordered",
      country: "ALL",
      sourceUrl: buildMetaAdsLibraryUrl({ query: `@${instagramHandle}`, country: "ALL" }),
      confidence: 0.9
    });
  }
  if (domain) {
    addApifySource(sources, {
      strategy: "website_domain_apify",
      query: domain,
      searchType: "keyword_unordered",
      country: "ALL",
      sourceUrl: buildMetaAdsLibraryUrl({ query: domain, country: "ALL" }),
      confidence: 0.86
    });
  }
  if (facebook) {
    addApifySource(sources, {
      strategy: "facebook_page_apify",
      query: facebookHandle || facebook,
      searchType: "page",
      country: metaCountry,
      sourceUrl: buildMetaAdsLibraryUrl({ query: facebookHandle || facebook, country: metaCountry, searchType: "page" }),
      confidence: 0.92
    });
  }
  if (business.name) {
    addApifySource(sources, {
      strategy: "business_name_apify",
      query: business.name,
      searchType: "keyword_unordered",
      country: "ALL",
      sourceUrl: buildMetaAdsLibraryUrl({ query: business.name, country: "ALL" }),
      confidence: 0.68
    });
  }

  return sources.slice(0, 4);
}

function hasLandingUrls(result) {
  return Array.isArray(result?.landingUrls) && result.landingUrls.length > 0;
}

function addApifySource(sources, source) {
  if (!source.sourceUrl || sources.some((item) => item.sourceUrl === source.sourceUrl)) return;
  sources.push({ ...source, sourceProvider: "apify" });
}

function buildApifyMetaInput(source, apify) {
  const maxChargedResults = Math.max(10, Number(apify?.maxChargedResults || 10));
  return {
    urls: [{ url: source.sourceUrl }],
    limitPerSource: 1,
    count: maxChargedResults,
    scrapeAdDetails: true,
    "scrapePageAds.period": "",
    "scrapePageAds.activeStatus": "active",
    "scrapePageAds.sortBy": "most_recent",
    "scrapePageAds.countryCode": source.country || "ALL",
    runTag: "lexington-meta-active-check"
  };
}

function inferApifyMetaActivity({ items = [], business, source, now }) {
  const activeItems = items.filter((item) => item?.is_active === true || item?.is_active == null);
  const matchedItems = [];
  let bestMatch = null;
  for (const item of activeItems) {
    const match = matchApifyBusinessItem({ item, business });
    if (!match.matched) continue;
    matchedItems.push({ item, match });
    if (!bestMatch || match.confidence > bestMatch.match.confidence) bestMatch = { item, match };
  }
  if (bestMatch) {
    const latestDetectedDate = apifyItemDate(bestMatch.item, now);
    const landingUrls = collectApifyLandingUrls(bestMatch.item, business);
    const spendEstimate = estimateMetaSpendFromApifyItems({
      matchedItems,
      business,
      now
    });
    return evidence({
      provider: "meta",
      status: "active",
      active: true,
      confidence: Math.max(Number(source.confidence || 0), bestMatch.match.confidence),
      sourceUrl: bestMatch.item.ad_library_url || source.sourceUrl,
      reason: "apify_active_ad_matched",
      latestDetectedDate,
      context: {
        ...source,
        matchedFields: bestMatch.match.fields,
        itemsSeen: items.length,
        total: apifyTotal(items),
        matchedItems: matchedItems.length,
        samplePageName: samplePageName(bestMatch.item),
        adArchiveId: bestMatch.item.ad_archive_id || null,
        landingUrls,
        spendEstimate
      }
    });
  }

  return evidence({
    provider: "meta",
    status: "unknown",
    active: null,
    confidence: activeItems.length ? 0.35 : 0.2,
    sourceUrl: source.sourceUrl,
    reason: activeItems.length ? "apify_active_items_not_matched" : "apify_no_active_items",
    context: {
      ...source,
      itemsSeen: items.length,
      total: apifyTotal(items),
      samplePageName: samplePageName(items[0])
    }
  });
}

function googleIdentityMatch({ text, context = {} }) {
  const normalized = normalizeText(text);
  const domain = extractDomain(context.domain || context.query || context.business?.website);
  const rootDomain = rootDomainToken(domain);
  const businessName = context.businessName || context.business?.name;
  const landingUrls = Array.isArray(context.landingUrls) ? context.landingUrls : [];
  const fields = [];

  if (domain && normalized.includes(normalizeText(domain))) fields.push("domain");
  if (rootDomain && rootDomain.length >= 5 && normalized.includes(normalizeText(rootDomain))) fields.push("brand_domain");
  if (businessName && textIncludesBusinessName(normalized, businessName)) fields.push("business_name");
  if (domain && landingUrls.some((url) => extractDomain(url) === domain)) fields.push("landing_domain");

  const hasStrongDomain = fields.includes("domain") || fields.includes("landing_domain");
  const hasBusinessName = fields.includes("business_name");
  const confidence = hasStrongDomain && hasBusinessName
    ? 0.88
    : hasStrongDomain
      ? 0.78
      : hasBusinessName
        ? 0.72
        : 0;
  return {
    matched: hasStrongDomain || hasBusinessName,
    confidence,
    fields
  };
}

function matchApifyBusinessItem({ item, business }) {
  const fields = [];
  const domain = extractDomain(business.website);
  const facebook = firstValue(business.facebook, business.custom_fields?.facebook, business.custom_fields?.facebook_url, business.custom_fields?.fb);
  const instagram = firstValue(business.instagram, business.custom_fields?.instagram, business.custom_fields?.instagram_url, business.custom_fields?.ig);
  const facebookHandle = extractSocialHandle(facebook, "facebook");
  const instagramHandle = extractSocialHandle(instagram, "instagram");
  const pageName = samplePageName(item);
  const text = collectApifyItemStrings(item).join("\n");
  const normalized = normalizeText(text);

  if (domain && normalized.includes(normalizeText(domain))) fields.push("domain");
  if (business.name && strongNameMatch(pageName, business.name)) fields.push("page_name");
  if (instagramHandle && normalized.includes(normalizeText(`@${instagramHandle}`))) fields.push("instagram_handle");
  if (instagramHandle && normalized.includes(normalizeText(`instagram.com/${instagramHandle}`))) fields.push("instagram_url");
  if (facebookHandle && normalized.includes(normalizeText(facebookHandle))) fields.push("facebook_handle");

  const hasDomain = fields.includes("domain");
  const hasPageName = fields.includes("page_name");
  const hasSocial = fields.some((field) => field.endsWith("_handle") || field.endsWith("_url"));
  const confidence = hasDomain && hasPageName
    ? 0.96
    : hasDomain && hasSocial
      ? 0.94
      : hasPageName && hasSocial
        ? 0.93
        : hasSocial
          ? 0.88
          : hasPageName
            ? 0.72
          : hasDomain
              ? 0.62
              : 0;
  const matched = (hasDomain && (hasPageName || hasSocial)) || (hasPageName && hasSocial);

  return {
    matched,
    confidence,
    fields
  };
}

function googleSourceIsVerified({ sourceUrl, identity, googleDomainAds }) {
  const fields = identity?.fields || [];
  if (fields.includes("landing_domain")) return true;
  if (googleDomainAds?.matched) return true;
  return /adstransparency\.google\.com\/advertiser\//i.test(String(sourceUrl || ""));
}

function googleDomainAdsSignal({ text, context = {} }) {
  const normalized = normalizeText(text);
  const domain = extractDomain(context.domain || context.query || context.business?.website);
  if (!domain || !normalized.includes(normalizeText(domain))) return null;
  const hasRecentFilter = normalizeText(context.datePreset).includes(normalizeText(GOOGLE_RECENT_DATE_PRESET)) ||
    normalized.includes(normalizeText(GOOGLE_RECENT_DATE_PRESET));
  if (!hasRecentFilter) return null;
  const hasDomainResultsCopy = [
    "este dominio incluye resultados",
    "this domain includes results",
    "anuncios que se orientan a este dominio",
    "ads that target this domain"
  ].some((phrase) => normalized.includes(normalizeText(phrase)));
  if (!hasDomainResultsCopy) return null;
  const matches = Array.from(String(text || "").matchAll(/\b(\d{1,5})\s+(?:anuncios|ads)\b/gi));
  const count = matches
    .map((match) => Number(match[1]))
    .find((value) => Number.isFinite(value) && value > 0);
  return count ? { matched: true, count } : null;
}

function textIncludesBusinessName(normalizedText, businessName) {
  const tokens = significantTokens(businessName);
  if (!normalizedText || !tokens.length) return false;
  const required = tokens.length <= 2 ? tokens : tokens.slice(0, Math.min(tokens.length, 3));
  return required.every((token) => normalizedText.includes(token));
}

function collectApifyItemStrings(item = {}) {
  const snapshot = item.snapshot || {};
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  const body = typeof snapshot.body === "string" ? snapshot.body : snapshot.body?.text;
  return [
    item.page_name,
    item.ad_archive_id,
    item.ad_library_url,
    item.url,
    snapshot.page_name,
    snapshot.page_profile_uri,
    snapshot.caption,
    snapshot.cta_text,
    snapshot.link_url,
    snapshot.link_description,
    snapshot.title,
    body,
    ...cards.flatMap((card) => [
      card.body,
      card.caption,
      card.link_description,
      card.link_url,
      card.title,
      card.cta_text
    ])
  ].filter(Boolean).map((value) => String(value));
}

function collectApifyLandingUrls(item, business) {
  return extractLandingUrlsFromText(collectApifyItemStrings(item).join("\n"), { business }).slice(0, 8);
}

function estimateMetaSpendFromApifyItems({ matchedItems = [], business = {}, now = new Date() } = {}) {
  const ranges = matchedItems
    .map(({ item }) => parseApifyImpressions(item?.impressions_with_index?.impressions_text))
    .filter(Boolean);
  if (!ranges.length) return null;

  const impressionsMin = ranges.reduce((sum, range) => sum + range.min, 0);
  const impressionsMax = ranges.reduce((sum, range) => sum + range.max, 0);
  if (!Number.isFinite(impressionsMax) || impressionsMax <= 0) return null;

  const cpm = cpmForBusiness(business);
  const estimatedSpendMin = roundMoney((impressionsMin / 1000) * cpm);
  const estimatedSpendMax = roundMoney((impressionsMax / 1000) * cpm);
  const exactLikeRanges = ranges.filter((range) => range.precision === "range").length;
  const confidence = Math.min(0.72, 0.42 + matchedItems.length * 0.04 + exactLikeRanges * 0.03);
  return normalizeMetaSpendEstimate({
    status: "estimated",
    source: "public_impressions_cpm_benchmark",
    currency: "EUR",
    impressionsMin,
    impressionsMax,
    estimatedSpendMin,
    estimatedSpendMax: Math.max(estimatedSpendMin, estimatedSpendMax),
    cpm,
    confidence,
    matchedAds: matchedItems.length,
    adsWithImpressions: ranges.length,
    checkedAt: now.toISOString(),
    note: "Estimación por impresiones públicas de Meta Ads Library multiplicadas por CPM benchmark del nicho."
  });
}

function parseApifyImpressions(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[–—]/g, "-")
    .replace(/,/g, "")
    .replace(/\./g, "");
  if (!normalized) return null;
  const less = normalized.match(/^<(\d+(?:k|m)?)/i);
  if (less) {
    const max = parseCompactNumber(less[1]);
    return max ? { min: 0, max: Math.max(0, max - 1), precision: "upper_bound", raw } : null;
  }
  const plus = normalized.match(/^(\d+(?:k|m)?)\+$/i);
  if (plus) {
    const min = parseCompactNumber(plus[1]);
    return min ? { min, max: Math.round(min * 1.5), precision: "lower_bound", raw } : null;
  }
  const range = normalized.match(/^(\d+(?:k|m)?)-(\d+(?:k|m)?)$/i);
  if (range) {
    const min = parseCompactNumber(range[1]);
    const max = parseCompactNumber(range[2]);
    return min != null && max != null ? { min, max: Math.max(min, max), precision: "range", raw } : null;
  }
  const exact = parseCompactNumber(normalized);
  return exact != null ? { min: exact, max: exact, precision: "exact", raw } : null;
}

function parseCompactNumber(value) {
  const match = String(value || "").match(/^(\d+)(k|m)?$/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === "m") return base * 1_000_000;
  if (suffix === "k") return base * 1_000;
  return base;
}

function cpmForBusiness(business = {}) {
  const text = [business.niche, business.category, business.name].filter(Boolean).join(" ");
  for (const [pattern, cpm] of META_CPM_BY_NICHE) {
    if (pattern.test(text)) return cpm;
  }
  return DEFAULT_META_CPM_EUR;
}

function normalizeMetaSpendEstimate(value) {
  if (!value || typeof value !== "object") return null;
  const impressionsMax = Number(value.impressionsMax ?? value.impressions_max);
  const estimatedSpendMax = Number(value.estimatedSpendMax ?? value.estimated_spend_max);
  if (!Number.isFinite(impressionsMax) || impressionsMax <= 0 || !Number.isFinite(estimatedSpendMax)) return null;
  const estimatedSpendMin = Number(value.estimatedSpendMin ?? value.estimated_spend_min ?? 0);
  const impressionsMin = Number(value.impressionsMin ?? value.impressions_min ?? 0);
  return {
    status: value.status || "estimated",
    source: value.source || "public_impressions_cpm_benchmark",
    currency: value.currency || "EUR",
    impressionsMin: Math.max(0, Math.round(Number.isFinite(impressionsMin) ? impressionsMin : 0)),
    impressionsMax: Math.max(0, Math.round(impressionsMax)),
    estimatedSpendMin: roundMoney(Number.isFinite(estimatedSpendMin) ? estimatedSpendMin : 0),
    estimatedSpendMax: roundMoney(estimatedSpendMax),
    cpm: roundMoney(value.cpm ?? DEFAULT_META_CPM_EUR),
    confidence: roundConfidence(value.confidence ?? 0.45),
    matchedAds: Number(value.matchedAds || value.matched_ads || 0),
    adsWithImpressions: Number(value.adsWithImpressions || value.ads_with_impressions || 0),
    checkedAt: value.checkedAt || value.checked_at || null,
    note: value.note || null
  };
}

function roundMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function roundConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.45;
  return Math.max(0.1, Math.min(0.95, Math.round(number * 100) / 100));
}

function strongNameMatch(pageName, businessName) {
  const page = normalizeText(pageName);
  const tokens = significantTokens(businessName);
  if (!page || !tokens.length) return false;
  if (tokens.length === 1) return page === tokens[0] || page.split(" ").includes(tokens[0]);
  return tokens.every((token) => page.includes(token));
}

function significantTokens(value) {
  const blocked = new Set(["the", "and", "de", "del", "la", "las", "los", "el", "y", "sl", "sll", "sa"]);
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !blocked.has(token));
}

function apifyTotal(items = []) {
  const totals = items.map((item) => Number(item?.total)).filter((value) => Number.isFinite(value));
  return totals.length ? Math.max(...totals) : items.length;
}

function samplePageName(item = {}) {
  return item?.page_name || item?.snapshot?.page_name || null;
}

function apifyItemDate(item = {}, now) {
  const raw = item.start_date || item.end_date;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(number > 10_000_000_000 ? number : number * 1000);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > now.getTime() + 86400_000 * 2) return null;
  return date.toISOString().slice(0, 10);
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
      "sharer.php",
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
    const blocked = new Set([
      "ads",
      "business",
      "dialog",
      "events",
      "groups",
      "l.php",
      "login",
      "marketplace",
      "pages",
      "people",
      "plugins",
      "profile.php",
      "reel",
      "share",
      "share.php",
      "sharer",
      "sharer.php",
      "stories",
      "tr",
      "tr.php"
    ]);
    return sanitizeHandle(parts.find((part) => !blocked.has(part.toLowerCase())) || "");
  } catch {
    return sanitizeHandle(raw);
  }
}

function sanitizeHandle(value) {
  const cleaned = String(value || "")
    .replace(/^@/, "")
    .replace(/[?#].*$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 80);
  return isBlockedSocialHandle(cleaned) ? "" : cleaned;
}

function isBlockedSocialHandle(value) {
  const normalized = String(value || "").toLowerCase();
  return new Set([
    "ads",
    "business",
    "dialog",
    "events",
    "l.php",
    "login",
    "marketplace",
    "pages",
    "people",
    "plugins",
    "profile.php",
    "share",
    "share.php",
    "sharer",
    "sharer.php",
    "stories",
    "tr",
    "tr.php",
    "watch"
  ]).has(normalized);
}

function rootDomainToken(domain) {
  if (!domain) return "";
  const parts = domain.split(".").filter(Boolean);
  if (parts.length <= 2) return parts[0] || "";
  return parts[parts.length - 2] || "";
}
