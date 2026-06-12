import { config } from "./config.mjs";
import { estimateDeepseekUsageCost } from "./aiUsage.mjs";
import { postDeepInfraJson } from "./deepinfraClient.mjs";

const DEFAULT_MAX_PAGES = 2;
const DEFAULT_MAX_VISIBLE_TEXT_CHARS = 9000;
const DEFAULT_MAX_EVIDENCE_CHARS = 18000;

const AI_TYPES = new Set(["lead_generation", "ecommerce", "other"]);

const BLOCKED_LANDING_HOSTS = [
  "facebook.com",
  "fb.com",
  "fbcdn.net",
  "instagram.com",
  "google.com",
  "google.fr",
  "google.es",
  "blog.google",
  "safety.google",
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
  aiClassifier,
  aiConfig = config.adsFunnelAi,
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
      evaluated.push(await classifyLandingPageForAds({ url, page, business, candidate, aiClassifier, aiConfig }));
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
    const fallbackAi = await classifyUnavailableLanding({ business, enrichment, activeProviders, crawlCandidates, rejected, evaluated, aiClassifier, aiConfig });
    if (fallbackAi) {
      return {
        ...fallbackAi,
        checkedAt: now.toISOString(),
        activeProviders,
        rejected,
        evaluated,
        candidates: crawlCandidates.slice(0, 8)
      };
    }
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
    ai: best.ai || null,
    rejected,
    evaluated: evaluated.map((item) => ({
      type: item.type,
      confidence: item.confidence,
      landingUrl: item.landingUrl,
      provider: item.provider || null,
      reason: item.reason,
      scores: item.scores,
      signals: item.signals.slice(0, 6),
      genericContactPage: item.genericContactPage,
      ai: item.ai || null
    })),
    candidates: crawlCandidates.slice(0, 8)
  };
}

async function classifyUnavailableLanding({ business = {}, enrichment = {}, activeProviders = [], crawlCandidates = [], rejected = [], evaluated = [], aiClassifier, aiConfig = config.adsFunnelAi } = {}) {
  if (!canUseAiClassifier({ aiClassifier, aiConfig })) return null;
  const evidence = {
    task: "ads_funnel_classification_without_crawlable_landing",
    business: {
      name: business.name || null,
      city: business.city || null,
      niche: business.niche || business.category || null,
      website: business.website || null
    },
    activeProviders,
    ads: Object.fromEntries(activeProviders.map((provider) => {
      const item = enrichment?.[provider] || {};
      return [provider, {
        active: item.active,
        sourceProvider: item.sourceProvider || null,
        sourceUrl: item.sourceUrl || null,
        reason: item.reason || null,
        landingUrls: item.landingUrls || [],
        samplePageName: item.samplePageName || null
      }];
    })),
    candidates: crawlCandidates.slice(0, 8),
    rejected: rejected.slice(0, 8),
    evaluated: evaluated.slice(0, 4).map((item) => ({
      type: item.type,
      reason: item.reason,
      landingUrl: item.landingUrl,
      confidence: item.confidence
    })),
    rules: [
      "If this is a local services business and active ads point to quote, call, WhatsApp, appointment, estimate, reformas or service pages, classify as lead_generation.",
      "Classify ecommerce only when the evidence points to direct catalog/cart/checkout purchase intent.",
      "Use other for brand awareness, informational pages, recruitment, or insufficient commercial action."
    ]
  };
  const rawResult = aiClassifier
    ? await aiClassifier({ evidence, aiConfig })
    : await classifyLandingWithDeepInfra({ evidence, aiConfig });
  const normalized = normalizeAiClassification(rawResult);
  if (!normalized) return null;
  return {
    type: normalized.type,
    confidence: normalized.confidence,
    landingUrl: crawlCandidates[0]?.url || business.website || null,
    reason: normalized.reason || "ai_unavailable_landing_classification",
    provider: activeProviders[0] || null,
    source: "ai_unavailable_landing_fallback",
    scores: normalized.scores || { lead_generation: 0, ecommerce: 0, other: 0 },
    signals: [{
      target: normalized.type,
      id: "ai_unavailable_landing_classifier",
      label: "Clasificador DeepSeek sin landing crawlable",
      weight: 2,
      snippet: normalized.summary || normalized.reason
    }],
    ai: {
      status: "classified",
      provider: aiConfig?.provider || "deepinfra",
      model: aiConfig?.model || null,
      evidenceChars: JSON.stringify(evidence).length,
      deterministicType: "unknown",
      deterministicConfidence: 0.2,
      summary: normalized.summary || null,
      usage: rawResult?.usage || null,
      cost: estimateDeepseekUsageCost(rawResult?.usage)
    }
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

async function classifyLandingPageForAds({ url, page = {}, business = {}, candidate = {}, aiClassifier, aiConfig = config.adsFunnelAi } = {}) {
  const deterministic = classifyLandingPage({ url, page, business, candidate });
  const evidence = buildLandingEvidencePack({
    url,
    page,
    business,
    candidate,
    deterministic,
    maxVisibleTextChars: aiConfig?.maxVisibleTextChars || DEFAULT_MAX_VISIBLE_TEXT_CHARS,
    maxEvidenceChars: aiConfig?.maxEvidenceChars || DEFAULT_MAX_EVIDENCE_CHARS
  });
  if (!canUseAiClassifier({ aiClassifier, aiConfig })) {
    return aiRequiredLandingClassification({ deterministic, evidence, aiConfig });
  }

  try {
    const rawResult = aiClassifier
      ? await aiClassifier({ evidence, deterministic, aiConfig })
      : await classifyLandingWithDeepInfra({ evidence, aiConfig });
    return mergeAiClassification({ deterministic, rawResult, evidence, aiConfig });
  } catch (error) {
    return aiFailedLandingClassification({ deterministic, evidence, aiConfig, error });
  }
}

function canUseAiClassifier({ aiClassifier, aiConfig }) {
  if (aiClassifier) return true;
  return Boolean(aiConfig && aiConfig.mode !== "never" && aiConfig.provider === "deepinfra" && aiConfig.apiKey);
}

export function buildLandingEvidencePack({
  url,
  page = {},
  business = {},
  candidate = {},
  deterministic = {},
  maxVisibleTextChars = DEFAULT_MAX_VISIBLE_TEXT_CHARS,
  maxEvidenceChars = DEFAULT_MAX_EVIDENCE_CHARS
} = {}) {
  const html = String(page.html || "");
  const links = normalizeEvidenceLinks(page.links);
  const ctas = extractCtas(html, links);
  const forms = extractForms(html);
  const visibleText = compactEvidenceText([
    page?.metadata?.title,
    page?.markdown,
    cleanLandingHtml(html, { maxChars: maxVisibleTextChars }),
    links.map((link) => `${link.text} ${link.url}`).join("\n")
  ], maxVisibleTextChars);
  const evidence = {
    task: "ads_landing_funnel_classification",
    schemaVersion: 1,
    allowedTypes: ["lead_generation", "ecommerce", "other"],
    business: compactObject({
      name: business.name,
      website: business.website,
      city: business.city,
      niche: business.niche || business.category
    }),
    landing: compactObject({
      url,
      path: urlPath(url),
      provider: candidate.provider || null,
      source: candidate.source || null,
      sameDomain: candidate.sameDomain ?? null,
      genericContactPage: deterministic.genericContactPage === true
    }),
    deterministic: {
      type: deterministic.type,
      confidence: deterministic.confidence,
      reason: deterministic.reason,
      scores: deterministic.scores,
      signals: compactSignals(deterministic.signals)
    },
    extracted: {
      visibleText,
      ctas,
      forms,
      keyLinks: extractKeyLinks(links, ctas),
      technologySignals: extractTechnologySignals({ html, text: visibleText, links }),
      structuredDataTypes: extractJsonLdTypes(html)
    },
    decisionRules: [
      "Classify ecommerce when the landing lets the user directly buy, add products to cart, checkout, browse a catalog, pick variants, see stock, or complete payment.",
      "Classify lead_generation when the primary objective is quote/demo/consultation/call/appointment capture through a form, phone, WhatsApp, calendar, CRM form, or explicit sales contact CTA.",
      "Do not classify a generic contact page or newsletter as lead_generation unless the ad landing has specific quote/demo/appointment intent.",
      "If WooCommerce/Shopify exists but the landing is a custom quote funnel without direct checkout, prefer lead_generation.",
      "If both appear, decide by the primary CTA and the final user action on this exact landing."
    ]
  };
  return enforceEvidenceBudget(evidence, maxEvidenceChars, maxVisibleTextChars);
}

export function cleanLandingHtml(html, { maxChars = DEFAULT_MAX_VISIBLE_TEXT_CHARS } = {}) {
  if (!html) return "";
  const text = decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|li|ul|ol|h[1-6]|tr|td|th|form|button|a)>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
  return compactEvidenceText([text], maxChars);
}

async function classifyLandingWithDeepInfra({ evidence, aiConfig = config.adsFunnelAi } = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 700,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You classify the business objective of an ads landing page.",
          "Return only valid JSON. Do not include markdown.",
          "Allowed type values: lead_generation, ecommerce, other.",
          "Be strict: a CRM/form/CTA must be tied to quote/demo/call/appointment intent for lead_generation.",
          "Direct cart, checkout, product catalog, stock, variants, prices and payment flow usually mean ecommerce."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            type: "lead_generation|ecommerce|other",
            confidence: "number 0..1",
            reason: "short snake_case reason",
            scores: { lead_generation: "0..10", ecommerce: "0..10", other: "0..10" },
            winningSignals: ["short evidence strings"],
            rejectedSignals: ["short evidence strings"],
            landingSummary: "one short sentence"
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
  const parsed = parseAiJson(json?.choices?.[0]?.message?.content);
  if (normalizeAiClassification(parsed)) {
    return {
      ...parsed,
      usage: json?.usage || null
    };
  }

  const repairBody = {
    model,
    temperature: 0,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You repair an ads landing page classification into strict JSON.",
          "Return exactly one JSON object with type, confidence, reason, scores, winningSignals, rejectedSignals, landingSummary.",
          "type must be one of: lead_generation, ecommerce, other.",
          "Do not include markdown or extra keys."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          previousInvalidResult: parsed || json?.choices?.[0]?.message?.content || null,
          evidence
        })
      }
    ]
  };
  let repairedJson;
  try {
    repairedJson = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: repairBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackRepairBody = { ...repairBody };
    delete fallbackRepairBody.response_format;
    repairedJson = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackRepairBody, timeoutMs: aiConfig?.requestTimeoutMs || 45000 });
  }
  return {
    ...parseAiJson(repairedJson?.choices?.[0]?.message?.content),
    usage: combineUsage(json?.usage, repairedJson?.usage)
  };
}

function mergeAiClassification({ deterministic, rawResult, evidence, aiConfig }) {
  const result = normalizeAiClassification(rawResult);
  if (!result) {
    return aiInvalidLandingClassification({ deterministic, rawResult, evidence, aiConfig });
  }
  const primarySignal = {
    target: result.type,
    id: "ai_landing_classifier",
    label: "Clasificador DeepSeek",
    weight: 5,
    snippet: result.summary || result.reason
  };
  const aiSignals = result.winningSignals.slice(0, 5).map((snippet, index) => ({
    target: result.type,
    id: `ai_winning_signal_${index + 1}`,
    label: "Señal validada por DeepSeek",
    weight: Math.max(1, 3 - index * 0.3),
    snippet: compactSnippet(snippet)
  }));
  const rejectedSignals = result.rejectedSignals.slice(0, 5).map((snippet, index) => ({
    target: "other",
    id: `ai_rejected_signal_${index + 1}`,
    label: "Señal descartada por DeepSeek",
    weight: 0,
    snippet: compactSnippet(snippet)
  }));
  return {
    ...deterministic,
    type: result.type,
    confidence: result.confidence,
    reason: result.reason || "ai_landing_classification",
    scores: result.scores || deterministic.scores,
    signals: [primarySignal, ...aiSignals, ...deterministic.signals, ...rejectedSignals]
      .filter(Boolean)
      .slice(0, 16),
    ai: {
      status: "classified",
      provider: aiConfig?.provider || "deepinfra",
      model: aiConfig?.model || null,
      evidenceChars: JSON.stringify(evidence).length,
      deterministicType: deterministic.type,
      deterministicConfidence: deterministic.confidence,
      summary: result.summary || null,
      usage: rawResult?.usage || null,
      cost: estimateDeepseekUsageCost(rawResult?.usage)
    }
  };
}

function aiRequiredLandingClassification({ deterministic = {}, evidence, aiConfig } = {}) {
  return unknownAiLandingClassification({
    deterministic,
    reason: "ai_required_but_unavailable",
    ai: landingAiMetadata({ status: "required_unavailable", deterministic, evidence, aiConfig })
  });
}

function aiFailedLandingClassification({ deterministic = {}, evidence, aiConfig, error } = {}) {
  return unknownAiLandingClassification({
    deterministic,
    reason: "ai_classification_failed",
    ai: {
      ...landingAiMetadata({ status: "failed", deterministic, evidence, aiConfig }),
      error: error.message
    }
  });
}

function aiInvalidLandingClassification({ deterministic = {}, rawResult, evidence, aiConfig } = {}) {
  return unknownAiLandingClassification({
    deterministic,
    reason: "ai_invalid_response",
    ai: landingAiMetadata({ status: "invalid_response", deterministic, evidence, aiConfig, rawResult })
  });
}

function unknownAiLandingClassification({ deterministic = {}, reason, ai } = {}) {
  return {
    ...deterministic,
    type: "unknown",
    confidence: 0.2,
    reason,
    scores: { lead_generation: 0, ecommerce: 0, other: 0 },
    signals: [],
    ai
  };
}

function landingAiMetadata({ status, deterministic = {}, evidence, aiConfig, rawResult } = {}) {
  return {
    status,
    provider: aiConfig?.provider || "deepinfra",
    model: aiConfig?.model || null,
    evidenceChars: JSON.stringify(evidence || {}).length,
    deterministicType: deterministic.type || null,
    deterministicConfidence: deterministic.confidence ?? null,
    deterministicReason: deterministic.reason || null,
    deterministicScores: deterministic.scores || null,
    usage: rawResult?.usage || null,
    cost: estimateDeepseekUsageCost(rawResult?.usage)
  };
}

function normalizeAiClassification(rawResult) {
  if (!rawResult || typeof rawResult !== "object") return null;
  const type = AI_TYPES.has(rawResult.type) ? rawResult.type : null;
  if (!type) return null;
  const scores = rawResult.scores && typeof rawResult.scores === "object"
    ? {
        lead_generation: roundScore(rawResult.scores.lead_generation),
        ecommerce: roundScore(rawResult.scores.ecommerce),
        other: roundScore(rawResult.scores.other)
      }
    : null;
  return {
    type,
    confidence: clampConfidence(rawResult.confidence, type),
    reason: normalizeReason(rawResult.reason) || "ai_landing_classification",
    scores,
    winningSignals: normalizeStringArray(rawResult.winningSignals || rawResult.winning_signals),
    rejectedSignals: normalizeStringArray(rawResult.rejectedSignals || rawResult.rejected_signals),
    summary: compactSnippet(rawResult.landingSummary || rawResult.summary || rawResult.explanation)
  };
}

function parseAiJson(content) {
  const raw = String(content || "").trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function combineUsage(...usages) {
  const valid = usages.filter((usage) => usage && typeof usage === "object");
  if (!valid.length) return null;
  const total = {};
  for (const usage of valid) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number") total[key] = (total[key] || 0) + value;
    }
  }
  return Object.keys(total).length ? total : null;
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

function normalizeEvidenceLinks(links) {
  return (Array.isArray(links) ? links : [])
    .map((link) => ({
      text: compactSnippet(link?.text || link?.title || ""),
      url: normalizeLandingUrl(link?.url || link?.href || "")
    }))
    .filter((link) => link.url || link.text)
    .slice(0, 80);
}

function extractCtas(html, links = []) {
  const items = [];
  const source = String(html || "");
  for (const match of source.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const text = cleanLandingHtml(match[3], { maxChars: 160 });
    const href = normalizeLandingUrl(attr(match[2], "href"));
    const classes = compactSnippet([attr(match[2], "class"), attr(match[2], "id"), attr(match[2], "name")].filter(Boolean).join(" "));
    if (!text && !href && !classes) continue;
    items.push(compactObject({
      kind: match[1].toLowerCase(),
      text,
      href,
      classes,
      intent: classifyCtaIntent(`${text} ${href} ${classes}`)
    }));
  }
  for (const match of source.matchAll(/<input\b([^>]*?)>/gi)) {
    const type = attr(match[1], "type").toLowerCase();
    if (!["submit", "button"].includes(type)) continue;
    const text = attr(match[1], "value") || attr(match[1], "aria-label") || type;
    items.push(compactObject({
      kind: "input",
      text: compactSnippet(text),
      classes: compactSnippet([attr(match[1], "class"), attr(match[1], "id"), attr(match[1], "name")].filter(Boolean).join(" ")),
      intent: classifyCtaIntent(text)
    }));
  }
  for (const link of links.slice(0, 40)) {
    const intent = classifyCtaIntent(`${link.text} ${link.url}`);
    if (intent !== "other") {
      items.push(compactObject({ kind: "link", text: link.text, href: link.url, intent }));
    }
  }
  return dedupeObjects(items, (item) => `${item.kind}:${item.text}:${item.href || ""}`)
    .filter((item) => item.text || item.href)
    .slice(0, 28);
}

function extractForms(html) {
  const forms = [];
  const source = String(html || "");
  for (const match of source.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const haystack = normalizeText(`${attrs} ${body}`);
    const fields = [];
    for (const field of body.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
      fields.push(compactObject({
        tag: field[1].toLowerCase(),
        type: attr(field[2], "type") || (field[1].toLowerCase() === "textarea" ? "textarea" : ""),
        name: attr(field[2], "name") || attr(field[2], "id"),
        placeholder: compactSnippet(attr(field[2], "placeholder") || attr(field[2], "aria-label"))
      }));
    }
    const submitText = Array.from(body.matchAll(/<(?:button|input)\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*?)>/gi))
      .map((button) => cleanLandingHtml(button[2] || attr(button[1] || button[3], "value"), { maxChars: 80 }))
      .filter(Boolean)
      .slice(0, 4);
    forms.push(compactObject({
      action: normalizeLandingUrl(attr(attrs, "action")),
      classes: compactSnippet([attr(attrs, "class"), attr(attrs, "id"), attr(attrs, "name")].filter(Boolean).join(" ")),
      fields: fields.slice(0, 14),
      submitText,
      transactional: /product-form|cart|checkout|add-to-cart|woocommerce|shopify|quantity|variation|coupon/.test(haystack),
      leadIntent: /email|e-mail|telefono|teléfono|phone|nombre|name|empresa|company|mensaje|message|presupuesto|consulta|demo|cita|quote|cotizacion|cotización/.test(haystack)
    }));
  }
  return forms.slice(0, 8);
}

function extractKeyLinks(links, ctas = []) {
  const all = [
    ...links,
    ...ctas.map((cta) => ({ text: cta.text, url: cta.href })).filter((link) => link.url)
  ];
  return dedupeObjects(all, (link) => link.url)
    .filter((link) => {
      const haystack = normalizeText(`${link.text} ${link.url}`);
      return /cart|carrito|checkout|finalizar|comprar|product|producto|shop|tienda|catalog|categoria|collection|contact|contacto|presupuesto|demo|cita|consulta|quote|whatsapp|wa\.me|calendly|typeform|hubspot|mailto:|tel:/.test(haystack);
    })
    .map((link) => compactObject({
      text: link.text,
      url: link.url,
      intent: classifyCtaIntent(`${link.text} ${link.url}`)
    }))
    .slice(0, 35);
}

function extractTechnologySignals({ html, text, links = [] }) {
  const haystack = `${html || ""}\n${text || ""}\n${links.map((link) => `${link.text} ${link.url}`).join("\n")}`;
  const checks = [
    ["ecommerce", "shopify", /shopify|cdn\.shopify|ShopifyAnalytics/i],
    ["ecommerce", "woocommerce", /woocommerce|wc-ajax|wp-content\/plugins\/woocommerce/i],
    ["ecommerce", "prestashop", /prestashop/i],
    ["ecommerce", "magento", /magento/i],
    ["ecommerce", "bigcommerce", /bigcommerce/i],
    ["ecommerce", "stripe_or_paypal", /stripe|paypal|klarna|redsys|mercadopago/i],
    ["lead_generation", "hubspot", /hubspot|hbspt\.forms|hsforms/i],
    ["lead_generation", "calendly", /calendly/i],
    ["lead_generation", "typeform_or_jotform", /typeform|jotform/i],
    ["lead_generation", "crm_or_marketing_form", /marketo|pardot|salesforce|pipedrive|zoho|activecampaign/i],
    ["lead_generation", "wordpress_form_plugin", /gravityforms|gform_|wpforms|wpcf7|contact-form-7|elementor-form/i],
    ["lead_generation", "whatsapp", /wa\.me|api\.whatsapp\.com|whatsapp/i]
  ];
  return checks
    .filter(([, , pattern]) => pattern.test(haystack))
    .map(([target, value]) => ({ target, value }))
    .slice(0, 18);
}

function extractJsonLdTypes(html) {
  const types = [];
  for (const match of String(html || "").matchAll(/<script\b[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const json = decodeEntities(match[1]).trim();
    for (const typeMatch of json.matchAll(/"@type"\s*:\s*"?([A-Za-z0-9_-]+)/g)) {
      if (!types.includes(typeMatch[1])) types.push(typeMatch[1]);
    }
    if (/"offers?"\s*:/i.test(json) && !types.includes("Offer")) types.push("Offer");
    if (/"price"\s*:/i.test(json) && !types.includes("Price")) types.push("Price");
  }
  return types.slice(0, 12);
}

function compactEvidenceText(parts, maxChars) {
  const seen = new Set();
  const chunks = [];
  for (const part of parts.flatMap((item) => String(item || "").split(/\n+/))) {
    const compact = decodeEntities(part)
      .replace(/https?:\/\/\S+/gi, (url) => normalizeLandingUrl(url) || " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
    if (!compact || compact.length < 2) continue;
    const key = normalizeText(compact).slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    chunks.push(compact);
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").slice(0, maxChars).trim();
}

function compactSignals(signals = []) {
  return (Array.isArray(signals) ? signals : [])
    .map((signal) => compactObject({
      target: signal.target,
      id: signal.id,
      label: signal.label,
      weight: signal.weight,
      snippet: signal.snippet
    }))
    .slice(0, 12);
}

function enforceEvidenceBudget(evidence, maxEvidenceChars, maxVisibleTextChars) {
  let result = evidence;
  let serialized = JSON.stringify(result);
  if (serialized.length <= maxEvidenceChars) return result;
  result = {
    ...result,
    extracted: {
      ...result.extracted,
      visibleText: result.extracted.visibleText.slice(0, Math.max(1500, Math.floor(maxVisibleTextChars * 0.55))),
      ctas: result.extracted.ctas.slice(0, 18),
      forms: result.extracted.forms.slice(0, 5),
      keyLinks: result.extracted.keyLinks.slice(0, 18)
    }
  };
  serialized = JSON.stringify(result);
  if (serialized.length <= maxEvidenceChars) return result;
  return {
    ...result,
    extracted: {
      ...result.extracted,
      visibleText: result.extracted.visibleText.slice(0, 2500),
      ctas: result.extracted.ctas.slice(0, 10),
      forms: result.extracted.forms.slice(0, 3),
      keyLinks: result.extracted.keyLinks.slice(0, 10)
    }
  };
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

function attr(attrs, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const quoted = String(attrs || "").match(pattern);
  if (quoted?.[2]) return decodeEntities(quoted[2]).trim();
  const unquoted = String(attrs || "").match(new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, "i"));
  return unquoted?.[1] ? decodeEntities(unquoted[1]).trim() : "";
}

function classifyCtaIntent(value) {
  const text = normalizeText(value);
  if (/add-to-cart|agregar al carrito|anadir al carrito|añadir al carrito|comprar|checkout|finalizar compra|carrito|cesta|shop|tienda|producto|catalogo|catálogo|collection|stock|precio|oferta/.test(text)) {
    return "ecommerce";
  }
  if (/presupuesto|cotizacion|cotización|consulta|demo|cita|llamada|te llamamos|contacta|contacto|habla con|quote|calendly|typeform|hubspot|whatsapp|wa\.me|mailto:|tel:|agenda/.test(text)) {
    return "lead_generation";
  }
  return "other";
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => {
      if (value == null || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value).length > 0;
      return true;
    })
  );
}

function dedupeObjects(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function clampConfidence(value, type) {
  const parsed = Number(value);
  const fallback = type === "other" ? 0.55 : 0.78;
  if (!Number.isFinite(parsed)) return fallback;
  return roundScore(Math.min(0.97, Math.max(0.35, parsed)), 2);
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

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => compactSnippet(typeof item === "string" ? item : JSON.stringify(item)))
    .filter(Boolean)
    .slice(0, 8);
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
    .replace(/&#(\d+);/g, (_, code) => {
      const parsed = Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const parsed = Number.parseInt(code, 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : " ";
    })
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&[a-z0-9#]+;/gi, " ");
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function roundScore(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}
