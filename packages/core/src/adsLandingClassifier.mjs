const DEFAULT_MAX_PAGES = 2;

const BLOCKED_LANDING_HOSTS = [
  "facebook.com",
  "fb.com",
  "fbcdn.net",
  "instagram.com",
  "google.com",
  "google.es",
  "gstatic.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adstransparency.google.com",
  "schema.org",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com"
];

const URL_PARAM_NOISE = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "mc_cid",
  "mc_eid"
];

export async function classifyAdsLandingIntent({
  business = {},
  enrichment = {},
  firecrawl,
  now = new Date(),
  maxPages = DEFAULT_MAX_PAGES
} = {}) {
  const activeProviders = ["meta", "google"].filter((provider) => enrichment?.[provider]?.active === true);
  if (!activeProviders.length) {
    return emptyClassification({
      now,
      reason: "no_active_ads",
      activeProviders,
      candidates: []
    });
  }

  const candidates = selectLandingCandidates({ business, enrichment });
  const crawlCandidates = candidates.length
    ? candidates
    : fallbackBusinessCandidate(business);

  if (!firecrawl) {
    return emptyClassification({
      now,
      reason: "firecrawl_client_missing",
      activeProviders,
      candidates: crawlCandidates
    });
  }

  const evaluated = [];
  const rejected = [];
  for (const candidate of crawlCandidates) {
    if (evaluated.length >= Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES)) break;
    const url = normalizeLandingUrl(candidate.url);
    if (!url) {
      rejected.push({ url: candidate.url || null, reason: "invalid_url" });
      continue;
    }
    if (isBlockedLandingUrl(url)) {
      rejected.push({ url, reason: "blocked_ad_or_social_host" });
      continue;
    }

    try {
      const page = await firecrawl.scrape(url, {
        formats: ["markdown", "html", "links"],
        onlyMainContent: false,
        waitFor: 2500
      });
      evaluated.push(classifyLandingPage({ url, page, business, candidate }));
    } catch (error) {
      rejected.push({
        url,
        reason: "landing_scrape_failed",
        error: error.message
      });
    }
  }

  const best = chooseBestClassification(evaluated);
  if (!best) {
    return emptyClassification({
      now,
      reason: "no_landing_page_classified",
      activeProviders,
      candidates: crawlCandidates,
      rejected,
      evaluated
    });
  }

  return {
    type: best.type,
    confidence: best.confidence,
    landingUrl: best.landingUrl,
    checkedAt: now.toISOString(),
    reason: best.reason,
    activeProviders,
    provider: best.provider || null,
    source: best.source || null,
    scores: best.scores,
    signals: best.signals.slice(0, 10),
    rejected,
    evaluated: evaluated.map((item) => ({
      type: item.type,
      confidence: item.confidence,
      landingUrl: item.landingUrl,
      provider: item.provider || null,
      reason: item.reason,
      scores: item.scores,
      signals: item.signals.slice(0, 6),
      genericContactPage: item.genericContactPage
    })),
    candidates: crawlCandidates.slice(0, 8)
  };
}

export function selectLandingCandidates({ business = {}, enrichment = {} } = {}) {
  const businessRoot = registrableDomain(extractHostname(business.website));
  const candidates = [];
  for (const provider of ["meta", "google"]) {
    const evidence = enrichment?.[provider];
    if (evidence?.active !== true) continue;
    for (const url of collectEvidenceLandingUrls(evidence, business)) {
      addCandidate(candidates, {
        url,
        provider,
        source: evidence.sourceProvider || "ads_evidence",
        active: true,
        sameDomain: sameRootDomain(url, businessRoot)
      });
    }
  }

  return candidates
    .sort((a, b) => candidatePriority(b) - candidatePriority(a))
    .slice(0, 8);
}

export function classifyLandingPage({ url, page = {}, business = {}, candidate = {} } = {}) {
  const text = pageText(page);
  const normalized = normalizeText(text);
  const html = String(page.html || "");
  const path = urlPath(url);
  const signals = [];
  let leadScore = 0;
  let ecommerceScore = 0;
  let otherScore = 0;
  const genericContactPage = isGenericContactPath(path);

  const addSignal = ({ target, id, label, weight, snippet }) => {
    const signal = { target, id, label, weight, snippet: snippet ? compactSnippet(snippet) : null };
    signals.push(signal);
    if (target === "lead_generation") leadScore += weight;
    if (target === "ecommerce") ecommerceScore += weight;
    if (target === "other") otherScore += weight;
  };

  const transactionalForm = /<form[^>]+(?:product-form|cart|checkout|add-to-cart|woocommerce|shopify)/i.test(html) ||
    /<(?:button|input|a)[^>]+(?:add-to-cart|ajax_add_to_cart|single_add_to_cart|name=["']add-to-cart)/i.test(html);
  if ((/<form\b/i.test(html) || /elementor-form|wpforms|gform_|wpcf7|contact-form-7/i.test(html)) && !transactionalForm) {
    addSignal({
      target: "lead_generation",
      id: "form_present",
      label: genericContactPage ? "Generic form on contact page" : "Form present",
      weight: genericContactPage ? 0.6 : 2.2
    });
  }

  const customQuoteCopy = firstMatchedPattern(normalized, [
    /\b(?:maqueta|fotomontaje|diseno|diseño).{0,80}\b(?:gratis|sin compromiso|presupuesto)\b/i,
    /\b(?:presupuesto|cotizacion|cotización).{0,100}\b(?:sin compromiso|maqueta|asesoramiento|alternativas|ahorrar)\b/i,
    /\b(?:te enviamos|enviamos).{0,80}\b(?:maqueta|presupuesto|alternativas)\b/i,
    /\b(?:pedido|producto|sudaderas?|camisetas?|ropa).{0,80}\bpersonalizad[oa]s?\b/i,
    /\b(?:quiero|solicita|pide).{0,80}\b(?:diseno|diseño|maqueta|presupuesto)\b/i,
    /\bsin compromiso\b.{0,80}\b(?:maqueta|presupuesto|diseno|diseño|formulario)\b/i
  ]);
  if (customQuoteCopy) {
    addSignal({
      target: "lead_generation",
      id: "custom_quote_landing",
      label: "Custom quote landing copy",
      weight: 4.2,
      snippet: customQuoteCopy
    });
  }

  const leadIntegration = firstMatchedPattern(text, [
    /hubspot|hbspt\.forms|hsforms/i,
    /calendly|typeform|jotform|marketo|pardot|salesforce|pipedrive|zoho|activecampaign/i,
    /gravityforms|gform_|wpforms|wpcf7|contact-form-7|elementor-form/i
  ]);
  if (leadIntegration) {
    addSignal({
      target: "lead_generation",
      id: "lead_form_integration",
      label: "CRM or form integration",
      weight: /hubspot|marketo|pardot|salesforce|pipedrive/i.test(leadIntegration) ? 3.5 : 2.4,
      snippet: leadIntegration
    });
  }

  const leadCopy = firstMatchedPattern(normalized, [
    /\bsolicita(?:r)? (?:presupuesto|informacion|info|consulta|demo)\b/i,
    /\bpide (?:presupuesto|cita|consulta|informacion)\b/i,
    /\bte llamamos\b|\bllamanos\b|\bhabla con (?:un|nuestro|una)\b/i,
    /\bagenda (?:una )?(?:demo|llamada|consulta|cita)\b/i,
    /\breserva (?:tu )?(?:cita|consulta|demo)\b/i,
    /\bdiagnostico gratuito\b|\basesoramiento gratuito\b|\bcotiza\b|\bquote\b/i,
    /\bcontacta con nuestro equipo\b/i,
    /\bquiero (?:un )?(?:diseno|diseño|presupuesto|maqueta)\b/i
  ]);
  if (leadCopy) {
    addSignal({
      target: "lead_generation",
      id: "lead_generation_copy",
      label: "Lead-generation CTA copy",
      weight: 2.6,
      snippet: leadCopy
    });
  }

  if (/\b(whatsapp|wa\.me|api\.whatsapp\.com)\b/i.test(text) && /presupuesto|consulta|cita|informacion|cotizacion|cotización|asesoramiento|maqueta|demo|quote/i.test(normalized)) {
    addSignal({
      target: "lead_generation",
      id: "whatsapp_lead_cta",
      label: "WhatsApp CTA with lead copy",
      weight: 1.8
    });
  }

  if (/\/(?:landing|presupuesto|demo|consulta|cita|quote|cotizacion|lead)\b/i.test(path)) {
    addSignal({
      target: "lead_generation",
      id: "lead_landing_path",
      label: "Lead-oriented landing URL",
      weight: 1.8,
      snippet: path
    });
  }

  const checkoutIntegration = firstMatchedPattern(text, [
    /shopify|cdn\.shopify|ShopifyAnalytics/i,
    /wc-ajax|add-to-cart|product-form/i,
    /cart_url|checkout_url|data-product-id|schema\.org\/Product/i
  ]);
  if (checkoutIntegration) {
    addSignal({
      target: "ecommerce",
      id: "checkout_integration",
      label: "Checkout or product integration",
      weight: 3.2,
      snippet: checkoutIntegration
    });
  }

  const ecommerceInfrastructure = firstMatchedPattern(text, [
    /woocommerce|wp-content\/plugins\/woocommerce|prestashop|magento|bigcommerce/i
  ]);
  if (ecommerceInfrastructure) {
    addSignal({
      target: "ecommerce",
      id: "ecommerce_infrastructure",
      label: "Ecommerce infrastructure detected",
      weight: 0.8,
      snippet: ecommerceInfrastructure
    });
  }

  const ecommerceCopy = firstMatchedPattern(normalized, [
    /\banadir al carrito\b|\bañadir al carrito\b|\bagregar al carrito\b/i,
    /\bcomprar ahora\b|\bcheckout\b|\bfinalizar compra\b/i,
    /\bcarrito\b|\bcesta\b|\bpago seguro\b/i
  ]);
  if (ecommerceCopy) {
    addSignal({
      target: "ecommerce",
      id: "commerce_copy",
      label: "Shopping or checkout copy",
      weight: 2.5,
      snippet: ecommerceCopy
    });
  }

  const catalogRuntimeCopy = firstMatchedPattern(normalized, [
    /\b(?:ver carrito|carrito de compras|subtotal|total:|calcular envio|calcular envío)\b/i,
    /\b(?:solo quedan|no tenemos mas stock|no tenemos más stock|en stock|productos?\s+producto)\b/i,
    /\b(?:agregando|agregado al carrito|ver mas productos|ver más productos)\b/i
  ]);
  if (catalogRuntimeCopy) {
    addSignal({
      target: "ecommerce",
      id: "catalog_runtime_copy",
      label: "Cart and stock runtime copy",
      weight: 1.7,
      snippet: catalogRuntimeCopy
    });
  }

  if (/\/(?:products?|producto|collections?|tienda|shop|catalogo|categoria|cart|checkout)\b/i.test(path)) {
    addSignal({
      target: "ecommerce",
      id: "commerce_path",
      label: "Catalog or product URL",
      weight: 2.1,
      snippet: path
    });
  }

  const priceSignals = Array.from(text.matchAll(/(?:€|\$|\bEUR\b|\bARS\b)\s?\d{1,9}(?:[.,]\d{2})?|\b\d{1,9}(?:[.,]\d{2})?\s?(?:€|\$|\bEUR\b|\bARS\b)/gi)).slice(0, 6);
  if (priceSignals.length >= 2) {
    addSignal({
      target: "ecommerce",
      id: "multiple_prices",
      label: "Multiple price signals",
      weight: priceSignals.length >= 4 ? 1.4 : 0.9,
      snippet: priceSignals.map((match) => match[0]).join(" ")
    });
  }

  if (genericContactPage) {
    addSignal({
      target: "other",
      id: "generic_contact_page",
      label: "Generic contact page",
      weight: 2.2,
      snippet: path
    });
    leadScore = Math.max(0, leadScore - 1.4);
  }

  const highIntentLeadSignal = signals.some((signal) =>
    signal.target === "lead_generation" &&
    ["custom_quote_landing", "lead_form_integration", "lead_generation_copy", "lead_landing_path"].includes(signal.id)
  );
  const quoteLeadSignal = signals.some((signal) =>
    signal.target === "lead_generation" &&
    ["custom_quote_landing", "lead_landing_path"].includes(signal.id)
  );
  const strongTransactionalSignal = signals.some((signal) =>
    signal.target === "ecommerce" &&
    ["checkout_integration", "commerce_copy", "commerce_path", "catalog_runtime_copy"].includes(signal.id)
  );
  const ecommerceOverride = strongTransactionalSignal &&
    ecommerceScore >= 5 &&
    ecommerceScore >= leadScore - 0.5 &&
    !quoteLeadSignal;
  const leadOverride = highIntentLeadSignal &&
    leadScore >= 4 &&
    leadScore >= ecommerceScore - 1.5 &&
    (!strongTransactionalSignal || quoteLeadSignal || leadScore >= ecommerceScore + 2);
  let type = "other";
  let reason = "insufficient_campaign_intent_signal";
  if (ecommerceOverride) {
    type = "ecommerce";
    reason = "ecommerce_signals_won";
  } else if (leadOverride && (!genericContactPage || highIntentLeadSignal)) {
    type = "lead_generation";
    reason = "lead_generation_signals_won";
  } else if (strongTransactionalSignal && ecommerceScore >= 4.5 && ecommerceScore >= leadScore + 2) {
    type = "ecommerce";
    reason = "ecommerce_signals_won";
  } else if (leadScore >= 4 && leadScore >= ecommerceScore && (!genericContactPage || highIntentLeadSignal)) {
    type = "lead_generation";
    reason = genericContactPage ? "lead_specific_contact_page" : "lead_generation_signals_won";
  } else if (strongTransactionalSignal && ecommerceScore >= 4 && leadScore < 3) {
    type = "ecommerce";
    reason = "ecommerce_signals_won";
  }

  const winnerScore = type === "lead_generation" ? leadScore : type === "ecommerce" ? ecommerceScore : otherScore;
  const runnerUp = type === "lead_generation"
    ? Math.max(ecommerceScore, otherScore)
    : type === "ecommerce"
      ? Math.max(leadScore, otherScore)
      : Math.max(leadScore, ecommerceScore);
  let confidence = confidenceFromScores({ type, winnerScore, runnerUp, candidate });
  if (genericContactPage && type !== "lead_generation") confidence = Math.max(0.35, confidence - 0.08);

  return {
    type,
    confidence,
    landingUrl: url,
    provider: candidate.provider || null,
    source: candidate.source || null,
    reason,
    scores: {
      lead_generation: roundScore(leadScore),
      ecommerce: roundScore(ecommerceScore),
      other: roundScore(otherScore)
    },
    signals: signals
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 14),
    genericContactPage,
    sameDomain: candidate.sameDomain ?? null
  };
}

export function extractLandingUrlsFromText(text, { business = {} } = {}) {
  const prepared = decodeEntities(String(text || ""))
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  const matches = Array.from(prepared.matchAll(/https?:\/\/[^\s"'<>)}\]]+/gi)).map((match) => match[0]);
  const businessRoot = registrableDomain(extractHostname(business.website));
  const urls = [];
  for (const match of matches) {
    const normalized = normalizeLandingUrl(match);
    if (!normalized || isBlockedLandingUrl(normalized)) continue;
    if (!urls.includes(normalized)) urls.push(normalized);
  }
  return urls
    .sort((a, b) => Number(sameRootDomain(b, businessRoot)) - Number(sameRootDomain(a, businessRoot)))
    .slice(0, 12);
}

function collectEvidenceLandingUrls(evidence, business) {
  const direct = [
    evidence?.landingUrl,
    ...(Array.isArray(evidence?.landingUrls) ? evidence.landingUrls : []),
    ...(Array.isArray(evidence?.attempts) ? evidence.attempts.flatMap((attempt) => [
      attempt.landingUrl,
      ...(Array.isArray(attempt.landingUrls) ? attempt.landingUrls : [])
    ]) : [])
  ];
  const extracted = extractLandingUrlsFromText(JSON.stringify(evidence || {}), { business });
  return unique([...direct, ...extracted].map(normalizeLandingUrl));
}

function addCandidate(candidates, candidate) {
  const url = normalizeLandingUrl(candidate.url);
  if (!url || candidates.some((item) => item.url === url)) return;
  candidates.push({ ...candidate, url });
}

function fallbackBusinessCandidate(business) {
  const url = normalizeLandingUrl(business.website);
  return url
    ? [{
        url,
        provider: "website",
        source: "business_website_fallback",
        active: false,
        sameDomain: true,
        fallback: true
      }]
    : [];
}

function candidatePriority(candidate) {
  return (candidate.provider === "meta" ? 6 : candidate.provider === "google" ? 5 : 1) +
    (candidate.sameDomain ? 2 : 0) -
    (isGenericContactPath(urlPath(candidate.url)) ? 2 : 0);
}

function chooseBestClassification(evaluated) {
  const classified = evaluated.filter(Boolean);
  if (!classified.length) return null;
  return classified.sort((a, b) => {
    const typeRank = (item) => item.type === "lead_generation" || item.type === "ecommerce" ? 2 : 1;
    return typeRank(b) - typeRank(a) || b.confidence - a.confidence;
  })[0];
}

function emptyClassification({ now, reason, activeProviders = [], candidates = [], rejected = [], evaluated = [] }) {
  return {
    type: "unknown",
    confidence: 0.2,
    landingUrl: null,
    checkedAt: now.toISOString(),
    reason,
    activeProviders,
    provider: null,
    source: null,
    scores: { lead_generation: 0, ecommerce: 0, other: 0 },
    signals: [],
    rejected,
    evaluated,
    candidates: candidates.slice(0, 8)
  };
}

function confidenceFromScores({ type, winnerScore, runnerUp, candidate }) {
  if (type === "other") return 0.38;
  const gap = Math.max(0, winnerScore - runnerUp);
  let confidence = 0.48 + Math.min(0.3, winnerScore / 18) + Math.min(0.16, gap / 18);
  if (candidate?.fallback) confidence -= 0.14;
  if (candidate?.sameDomain === false) confidence -= 0.08;
  return roundScore(Math.min(0.95, Math.max(0.42, confidence)), 2);
}

function pageText(page) {
  const links = Array.isArray(page?.links) ? page.links.map((link) => `${link.text || ""} ${link.url || ""}`).join("\n") : "";
  return `${page?.metadata?.title || ""}\n${page?.markdown || ""}\n${page?.html || ""}\n${links}`.slice(0, 280000);
}

function normalizeLandingUrl(value) {
  if (!value) return "";
  let raw = String(value).trim().replace(/[.,;)\]}"']+$/g, "");
  raw = decodeEntities(raw).replace(/\\\//g, "/");
  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    parsed.hash = "";
    for (const param of URL_PARAM_NOISE) parsed.searchParams.delete(param);
    const redirect = redirectParam(parsed);
    if (redirect) return normalizeLandingUrl(redirect);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function redirectParam(parsed) {
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (
    host.endsWith("facebook.com") ||
    host.endsWith("google.com") ||
    host.endsWith("googleadservices.com") ||
    host.endsWith("l.instagram.com")
  ) {
    for (const key of ["u", "url", "q", "adurl", "target", "destination"]) {
      const value = parsed.searchParams.get(key);
      if (value?.startsWith("http")) return value;
    }
  }
  return "";
}

function isBlockedLandingUrl(value) {
  const host = extractHostname(value);
  return BLOCKED_LANDING_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function isGenericContactPath(path) {
  return /\/(?:contacto?|contact-us|contactenos|contactanos|ubicacion|localizacion)(?:\/|$)/i.test(path);
}

function sameRootDomain(url, root) {
  if (!root) return false;
  return registrableDomain(extractHostname(url)) === root;
}

function extractHostname(value) {
  if (!value) return "";
  try {
    return new URL(String(value).startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(value).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

function registrableDomain(host) {
  const parts = String(host || "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last = parts.at(-1);
  const second = parts.at(-2);
  if (last?.length === 2 && ["com", "co", "net", "org", "edu", "gov"].includes(second)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function urlPath(value) {
  try {
    return new URL(value).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function firstMatchedPattern(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[0]) return match[0];
  }
  return "";
}

function compactSnippet(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function roundScore(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}
