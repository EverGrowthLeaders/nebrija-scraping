import { classifyAdsLandingIntent, extractLandingUrlsFromText } from "./adsLandingClassifier.mjs";
import { estimateDeepseekUsageCost } from "./aiUsage.mjs";
import { config } from "./config.mjs";
import { postDeepInfraJson } from "./deepinfraClient.mjs";
import { jsonrepair } from "jsonrepair";

const DEFAULT_COUNTRY = "ES";
const GOOGLE_RECENT_DAYS = 30;
const GOOGLE_RECENT_DATE_PRESET = "Últimos 30 días";
const DEFAULT_META_CPM_EUR = 8;
const DEFAULT_MAX_AI_EVIDENCE_CHARS = 22000;
const ADS_ACTIVITY_PROVIDERS = ["meta", "google"];
const META_CPM_BY_NICHE = [
  [/abogad|legal|jurid|bufete/i, 18],
  [/dental|clinica|clínica|salud|medic|estet/i, 12],
  [/inmobili|real estate|propiedad/i, 10],
  [/formacion|curso|academy|academia|educacion|educación/i, 9],
  [/ecommerce|tienda|moda|ropa|retail|shop/i, 7]
];

export async function enrichBusinessAds({
  business,
  firecrawl,
  apify,
  country = DEFAULT_COUNTRY,
  now = new Date(),
  aiDiscoveryPlanner,
  aiResolver,
  aiVerifier,
  aiConfig = config.adsActivityAi,
  landingAiClassifier,
  landingAiConfig = config.adsFunnelAi,
  apifyFallbackMode = config.adsEnrichment?.apifyFallbackMode || "off"
}) {
  if (!firecrawl) throw new Error("firecrawl_client_required");
  const socialDiscovery = await discoverSocialsForAds({ business, firecrawl, aiConfig });
  const enrichedBusiness = mergeDiscoveredSocials(business, socialDiscovery);
  const discoveryPlan = await planAdsLibraryDiscovery({
    business: enrichedBusiness,
    country,
    socialDiscovery,
    aiDiscoveryPlanner,
    aiConfig,
    now
  });
  const requirePlannedEvidence = shouldRequireAiPlannedEvidence({ aiResolver, aiConfig });
  const shouldInspectAdsLibraries = !requirePlannedEvidence ||
    discoveryPlan?.ai?.status === "planned" ||
    discoveryPlan?.ai?.status === "seed";
  const restrictToAiPlannedTargets = requirePlannedEvidence && discoveryPlan?.ai?.status === "planned";
  const firecrawlMeta = shouldInspectAdsLibraries
    ? await inspectMetaAds({ business: enrichedBusiness, firecrawl, country, now, socialDiscovery, discoveryPlan, requirePlannedEvidence: restrictToAiPlannedTargets })
    : aiDiscoveryPlanRequiredProviderEvidence({ provider: "meta", business: enrichedBusiness, country, now, discoveryPlan, socialDiscovery });
  const firecrawlGoogle = shouldInspectAdsLibraries
    ? await inspectGoogleAds({ business: enrichedBusiness, firecrawl, country, now, discoveryPlan, requirePlannedEvidence: restrictToAiPlannedTargets })
    : aiDiscoveryPlanRequiredProviderEvidence({ provider: "google", business: enrichedBusiness, country, now, discoveryPlan });
  let resolved = await resolveAdsActivity({
    business: enrichedBusiness,
    providerEvidence: { meta: firecrawlMeta, google: firecrawlGoogle },
    aiResolver,
    aiVerifier,
    aiConfig,
    now,
    phase: "firecrawl"
  });

  if (shouldRunApifyAdsFallback({ resolved, apify, mode: apifyFallbackMode, aiResolver, aiConfig, discoveryPlan })) {
    const shouldCollectMetaApify = shouldCollectApifyProvider({ provider: "meta", resolved, mode: apifyFallbackMode }) &&
      typeof apify?.runFacebookAdsLibrary === "function";
    const shouldCollectGoogleApify = shouldCollectApifyProvider({ provider: "google", resolved, mode: apifyFallbackMode }) &&
      (apify?.googleFallbackEnabled === true || config.adsEnrichment?.apifyGoogleFallbackEnabled === true) &&
      typeof apify?.runGoogleAdsTransparency === "function";
    const apifyMeta = shouldCollectMetaApify
      ? await inspectMetaAdsWithApify({ business: enrichedBusiness, apify, country, now, socialDiscovery, discoveryPlan })
      : null;
    const apifyGoogle = shouldCollectGoogleApify
      ? await inspectGoogleAdsWithApify({ business: enrichedBusiness, apify, country, now })
      : null;
    resolved = await resolveAdsActivity({
      business: enrichedBusiness,
      providerEvidence: {
        meta: mergeProviderEvidence(firecrawlMeta, apifyMeta),
        google: mergeProviderEvidence(firecrawlGoogle, apifyGoogle)
      },
      aiResolver,
      aiVerifier,
      aiConfig,
      now,
      phase: "firecrawl_apify",
      previousResult: resolved
    });
  }

  const { meta, google } = resolved;
  const classification = await classifyAdsLandingIntent({
    business: enrichedBusiness,
    enrichment: { meta, google },
    firecrawl,
    aiClassifier: landingAiClassifier,
    aiConfig: landingAiConfig,
    now
  });
  return {
    checkedAt: now.toISOString(),
    discoveryPlan,
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

export async function discoverSocialsForAds({ business = {}, firecrawl, aiConfig = config.adsActivityAi }) {
  if (!firecrawl || (!business.website && !business.name)) return null;
  const candidates = [];
  let websiteStatus = null;
  try {
    if (business.website) {
      const page = await firecrawl.scrape(business.website, {
        formats: ["markdown", "html", "links"],
        onlyMainContent: false,
        waitFor: 2500
      });
      const links = extractSocialLinks(page);
      addSocialCandidate(candidates, links.facebook, "facebook", "website_link", business.website);
      addSocialCandidate(candidates, links.instagram, "instagram", "website_link", business.website);
      websiteStatus = "scraped";
    }
  } catch (error) {
    websiteStatus = "error";
    addSocialCandidate(candidates, business.facebook, "facebook", "business_field", business.website);
    addSocialCandidate(candidates, business.instagram, "instagram", "business_field", business.website);
  }

  if (!candidates.some((item) => item.provider === "facebook")) {
    await collectSocialSearchCandidates({ firecrawl, business, provider: "facebook", candidates });
  }

  const uniqueCandidates = uniqueSocialCandidates(candidates).slice(0, 16);
  if (!uniqueCandidates.length) {
    return { status: "not_found", sourceUrl: business.website || null, websiteStatus, candidates: [] };
  }

  if (!canUseAdsActivityAi({ aiConfig })) {
    const facebook = uniqueCandidates.find((item) => item.provider === "facebook")?.url || null;
    const instagram = uniqueCandidates.find((item) => item.provider === "instagram")?.url || null;
    return {
      status: facebook || instagram ? "found" : "not_found",
      sourceUrl: business.website || null,
      websiteStatus,
      facebook,
      instagram,
      candidates: uniqueCandidates,
      ai: { status: "skipped" }
    };
  }

  try {
    const resolved = await resolveSocialProfilesWithDeepInfra({ business, candidates: uniqueCandidates, aiConfig });
    return {
      status: resolved.facebook || resolved.instagram ? "found" : "not_found",
      sourceUrl: business.website || null,
      websiteStatus,
      facebook: resolved.facebook || null,
      instagram: resolved.instagram || null,
      candidates: uniqueCandidates,
      ai: {
        status: "resolved",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null,
        confidence: resolved.confidence ?? null,
        reason: resolved.reason || null,
        usage: resolved.usage || null
      }
    };
  } catch (error) {
    const facebook = uniqueCandidates.find((item) => item.provider === "facebook" && item.sourceType === "website_link")?.url || null;
    const instagram = uniqueCandidates.find((item) => item.provider === "instagram" && item.sourceType === "website_link")?.url || null;
    return {
      status: facebook || instagram ? "found" : "error",
      sourceUrl: business.website || null,
      websiteStatus,
      facebook,
      instagram,
      candidates: uniqueCandidates,
      ai: {
        status: "failed",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null,
        error: error.message
      }
    };
  }
}

async function collectSocialSearchCandidates({ firecrawl, business = {}, provider, candidates }) {
  if (!firecrawl || !business.name) return;
  const site = provider === "facebook" ? "facebook.com" : "instagram.com";
  const queries = [
    `site:${site} ${business.name} ${business.city || ""}`.trim(),
    `${business.name} ${business.city || ""} ${provider}`.trim()
  ];
  for (const query of unique(queries)) {
    try {
      const results = await firecrawl.search(query, { limit: 4 });
      for (const result of results) {
        addSocialCandidate(candidates, result.url, provider, "firecrawl_search", result.url, {
          title: result.title || null,
          description: result.description || null,
          query
        });
      }
    } catch {
      // Social search is opportunistic; DeepSeek will decide from whatever candidates were collected.
    }
  }
}

function addSocialCandidate(candidates, value, provider, sourceType, sourceUrl, extra = {}) {
  const url = cleanSocialUrl(value);
  if (!url) return;
  const host = hostname(url);
  if (provider === "facebook" && !(host.endsWith("facebook.com") || host.endsWith("fb.com"))) return;
  if (provider === "instagram" && !host.endsWith("instagram.com")) return;
  candidates.push({
    provider,
    url,
    sourceType,
    sourceUrl: sourceUrl || url,
    ...extra
  });
}

function uniqueSocialCandidates(candidates = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = `${candidate.provider}:${candidate.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

async function resolveSocialProfilesWithDeepInfra({ business = {}, candidates = [], aiConfig = config.adsActivityAi } = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You select official social profiles for a local business.",
          "Use only the supplied candidate URLs and business identifiers.",
          "Reject login, share, post, reel, group, marketplace, unrelated, directory, and ambiguous profiles.",
          "Return null when no candidate is clearly the official profile.",
          "Return only valid JSON."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            facebook: "official Facebook page URL from candidates or null",
            instagram: "official Instagram profile URL from candidates or null",
            confidence: "number 0..1",
            reason: "short snake_case reason"
          },
          business: compactObject({
            name: business.name,
            city: business.city,
            niche: business.niche || business.category,
            website: business.website,
            domain: extractDomain(business.website)
          }),
          candidates
        })
      }
    ]
  };
  let json;
  try {
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  }
  const parsed = parseAiJson(json?.choices?.[0]?.message?.content) || {};
  const candidateUrls = new Set(candidates.map((item) => item.url));
  return {
    facebook: candidateUrls.has(cleanSocialUrl(parsed.facebook)) ? cleanSocialUrl(parsed.facebook) : null,
    instagram: candidateUrls.has(cleanSocialUrl(parsed.instagram)) ? cleanSocialUrl(parsed.instagram) : null,
    confidence: clamp01(parsed.confidence),
    reason: String(parsed.reason || "").slice(0, 120),
    usage: json?.usage || null
  };
}

async function planAdsLibraryDiscovery({
  business = {},
  country = DEFAULT_COUNTRY,
  socialDiscovery,
  aiDiscoveryPlanner,
  aiConfig = config.adsActivityAi,
  now = new Date()
} = {}) {
  const seedPlan = buildSeedAdsDiscoveryPlan({ business, country, socialDiscovery, now });
  if (!canUseAdsActivityAi({ aiResolver: aiDiscoveryPlanner, aiConfig })) return seedPlan;

  try {
    const rawPlan = aiDiscoveryPlanner
      ? await aiDiscoveryPlanner({ business, country, socialDiscovery, seedPlan, aiConfig, now })
      : await planAdsDiscoveryWithDeepInfra({ business, country, socialDiscovery, seedPlan, aiConfig, now });
    return mergeAdsDiscoveryPlans(seedPlan, rawPlan, aiConfig);
  } catch (error) {
    return {
      ...seedPlan,
      ai: {
        status: "failed",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null,
        error: error.message
      }
    };
  }
}

function buildSeedAdsDiscoveryPlan({ business = {}, country = DEFAULT_COUNTRY, socialDiscovery, now = new Date() } = {}) {
  const domain = extractDomain(business.website);
  return {
    generatedAt: now.toISOString(),
    country,
    ai: {
      status: "seed",
      provider: null,
      model: null
    },
    socialDiscovery: socialDiscovery || null,
    metaProbes: buildMetaAdProbes(business).map((probe) => ({
      ...probe,
      country: probe.country || null,
      plannedBy: "seed",
      discoveryReason: "seed_business_identifier"
    })),
    metaUrls: [],
    googleSearchQueries: domain
      ? [{
          query: `site:adstransparency.google.com/advertiser ${domain}`,
          plannedBy: "seed",
          discoveryReason: "seed_domain_transparency_search"
        }]
      : [],
    googleUrls: domain
      ? [{
          url: buildGoogleAdsTransparencyUrl({ domain, country }),
          strategy: "direct_transparency",
          query: domain,
          plannedBy: "seed",
          discoveryReason: "seed_domain_transparency_url"
        }]
      : []
  };
}

async function planAdsDiscoveryWithDeepInfra({
  business = {},
  country = DEFAULT_COUNTRY,
  socialDiscovery,
  seedPlan,
  aiConfig = config.adsActivityAi
} = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 800,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You plan how Firecrawl should locate official Meta Ads Library and Google Ads Transparency evidence for a local business.",
          "Return only valid JSON. Do not include markdown.",
          "The whole response must be one JSON object with double-quoted keys and no trailing commas.",
          "Use business identifiers, domain, discovered Facebook/Instagram URLs, city and brand variants.",
          "Prefer precise probes that reduce false positives and avoid unnecessary scraping.",
          "Do not decide ad activity. Only propose search queries, Meta Library probes and official library URLs to collect evidence."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            metaProbes: [{
              query: "short Meta Ads Library query, page handle, domain, URL, or @instagram",
              searchType: "keyword_unordered|page",
              country: "country code or ALL or null",
              reason: "short snake_case reason"
            }],
            metaUrls: [{
              url: "https://www.facebook.com/ads/library/... or null",
              reason: "short snake_case reason"
            }],
            googleSearchQueries: [{
              query: "Firecrawl search query for adstransparency.google.com advertiser pages",
              reason: "short snake_case reason"
            }],
            googleUrls: [{
              url: "https://adstransparency.google.com/... or null",
              reason: "short snake_case reason"
            }]
          },
          evidence: {
            task: "ads_library_discovery_plan",
            business: compactObject({
              name: business.name,
              city: business.city,
              niche: business.niche || business.category,
              website: business.website,
              domain: extractDomain(business.website),
              instagram: business.instagram,
              facebook: business.facebook
            }),
            country,
            socialDiscovery: socialDiscovery || null,
            seedPlan: {
              metaProbes: seedPlan.metaProbes.slice(0, 10),
              googleSearchQueries: seedPlan.googleSearchQueries.slice(0, 4),
              googleUrls: seedPlan.googleUrls.slice(0, 4)
            },
            rules: [
              "Meta probes may use the domain, official Facebook page handle, official Instagram handle with @, business name with city, and brand token.",
              "Google queries should target site:adstransparency.google.com/advertiser plus exact domain, brand, or business name.",
              "Official URLs must be Meta Ads Library or Google Ads Transparency URLs only.",
              "When uncertain, add several precise probes instead of broad generic names."
            ]
          }
        })
      }
    ]
  };

  let json;
  try {
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  }
  const content = json?.choices?.[0]?.message?.content;
  const parsed = await parseAdsDiscoveryJsonOrRepair({ content, baseUrl, model, aiConfig });
  return {
    ...parsed.plan,
    usage: combineAiUsage(json?.usage, parsed.repairUsage)
  };
}

async function parseAdsDiscoveryJsonOrRepair({ content, baseUrl, model, aiConfig }) {
  try {
    return { plan: parseAiJson(content), repairUsage: null };
  } catch (error) {
    const repairBody = {
      model,
      temperature: 0,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Repair malformed JSON for an Ads Library discovery plan.",
            "Return only one valid JSON object with keys metaProbes, metaUrls, googleSearchQueries and googleUrls.",
            "Do not add explanations, markdown, trailing commas or comments."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            malformedJson: String(content || "").slice(0, 12000),
            parseError: error.message,
            outputSchema: {
              metaProbes: [{ query: "", searchType: "keyword_unordered|page", country: "ES|ALL|null", reason: "" }],
              metaUrls: [{ url: "", reason: "" }],
              googleSearchQueries: [{ query: "", reason: "" }],
              googleUrls: [{ url: "", reason: "" }]
            }
          })
        }
      ]
    };
    let repaired;
    try {
      repaired = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: repairBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
    } catch (repairError) {
      if (!/response_format|json_object|unsupported/i.test(repairError.message)) throw repairError;
      const fallbackRepairBody = { ...repairBody };
      delete fallbackRepairBody.response_format;
      repaired = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackRepairBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
    }
    return {
      plan: parseAiJson(repaired?.choices?.[0]?.message?.content),
      repairUsage: repaired?.usage || null
    };
  }
}

function combineAiUsage(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;
  return {
    prompt_tokens: Number(primary.prompt_tokens || 0) + Number(secondary.prompt_tokens || 0),
    completion_tokens: Number(primary.completion_tokens || 0) + Number(secondary.completion_tokens || 0),
    total_tokens: Number(primary.total_tokens || 0) + Number(secondary.total_tokens || 0),
    prompt_cache_hit_tokens: Number(primary.prompt_cache_hit_tokens || 0) + Number(secondary.prompt_cache_hit_tokens || 0),
    prompt_cache_miss_tokens: Number(primary.prompt_cache_miss_tokens || 0) + Number(secondary.prompt_cache_miss_tokens || 0)
  };
}

function mergeAdsDiscoveryPlans(seedPlan, rawPlan, aiConfig) {
  const normalized = normalizeAiAdsDiscoveryPlan(rawPlan);
  if (!normalized) {
    return {
      ...seedPlan,
      ai: {
        status: "invalid_response",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null
      }
    };
  }
  return {
    ...seedPlan,
    ai: {
      status: "planned",
      provider: aiConfig?.provider || "deepinfra",
      model: aiConfig?.model || null,
      usage: rawPlan?.usage || null,
      cost: estimateDeepseekUsageCost(rawPlan?.usage)
    },
    metaProbes: uniqueMetaDiscoveryProbes([
      ...normalized.metaProbes,
      ...seedPlan.metaProbes
    ]).slice(0, 16),
    metaUrls: uniqueDiscoveryUrls([
      ...normalized.metaUrls,
      ...seedPlan.metaUrls
    ]).slice(0, 8),
    googleSearchQueries: uniqueDiscoveryQueries([
      ...normalized.googleSearchQueries,
      ...seedPlan.googleSearchQueries
    ]).slice(0, 8),
    googleUrls: uniqueDiscoveryUrls([
      ...normalized.googleUrls,
      ...seedPlan.googleUrls
    ]).slice(0, 8)
  };
}

function normalizeAiAdsDiscoveryPlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") return null;
  return {
    metaProbes: normalizeMetaDiscoveryProbes(rawPlan.metaProbes || rawPlan.meta_probes, "ai"),
    metaUrls: normalizeDiscoveryUrlEntries(rawPlan.metaUrls || rawPlan.meta_urls, "meta", "ai"),
    googleSearchQueries: normalizeDiscoveryQueryEntries(rawPlan.googleSearchQueries || rawPlan.google_search_queries, "ai"),
    googleUrls: normalizeDiscoveryUrlEntries(rawPlan.googleUrls || rawPlan.google_urls, "google", "ai")
  };
}

function normalizeMetaDiscoveryProbes(value, plannedBy = "seed") {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const query = cleanQuery(typeof item === "string" ? item : item?.query);
      if (!query) return null;
      return {
        strategy: normalizeReason(item?.strategy || item?.reason) || `${plannedBy}_meta_probe`,
        query,
        searchType: normalizeMetaSearchType(item?.searchType || item?.search_type),
        country: normalizeCountryCode(item?.country),
        confidence: Number(item?.confidence) || (plannedBy === "ai" ? 0.86 : 0.7),
        plannedBy: item?.plannedBy || plannedBy,
        discoveryReason: normalizeReason(item?.reason) || `${plannedBy}_ads_discovery`
      };
    })
    .filter(Boolean);
}

function normalizeDiscoveryQueryEntries(value, plannedBy = "seed") {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const query = String(typeof item === "string" ? item : item?.query || "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (!query) return null;
      return {
        query,
        plannedBy: item?.plannedBy || plannedBy,
        discoveryReason: normalizeReason(item?.reason) || `${plannedBy}_ads_discovery`
      };
    })
    .filter(Boolean);
}

function normalizeDiscoveryUrlEntries(value, provider, plannedBy = "seed") {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const url = normalizeAdsLibraryUrl(typeof item === "string" ? item : item?.url, provider);
      if (!url) return null;
      return {
        url,
        strategy: normalizeReason(item?.strategy || item?.reason) || `${plannedBy}_${provider}_url`,
        query: typeof item === "object" ? cleanQuery(item?.query) : "",
        country: typeof item === "object" ? normalizeCountryCode(item?.country) : null,
        plannedBy: item?.plannedBy || plannedBy,
        discoveryReason: normalizeReason(item?.reason) || `${plannedBy}_ads_discovery`
      };
    })
    .filter(Boolean);
}

function buildMetaInspectionTargets({ probes = [], explicitUrls = [], country = DEFAULT_COUNTRY } = {}) {
  const targets = [];
  const seen = new Set();
  const add = ({ url, context }) => {
    const normalized = normalizeAdsLibraryUrl(url, "meta");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    targets.push({ url: normalized, context });
  };

  for (const entry of explicitUrls) {
    add({
      url: entry.url,
      context: {
        provider: "meta",
        strategy: entry.strategy || "ai_planned_meta_url",
        query: entry.query || "",
        searchType: null,
        country: entry.country || country,
        sourceProvider: "firecrawl",
        plannedBy: entry.plannedBy || "ai",
        discoveryReason: entry.discoveryReason || "ai_ads_discovery"
      }
    });
  }

  for (const probe of probes) {
    const countries = probe.country ? [probe.country] : unique([country, "ALL"]);
    for (const metaCountry of countries) {
      add({
        url: buildMetaAdsLibraryUrl({ query: probe.query, country: metaCountry, searchType: probe.searchType }),
        context: {
          ...probe,
          country: metaCountry,
          sourceProvider: "firecrawl",
          plannedBy: probe.plannedBy || "seed",
          discoveryReason: probe.discoveryReason || "seed_business_identifier"
        }
      });
    }
  }

  return targets;
}

async function inspectMetaAds({ business, firecrawl, country, now, socialDiscovery, discoveryPlan, requirePlannedEvidence = false }) {
  const discoveryProbes = normalizeMetaDiscoveryProbes(discoveryPlan?.metaProbes || [], "seed")
    .filter((probe) => !requirePlannedEvidence || probe.plannedBy === "ai");
  const seedProbes = requirePlannedEvidence
    ? []
    : buildMetaAdProbes(business).map((probe) => ({ ...probe, plannedBy: "seed", discoveryReason: "seed_business_identifier" }));
  const probes = uniqueMetaDiscoveryProbes([
    ...discoveryProbes,
    ...seedProbes
  ]);
  const explicitUrls = normalizeDiscoveryUrlEntries(discoveryPlan?.metaUrls || [], "meta", "ai")
    .filter((entry) => !requirePlannedEvidence || entry.plannedBy === "ai");
  const targets = buildMetaInspectionTargets({ probes, explicitUrls, country }).slice(0, 28);
  const attempts = [];
  let fallback = null;

  for (const target of targets) {
      const { url, context } = target;
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
          context: { ...context, landingUrls, evidenceSnippet: compactSnippet(text, 1400) }
        });
        attempts.push(metaAttempt(context, result, url));
        fallback = betterMetaFallback(fallback, result);
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

  return withAttempts(
    fallback || evidence({ provider: "meta", status: "unknown", active: null, confidence: 0.2, reason: "no_meta_probe_matched" }),
    attempts,
    socialDiscovery
  );
}

function aiDiscoveryPlanRequiredProviderEvidence({ provider, business = {}, country, now, discoveryPlan, socialDiscovery }) {
  const domain = extractDomain(business.website);
  const result = evidence({
    provider,
    status: "unknown",
    active: null,
    confidence: 0,
    sourceUrl: null,
    reason: "ai_discovery_plan_required",
    context: {
      strategy: "ai_discovery_plan_required",
      query: domain || business.name,
      domain,
      businessName: business.name,
      country,
      sourceProvider: "firecrawl",
      evidenceSnippet: `Ads Library collection skipped because DeepSeek discovery plan status was ${discoveryPlan?.ai?.status || "missing"}.`
    }
  });
  return withAttempts(result, [], provider === "meta" ? socialDiscovery : null);
}

async function inspectGoogleAds({ business, firecrawl, country, now, discoveryPlan, requirePlannedEvidence = false }) {
  const domain = extractDomain(business.website);
  const primaryUrl = domain ? buildGoogleAdsTransparencyUrl({ domain, country }) : null;
  const candidates = new Map();
  const addCandidate = (url, context = {}) => {
    const normalized = normalizeAdsLibraryUrl(url, "google");
    if (!normalized || candidates.has(normalized)) return;
    candidates.set(normalized, context);
  };
  if (domain && !requirePlannedEvidence) {
    addCandidate(primaryUrl, {
      strategy: "direct_transparency",
      query: domain,
      domain,
      businessName: business.name,
      country,
      datePreset: GOOGLE_RECENT_DATE_PRESET,
      sourceProvider: "firecrawl",
      plannedBy: "seed",
      discoveryReason: "seed_domain_transparency_url"
    });
  }
  for (const entry of normalizeDiscoveryUrlEntries(discoveryPlan?.googleUrls || [], "google", "ai")
    .filter((entry) => !requirePlannedEvidence || entry.plannedBy === "ai")) {
    addCandidate(entry.url, {
      strategy: entry.strategy || "ai_planned_google_url",
      query: entry.query || domain,
      domain,
      businessName: business.name,
      country: entry.country || country,
      datePreset: primaryUrl && entry.url === primaryUrl ? GOOGLE_RECENT_DATE_PRESET : null,
      sourceProvider: "firecrawl",
      plannedBy: entry.plannedBy || "ai",
      discoveryReason: entry.discoveryReason || "ai_ads_discovery"
    });
  }
  const attempts = [];
  let fallback = null;

  try {
    const searchQueries = uniqueDiscoveryQueries([
      ...normalizeDiscoveryQueryEntries(discoveryPlan?.googleSearchQueries || [], "ai")
        .filter((entry) => !requirePlannedEvidence || entry.plannedBy === "ai"),
      ...(domain && !requirePlannedEvidence ? [{ query: `site:adstransparency.google.com/advertiser ${domain}`, plannedBy: "seed", discoveryReason: "seed_domain_transparency_search" }] : [])
    ]).slice(0, 8);
    for (const search of searchQueries) {
      const results = await firecrawl.search(search.query, { limit: 4 });
      for (const result of results) {
        if (result.url?.includes("adstransparency.google.com/advertiser/")) {
          addCandidate(result.url, {
            strategy: "search_transparency",
            query: search.query,
            domain,
            businessName: business.name,
            country,
            datePreset: null,
            sourceProvider: "firecrawl",
            plannedBy: search.plannedBy,
            discoveryReason: search.discoveryReason
          });
        }
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

  for (const [url, plannedContext] of candidates) {
    const context = {
      strategy: plannedContext.strategy || (primaryUrl && url === primaryUrl ? "direct_transparency" : "search_transparency"),
      query: domain,
      domain,
      businessName: business.name,
      country,
      datePreset: primaryUrl && url === primaryUrl ? GOOGLE_RECENT_DATE_PRESET : null,
      sourceProvider: "firecrawl",
      ...plannedContext
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
        context: { ...context, landingUrls, evidenceSnippet: compactSnippet(text, 1400) }
      });
      attempts.push(adAttempt(context, result, url));
      fallback = betterMetaFallback(fallback, result);
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
      fallback = betterMetaFallback(fallback, result);
    }
  }

  return withAttempts(
    fallback || evidence({
        provider: "google",
        status: "unknown",
        active: null,
        confidence: 0.2,
        sourceUrl: primaryUrl,
        reason: domain ? "no_strong_signal" : "no_google_domain_or_ai_candidate",
        context: {
          strategy: domain ? "direct_transparency" : "ai_discovery_required",
          query: domain || business.name,
          domain,
          businessName: business.name,
          country,
          sourceProvider: "firecrawl"
        }
      }),
    attempts
  );
}

async function inspectGoogleAdsWithApify({ business, apify, country, now }) {
  const domain = extractDomain(business.website);
  const primaryUrl = buildGoogleAdsTransparencyUrl({ domain, country });
  const attempts = [];
  const apifyAvailable = apify?.enabled !== false && typeof apify?.runGoogleAdsTransparency === "function";
  if (!apifyAvailable || !domain) {
    return withAttempts(
      evidence({
        provider: "google",
        status: "unknown",
        active: null,
        confidence: 0.2,
        sourceUrl: primaryUrl,
        reason: "apify_google_unavailable",
        context: { strategy: "domain_apify", query: domain, domain, businessName: business.name, country, sourceProvider: "apify" }
      }),
      attempts
    );
  }

  try {
    const input = buildApifyGoogleInput({ domain, country, apify });
    const items = await apify.runGoogleAdsTransparency(input);
    const apifyResult = inferApifyGoogleActivity({ items, business, domain, country, now });
    attempts.push(adAttempt(
      {
        provider: "google",
        strategy: "domain_apify",
        query: domain,
        domain,
        businessName: business.name,
        country,
        sourceProvider: "apify",
        actorId: apify.googleAdsActorId || null,
        datePreset: GOOGLE_RECENT_DATE_PRESET
      },
      apifyResult,
      apifyResult.sourceUrl || primaryUrl
    ));
    return withAttempts(apifyResult, attempts);
  } catch (error) {
    const quotaExceeded = isExternalQuotaError(error);
    const result = evidence({
      provider: "google",
      status: "error",
      active: null,
      confidence: 0,
      sourceUrl: primaryUrl,
      reason: quotaExceeded ? "apify_google_quota_exceeded" : "apify_google_error",
      error: externalErrorMessage(error),
      context: {
        strategy: "domain_apify",
        query: domain,
        domain,
        businessName: business.name,
        country,
        sourceProvider: "apify",
        actorId: apify.googleAdsActorId || null
      }
    });
    attempts.push(adAttempt(
      {
        provider: "google",
        strategy: "domain_apify",
        query: domain,
        domain,
        businessName: business.name,
        country,
        sourceProvider: "apify",
        actorId: apify.googleAdsActorId || null,
        datePreset: GOOGLE_RECENT_DATE_PRESET
      },
      result,
      primaryUrl
    ));
    return withAttempts(result, attempts);
  }
}

function buildApifyGoogleInput({ domain, country, apify }) {
  const maxResults = Math.min(10, Math.max(1, Number(apify?.maxChargedResults || 3)));
  if (isSolidcodeGoogleAdsActor(apify?.googleAdsActorId)) {
    return {
      searchQuery: domain,
      maxResults
    };
  }
  return {
    searchTerms: [domain],
    region: country,
    resultsLimit: Math.min(3, maxResults),
    skipDetails: true
  };
}

function isSolidcodeGoogleAdsActor(actorId) {
  return /solidcode~ads-transparency-scraper/i.test(String(actorId || ""));
}

function isCrawlerbrosFacebookAdsActor(actorId) {
  return /crawlerbros~facebook-ads-library-scraper/i.test(String(actorId || ""));
}

function inferApifyGoogleActivity({ items = [], business = {}, domain, country, now }) {
  const evidenceSnippet = compactSnippet(items.map((item) => collectApifyGoogleItemStrings(item).join("\n")).join("\n---\n"), 1800);
  const recentItems = items
    .filter((item) => apifyGoogleItemMatchesDomain(item, domain))
    .filter((item) => apifyGoogleDateWithin(item?.lastShown || item?.last_shown_datetime, now, GOOGLE_RECENT_DAYS));
  if (!recentItems.length) {
    if (!items.length && domain) {
      return evidence({
        provider: "google",
        status: "inactive",
        active: false,
        confidence: 0.74,
        sourceUrl: buildGoogleAdsTransparencyUrl({ domain, country }),
        reason: "apify_google_no_recent_domain_ads",
        context: {
          strategy: "domain_apify",
          query: domain,
          domain,
          businessName: business.name,
          country,
          sourceProvider: "apify",
          matchedFields: ["domain"],
          itemsSeen: 0,
          total: 0,
          evidenceSnippet: "Apify returned zero Google Ads Transparency items for this exact domain search."
        }
      });
    }
    return evidence({
      provider: "google",
      status: "unknown",
      active: null,
      confidence: items.length ? 0.35 : 0.2,
      sourceUrl: buildGoogleAdsTransparencyUrl({ domain, country }),
      reason: items.length ? "apify_google_items_not_recent" : "apify_google_no_items",
      context: {
        strategy: "domain_apify",
        query: domain,
        domain,
        businessName: business.name,
        country,
        sourceProvider: "apify",
        matchedFields: ["domain"],
        itemsSeen: items.length,
        total: items.length,
        evidenceSnippet
      }
    });
  }
  const first = recentItems[0];
  return evidence({
    provider: "google",
    status: "active",
    active: true,
    confidence: 0.82,
    sourceUrl: first.adUrl || first.ad_url || first.adLibraryUrl || first.ad_library_url || buildGoogleAdsTransparencyUrl({ domain, country }),
    reason: "apify_google_recent_domain_ad",
    latestDetectedDate: normalizeApifyGoogleDate(first.lastShown || first.last_shown_datetime),
    context: {
      strategy: "domain_apify",
      query: domain,
      domain,
      businessName: business.name,
      country,
      sourceProvider: "apify",
      matchedFields: ["domain"],
      itemsSeen: recentItems.length,
      total: items.length,
      samplePageName: first.advertiserName || first.advertiser_name || null,
      adArchiveId: first.creativeId || first.creative_id || null,
      evidenceSnippet
    }
  });
}

function apifyGoogleItemMatchesDomain(item = {}, domain) {
  const normalizedDomain = normalizeText(domain);
  if (!normalizedDomain) return false;
  const explicitSearchTerm = firstValue(item.searchTerm, item.search_term, item.searchQuery, item.search_query);
  if (explicitSearchTerm) return normalizeText(explicitSearchTerm) === normalizedDomain;
  const strings = collectApifyGoogleItemStrings(item);
  if (strings
    .map((value) => normalizeText(value))
    .some((value) => value.includes(normalizedDomain))) {
    return true;
  }
  return Boolean(firstValue(item.advertiserName, item.advertiser_name, item.advertiserId, item.advertiser_id, item.creativeId, item.creative_id, item.adUrl, item.ad_url));
}

async function inspectMetaAdsWithApify({ business, apify, country, now, socialDiscovery, discoveryPlan }) {
  const sources = buildApifyMetaSources(business, country, discoveryPlan)
    .slice(0, apifyMetaMaxSources(apify));
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
      if (isStrongMetaApifyResult(analyzed)) break;
    } catch (error) {
      const quotaExceeded = isExternalQuotaError(error);
      const result = evidence({
        provider: "meta",
        status: "error",
        active: null,
        confidence: 0,
        sourceUrl: sourceWithActor.sourceUrl,
        reason: quotaExceeded ? "apify_quota_exceeded" : "apify_error",
        error: externalErrorMessage(error),
        context: sourceWithActor
      });
      attempts.push(apifyAttempt(sourceWithActor, result, []));
      fallback = betterMetaFallback(fallback, result);
      if (quotaExceeded) break;
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
    landingUrls,
    evidenceSnippet: compactSnippet(context?.evidenceSnippet || context?.evidenceText || "", 1800)
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
    plannedBy: probe.plannedBy || result.plannedBy || null,
    discoveryReason: probe.discoveryReason || result.discoveryReason || null,
    strategy: probe.strategy,
    query: probe.query,
    searchType: probe.searchType,
    country: probe.country || null,
    status: result.status,
    active: result.active,
    confidence: result.confidence,
    reason: result.reason,
    error: result.error || null,
    sourceUrl: url,
    latestDetectedDate: result.latestDetectedDate || null,
    itemsSeen: result.itemsSeen ?? null,
    total: result.total ?? null,
    samplePageName: result.samplePageName || null,
    matchedFields: result.matchedFields || null,
    adArchiveId: result.adArchiveId || null,
    actorId: result.actorId || probe.actorId || null,
    spendEstimate: result.spendEstimate || null,
    landingUrl: result.landingUrl || null,
    landingUrls: Array.isArray(result.landingUrls) ? result.landingUrls.slice(0, 8) : [],
    evidenceSnippet: compactSnippet(result.evidenceSnippet || "", 1800)
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
    attempts: attempts.slice(0, 30).map((attempt, index) => ({
      ...attempt,
      attemptId: attempt.attemptId || `${attempt.provider || result.provider || "ads"}_${index + 1}`
    }))
  };
}

async function resolveAdsActivity({
  business = {},
  providerEvidence = {},
  aiResolver,
  aiVerifier,
  aiConfig = config.adsActivityAi,
  now = new Date(),
  phase = "firecrawl",
  previousResult
} = {}) {
  const evidence = buildAdsActivityEvidencePack({
    business,
    providerEvidence,
    phase,
    previousResult,
    now,
    maxEvidenceChars: aiConfig?.maxEvidenceChars || DEFAULT_MAX_AI_EVIDENCE_CHARS
  });

  if (!canUseAdsActivityAi({ aiResolver, aiConfig })) {
    return {
      meta: aiRequiredProviderResult({ provider: "meta", evidence: providerEvidence.meta, aiConfig, now, phase }),
      google: aiRequiredProviderResult({ provider: "google", evidence: providerEvidence.google, aiConfig, now, phase })
    };
  }

  try {
    const rawResult = aiResolver
      ? await aiResolver({ business, evidence, providerEvidence, aiConfig, phase, previousResult })
      : await resolveAdsActivityWithDeepInfra({ evidence, aiConfig });
    const resolved = mergeAiAdsActivityResult({
      providerEvidence,
      rawResult,
      aiConfig,
      now,
      phase,
      requireAiPlannedEvidence: shouldRequireAiPlannedEvidence({ aiResolver, aiConfig })
    });
    if (!canUseAdsActivityVerifier({ aiVerifier, aiConfig })) return resolved;
    return await verifyAdsActivityResolution({
      business,
      evidence,
      providerEvidence,
      resolved,
      aiVerifier,
      aiConfig,
      now,
      phase,
      previousResult
    });
  } catch (error) {
    return {
      meta: aiFailedProviderResult({ provider: "meta", evidence: providerEvidence.meta, aiConfig, error, now, phase }),
      google: aiFailedProviderResult({ provider: "google", evidence: providerEvidence.google, aiConfig, error, now, phase })
    };
  }
}

function canUseAdsActivityAi({ aiResolver, aiConfig }) {
  if (aiResolver) return true;
  return Boolean(aiConfig && aiConfig.mode !== "never" && aiConfig.provider === "deepinfra" && aiConfig.apiKey);
}

function canUseAdsActivityVerifier({ aiVerifier, aiConfig }) {
  const verifyMode = String(aiConfig?.verifyMode || aiConfig?.verificationMode || "always").toLowerCase();
  if (["never", "off", "false", "0"].includes(verifyMode)) return false;
  if (aiVerifier) return true;
  return Boolean(aiConfig && aiConfig.mode !== "never" && aiConfig.provider === "deepinfra" && aiConfig.apiKey);
}

function shouldRequireAiPlannedEvidence({ aiResolver, aiConfig }) {
  if (aiConfig?.requirePlannedEvidence === true) return true;
  if (aiConfig?.requirePlannedEvidence === false) return false;
  return !aiResolver;
}

async function resolveAdsActivityWithDeepInfra({ evidence, aiConfig = config.adsActivityAi } = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 900,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You decide whether a local business is currently running active ads on Meta and Google.",
          "Use only the supplied Firecrawl and Apify evidence.",
          "Do not rely on generic scraper labels as proof. Verify advertiser identity, business/domain/social match, recency and official library context.",
          "Return active=false only when official evidence clearly says there are no active/current ads for this exact business query.",
          "Return active=null/status=unknown when pages are loading, blocked, unrelated, ambiguous, stale, or identity is not proven.",
          "Return only valid JSON. Do not include markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            meta: {
              active: "boolean or null",
              status: "active|inactive|unknown",
              confidence: "number 0..1",
              reason: "short snake_case reason",
              selectedAttemptIds: ["attempt ids"],
              landingUrls: ["urls copied from evidence only"],
              matchedFields: ["domain|business_name|page_name|instagram_handle|facebook_handle|landing_domain"],
              latestDetectedDate: "YYYY-MM-DD or null",
              sourceUrl: "url from evidence or null",
              evidenceSummary: "one short sentence",
              needsMoreEvidence: "boolean"
            },
            google: {
              active: "boolean or null",
              status: "active|inactive|unknown",
              confidence: "number 0..1",
              reason: "short snake_case reason",
              selectedAttemptIds: ["attempt ids"],
              landingUrls: ["urls copied from evidence only"],
              matchedFields: ["domain|business_name|landing_domain|advertiser"],
              latestDetectedDate: "YYYY-MM-DD or null",
              sourceUrl: "url from evidence or null",
              evidenceSummary: "one short sentence",
              needsMoreEvidence: "boolean"
            }
          },
          evidence
        })
      }
    ]
  };

  let json;
  try {
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  }
  return {
    ...parseAiJson(json?.choices?.[0]?.message?.content),
    usage: json?.usage || null
  };
}

async function verifyAdsActivityResolution({
  business = {},
  evidence,
  providerEvidence = {},
  resolved = {},
  aiVerifier,
  aiConfig = config.adsActivityAi,
  now = new Date(),
  phase = "firecrawl",
  previousResult
} = {}) {
  const needsVerification = ADS_ACTIVITY_PROVIDERS.some((provider) => typeof resolved?.[provider]?.active === "boolean");
  if (!needsVerification) return resolved;
  const verificationEvidence = buildAdsActivityVerificationPack({
    business,
    evidence,
    resolved,
    phase,
    previousResult,
    maxEvidenceChars: aiConfig?.maxEvidenceChars || DEFAULT_MAX_AI_EVIDENCE_CHARS
  });

  try {
    const rawVerification = aiVerifier
      ? await aiVerifier({ business, evidence: verificationEvidence, providerEvidence, resolved, aiConfig, phase, previousResult })
      : await verifyAdsActivityWithDeepInfra({ evidence: verificationEvidence, aiConfig });
    return applyAdsActivityVerification({
      providerEvidence,
      resolved,
      rawVerification,
      aiConfig,
      now,
      phase
    });
  } catch (error) {
    return Object.fromEntries(ADS_ACTIVITY_PROVIDERS.map((provider) => {
      const current = resolved?.[provider];
      if (typeof current?.active !== "boolean") return [provider, current || aiRequiredProviderResult({ provider, evidence: providerEvidence[provider], aiConfig, now, phase })];
      return [provider, aiVerificationFailedProviderResult({ provider, current, error, aiConfig, phase })];
    }));
  }
}

async function verifyAdsActivityWithDeepInfra({ evidence, aiConfig = config.adsActivityAi } = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 650,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are a skeptical auditor for Meta and Google Ads Library enrichment.",
          "Use only the supplied evidence and proposed decision.",
          "Confirm a proposed active=true or active=false only when the exact business identity and current ads state are proven by official or directly relevant evidence.",
          "Reject when advertiser identity, domain, social handle, recency, selected attempts, or official library context are ambiguous.",
          "Return unknown when more evidence is needed. Return only valid JSON."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            meta: {
              confirmed: "boolean",
              status: "confirmed|rejected|unknown",
              active: "the confirmed boolean decision or null",
              confidence: "number 0..1",
              reason: "short snake_case reason",
              selectedAttemptIds: ["attempt ids from evidence"],
              evidenceSummary: "one short sentence",
              needsMoreEvidence: "boolean"
            },
            google: {
              confirmed: "boolean",
              status: "confirmed|rejected|unknown",
              active: "the confirmed boolean decision or null",
              confidence: "number 0..1",
              reason: "short snake_case reason",
              selectedAttemptIds: ["attempt ids from evidence"],
              evidenceSummary: "one short sentence",
              needsMoreEvidence: "boolean"
            }
          },
          evidence
        })
      }
    ]
  };

  let json;
  try {
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  }
  return {
    ...parseAiJson(json?.choices?.[0]?.message?.content),
    usage: json?.usage || null
  };
}

function mergeAiAdsActivityResult({ providerEvidence = {}, rawResult, aiConfig, now, phase, requireAiPlannedEvidence = false }) {
  return Object.fromEntries(ADS_ACTIVITY_PROVIDERS.map((provider) => {
    const normalized = normalizeAiProviderActivity(rawResult?.[provider]);
    const base = providerEvidence[provider] || emptyProviderEvidence({ provider, now });
    if (!normalized) {
      return [provider, {
        ...base,
        active: null,
        status: "unknown",
        confidence: 0.2,
        reason: "ai_invalid_response",
        ai: adsActivityAiMetadata({ status: "invalid_response", rawResult, aiConfig, phase, provider })
      }];
    }
    return [provider, applyAiProviderDecision({ provider, base, normalized, rawResult, aiConfig, phase, requireAiPlannedEvidence })];
  }));
}

function applyAiProviderDecision({ provider, base, normalized, rawResult, aiConfig, phase, requireAiPlannedEvidence = false }) {
  const attempts = base.attempts || [];
  const sourceMatchedAttempt = attempts.find((attempt) => normalized.sourceUrl && attempt.sourceUrl === normalized.sourceUrl) || null;
  const idSelectedAttempts = normalized.selectedAttemptIds.length
    ? attempts.filter((attempt) => normalized.selectedAttemptIds.includes(attempt.attemptId))
    : [];
  const selectedAttempts = idSelectedAttempts.length
    ? idSelectedAttempts
    : sourceMatchedAttempt
      ? [sourceMatchedAttempt]
      : [];
  if (normalized.active !== null && !selectedAttempts.length) {
    return aiUnbackedProviderResult({ provider, base, rawResult, aiConfig, phase, normalized });
  }
  if (normalized.active !== null && requireAiPlannedEvidence && !selectedAttempts.some((attempt) => attempt.plannedBy === "ai")) {
    return aiUnplannedProviderResult({ provider, base, rawResult, aiConfig, phase, normalized });
  }
  const primary = selectedAttempts[0] || sourceMatchedAttempt || attempts[0] || {};
  const landingUrls = unique([
    ...normalized.landingUrls,
    ...selectedAttempts.flatMap((attempt) => attempt.landingUrls || [])
  ]).slice(0, 8);
  const matchedFields = unique([
    ...normalized.matchedFields,
    ...selectedAttempts.flatMap((attempt) => attempt.matchedFields || [])
  ]);
  const spendEstimate = provider === "meta" && normalized.active === true
    ? selectedAttempts.find((attempt) => attempt.spendEstimate)?.spendEstimate || base.spendEstimate || null
    : null;
  return {
    ...base,
    active: normalized.active,
    status: normalized.status,
    confidence: normalized.confidence,
    sourceUrl: normalized.sourceUrl || primary.sourceUrl || base.sourceUrl || null,
    reason: normalized.reason || "ai_ads_activity_resolution",
    latestDetectedDate: normalized.latestDetectedDate || primary.latestDetectedDate || base.latestDetectedDate || null,
    strategy: primary.strategy || base.strategy || null,
    query: primary.query || base.query || null,
    searchType: primary.searchType || base.searchType || null,
    country: primary.country || base.country || null,
    sourceProvider: selectedSourceProvider(selectedAttempts, primary, base),
    matchedFields: matchedFields.length ? matchedFields : null,
    itemsSeen: primary.itemsSeen ?? base.itemsSeen ?? null,
    total: primary.total ?? base.total ?? null,
    samplePageName: primary.samplePageName || base.samplePageName || null,
    adArchiveId: primary.adArchiveId || base.adArchiveId || null,
    spendEstimate,
    landingUrl: landingUrls[0] || null,
    landingUrls,
    ai: adsActivityAiMetadata({
      status: "resolved",
      rawResult,
      aiConfig,
      phase,
      provider,
      evidenceSummary: normalized.evidenceSummary,
      needsMoreEvidence: normalized.needsMoreEvidence,
      selectedAttemptIds: normalized.selectedAttemptIds
    })
  };
}

function aiUnbackedProviderResult({ provider, base, rawResult, aiConfig, phase, normalized }) {
  return {
    ...base,
    active: null,
    status: "unknown",
    confidence: 0.2,
    reason: "ai_unbacked_activity_decision",
    ai: adsActivityAiMetadata({
      status: "invalid_unbacked_decision",
      rawResult,
      aiConfig,
      phase,
      provider,
      evidenceSummary: normalized.evidenceSummary,
      needsMoreEvidence: true,
      selectedAttemptIds: normalized.selectedAttemptIds
    })
  };
}

function aiUnplannedProviderResult({ provider, base, rawResult, aiConfig, phase, normalized }) {
  return {
    ...base,
    active: null,
    status: "unknown",
    confidence: 0.2,
    reason: "ai_unplanned_activity_decision",
    ai: adsActivityAiMetadata({
      status: "invalid_unplanned_decision",
      rawResult,
      aiConfig,
      phase,
      provider,
      evidenceSummary: normalized.evidenceSummary,
      needsMoreEvidence: true,
      selectedAttemptIds: normalized.selectedAttemptIds
    })
  };
}

function aiRequiredProviderResult({ provider, evidence: providerEvidence, aiConfig, now, phase }) {
  return {
    ...(providerEvidence || emptyProviderEvidence({ provider, now })),
    active: null,
    status: "unknown",
    confidence: 0,
    reason: "ai_required_but_unavailable",
    ai: adsActivityAiMetadata({ status: "required_unavailable", rawResult: null, aiConfig, phase, provider })
  };
}

function aiFailedProviderResult({ provider, evidence: providerEvidence, aiConfig, error, now, phase }) {
  return {
    ...(providerEvidence || emptyProviderEvidence({ provider, now })),
    active: null,
    status: "unknown",
    confidence: 0,
    reason: "ai_resolution_failed",
    error: error.message,
    ai: {
      ...adsActivityAiMetadata({ status: "failed", rawResult: null, aiConfig, phase, provider }),
      error: error.message
    }
  };
}

function applyAdsActivityVerification({ providerEvidence = {}, resolved = {}, rawVerification, aiConfig, now, phase }) {
  return Object.fromEntries(ADS_ACTIVITY_PROVIDERS.map((provider) => {
    const current = resolved?.[provider] || aiRequiredProviderResult({ provider, evidence: providerEvidence[provider], aiConfig, now, phase });
    if (typeof current.active !== "boolean") return [provider, current];

    const normalized = normalizeAiProviderVerification(rawVerification?.[provider], current.active);
    if (!normalized) {
      return [provider, aiVerificationInvalidProviderResult({ provider, current, rawVerification, aiConfig, phase })];
    }
    if (normalized.confirmed !== true || normalized.active !== current.active) {
      return [provider, aiVerificationRejectedProviderResult({ provider, current, rawVerification, aiConfig, phase, normalized })];
    }

    return [provider, {
      ...current,
      confidence: Math.min(current.confidence ?? 0, normalized.confidence ?? current.confidence ?? 0),
      ai: {
        ...(current.ai || {}),
        verification: adsActivityVerificationMetadata({
          status: "confirmed",
          rawVerification,
          aiConfig,
          phase,
          provider,
          evidenceSummary: normalized.evidenceSummary,
          needsMoreEvidence: normalized.needsMoreEvidence,
          selectedAttemptIds: normalized.selectedAttemptIds
        })
      }
    }];
  }));
}

function aiVerificationInvalidProviderResult({ provider, current, rawVerification, aiConfig, phase }) {
  return {
    ...current,
    active: null,
    status: "unknown",
    confidence: 0.2,
    reason: "ai_verification_invalid_response",
    ai: {
      ...(current.ai || {}),
      status: "verification_invalid_response",
      needsMoreEvidence: true,
      verification: adsActivityVerificationMetadata({
        status: "invalid_response",
        rawVerification,
        aiConfig,
        phase,
        provider,
        needsMoreEvidence: true
      })
    }
  };
}

function aiVerificationRejectedProviderResult({ provider, current, rawVerification, aiConfig, phase, normalized }) {
  return {
    ...current,
    active: null,
    status: "unknown",
    confidence: 0.2,
    reason: normalized.status === "unknown" ? "ai_verification_unknown" : "ai_verification_rejected",
    ai: {
      ...(current.ai || {}),
      status: normalized.status === "unknown" ? "verification_unknown" : "verification_rejected",
      evidenceSummary: normalized.evidenceSummary || current.ai?.evidenceSummary || null,
      needsMoreEvidence: true,
      selectedAttemptIds: normalized.selectedAttemptIds || current.ai?.selectedAttemptIds || [],
      verification: adsActivityVerificationMetadata({
        status: normalized.status === "unknown" ? "unknown" : "rejected",
        rawVerification,
        aiConfig,
        phase,
        provider,
        evidenceSummary: normalized.evidenceSummary,
        needsMoreEvidence: true,
        selectedAttemptIds: normalized.selectedAttemptIds
      })
    }
  };
}

function aiVerificationFailedProviderResult({ provider, current, error, aiConfig, phase }) {
  return {
    ...current,
    active: null,
    status: "unknown",
    confidence: 0,
    reason: "ai_verification_failed",
    error: error.message,
    ai: {
      ...(current.ai || {}),
      status: "verification_failed",
      needsMoreEvidence: true,
      verification: {
        ...adsActivityVerificationMetadata({
          status: "failed",
          rawVerification: null,
          aiConfig,
          phase,
          provider,
          needsMoreEvidence: true
        }),
        error: error.message
      }
    }
  };
}

function emptyProviderEvidence({ provider, now }) {
  return evidence({
    provider,
    status: "unknown",
    active: null,
    confidence: 0.2,
    reason: "no_evidence_collected",
    context: { sourceProvider: "firecrawl", checkedAt: now?.toISOString?.() }
  });
}

function normalizeAiProviderActivity(value) {
  if (!value || typeof value !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(value, "active")) return null;
  const active = value.active === true
    ? true
    : value.active === false
      ? false
      : value.active == null
        ? null
        : undefined;
  if (active === undefined) return null;
  const rawStatus = String(value.status || "").toLowerCase();
  if (!["active", "inactive", "unknown"].includes(rawStatus)) return null;
  if (active === true && rawStatus !== "active") return null;
  if (active === false && rawStatus !== "inactive") return null;
  if (active === null && rawStatus !== "unknown") return null;
  return {
    active,
    status: rawStatus,
    confidence: roundConfidence(value.confidence),
    reason: normalizeReason(value.reason) || "ai_ads_activity_resolution",
    selectedAttemptIds: normalizeStringArray(value.selectedAttemptIds || value.selected_attempt_ids).slice(0, 8),
    landingUrls: normalizeStringArray(value.landingUrls || value.landing_urls).filter(isHttpUrl).slice(0, 8),
    matchedFields: normalizeStringArray(value.matchedFields || value.matched_fields).slice(0, 8),
    latestDetectedDate: normalizeDateString(value.latestDetectedDate || value.latest_detected_date),
    sourceUrl: isHttpUrl(value.sourceUrl || value.source_url) ? String(value.sourceUrl || value.source_url) : null,
    evidenceSummary: compactSnippet(value.evidenceSummary || value.evidence_summary || value.summary || "", 280),
    needsMoreEvidence: value.needsMoreEvidence === true || String(value.needs_more_evidence).toLowerCase() === "true"
  };
}

function normalizeAiProviderVerification(value, expectedActive) {
  if (!value || typeof value !== "object") return null;
  const rawStatus = String(value.status || "").toLowerCase();
  if (!["confirmed", "rejected", "unknown"].includes(rawStatus)) return null;
  const statusImpliedConfirmed = rawStatus === "confirmed"
    ? true
    : rawStatus === "rejected" || rawStatus === "unknown"
      ? false
      : undefined;
  const confirmed = value.confirmed === true
    ? true
    : value.confirmed === false
      ? false
      : value.confirmed == null
        ? statusImpliedConfirmed
        : undefined;
  if (confirmed === undefined) return null;
  if (confirmed === true && rawStatus !== "confirmed") return null;
  if (confirmed === false && rawStatus === "confirmed") return null;
  const active = value.active === true
    ? true
    : value.active === false
      ? false
      : value.active == null
        ? null
        : undefined;
  if (active === undefined) return null;
  if (confirmed === true && active !== expectedActive) return null;
  return {
    confirmed,
    status: rawStatus,
    active,
    confidence: roundConfidence(value.confidence),
    reason: normalizeReason(value.reason) || "ai_ads_activity_verification",
    selectedAttemptIds: normalizeStringArray(value.selectedAttemptIds || value.selected_attempt_ids).slice(0, 8),
    evidenceSummary: compactSnippet(value.evidenceSummary || value.evidence_summary || value.summary || "", 280),
    needsMoreEvidence: value.needsMoreEvidence === true || String(value.needs_more_evidence).toLowerCase() === "true"
  };
}

function selectedSourceProvider(selectedAttempts, primary, base) {
  const providers = unique(selectedAttempts.map((attempt) => attempt.sourceProvider).filter(Boolean));
  if (providers.length > 1) return "mixed";
  return providers[0] || primary.sourceProvider || base.sourceProvider || null;
}

function adsActivityAiMetadata({
  status,
  rawResult,
  aiConfig,
  phase,
  provider,
  evidenceSummary,
  needsMoreEvidence,
  selectedAttemptIds
}) {
  return {
    status,
    provider: aiConfig?.provider || "deepinfra",
    model: aiConfig?.model || null,
    phase,
    adsProvider: provider,
    evidenceSummary: evidenceSummary || null,
    needsMoreEvidence: needsMoreEvidence === true,
    selectedAttemptIds: selectedAttemptIds || [],
    usage: rawResult?.usage || null,
    cost: estimateDeepseekUsageCost(rawResult?.usage)
  };
}

function adsActivityVerificationMetadata({
  status,
  rawVerification,
  aiConfig,
  phase,
  provider,
  evidenceSummary,
  needsMoreEvidence,
  selectedAttemptIds
}) {
  return {
    status,
    provider: aiConfig?.provider || "deepinfra",
    model: aiConfig?.model || null,
    phase,
    adsProvider: provider,
    evidenceSummary: evidenceSummary || null,
    needsMoreEvidence: needsMoreEvidence === true,
    selectedAttemptIds: selectedAttemptIds || [],
    usage: rawVerification?.usage || null,
    cost: estimateDeepseekUsageCost(rawVerification?.usage)
  };
}

function buildAdsActivityEvidencePack({
  business = {},
  providerEvidence = {},
  phase,
  previousResult,
  now = new Date(),
  maxEvidenceChars = DEFAULT_MAX_AI_EVIDENCE_CHARS
} = {}) {
  const evidencePack = {
    task: "ads_activity_resolution",
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    phase,
    business: compactObject({
      name: business.name,
      cleanName: business.name,
      city: business.city,
      niche: business.niche || business.category,
      website: business.website,
      domain: extractDomain(business.website),
      instagram: business.instagram,
      facebook: business.facebook
    }),
    previousResult: previousResult ? summarizePreviousAdsResult(previousResult) : null,
    providers: Object.fromEntries(ADS_ACTIVITY_PROVIDERS.map((provider) => [
      provider,
      providerEvidenceForAi(providerEvidence[provider], provider)
    ])),
    decisionRules: [
      "A provider is active only when evidence proves active/current ads for this exact business, domain, official page, or social identity.",
      "A provider is inactive only when official library evidence clearly says no active/current ads for this exact business query.",
      "Search results, generic library UI text, loading pages, unrelated advertisers, stale dates, or domain mentions inside unrelated ads are unknown.",
      "Apify items are evidence, not a decision. Verify page name, domain, social handle, landing URL, advertiser identity and recency before active=true.",
      "For Meta, an Apify active result from a page-scoped Facebook source URL is exact page evidence; keyword or domain searches are not page-scoped and still need identity proof.",
      "Copy landing URLs only from the evidence. Never invent URLs, advertiser names, profile names or dates."
    ]
  };
  return enforceAdsEvidenceBudget(evidencePack, maxEvidenceChars);
}

function buildAdsActivityVerificationPack({
  business = {},
  evidence,
  resolved = {},
  phase,
  previousResult,
  maxEvidenceChars = DEFAULT_MAX_AI_EVIDENCE_CHARS
} = {}) {
  const verificationPack = {
    task: "ads_activity_verification",
    schemaVersion: 1,
    phase,
    business: evidence?.business || compactObject({
      name: business.name,
      cleanName: business.name,
      city: business.city,
      niche: business.niche || business.category,
      website: business.website,
      domain: extractDomain(business.website),
      instagram: business.instagram,
      facebook: business.facebook
    }),
    previousResult: previousResult ? summarizePreviousAdsResult(previousResult) : evidence?.previousResult || null,
    proposedDecision: Object.fromEntries(ADS_ACTIVITY_PROVIDERS.map((provider) => {
      const value = resolved?.[provider] || {};
      return [provider, {
        active: value.active ?? null,
        status: value.status || null,
        confidence: value.confidence ?? null,
        reason: value.reason || null,
        selectedAttemptIds: value.ai?.selectedAttemptIds || [],
        sourceUrl: value.sourceUrl || null,
        matchedFields: value.matchedFields || [],
        landingUrls: value.landingUrls || []
      }];
    })),
    providers: evidence?.providers || {},
    auditRules: [
      "Confirm only the exact proposed boolean decision for each provider.",
      "confirmed=true requires a selected attempt or source URL that supports the same active boolean for the exact business identity.",
      "Reject if active ads belong to a similarly named, unrelated, stale, or unproven advertiser.",
      "For Meta, accept active=true when the selected evidence is an Apify active result from a page-scoped Facebook source URL for the planned page; do not apply this to keyword or domain searches.",
      "Reject inactive when the evidence only shows a failed scrape, blocked page, generic no-results text, or an unverified query.",
      "Use unknown when the evidence is insufficient and set needsMoreEvidence=true."
    ]
  };
  return enforceAdsEvidenceBudget(verificationPack, maxEvidenceChars);
}

function providerEvidenceForAi(providerEvidence = {}, provider) {
  const attempts = (providerEvidence?.attempts || []).map((attempt, index) => ({
    attemptId: attempt.attemptId || `${provider}_${index + 1}`,
    provider,
    sourceProvider: attempt.sourceProvider || null,
    plannedBy: attempt.plannedBy || null,
    discoveryReason: attempt.discoveryReason || null,
    strategy: attempt.strategy || null,
    query: attempt.query || null,
    searchType: attempt.searchType || null,
    country: attempt.country || null,
    statusSignal: attempt.status || null,
    activeSignal: attempt.active,
    confidenceSignal: attempt.confidence ?? null,
    reasonSignal: attempt.reason || null,
    sourceUrl: attempt.sourceUrl || null,
    matchedFields: attempt.matchedFields || [],
    landingUrls: attempt.landingUrls || [],
    latestDetectedDate: attempt.latestDetectedDate || null,
    itemsSeen: attempt.itemsSeen ?? null,
    total: attempt.total ?? null,
    samplePageName: attempt.samplePageName || null,
    adArchiveId: attempt.adArchiveId || null,
    evidenceSnippet: compactSnippet(attempt.evidenceSnippet || "", 1100)
  }));
  return {
    deterministicSummary: {
      statusSignal: providerEvidence?.status || null,
      activeSignal: providerEvidence?.active,
      confidenceSignal: providerEvidence?.confidence ?? null,
      reasonSignal: providerEvidence?.reason || null,
      sourceUrl: providerEvidence?.sourceUrl || null,
      sourceProvider: providerEvidence?.sourceProvider || null,
      landingUrls: providerEvidence?.landingUrls || []
    },
    attempts
  };
}

function enforceAdsEvidenceBudget(evidencePack, maxEvidenceChars) {
  const limit = Math.max(5000, Number(maxEvidenceChars) || DEFAULT_MAX_AI_EVIDENCE_CHARS);
  let serialized = JSON.stringify(evidencePack);
  if (serialized.length <= limit) return evidencePack;
  let reduced = {
    ...evidencePack,
    providers: Object.fromEntries(Object.entries(evidencePack.providers).map(([provider, value]) => [
      provider,
      {
        ...value,
        attempts: value.attempts.slice(0, 12).map((attempt) => ({
          ...attempt,
          evidenceSnippet: compactSnippet(attempt.evidenceSnippet, 550)
        }))
      }
    ]))
  };
  serialized = JSON.stringify(reduced);
  if (serialized.length <= limit) return reduced;
  return {
    ...reduced,
    providers: Object.fromEntries(Object.entries(reduced.providers).map(([provider, value]) => [
      provider,
      {
        ...value,
        attempts: value.attempts.slice(0, 8).map((attempt) => ({
          ...attempt,
          evidenceSnippet: compactSnippet(attempt.evidenceSnippet, 320)
        }))
      }
    ]))
  };
}

function summarizePreviousAdsResult(result = {}) {
  return Object.fromEntries(ADS_ACTIVITY_PROVIDERS.map((provider) => {
    const value = result[provider] || {};
    return [provider, {
      status: value.status,
      active: value.active,
      confidence: value.confidence,
      reason: value.reason,
      aiStatus: value.ai?.status || null,
      needsMoreEvidence: value.ai?.needsMoreEvidence === true
    }];
  }));
}

function shouldRunApifyAdsFallback({ resolved = {}, apify, mode, aiResolver, aiConfig, discoveryPlan }) {
  const normalizedMode = normalizeApifyFallbackMode(mode);
  if (normalizedMode === "off") return false;
  if (discoveryPlan?.ai?.status !== "planned") return false;
  const apifyAvailable = apify && (
    typeof apify.runFacebookAdsLibrary === "function" ||
    typeof apify.runGoogleAdsTransparency === "function"
  );
  if (!apifyAvailable || !canUseAdsActivityAi({ aiResolver, aiConfig })) return false;
  if (normalizedMode === "always") return true;
  return ADS_ACTIVITY_PROVIDERS.some((provider) => shouldCollectApifyProvider({ provider, resolved, mode: normalizedMode }));
}

function shouldCollectApifyProvider({ provider, resolved = {}, mode }) {
  const normalizedMode = normalizeApifyFallbackMode(mode);
  if (normalizedMode === "always") return true;
  const result = resolved?.[provider];
  return !result || result.active == null || result.ai?.needsMoreEvidence === true || result.reason === "ai_resolution_failed";
}

function normalizeApifyFallbackMode(value) {
  const mode = String(value || "off").toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "on_unknown", "unknown"].includes(mode)) return "on_unknown";
  if (["always", "all"].includes(mode)) return "always";
  return "off";
}

function mergeProviderEvidence(primary, secondary) {
  if (!secondary) return primary;
  const attempts = [...(primary?.attempts || []), ...(secondary?.attempts || [])]
    .map((attempt, index) => ({ ...attempt, attemptId: `${attempt.provider || primary?.provider || secondary?.provider || "ads"}_${index + 1}` }))
    .slice(0, 30);
  const better = (secondary?.confidence || 0) > (primary?.confidence || 0) ? secondary : primary;
  return {
    ...(better || primary || secondary),
    active: null,
    status: "unknown",
    confidence: Math.max(primary?.confidence || 0, secondary?.confidence || 0, 0.2),
    reason: "ai_pending_combined_evidence",
    attempts,
    firecrawlStatus: primary?.status || null,
    firecrawlReason: primary?.reason || null,
    apifyStatus: secondary?.status || null,
    apifyReason: secondary?.reason || null,
    socialDiscovery: primary?.socialDiscovery || secondary?.socialDiscovery || null
  };
}

function betterMetaFallback(current, next) {
  if (!current) return next;
  if (current.active === true || next.active === true) {
    if (next.active === true && current.active !== true) return next;
    if (current.active === true && next.active !== true) return current;
    const currentLandingCount = Array.isArray(current.landingUrls) ? current.landingUrls.length : 0;
    const nextLandingCount = Array.isArray(next.landingUrls) ? next.landingUrls.length : 0;
    if (nextLandingCount > currentLandingCount) return next;
    if (nextLandingCount < currentLandingCount) return current;
    if ((next.confidence || 0) > (current.confidence || 0)) return next;
    return current;
  }
  if (next.active === false && current.active == null) return next;
  if ((next.confidence || 0) > (current.confidence || 0)) return next;
  return current;
}

function isStrongMetaApifyResult(result = {}) {
  return result.active === true &&
    (result.confidence || 0) >= 0.9 &&
    Array.isArray(result.landingUrls) &&
    result.landingUrls.length > 0;
}

function buildApifyMetaSources(business, country, discoveryPlan) {
  const sources = [];
  const metaCountry = country || DEFAULT_COUNTRY;

  const aiPlannedMetaUrls = discoveryPlan?.ai?.status === "planned"
    ? normalizeDiscoveryUrlEntries(discoveryPlan?.metaUrls || [], "meta", "ai").filter((entry) => entry.plannedBy === "ai")
    : [];
  const aiPlannedMetaProbes = discoveryPlan?.ai?.status === "planned"
    ? normalizeMetaDiscoveryProbes(discoveryPlan?.metaProbes || [], "ai").filter((probe) => probe.plannedBy === "ai")
    : [];

  for (const entry of aiPlannedMetaUrls) {
    const normalizedUrl = normalizeApifyMetaSourceUrl(entry.url, entry.country || metaCountry);
    if (!normalizedUrl) continue;
    const searchType = metaSearchTypeFromUrl(normalizedUrl);
    const query = entry.query || metaApifySearchTerm({ sourceUrl: normalizedUrl });
    const sourceUrl = facebookPageUrlFromMetaSource({
      query,
      searchType,
      sourceUrl: normalizedUrl
    }) || normalizedUrl;
    addApifySource(sources, {
      strategy: entry.strategy || "ai_planned_meta_url_apify",
      query,
      searchType,
      country: entry.country || metaCountry,
      sourceUrl,
      confidence: 0.88,
      plannedBy: entry.plannedBy || "ai",
      discoveryReason: entry.discoveryReason || "ai_ads_discovery"
    });
  }
  for (const probe of aiPlannedMetaProbes) {
    const libraryUrl = buildMetaAdsLibraryUrl({
      query: probe.query,
      country: probe.country || "ALL",
      searchType: probe.searchType
    });
    addApifySource(sources, {
      strategy: probe.strategy || `${probe.plannedBy || "seed"}_meta_probe_apify`,
      query: probe.query,
      searchType: probe.searchType,
      country: probe.country || "ALL",
      sourceUrl: facebookPageUrlFromMetaSource({
        query: probe.query,
        searchType: probe.searchType,
        sourceUrl: libraryUrl
      }) || libraryUrl,
      confidence: probe.confidence || (probe.plannedBy === "ai" ? 0.86 : 0.7),
      plannedBy: probe.plannedBy || "seed",
      discoveryReason: probe.discoveryReason || `${probe.plannedBy || "seed"}_ads_discovery`
    });
  }

  return sources
    .filter((source) => source.plannedBy === "ai")
    .sort((a, b) => rankApifyMetaSource(b, business) - rankApifyMetaSource(a, business));
}

function addApifySource(sources, source) {
  if (!source.sourceUrl || sources.some((item) => item.sourceUrl === source.sourceUrl)) return;
  sources.push({
    ...source,
    plannedBy: source.plannedBy || "seed",
    discoveryReason: source.discoveryReason || "seed_apify_source",
    sourceProvider: "apify"
  });
}

function buildApifyMetaInput(source, apify) {
  const maxResults = apifyMetaMaxResults(apify);
  if (isCrawlerbrosFacebookAdsActor(apify?.facebookAdsActorId)) {
    return {
      searchTerms: [metaApifySearchTerm(source)].filter(Boolean),
      country: apifyMetaCountry(source.country),
      adActiveStatus: "active",
      adType: "all",
      mediaType: "all",
      resultsPerSearch: maxResults,
      runTag: "lexington-meta-active-check"
    };
  }
  return {
    urls: [{ url: source.sourceUrl }],
    limitPerSource: maxResults,
    count: maxResults,
    scrapeAdDetails: false,
    "scrapePageAds.period": "",
    "scrapePageAds.activeStatus": "active",
    "scrapePageAds.sortBy": "most_recent",
    "scrapePageAds.countryCode": source.country || "ALL",
    runTag: "lexington-meta-active-check"
  };
}

function normalizeApifyMetaSourceUrl(value, country = DEFAULT_COUNTRY) {
  try {
    const parsed = new URL(value);
    const viewAllPageId = parsed.searchParams.get("view_all_page_id");
    if (viewAllPageId && !/^\d+$/.test(viewAllPageId)) {
      parsed.searchParams.delete("view_all_page_id");
      parsed.searchParams.set("q", viewAllPageId);
      parsed.searchParams.set("search_type", "page");
    }
    const query = parsed.searchParams.get("q");
    const pageId = parsed.searchParams.get("page_id") || parsed.searchParams.get("view_all_page_id");
    const archiveId = parsed.searchParams.get("id");
    if (!query && !pageId && !archiveId) return "";
    parsed.searchParams.set("active_status", "active");
    parsed.searchParams.set("ad_type", parsed.searchParams.get("ad_type") || "all");
    parsed.searchParams.set("country", normalizeCountryCode(parsed.searchParams.get("country")) || apifyMetaCountry(country));
    parsed.searchParams.set("media_type", parsed.searchParams.get("media_type") || "all");
    if (!parsed.searchParams.get("search_type") && query) parsed.searchParams.set("search_type", "keyword_unordered");
    return parsed.toString();
  } catch {
    return "";
  }
}

function metaSearchTypeFromUrl(value) {
  try {
    return normalizeMetaSearchType(new URL(value).searchParams.get("search_type"));
  } catch {
    return "keyword_unordered";
  }
}

function facebookPageUrlFromMetaSource({ query, searchType, sourceUrl } = {}) {
  const normalizedSearchType = normalizeMetaSearchType(searchType || metaSearchTypeFromUrl(sourceUrl || ""));
  if (normalizedSearchType !== "page") return "";
  return facebookPageUrlFromQuery(query || metaApifySearchTerm({ sourceUrl }));
}

function facebookPageUrlFromQuery(value) {
  const raw = cleanQuery(value).replace(/^@+/, "");
  if (!raw || /\s/.test(raw) || /^\d+$/.test(raw)) return "";
  const parsedFacebookUrl = parseFacebookPageUrl(raw);
  if (parsedFacebookUrl) return parsedFacebookUrl;
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(raw)) return "";
  if (/\.[a-z]{2,}$/i.test(raw)) return "";
  return `https://www.facebook.com/${encodeURIComponent(raw)}`;
}

function parseFacebookPageUrl(value) {
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "facebook.com" && host !== "fb.com") return "";
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts[0] === "profile.php" && /^\d+$/.test(parsed.searchParams.get("id") || "")) {
      return `https://www.facebook.com/profile.php?id=${parsed.searchParams.get("id")}`;
    }
    const handle = pathParts[0] || "";
    if (!handle || /^(ads|ad|share|sharer|groups|events|marketplace|watch|reel|reels|stories)$/i.test(handle)) return "";
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(handle)) return "";
    return `https://www.facebook.com/${encodeURIComponent(handle)}`;
  } catch {
    return "";
  }
}

function apifyMetaMaxResults(apify) {
  const configured = Number(apify?.maxChargedResults || 1);
  return Math.min(3, Math.max(1, Number.isFinite(configured) ? configured : 1));
}

function apifyMetaMaxSources(apify) {
  const configured = Number(apify?.metaMaxSources ?? config.adsEnrichment?.apifyMetaMaxSources ?? 1);
  return Math.min(3, Math.max(1, Number.isFinite(configured) ? configured : 1));
}

function rankApifyMetaSource(source = {}, business = {}) {
  const query = String(source.query || "");
  const strategy = String(source.strategy || "");
  const searchType = String(source.searchType || "");
  const sourceUrl = String(source.sourceUrl || "");
  const domain = extractDomain(business.website);
  let score = Number(source.confidence || 0) * 10;
  if (source.plannedBy === "ai") score += 30;
  if (searchType === "page" || /page/i.test(strategy)) score += 18;
  if (/page_id=|\/ads\/library\/\?id=/i.test(sourceUrl)) score += 16;
  if (/^@[\w.]+$/i.test(query)) score += 14;
  if (domain && normalizeText(query) === normalizeText(domain)) score += 12;
  if (/facebook|instagram|handle|domain|url/i.test(strategy)) score += 8;
  if (/business_name|name_city|brand/i.test(strategy)) score -= 12;
  return score;
}

function metaApifySearchTerm(source = {}) {
  const query = cleanQuery(source.query);
  if (query) return query;
  try {
    const parsed = new URL(source.sourceUrl);
    const viewAllPageId = parsed.searchParams.get("view_all_page_id") || "";
    return cleanQuery(parsed.searchParams.get("q") || parsed.searchParams.get("page_id") || (/^\d+$/.test(viewAllPageId) ? viewAllPageId : "") || viewAllPageId || "");
  } catch {
    return cleanQuery(source.sourceUrl || "");
  }
}

function apifyMetaCountry(country) {
  const normalized = normalizeCountryCode(country);
  return normalized && normalized !== "ALL" ? normalized : "ES";
}

function isApifyMetaItemActive(item = {}) {
  const explicit = firstDefined(item?.is_active, item?.isActive, item?.active, item?.isCurrentlyActive);
  if (explicit === true || normalizeText(explicit) === "true") return true;
  if (explicit === false || normalizeText(explicit) === "false") return false;
  const status = normalizeText(item?.status || item?.ad_status || item?.active_status || item?.activeStatus || item?.state || "");
  if (status.includes("inactive")) return false;
  if (status.includes("active")) return true;
  return true;
}

function inferApifyMetaActivity({ items = [], business, source, now }) {
  const activeItems = items.filter((item) => isApifyMetaItemActive(item));
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
    const evidenceSnippet = compactSnippet(matchedItems.map(({ item }) => collectApifyItemStrings(item).join("\n")).join("\n---\n"), 1800);
    return evidence({
      provider: "meta",
      status: "active",
      active: true,
      confidence: Math.max(Number(source.confidence || 0), bestMatch.match.confidence),
      sourceUrl: apifyMetaItemUrl(bestMatch.item) || source.sourceUrl,
      reason: "apify_active_ad_matched",
      latestDetectedDate,
      context: {
        ...source,
        matchedFields: bestMatch.match.fields,
        itemsSeen: items.length,
        total: apifyTotal(items),
        matchedItems: matchedItems.length,
        samplePageName: samplePageName(bestMatch.item),
        adArchiveId: apifyMetaItemAdId(bestMatch.item),
        landingUrls,
        spendEstimate,
        evidenceSnippet
      }
    });
  }

  const evidenceSnippet = compactSnippet(activeItems.map((item) => collectApifyItemStrings(item).join("\n")).join("\n---\n"), 1800);
  if (activeItems.length && isPageScopedApifyMetaSource(source)) {
    const latestDetectedDate = apifyItemDate(activeItems[0], now);
    const landingUrls = activeItems.flatMap((item) => collectApifyLandingUrls(item, business)).slice(0, 8);
    const spendEstimate = estimateMetaSpendFromApifyItems({
      matchedItems: activeItems.map((item) => ({
        item,
        match: { confidence: 0.9, fields: ["facebook_handle"] }
      })),
      business,
      now
    });
    return evidence({
      provider: "meta",
      status: "active",
      active: true,
      confidence: Math.max(Number(source.confidence || 0), 0.9),
      sourceUrl: apifyMetaItemUrl(activeItems[0]) || source.sourceUrl,
      reason: "apify_active_items_for_page_scoped_source",
      latestDetectedDate,
      context: {
        ...source,
        matchedFields: ["facebook_handle"],
        itemsSeen: items.length,
        total: apifyTotal(items),
        matchedItems: activeItems.length,
        samplePageName: samplePageName(activeItems[0]),
        adArchiveId: apifyMetaItemAdId(activeItems[0]),
        landingUrls,
        spendEstimate,
        evidenceSnippet: evidenceSnippet || "Apify returned active Meta Ads Library items for a page-scoped Facebook source URL."
      }
    });
  }
  if (!activeItems.length && isPreciseApifyMetaSource(source)) {
    return evidence({
      provider: "meta",
      status: "inactive",
      active: false,
      confidence: Math.max(Number(source.confidence || 0), 0.74),
      sourceUrl: source.sourceUrl,
      reason: "apify_no_active_items_for_precise_source",
      context: {
        ...source,
        itemsSeen: items.length,
        total: apifyTotal(items),
        samplePageName: null,
        evidenceSnippet: "Apify returned zero active Meta Ads Library items for this precise planned source."
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
      samplePageName: samplePageName(items[0]),
      evidenceSnippet
    }
  });
}

function isPageScopedApifyMetaSource(source = {}) {
  const sourceUrl = String(source.sourceUrl || "");
  const searchType = String(source.searchType || "").toLowerCase();
  if (parseFacebookPageUrl(sourceUrl)) return true;
  try {
    const parsed = new URL(sourceUrl);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "facebook.com" && host !== "fb.com") return false;
    if (!/\/ads\/library\/?$/i.test(parsed.pathname)) return false;
    if (parsed.searchParams.get("view_all_page_id") || parsed.searchParams.get("page_id") || parsed.searchParams.get("id")) {
      return true;
    }
    return searchType === "page" && /^[a-z0-9][a-z0-9._-]{1,79}$/i.test(String(source.query || ""));
  } catch {
    return false;
  }
}

function isPreciseApifyMetaSource(source = {}) {
  if (source.plannedBy !== "ai") return false;
  const strategy = String(source.strategy || "");
  const searchType = String(source.searchType || "");
  return searchType === "page" ||
    /page|domain|facebook|instagram|url|handle/i.test(strategy) ||
    /^https?:\/\//i.test(String(source.query || "")) ||
    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(source.query || ""));
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
    [
      GOOGLE_RECENT_DATE_PRESET,
      "ultimos 30 dias",
      "últimos 30 días",
      "last 30 days",
      "30 derniers jours"
    ].some((phrase) => normalized.includes(normalizeText(phrase)));
  if (!hasRecentFilter) return null;
  const hasDomainResultsCopy = [
    "este dominio incluye resultados",
    "this domain includes results",
    "ce domaine inclut des resultats",
    "ce domaine inclut des résultats",
    "anuncios que se orientan a este dominio",
    "ads that target this domain",
    "annonces redirigent vers ce domaine"
  ].some((phrase) => normalized.includes(normalizeText(phrase)));
  if (!hasDomainResultsCopy) return null;
  const matches = Array.from(String(text || "").matchAll(/\b(\d{1,5})\s+(?:anuncios|ads|annonces)\b/gi));
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
    item.pageName,
    item.page_id,
    item.pageId,
    item.ad_archive_id,
    item.adArchiveId,
    item.adArchiveID,
    item.ad_id,
    item.adId,
    item.ad_library_url,
    item.adLibraryUrl,
    item.ad_snapshot_url,
    item.adSnapshotUrl,
    item.url,
    item.status,
    item.activeStatus,
    item.state,
    item.ad_text,
    item.adText,
    item.link_url,
    item.linkUrl,
    item.targetUrl,
    item.destinationUrl,
    item.cta_text,
    item.ctaText,
    item.search_term,
    item.searchTerm,
    Array.isArray(item.platforms) ? item.platforms.join(" ") : item.platforms,
    Array.isArray(item.publisherPlatform) ? item.publisherPlatform.join(" ") : item.publisherPlatform,
    item.publisher_platform,
    item.media_type,
    item.mediaType,
    item.advertiser,
    item.advertiserName,
    snapshot.page_name,
    snapshot.pageName,
    snapshot.page_profile_uri,
    snapshot.pageProfileUri,
    snapshot.caption,
    snapshot.cta_text,
    snapshot.ctaText,
    snapshot.link_url,
    snapshot.linkUrl,
    snapshot.link_description,
    snapshot.linkDescription,
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

function collectApifyGoogleItemStrings(item = {}) {
  return [
    item.advertiserName,
    item.advertiser_name,
    item.advertiserId,
    item.advertiser_id,
    item.creativeId,
    item.creative_id,
    item.adUrl,
    item.ad_url,
    item.adLibraryUrl,
    item.ad_library_url,
    item.imageUrl,
    item.image_url,
    item.searchTerm,
    item.search_term,
    item.searchQuery,
    item.search_query,
    item.firstShown,
    item.first_shown_datetime,
    item.lastShown,
    item.last_shown_datetime,
    item.title,
    item.description,
    item.url,
    item.finalUrl,
    item.final_url,
    item.displayUrl,
    item.display_url
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
  return item?.page_name || item?.pageName || item?.snapshot?.page_name || item?.snapshot?.pageName || null;
}

function apifyItemDate(item = {}, now) {
  const raw = item.start_date || item.startDate || item.startDateFormatted || item.end_date || item.endDate;
  const number = Number(raw);
  const date = Number.isFinite(number) && number > 0
    ? new Date(number > 10_000_000_000 ? number : number * 1000)
    : parseLooseDate(raw);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > now.getTime() + 86400_000 * 2) return null;
  return date.toISOString().slice(0, 10);
}

function apifyMetaItemUrl(item = {}) {
  return firstValue(
    item.ad_library_url,
    item.adLibraryUrl,
    item.ad_snapshot_url,
    item.adSnapshotUrl,
    item.url
  ) || null;
}

function apifyMetaItemAdId(item = {}) {
  return firstValue(
    item.ad_archive_id,
    item.adArchiveId,
    item.adArchiveID,
    item.ad_id,
    item.adId,
    item.id
  ) || null;
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

function apifyGoogleDateWithin(value, now, days) {
  const normalized = normalizeApifyGoogleDate(value);
  if (!normalized) return false;
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const cutoff = now.getTime() - days * 86400_000;
  return date.getTime() >= cutoff && date.getTime() <= now.getTime() + 86400_000;
}

function normalizeApifyGoogleDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const date = parseLooseDate(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function parseLooseDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Date(Number.NaN);
  const parsed = new Date(raw);
  return parsed;
}

function externalErrorMessage(error) {
  const bodyMessage =
    error?.body?.error?.message ||
    error?.body?.message ||
    (typeof error?.body === "string" ? error.body.slice(0, 300) : "");
  return compactSnippet([error?.message, bodyMessage].filter(Boolean).join(" - "), 600);
}

function isExternalQuotaError(error) {
  const text = externalErrorMessage(error);
  return /quota|hard limit|usage limit|monthly usage|limit exceeded/i.test(text);
}

export function parseAiJson(content) {
  const raw = String(content || "").trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!raw) return null;
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  const candidates = unique([
    raw,
    objectMatch ? objectMatch[0] : "",
    repairJsonWithLibrary(raw),
    objectMatch ? repairJsonWithLibrary(objectMatch[0]) : "",
    ...jsonRepairCandidates(raw),
    ...(objectMatch ? jsonRepairCandidates(objectMatch[0]) : [])
  ]);
  let lastError = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

function repairJsonWithLibrary(value) {
  try {
    return jsonrepair(String(value || ""));
  } catch {
    return "";
  }
}

function jsonRepairCandidates(raw) {
  const compacted = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  const escapedControls = escapeJsonControlCharactersInStrings(compacted);
  return [
    compacted,
    escapedControls,
    compacted
      .replace(/}\s*(?={)/g, "},")
      .replace(/\]\s*(?="[^"]+"\s*:)/g, "],")
      .replace(/"\s*(?="[^"]+"\s*:)/g, "\","),
    escapedControls
      .replace(/}\s*(?={)/g, "},")
      .replace(/\]\s*(?="[^"]+"\s*:)/g, "],")
      .replace(/"\s*(?="[^"]+"\s*:)/g, "\",")
  ];
}

function escapeJsonControlCharactersInStrings(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const char of String(value || "")) {
    if (!inString) {
      output += char;
      if (char === "\"") inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      output += char;
      inString = false;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code <= 0x1f) {
      if (char === "\n") output += "\\n";
      else if (char === "\r") output += "\\r";
      else if (char === "\t") output += "\\t";
      else output += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += char;
  }
  return output;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeReason(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeDateString(value) {
  const match = String(value || "").match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function compactSnippet(value, maxChars = 600) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== "" && (!Array.isArray(item) || item.length)));
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

function uniqueMetaDiscoveryProbes(probes = []) {
  const seen = new Set();
  return (probes || []).filter((probe) => {
    const query = cleanQuery(probe?.query);
    if (!query) return false;
    const key = `${normalizeMetaSearchType(probe.searchType)}:${normalizeCountryCode(probe.country) || ""}:${normalizeText(query)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    probe.query = query;
    probe.searchType = normalizeMetaSearchType(probe.searchType);
    probe.country = normalizeCountryCode(probe.country);
    return true;
  });
}

function uniqueDiscoveryQueries(entries = []) {
  const seen = new Set();
  return (entries || []).filter((entry) => {
    const query = String(entry?.query || "").replace(/\s+/g, " ").trim();
    const key = normalizeText(query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    entry.query = query;
    return true;
  });
}

function uniqueDiscoveryUrls(entries = []) {
  const seen = new Set();
  return (entries || []).filter((entry) => {
    const provider = String(entry?.url || "").includes("facebook.com/ads/library") ? "meta" : "google";
    const url = normalizeAdsLibraryUrl(entry?.url, provider);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    entry.url = url;
    return true;
  });
}

function normalizeMetaSearchType(value) {
  return String(value || "").toLowerCase() === "page" ? "page" : "keyword_unordered";
}

function normalizeCountryCode(value) {
  const country = String(value || "").trim().toUpperCase();
  if (country === "ALL") return "ALL";
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function normalizeAdsLibraryUrl(value, provider) {
  try {
    const parsed = new URL(String(value || "").startsWith("http") ? value : `https://${value}`);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (provider === "meta") {
      if (!["facebook.com", "m.facebook.com"].some((item) => host === item || host.endsWith(`.${item}`))) return "";
      if (!/^\/ads\/library\/?$/i.test(parsed.pathname)) return "";
      return parsed.toString();
    }
    if (provider === "google") {
      if (host !== "adstransparency.google.com") return "";
      return parsed.toString();
    }
    return "";
  } catch {
    return "";
  }
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

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
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
