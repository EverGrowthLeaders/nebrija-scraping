import { config } from "./config.mjs";
import { estimateDeepseekUsageCost } from "./aiUsage.mjs";
import { postDeepInfraJson } from "./deepinfraClient.mjs";
import { extractEmails, extractPhones } from "./extractors.mjs";
import { normalizeSpanishPhone } from "./phone.mjs";

const LINKEDIN_PROFILE_HOSTS = ["linkedin.com"];
const DEFAULT_MAX_AI_EVIDENCE_CHARS = 12000;
const DEFAULT_MAX_WEBSITE_DECISION_PAGES = 6;
const WEBSITE_DECISION_PAGE_TEXT_CHARS = 2200;
const ROLE_PATTERNS = [
  /\b(ceo|founder|cofounder|co-founder|owner|partner|managing director)\b/i,
  /\b(gerente|director|directora|propietario|propietaria|fundador|fundadora|socio|socia|administrador|administradora|responsable)\b/i
];

export async function enrichDecisionMaker({
  business = {},
  contacts = [],
  searchClient,
  websiteScraper,
  aiSearchPlanner,
  aiResolver,
  aiVerifier,
  websiteResolver,
  websiteUrlPlanner,
  aiConfig = config.decisionMakerAi,
  now = new Date()
} = {}) {
  if (!searchClient?.search || !business.name) {
    return emptyDecisionMakerResult({ business, now, reason: "missing_required_fields" });
  }

  const websiteDecisionMaker = await enrichDecisionMakerFromWebsite({
    business,
    contacts,
    firecrawl: websiteScraper || searchClient,
    aiConfig,
    aiUrlPlanner: websiteUrlPlanner,
    aiResolver: websiteResolver,
    now
  });
  const searchPlan = await planDecisionMakerSearch({ business, contacts, aiSearchPlanner, aiConfig, now });
  const search = await runEscalatedDecisionMakerSearch({ business, searchClient, searchPlan, now });
  const deterministic = selectDecisionMakerFromSearchResults({
    business,
    query: search.queries[0],
    queries: search.queries,
    searchPlan: search.searchPlan,
    results: search.results,
    linkedinCompany: search.linkedinCompany,
    accessContacts: buildAccessContacts({ business, contacts, linkedinCompany: search.linkedinCompany }),
    websiteDecisionMaker,
    now
  });

  if (!shouldUseAiDecisionMakerResolver({ deterministic, aiResolver, aiConfig })) {
    return aiRequiredDecisionMakerResult({ deterministic, aiConfig });
  }

  try {
    const rawResult = aiResolver
      ? await aiResolver({
          business,
          query: deterministic.query,
          queries: deterministic.queries || [],
          searchPlan: deterministic.searchPlan || null,
          candidates: deterministic.candidates || [],
          searchResults: deterministic.searchResults || [],
          accessContacts: deterministic.accessContacts || [],
          linkedinCompany: deterministic.linkedinCompany || null,
          websiteDecisionMaker,
          deterministic,
          aiConfig
        })
      : await resolveDecisionMakerWithDeepInfra({
          business,
          query: deterministic.query,
          queries: deterministic.queries || [],
          searchPlan: deterministic.searchPlan || null,
          candidates: deterministic.candidates || [],
          searchResults: deterministic.searchResults || [],
          accessContacts: deterministic.accessContacts || [],
          linkedinCompany: deterministic.linkedinCompany || null,
          websiteDecisionMaker,
          deterministic,
          aiConfig
        });
    const resolved = mergeAiDecisionMakerResult({
      deterministic,
      rawResult,
      aiConfig,
      requireAiPlannedSearch: shouldRequireAiPlannedDecisionMakerSearch({ aiResolver, aiConfig })
    });
    const merged = mergeWebsiteDecisionMakerResult({ resolved, websiteDecisionMaker, now });
    if (!canUseDecisionMakerVerifier({ aiVerifier, aiConfig }) || merged.found !== true || !merged.decisionMaker?.linkedinUrl) return merged;
    const verified = await verifyDecisionMakerResolution({
      business,
      deterministic,
      resolved: merged,
      aiVerifier,
      aiConfig
    });
    return mergeWebsiteDecisionMakerResult({ resolved: verified, websiteDecisionMaker, now });
  } catch (error) {
    const failed = unverifiedDecisionMakerResult({
      deterministic,
      reason: "ai_resolution_failed",
      ai: {
        status: "failed",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null,
        error: error.message
      }
    });
    return mergeWebsiteDecisionMakerResult({ resolved: failed, websiteDecisionMaker, now });
  }
}

export function buildLinkedInDecisionMakerDork(business = {}) {
  const [company] = companySearchNames(business);
  const city = String(business.city || "").trim();
  return city ? `site:linkedin.com/in/ "${company}" "${city}"` : `site:linkedin.com/in/ "${company}"`;
}

export function buildLinkedInDecisionMakerQueries(business = {}) {
  const names = companySearchNames(business);
  const company = names[0];
  const city = String(business.city || "").trim();
  const compact = compactCompanyToken(company);
  const queries = [
    ...names.flatMap((name) => [
      city ? `site:linkedin.com/in/ "${name}" "${city}"` : "",
      `site:linkedin.com/in/ "${name}"`,
      `site:linkedin.com/in/ "${name}" gerente OR fundador OR socio OR director`,
      city ? `site:linkedin.com/company/ "${name}" "${city}"` : `site:linkedin.com/company/ "${name}"`
    ]),
    compact ? `site:linkedin.com/in/ "${compact}"` : "",
    compact ? `site:linkedin.com/company/ "${compact}"` : ""
  ].filter(Boolean);
  return [...new Set(queries)];
}

export function selectDecisionMakerFromSearchResults({
  business = {},
  query,
  queries,
  searchPlan,
  results = [],
  linkedinCompany,
  accessContacts,
  websiteDecisionMaker,
  now = new Date()
} = {}) {
  const candidates = results
    .map((result, index) => buildDecisionMakerCandidate({ business, query: result.query || query, result, index, now }))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || null;
  const company = linkedinCompany || selectLinkedInCompanyFromSearchResults({ business, results });
  const contacts = accessContacts || buildAccessContacts({ business, contacts: [], linkedinCompany: company });
  const searchResults = normalizeDecisionMakerSearchResults({ results, queries: queries || (query ? [query] : []) });
  if (!best || best.confidence < 0.55) {
    return {
      found: false,
      decisionStatus: contacts.length || company ? "access_contact" : "not_found",
      checkedAt: now.toISOString(),
      query,
      queries: queries || (query ? [query] : []),
      searchPlan: searchPlan || null,
      reason: best ? "low_confidence_match" : "no_linkedin_profile_match",
      linkedinCompany: company || null,
      websiteDecisionMaker: websiteDecisionMaker || null,
      accessContacts: contacts,
      recommendedAccessContact: contacts[0] || null,
      searchResults,
      candidates: candidates.slice(0, 5)
    };
  }
  return {
    found: true,
    decisionStatus: "verified",
    checkedAt: now.toISOString(),
    query,
    queries: queries || (query ? [query] : []),
    searchPlan: searchPlan || null,
    decisionMaker: best,
    linkedinCompany: company || null,
    websiteDecisionMaker: websiteDecisionMaker || null,
    accessContacts: contacts,
    recommendedAccessContact: contacts[0] || null,
    searchResults,
    candidates: candidates.slice(0, 5)
  };
}

export async function enrichDecisionMakerFromWebsite({
  business = {},
  contacts = [],
  firecrawl,
  aiUrlPlanner,
  aiResolver,
  aiConfig = config.decisionMakerAi,
  now = new Date()
} = {}) {
  if (!business.website || !firecrawl?.scrape || (!aiResolver && !canUseDecisionMakerSearchPlanner({ aiConfig }))) {
    return null;
  }
  const checkedAt = now.toISOString();
  try {
    const homePage = await firecrawl.scrape(business.website, { formats: ["markdown", "html", "links"] });
    const homeUrl = normalizeWebsiteUrl(business.website, business.website);
    const urlsWithAnchors = extractWebsiteUrlsWithAnchors({
      rootUrl: business.website,
      links: homePage.links || [],
      html: homePage.html || ""
    });
    const plannedUrls = await planDecisionMakerWebsiteUrls({
      business,
      urlsWithAnchors,
      aiUrlPlanner,
      aiConfig
    });
    const selectedUrls = uniqueStrings([
      homeUrl,
      ...plannedUrls.urls.map((url) => normalizeWebsiteUrl(url, business.website))
    ]).filter(Boolean).slice(0, DEFAULT_MAX_WEBSITE_DECISION_PAGES);

    const pages = [];
    for (const url of selectedUrls) {
      try {
        const page = url === homeUrl ? homePage : await firecrawl.scrape(url, { formats: ["markdown", "html", "links"] });
        pages.push(compactWebsiteDecisionPage({ url, page }));
      } catch (error) {
        pages.push({ url, status: "error", error: error.message });
      }
    }
    const rawResult = aiResolver
      ? await aiResolver({ business, contacts, pages, plannedUrls, aiConfig })
      : await resolveDecisionMakerWebsiteWithDeepInfra({ business, contacts, pages, plannedUrls, aiConfig });
    const normalized = normalizeWebsiteDecisionMakerResult(rawResult, { business, pages, checkedAt, aiConfig });
    return {
      ...normalized,
      checkedAt,
      urlPlan: {
        ...(plannedUrls.ai ? { ai: plannedUrls.ai } : {}),
        urls: plannedUrls.urls
      },
      pages: pages.map((page) => ({
        url: page.url,
        status: page.status || "ok",
        emails: page.emails || [],
        phones: page.phones || []
      }))
    };
  } catch (error) {
    return {
      status: "error",
      found: false,
      checkedAt,
      reason: "website_scrape_failed",
      error: error.message
    };
  }
}

function extractWebsiteUrlsWithAnchors({ rootUrl, links = [], html = "" } = {}) {
  const rows = [];
  const add = (url, text = "") => {
    const normalized = normalizeWebsiteUrl(url, rootUrl);
    if (!normalized || !isSameWebsiteUrl(normalized, rootUrl) || isBlockedWebsiteDecisionUrl(normalized)) return;
    if (rows.some((row) => normalizeUrlForDedupe(row.url) === normalizeUrlForDedupe(normalized))) return;
    rows.push({
      url: normalized,
      text: cleanText(text || "") || "Sin texto"
    });
  };
  for (const link of links || []) add(link.url || link.href, link.text || link.title);
  for (const match of String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(match[1], cleanHtmlText(match[2]));
  }
  return rows.slice(0, 80);
}

async function planDecisionMakerWebsiteUrls({
  business = {},
  urlsWithAnchors = [],
  aiUrlPlanner,
  aiConfig = config.decisionMakerAi
} = {}) {
  const seeded = seedDecisionMakerWebsiteUrls(urlsWithAnchors);
  if (!urlsWithAnchors.length) return { urls: seeded, ai: { status: "no_urls" } };
  try {
    const rawPlan = aiUrlPlanner
      ? await aiUrlPlanner({ business, urlsWithAnchors, seedUrls: seeded, aiConfig })
      : await planDecisionMakerWebsiteUrlsWithDeepInfra({ business, urlsWithAnchors, seedUrls: seeded, aiConfig });
    const normalized = normalizeWebsiteUrlPlan(rawPlan, business.website);
    if (!normalized.urls.length) {
      return { urls: seeded, ai: { status: "invalid_response_repaired_to_seed", rawPlan } };
    }
    return {
      urls: uniqueStrings([...normalized.urls, ...seeded]).slice(0, DEFAULT_MAX_WEBSITE_DECISION_PAGES),
      ai: {
        status: "planned",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null,
        usage: rawPlan?.usage || null,
        cost: estimateDeepseekUsageCost(rawPlan?.usage)
      }
    };
  } catch (error) {
    return {
      urls: seeded,
      ai: {
        status: "failed",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null,
        error: error.message
      }
    };
  }
}

function seedDecisionMakerWebsiteUrls(urlsWithAnchors = []) {
  return urlsWithAnchors
    .map((entry) => ({
      url: entry.url,
      score: websiteDecisionUrlScore(`${entry.url} ${entry.text}`)
    }))
    .sort((a, b) => b.score - a.score)
    .filter((entry) => entry.score > 0)
    .slice(0, DEFAULT_MAX_WEBSITE_DECISION_PAGES)
    .map((entry) => entry.url);
}

async function planDecisionMakerWebsiteUrlsWithDeepInfra({
  business = {},
  urlsWithAnchors = [],
  seedUrls = [],
  aiConfig = config.decisionMakerAi
} = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 350,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Eres un experto en enriquecer listas de Leads. Devuelve solo JSON valido, sin markdown."
      },
      {
        role: "user",
        content: [
          "Te voy a pasar un listado de URLs con su correspondiente Anchor text.",
          "Necesito que me devuelvas un listado con todas las URLs que tienen mas potencial de contener informacion de contacto como el email, movil o el nombre del encargado/ceo/propietario del negocio.",
          "Suelen funcionar bien los siguientes tipos de pagina: Contacto, Conocenos, Equipo, Aviso legal, Politica de privacidad.",
          "Usa tanto la ruta de la URL como el anchor text para priorizar.",
          "No des mas indicaciones, solo las URLs que debe priorizar.",
          "",
          JSON.stringify({
            outputSchema: { urls: ["https://dominio.com/contacto"] },
            negocio: compactObject({
              nombre: business.name,
              direccion: business.address,
              ciudad: business.city,
              dominio: business.website
            }),
            seedUrls,
            urlsWithAnchors: urlsWithAnchors.slice(0, 70).map((entry) => `URL: ${entry.url} | Texto: ${entry.text}`)
          })
        ].join("\n")
      }
    ]
  };
  let json;
  try {
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body, timeoutMs: aiConfig?.requestTimeoutMs || 30000 });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackBody, timeoutMs: aiConfig?.requestTimeoutMs || 30000 });
  }
  return {
    ...parseAiJson(json?.choices?.[0]?.message?.content),
    usage: json?.usage || null
  };
}

function compactWebsiteDecisionPage({ url, page = {} } = {}) {
  const markdown = cleanText(page.markdown || cleanHtmlText(page.html || ""));
  const html = page.html || "";
  const links = page.links || [];
  return {
    url,
    status: "ok",
    title: cleanText(page.metadata?.title || ""),
    text: markdown.slice(0, WEBSITE_DECISION_PAGE_TEXT_CHARS),
    emails: extractEmails(`${markdown}\n${html}`).slice(0, 8),
    phones: extractPhones(markdown, { html, links, strict: true, maxPhones: 8 }).slice(0, 8)
  };
}

async function resolveDecisionMakerWebsiteWithDeepInfra({
  business = {},
  contacts = [],
  pages = [],
  plannedUrls,
  aiConfig = config.decisionMakerAi
} = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 520,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Eres un experto en enriquecer listas de Leads. Devuelve solo JSON valido, sin markdown. No inventes datos."
      },
      {
        role: "user",
        content: [
          "Recopila la siguiente informacion para un negocio local usando los datos y paginas scrapeadas disponibles:",
          "",
          "Decisor: El nombre mas probable del propietario, fundador, gerente, administrador o persona de mayor cargo. No uses nombres comerciales. Si no encuentras un nombre de persona, deja este campo vacio.",
          "Movil decisor: El numero movil mas probable de pertenecer a esa persona o a un WhatsApp directo de alta intencion. No confundas telefonos fijos o telefonos genericos de centralita con movil del decisor. Si no puedes atribuirlo con suficiente evidencia, deja el campo vacio.",
          "Email: El email mas probable de pertenecer al propietario, fundador o persona de alto cargo. Si no puedes atribuirlo, usa el mejor email de contacto disponible y marca la razon.",
          "",
          "Datos disponibles:",
          `Nombre del negocio: ${business.name || ""}`,
          `Direccion: ${business.address || ""}`,
          `Dominio: ${business.website || ""}`,
          `Email inicial: ${(contacts || []).find((contact) => normalizeContactKind(contact.kind) === "email")?.value || ""}`,
          "",
          "Instrucciones clave:",
          "Usa solo el texto, emails, telefonos y URLs scrapeadas que recibes abajo.",
          "Prioriza paginas de contacto, conocenos, equipo, aviso legal y politica de privacidad.",
          "El campo decisor debe contener una persona, nunca un nombre comercial, calle o direccion.",
          "Asegurate de revisar todas las paginas aportadas antes de rendirte.",
          "",
          JSON.stringify({
            outputSchema: {
              found: "boolean",
              decisor: "nombre de persona o string vacio",
              role: "cargo o string vacio",
              movil: "telefono movil o string vacio",
              email: "email o string vacio",
              sourceUrl: "url de la pagina que contiene la evidencia",
              confidence: "number 0..1",
              reason: "short snake_case reason",
              evidenceSummary: "frase breve"
            },
            urlsPlanificadas: plannedUrls?.urls || [],
            paginas: pages.map((page) => ({
              url: page.url,
              title: page.title || "",
              text: page.text || "",
              emails: page.emails || [],
              phones: page.phones || [],
              status: page.status || "ok"
            }))
          })
        ].join("\n")
      }
    ]
  };
  let json;
  try {
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body, timeoutMs: aiConfig?.requestTimeoutMs || 30000 });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({ baseUrl, apiKey: aiConfig?.apiKey, body: fallbackBody, timeoutMs: aiConfig?.requestTimeoutMs || 30000 });
  }
  return {
    ...parseAiJson(json?.choices?.[0]?.message?.content),
    usage: json?.usage || null
  };
}

export function normalizeWebsiteDecisionMakerResult(rawResult, { business = {}, pages = [], checkedAt = new Date().toISOString(), aiConfig = config.decisionMakerAi } = {}) {
  const raw = rawResult && typeof rawResult === "object" ? rawResult : {};
  const found = normalizeAiBoolean(raw.found) === true;
  const fullName = cleanPersonName(raw.decisor || raw.fullName || raw.full_name || raw.nombre, business.name);
  const phone = normalizeDecisionMakerMobile(raw.movil || raw.mobile || raw.mobilePhone || raw.phone || raw.telefono);
  const email = normalizeDecisionMakerEmail(raw.email);
  const sourceUrl = normalizeWebsiteUrl(raw.sourceUrl || raw.source_url, business.website) || pages.find((page) => page.status === "ok")?.url || business.website || "";
  const confidence = roundConfidence(raw.confidence || (fullName && phone ? 0.78 : fullName ? 0.68 : 0.35));
  const status = found && fullName
    ? "verified"
    : fullName || phone || email
      ? "candidate"
      : "not_found";
  return {
    status,
    found: status === "verified",
    fullName,
    role: cleanText(raw.role || raw.cargo),
    phone,
    email,
    sourceUrl,
    confidence,
    reason: normalizeReason(raw.reason) || (status === "verified" ? "website_decision_maker_found" : "website_decision_maker_not_found"),
    evidenceSummary: cleanText(raw.evidenceSummary || raw.evidence_summary || raw.summary),
    checkedAt,
    ai: {
      status: rawResult ? "resolved" : "invalid_response",
      provider: aiConfig?.provider || "deepinfra",
      model: aiConfig?.model || null,
      usage: rawResult?.usage || null,
      cost: estimateDeepseekUsageCost(rawResult?.usage)
    }
  };
}

async function planDecisionMakerSearch({
  business = {},
  contacts = [],
  aiSearchPlanner,
  aiConfig = config.decisionMakerAi,
  now = new Date()
} = {}) {
  const seedPlan = buildSeedDecisionMakerSearchPlan({ business, contacts, now });
  if (!canUseDecisionMakerSearchPlanner({ aiSearchPlanner, aiConfig })) return seedPlan;

  try {
    const rawPlan = aiSearchPlanner
      ? await aiSearchPlanner({ business, contacts, seedPlan, aiConfig, now })
      : await planDecisionMakerSearchWithDeepInfra({ business, contacts, seedPlan, aiConfig });
    return mergeDecisionMakerSearchPlans(seedPlan, rawPlan, aiConfig);
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

function buildSeedDecisionMakerSearchPlan({ business = {}, contacts = [], now = new Date() } = {}) {
  return {
    generatedAt: now.toISOString(),
    ai: {
      status: "seed",
      provider: null,
      model: null
    },
    queries: buildLinkedInDecisionMakerQueries(business).map((query) => ({
      query,
      plannedBy: "seed",
      discoveryReason: "seed_linkedin_decision_maker_query"
    })),
    contactSignals: (contacts || []).slice(0, 6).map((contact) => compactObject({
      kind: normalizeContactKind(contact.kind),
      value: cleanText(contact.value),
      sourceUrl: contact.source_url || contact.sourceUrl
    })).filter((contact) => contact.kind && contact.value)
  };
}

async function planDecisionMakerSearchWithDeepInfra({
  business = {},
  contacts = [],
  seedPlan,
  aiConfig = config.decisionMakerAi
} = {}) {
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
          "You plan Firecrawl/Google searches to locate the professional decision maker for a local business.",
          "Return only valid JSON. Do not include markdown.",
          "Use business identifiers, domain, city, niche, contact/social clues and LinkedIn search operators.",
          "Prefer precise LinkedIn personal profile searches and company LinkedIn searches that reduce false positives.",
          "Do not decide who the decision maker is. Only propose search queries to collect evidence.",
          "Never invent names or profiles."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            queries: [{
              query: "Google/Firecrawl search query string",
              reason: "short snake_case reason"
            }]
          },
          evidence: {
            task: "linkedin_decision_maker_search_plan",
            business: compactObject({
              name: business.name,
              cleanName: cleanCompanyName(business.name),
              brandName: brandCompanyName(business.name),
              city: business.city,
              niche: business.niche || business.category,
              website: business.website,
              instagram: business.instagram,
              facebook: business.facebook
            }),
            contactSignals: (contacts || []).slice(0, 6).map((contact) => compactObject({
              kind: normalizeContactKind(contact.kind),
              value: cleanText(contact.value),
              sourceUrl: contact.source_url || contact.sourceUrl
            })),
            seedQueries: (seedPlan?.queries || []).slice(0, 10),
            rules: [
              "Personal profile queries should target site:linkedin.com/in/ and include exact business or brand tokens.",
              "Include city/province where useful, especially for common business names.",
              "Use Spanish and English decision maker role words such as gerente, fundador, socio, administrador, owner, founder, CEO and managing director.",
              "Company profile queries should target site:linkedin.com/company/ and help identify access contacts only.",
              "Avoid broad person-name-only queries unless the name is already present in supplied evidence.",
              "Return several precise queries instead of one broad query when identity may be ambiguous."
            ]
          }
        })
      }
    ]
  };

  let json;
  try {
    json = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body: fallbackBody,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  }

  const parsed = parseAiJson(json?.choices?.[0]?.message?.content);
  if (normalizeAiDecisionMakerSearchPlan(parsed)?.queries?.length) {
    return {
      ...parsed,
      usage: json?.usage || null
    };
  }

  const repairBody = {
    model,
    temperature: 0,
    max_tokens: 550,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Repair or regenerate a LinkedIn decision-maker search plan as strict JSON.",
          "Return exactly one JSON object with a queries array.",
          "Each query must be a precise Google/Firecrawl search string for LinkedIn personal or company evidence.",
          "Do not include markdown or extra text."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          previousInvalidResult: parsed || json?.choices?.[0]?.message?.content || null,
          business: compactObject({
            name: business.name,
            cleanName: cleanCompanyName(business.name),
            brandName: brandCompanyName(business.name),
            city: business.city,
            niche: business.niche || business.category,
            website: business.website
          }),
          seedQueries: (seedPlan?.queries || []).slice(0, 10),
          outputSchema: { queries: [{ query: "site:linkedin.com/in ...", reason: "short_snake_case_reason" }] }
        })
      }
    ]
  };
  let repaired;
  try {
    repaired = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body: repairBody,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackRepairBody = { ...repairBody };
    delete fallbackRepairBody.response_format;
    repaired = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body: fallbackRepairBody,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  }
  return {
    ...parseAiJson(repaired?.choices?.[0]?.message?.content),
    usage: combineAiUsage(json?.usage, repaired?.usage)
  };
}

function mergeDecisionMakerSearchPlans(seedPlan, rawPlan, aiConfig) {
  const normalized = normalizeAiDecisionMakerSearchPlan(rawPlan);
  if (!normalized || !normalized.queries.length) {
    const repairedSeedQueries = normalizeDecisionMakerQueryEntries(seedPlan.queries, "ai")
      .map((entry) => ({
        ...entry,
        plannedBy: "ai",
        discoveryReason: "ai_invalid_plan_repaired_to_seed_query"
      }));
    if (rawPlan?.usage && repairedSeedQueries.length) {
      return {
        ...seedPlan,
        ai: {
          status: "planned",
          provider: aiConfig?.provider || "deepinfra",
          model: aiConfig?.model || null,
          warning: "invalid_response_repaired_to_seed_queries",
          usage: rawPlan.usage,
          cost: estimateDeepseekUsageCost(rawPlan.usage)
        },
        queries: uniqueDecisionMakerQueryEntries(repairedSeedQueries).slice(0, 18)
      };
    }
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
    queries: uniqueDecisionMakerQueryEntries([
      ...normalized.queries,
      ...normalizeDecisionMakerQueryEntries(seedPlan.queries, "seed")
    ]).slice(0, 18)
  };
}

function normalizeAiDecisionMakerSearchPlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") return null;
  return {
    queries: normalizeDecisionMakerQueryEntries(
      rawPlan.queries || rawPlan.searchQueries || rawPlan.search_queries || rawPlan.linkedinQueries || rawPlan.linkedin_queries,
      "ai"
    )
  };
}

function normalizeDecisionMakerQueryEntries(value, plannedBy = "seed") {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const query = cleanSearchQuery(typeof item === "string" ? item : item?.query);
    if (!query) return null;
    return {
      query,
      plannedBy: typeof item === "object" && item?.plannedBy ? cleanText(item.plannedBy).slice(0, 40) : plannedBy,
      discoveryReason: normalizeReason(typeof item === "object" ? item?.reason || item?.discoveryReason : "") || `${plannedBy}_decision_maker_search`
    };
  }).filter(Boolean);
}

function uniqueDecisionMakerQueryEntries(entries = []) {
  const seen = new Set();
  const uniqueEntries = [];
  for (const entry of normalizeDecisionMakerQueryEntries(entries, "seed")) {
    const key = normalizeText(entry.query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueEntries.push(entry);
  }
  return uniqueEntries;
}

function canUseDecisionMakerSearchPlanner({ aiSearchPlanner, aiConfig }) {
  if (aiSearchPlanner) return true;
  return Boolean(aiConfig && aiConfig.mode !== "never" && aiConfig.provider === "deepinfra" && aiConfig.apiKey);
}

async function runEscalatedDecisionMakerSearch({ business = {}, searchClient, searchPlan, now = new Date() }) {
  const activeSearchPlan = searchPlan || buildSeedDecisionMakerSearchPlan({ business, now });
  const baseQueryEntries = uniqueDecisionMakerQueryEntries(activeSearchPlan.queries?.length
    ? activeSearchPlan.queries
    : buildLinkedInDecisionMakerQueries(business));
  const collected = [];
  const queries = [];
  for (const entry of baseQueryEntries) {
    const results = await safeSearch(searchClient, entry.query, { limit: 5 });
    queries.push(entry.query);
    addSearchResults(collected, results, entry);
  }

  const firstPassCandidates = collected
    .map((result, index) => buildDecisionMakerCandidate({ business, query: result.query || queries[0], result, index, now }))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  for (const candidate of firstPassCandidates) {
    if (!candidate.fullName) continue;
    const personQueries = [
      `"${candidate.fullName}" "${cleanCompanyName(business.name)}"`,
      `"${candidate.fullName}" "${business.city || ""}"`,
      `"${candidate.fullName}" "${compactCompanyToken(business.name)}"`
    ].filter(Boolean);
    for (const query of personQueries) {
      if (queries.includes(query)) continue;
      const results = await safeSearch(searchClient, query, { limit: 3 });
      queries.push(query);
      addSearchResults(collected, results, {
        query,
        plannedBy: "derived_candidate",
        discoveryReason: "candidate_name_followup"
      });
    }
  }

  return {
    queries,
    results: collected,
    searchPlan: {
      ...activeSearchPlan,
      queries: baseQueryEntries
    },
    linkedinCompany: selectLinkedInCompanyFromSearchResults({ business, results: collected })
  };
}

async function safeSearch(searchClient, query, options) {
  try {
    return await searchClient.search(query, options);
  } catch {
    return [];
  }
}

function addSearchResults(target, results = [], queryEntry) {
  const entry = typeof queryEntry === "string"
    ? { query: queryEntry, plannedBy: "seed", discoveryReason: "seed_decision_maker_search" }
    : queryEntry || {};
  const seen = new Set(target.map((item) => normalizeUrlForDedupe(item.url)));
  for (const result of results || []) {
    const key = normalizeUrlForDedupe(result?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.push({
      ...result,
      query: result.query || entry.query || null,
      plannedBy: result.plannedBy || entry.plannedBy || null,
      discoveryReason: result.discoveryReason || entry.discoveryReason || null
    });
  }
}

function normalizeDecisionMakerSearchResults({ results = [], queries = [] } = {}) {
  return (results || []).slice(0, 20).map((result, index) => ({
    resultId: `r${index + 1}`,
    query: result.query || queries[0] || null,
    plannedBy: result.plannedBy || null,
    discoveryReason: result.discoveryReason || null,
    url: result.url || "",
    title: cleanText(result.title),
    snippet: cleanText(result.description || result.snippet || result.markdown)
  })).filter((result) => result.url);
}

function deterministicHasAiContext(deterministic = {}) {
  return Boolean(
    deterministic.searchResults?.length ||
    deterministic.candidates?.length ||
    deterministic.linkedinCompany ||
    deterministic.accessContacts?.length
  );
}

function aiRequiredDecisionMakerResult({ deterministic = {}, aiConfig } = {}) {
  return {
    ...deterministic,
    found: false,
    decisionStatus: deterministic.recommendedAccessContact
      ? "access_contact"
      : deterministic.candidates?.length
        ? "candidate"
        : deterministic.decisionStatus === "access_contact"
          ? "access_contact"
          : "not_found",
    reason: "ai_required_but_unavailable",
    ai: {
      status: "required_unavailable",
      provider: aiConfig?.provider || "deepinfra",
      model: aiConfig?.model || null,
      deterministicFound: deterministic?.found === true,
      deterministicStatus: deterministic?.decisionStatus || null,
      deterministicReason: deterministic?.reason || null,
      deterministicConfidence: deterministic?.decisionMaker?.confidence || null
    }
  };
}

function buildDecisionMakerCandidate({ business, query, result, index = 0, now }) {
  const url = normalizeLinkedInProfileUrl(result?.url);
  if (!url) return null;

  const title = cleanText(result.title);
  const description = cleanText(result.description || result.snippet || result.markdown);
  const haystack = normalizeText(`${title} ${description}`);
  const company = cleanCompanyName(business.name);
  const companyTokens = significantTokens(company);
  const city = normalizeText(business.city || "");
  const role = extractRole({ title, description });
  const name = extractPersonName({ title, company });
  const matchedCompanyTokens = companyTokens.filter((token) => haystack.includes(token));

  let confidence = 0.4;
  if (matchedCompanyTokens.length >= Math.min(2, companyTokens.length)) confidence += 0.22;
  else if (matchedCompanyTokens.length === 1) confidence += 0.12;
  if (city && haystack.includes(city)) confidence += 0.14;
  if (role) confidence += 0.14;
  if (name) confidence += 0.08;
  if (title.toLowerCase().includes("linkedin")) confidence += 0.03;

  return compactObject({
    candidateId: `c${index + 1}`,
    fullName: name,
    role,
    linkedinUrl: url,
    sourceTitle: title,
    sourceSnippet: description,
    query,
    plannedBy: result.plannedBy || null,
    discoveryReason: result.discoveryReason || null,
    confidence: roundConfidence(confidence),
    matchedCompanyTokens,
    checkedAt: now.toISOString()
  });
}

function selectLinkedInCompanyFromSearchResults({ business = {}, results = [] } = {}) {
  const company = cleanCompanyName(business.name);
  const companyTokens = significantTokens(company);
  const scored = results
    .map((result) => buildLinkedInCompanyCandidate({ business, result, companyTokens }))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);
  return scored[0]?.confidence >= 0.52 ? scored[0] : null;
}

function buildLinkedInCompanyCandidate({ business, result, companyTokens }) {
  const url = normalizeLinkedInCompanyUrl(result?.url);
  if (!url) return null;
  const title = cleanText(result.title);
  const description = cleanText(result.description || result.snippet || result.markdown);
  const haystack = normalizeText(`${title} ${description} ${url}`);
  const city = normalizeText(business.city || "");
  const matchedCompanyTokens = companyTokens.filter((token) => haystack.includes(token));
  let confidence = 0.38;
  if (matchedCompanyTokens.length >= Math.min(2, companyTokens.length)) confidence += 0.24;
  else if (matchedCompanyTokens.length === 1) confidence += 0.12;
  if (city && haystack.includes(city)) confidence += 0.1;
  if (/linkedin/i.test(title)) confidence += 0.04;
  return compactObject({
    linkedinUrl: url,
    sourceTitle: title,
    sourceSnippet: description,
    confidence: roundConfidence(confidence),
    matchedCompanyTokens
  });
}

function shouldUseAiDecisionMakerResolver({ deterministic = {}, aiResolver, aiConfig }) {
  const candidates = deterministic.candidates || [];
  if (aiResolver) return true;
  if (!aiConfig || aiConfig.mode === "never" || aiConfig.provider !== "deepinfra" || !aiConfig.apiKey) return false;
  if (aiConfig.mode === "always") return true;
  const hasContext = candidates.length || deterministic.linkedinCompany || deterministic.accessContacts?.length || deterministic.searchResults?.length;
  if (!hasContext) return false;

  const [first, second] = candidates;
  if (!first) return Boolean(deterministic.linkedinCompany || deterministic.accessContacts?.length);
  if (!deterministic.found && first.confidence >= 0.45) return true;
  if (!second) return false;
  return first.confidence < 0.82 || first.confidence - second.confidence < 0.18;
}

function canUseDecisionMakerVerifier({ aiVerifier, aiConfig }) {
  const verifyMode = String(aiConfig?.verifyMode || aiConfig?.verificationMode || "always").toLowerCase();
  if (["never", "off", "false", "0"].includes(verifyMode)) return false;
  if (aiVerifier) return true;
  return Boolean(aiConfig && aiConfig.mode !== "never" && aiConfig.provider === "deepinfra" && aiConfig.apiKey);
}

function shouldRequireAiPlannedDecisionMakerSearch({ aiResolver, aiConfig }) {
  if (aiConfig?.requirePlannedSearch === true) return true;
  if (aiConfig?.requirePlannedSearch === false) return false;
  return !aiResolver;
}

async function resolveDecisionMakerWithDeepInfra({
  business = {},
  query,
  queries = [],
  searchPlan,
  candidates = [],
  searchResults = [],
  accessContacts = [],
  linkedinCompany,
  websiteDecisionMaker,
  deterministic = {},
  aiConfig = config.decisionMakerAi
} = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const evidence = buildDecisionMakerEvidencePack({
    business,
    query,
    queries,
    searchPlan,
    candidates,
    searchResults,
    accessContacts,
    linkedinCompany,
    websiteDecisionMaker,
    deterministic,
    maxEvidenceChars: aiConfig?.maxEvidenceChars || DEFAULT_MAX_AI_EVIDENCE_CHARS
  });
  const body = {
    model,
    temperature: 0,
    max_tokens: 450,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You resolve which LinkedIn search result is the decision maker for a local business.",
          "Use only the supplied Google search result titles/snippets/URLs.",
          "Return only valid JSON. Do not include markdown.",
          "Do not invent emails, phone numbers, names, roles, or profiles.",
          "Prefer owners, founders, partners, administrators, CEOs, managing directors, general managers and local branch managers.",
          "Return found=false when evidence is weak or the candidate does not clearly match the business and location."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            found: "boolean",
            decisionStatus: "verified|candidate|access_contact|not_found",
            selectedCandidateId: "candidate id or null",
            selectedResultId: "raw search result id or null",
            selectedAccessContactId: "access contact id or null",
            confidence: "number 0..1",
            fullName: "string or null; copy from evidence only",
            role: "string or null; copy from evidence only",
            reason: "short snake_case reason",
            riskFlags: ["short strings"]
          },
          evidence
        })
      }
    ]
  };

  let json;
  try {
    json = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body: fallbackBody,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  }

  return {
    ...parseAiJson(json?.choices?.[0]?.message?.content),
    usage: json?.usage || null
  };
}

async function verifyDecisionMakerResolution({
  business = {},
  deterministic = {},
  resolved = {},
  aiVerifier,
  aiConfig = config.decisionMakerAi
} = {}) {
  const evidence = buildDecisionMakerVerificationPack({
    business,
    deterministic,
    resolved,
    maxEvidenceChars: aiConfig?.maxEvidenceChars || DEFAULT_MAX_AI_EVIDENCE_CHARS
  });
  try {
    const rawVerification = aiVerifier
      ? await aiVerifier({ business, evidence, deterministic, resolved, aiConfig })
      : await verifyDecisionMakerWithDeepInfra({ evidence, aiConfig });
    return applyDecisionMakerVerification({ deterministic, resolved, rawVerification, aiConfig });
  } catch (error) {
    return unverifiedDecisionMakerResult({
      deterministic,
      decisionStatus: "candidate",
      reason: "ai_verification_failed",
      riskFlags: resolved.riskFlags,
      ai: {
        ...(resolved.ai || {}),
        status: "verification_failed",
        error: error.message,
        verification: {
          ...aiDecisionMakerVerificationMetadata({
            status: "failed",
            rawVerification: null,
            aiConfig
          }),
          error: error.message
        }
      }
    });
  }
}

async function verifyDecisionMakerWithDeepInfra({ evidence, aiConfig = config.decisionMakerAi } = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const body = {
    model,
    temperature: 0,
    max_tokens: 420,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are a skeptical auditor for LinkedIn decision-maker enrichment.",
          "Use only the supplied search evidence and proposed decision.",
          "Confirm only when the selected URL is a personal LinkedIn /in/ profile and the title/snippet clearly link the person to the target business and a decision-maker role.",
          "Reject employees, weak matches, company pages, ambiguous people, unrelated businesses, and invented names or roles.",
          "Return unknown when more evidence is needed. Return only valid JSON."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputSchema: {
            confirmed: "boolean",
            status: "confirmed|rejected|unknown",
            found: "boolean",
            decisionStatus: "verified|candidate|access_contact|not_found",
            confidence: "number 0..1",
            reason: "short snake_case reason",
            riskFlags: ["short strings"],
            evidenceSummary: "one short sentence",
            needsMoreEvidence: "boolean"
          },
          evidence
        })
      }
    ]
  };

  let json;
  try {
    json = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  } catch (error) {
    if (!/response_format|json_object|unsupported/i.test(error.message)) throw error;
    const fallbackBody = { ...body };
    delete fallbackBody.response_format;
    json = await postDeepInfraJson({
      baseUrl,
      apiKey: aiConfig?.apiKey,
      body: fallbackBody,
      timeoutMs: aiConfig?.requestTimeoutMs || 30000
    });
  }

  return {
    ...parseAiJson(json?.choices?.[0]?.message?.content),
    usage: json?.usage || null
  };
}

function buildDecisionMakerEvidencePack({
  business = {},
  query,
  queries = [],
  searchPlan,
  candidates = [],
  searchResults = [],
  accessContacts = [],
  linkedinCompany,
  websiteDecisionMaker,
  deterministic = {},
  maxEvidenceChars = DEFAULT_MAX_AI_EVIDENCE_CHARS
} = {}) {
  const evidence = {
    task: "linkedin_decision_maker_resolution",
    schemaVersion: 1,
    business: compactObject({
      name: business.name,
      cleanName: cleanCompanyName(business.name),
      city: business.city,
      niche: business.niche || business.category,
      website: business.website
    }),
    query,
    queries: queries.slice(0, 12),
    websiteDecisionMaker: compactWebsiteDecisionForAi(websiteDecisionMaker || deterministic.websiteDecisionMaker),
    searchPlan: searchPlan ? {
      ai: searchPlan.ai || null,
      queries: normalizeDecisionMakerQueryEntries(searchPlan.queries || [], "seed").slice(0, 12).map((entry) => ({
        query: entry.query,
        plannedBy: entry.plannedBy,
        discoveryReason: entry.discoveryReason
      }))
    } : null,
    deterministic: {
      found: deterministic.found,
      decisionStatus: deterministic.decisionStatus,
      reason: deterministic.reason,
      selectedCandidateId: deterministic.decisionMaker?.candidateId || null,
      confidence: deterministic.decisionMaker?.confidence || null,
      recommendedAccessContactId: deterministic.recommendedAccessContact?.contactId || null
    },
    linkedinCompany: linkedinCompany || null,
    candidates: candidates.slice(0, 5).map((candidate) => ({
      candidateId: candidate.candidateId,
      fullName: candidate.fullName || null,
      role: candidate.role || null,
      linkedinUrl: candidate.linkedinUrl,
      sourceTitle: candidate.sourceTitle,
      sourceSnippet: candidate.sourceSnippet,
      confidence: candidate.confidence,
      matchedCompanyTokens: candidate.matchedCompanyTokens || [],
      plannedBy: candidate.plannedBy || null,
      discoveryReason: candidate.discoveryReason || null
    })),
    searchResults: searchResults.slice(0, 12).map((result) => ({
      resultId: result.resultId,
      query: result.query || null,
      plannedBy: result.plannedBy || null,
      discoveryReason: result.discoveryReason || null,
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      isLinkedInPersonalProfile: Boolean(normalizeLinkedInProfileUrl(result.url)),
      isLinkedInCompanyProfile: Boolean(normalizeLinkedInCompanyUrl(result.url))
    })),
    accessContacts: accessContacts.slice(0, 8).map((contact) => ({
      contactId: contact.contactId,
      kind: contact.kind,
      value: contact.value,
      confidence: contact.confidence,
      sourceUrl: contact.sourceUrl || null,
      reason: contact.reason || null
    })),
    decisionRules: [
      "The selected candidate must be a personal LinkedIn /in/ profile.",
      "Website decision-maker evidence may provide names, roles, phones or emails, but it does not prove a LinkedIn profile unless a search result URL also matches.",
      "If selectedCandidateId is unavailable but a raw search result clearly contains the personal LinkedIn /in/ profile, return selectedResultId.",
      "The title or snippet should connect the person to the business name or distinctive business tokens.",
      "The title or snippet should connect the person to the city/province when available.",
      "Prefer decision-maker roles over employee, marketing, recruiter, student or unrelated roles.",
      "If several candidates are plausible, choose the highest authority role with the strongest company and location match.",
      "If a person is related but not clearly a decision maker, return decisionStatus=candidate and found=false.",
      "If no person is clearly supported, return decisionStatus=access_contact and choose the best phone/email/company LinkedIn contact.",
      "If no useful contact exists, return decisionStatus=not_found.",
      "Never invent names, roles, phone numbers, emails, URLs or company relationships."
    ]
  };
  return enforceEvidenceBudget(evidence, maxEvidenceChars);
}

function buildDecisionMakerVerificationPack({
  business = {},
  deterministic = {},
  resolved = {},
  maxEvidenceChars = DEFAULT_MAX_AI_EVIDENCE_CHARS
} = {}) {
  const evidence = {
    task: "linkedin_decision_maker_verification",
    schemaVersion: 1,
    business: compactObject({
      name: business.name,
      cleanName: cleanCompanyName(business.name),
      city: business.city,
      niche: business.niche || business.category,
      website: business.website
    }),
    proposedDecision: {
      found: resolved.found === true,
      decisionStatus: resolved.decisionStatus || null,
      reason: resolved.reason || null,
      decisionMaker: resolved.decisionMaker ? {
        candidateId: resolved.decisionMaker.candidateId || null,
        resultId: resolved.decisionMaker.resultId || null,
        fullName: resolved.decisionMaker.fullName || null,
        role: resolved.decisionMaker.role || null,
        linkedinUrl: resolved.decisionMaker.linkedinUrl || null,
        confidence: resolved.decisionMaker.confidence ?? null,
        sourceTitle: resolved.decisionMaker.sourceTitle || null,
        sourceSnippet: resolved.decisionMaker.sourceSnippet || null
      } : null
    },
    deterministic: {
      found: deterministic.found,
      decisionStatus: deterministic.decisionStatus,
      reason: deterministic.reason,
      selectedCandidateId: deterministic.decisionMaker?.candidateId || null,
      confidence: deterministic.decisionMaker?.confidence || null
    },
    linkedinCompany: resolved.linkedinCompany || deterministic.linkedinCompany || null,
    candidates: (resolved.candidates || deterministic.candidates || []).slice(0, 6).map((candidate) => ({
      candidateId: candidate.candidateId,
      fullName: candidate.fullName || null,
      role: candidate.role || null,
      linkedinUrl: candidate.linkedinUrl,
      sourceTitle: candidate.sourceTitle,
      sourceSnippet: candidate.sourceSnippet,
      confidence: candidate.confidence,
      matchedCompanyTokens: candidate.matchedCompanyTokens || [],
      plannedBy: candidate.plannedBy || null,
      discoveryReason: candidate.discoveryReason || null
    })),
    searchResults: (resolved.searchResults || deterministic.searchResults || []).slice(0, 12).map((result) => ({
      resultId: result.resultId,
      query: result.query || null,
      plannedBy: result.plannedBy || null,
      discoveryReason: result.discoveryReason || null,
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      isLinkedInPersonalProfile: Boolean(normalizeLinkedInProfileUrl(result.url)),
      isLinkedInCompanyProfile: Boolean(normalizeLinkedInCompanyUrl(result.url))
    })),
    accessContacts: (resolved.accessContacts || deterministic.accessContacts || []).slice(0, 8).map((contact) => ({
      contactId: contact.contactId,
      kind: contact.kind,
      value: contact.value,
      confidence: contact.confidence,
      sourceUrl: contact.sourceUrl || null,
      reason: contact.reason || null
    })),
    auditRules: [
      "Confirm only the proposed verified decision maker.",
      "The selected URL must be a personal LinkedIn /in/ profile.",
      "The profile title or snippet must connect the person to the target business or distinctive business tokens.",
      "The profile title or snippet must support a decision-maker role, not just employment or weak affiliation.",
      "Use rejected or unknown if the selected evidence is ambiguous, generic, unrelated, or only a company page.",
      "Never invent missing name, role, company relationship or URL."
    ]
  };
  return enforceEvidenceBudget(evidence, maxEvidenceChars);
}

function mergeAiDecisionMakerResult({ deterministic = {}, rawResult, aiConfig, requireAiPlannedSearch = false }) {
  const normalized = normalizeAiDecisionMakerResult(rawResult);
  if (!normalized) {
    return unverifiedDecisionMakerResult({
      deterministic,
      reason: "ai_invalid_response",
      ai: aiDecisionMakerMetadata({ status: "invalid_response", rawResult, aiConfig, deterministic })
    });
  }
  if (normalized.found && normalized.decisionStatus !== "verified") {
    return unverifiedDecisionMakerResult({
      deterministic,
      reason: "ai_inconsistent_response",
      ai: aiDecisionMakerMetadata({ status: "inconsistent_response", rawResult, aiConfig, deterministic })
    });
  }

  const candidates = deterministic.candidates || [];
  const searchResults = deterministic.searchResults || [];
  const accessContacts = deterministic.accessContacts || [];
  const selected = normalized.selectedCandidateId
    ? candidates.find((candidate) => candidate.candidateId === normalized.selectedCandidateId)
    : null;
  const selectedRawResult = !selected && normalized.selectedResultId
    ? searchResults.find((result) => result.resultId === normalized.selectedResultId)
    : null;
  const selectedFromRaw = selectedRawResult
    ? buildDecisionMakerFromRawAiResult({ result: selectedRawResult, normalized, deterministic })
    : null;
  const selectedAccessContact = normalized.selectedAccessContactId
    ? accessContacts.find((contact) => contact.contactId === normalized.selectedAccessContactId)
    : deterministic.recommendedAccessContact || null;

  if (normalized.decisionStatus === "candidate") {
    return unverifiedDecisionMakerResult({
      deterministic,
      decisionStatus: "candidate",
      reason: normalized.reason || "ai_candidate_not_verified",
      riskFlags: normalized.riskFlags,
      ai: aiDecisionMakerMetadata({ status: "resolved_candidate", rawResult, aiConfig, deterministic })
    });
  }

  if (normalized.decisionStatus === "access_contact" || (!normalized.found && !selected && !selectedFromRaw)) {
    return {
      found: false,
      decisionStatus: selectedAccessContact ? "access_contact" : normalized.decisionStatus || deterministic.decisionStatus || "not_found",
      checkedAt: deterministic.checkedAt,
      query: deterministic.query,
      queries: deterministic.queries || [],
      searchPlan: deterministic.searchPlan || null,
      reason: normalized.reason || (selectedAccessContact ? "ai_selected_access_contact" : "ai_rejected_candidates"),
      linkedinCompany: deterministic.linkedinCompany || null,
      accessContacts,
      recommendedAccessContact: selectedAccessContact || null,
      searchResults,
      candidates,
      riskFlags: normalized.riskFlags,
      ai: aiDecisionMakerMetadata({ status: "resolved_no_match", rawResult, aiConfig, deterministic })
    };
  }

  if (!normalized.found || (!selected && !selectedFromRaw) || normalized.confidence < 0.55) {
    return unverifiedDecisionMakerResult({
      deterministic,
      decisionStatus: normalized.decisionStatus,
      reason: normalized.reason || "ai_rejected_candidates",
      riskFlags: normalized.riskFlags,
      ai: aiDecisionMakerMetadata({ status: "resolved_no_match", rawResult, aiConfig, deterministic })
    });
  }

  const baseDecisionMaker = selected || selectedFromRaw;
  if (requireAiPlannedSearch && baseDecisionMaker.plannedBy !== "ai") {
    return unverifiedDecisionMakerResult({
      deterministic,
      decisionStatus: "candidate",
      reason: "ai_unplanned_decision_maker_search",
      riskFlags: [...normalized.riskFlags, "selected_search_not_ai_planned"],
      ai: aiDecisionMakerMetadata({ status: "invalid_unplanned_search", rawResult, aiConfig, deterministic })
    });
  }
  const decisionMaker = {
    ...baseDecisionMaker,
    fullName: normalized.fullName || baseDecisionMaker.fullName,
    role: normalized.role || baseDecisionMaker.role,
    confidence: roundConfidence(Math.max(baseDecisionMaker.confidence || 0, normalized.confidence || 0))
  };

  return {
    found: true,
    decisionStatus: normalized.decisionStatus === "candidate" ? "candidate" : "verified",
    checkedAt: deterministic.checkedAt,
    query: deterministic.query,
    queries: deterministic.queries || [],
    searchPlan: deterministic.searchPlan || null,
    decisionMaker: compactObject(decisionMaker),
    linkedinCompany: deterministic.linkedinCompany || null,
    accessContacts,
    recommendedAccessContact: selectedAccessContact || deterministic.recommendedAccessContact || null,
    searchResults,
    candidates,
    reason: normalized.reason || "ai_resolved_candidate",
    riskFlags: normalized.riskFlags,
    ai: aiDecisionMakerMetadata({ status: "resolved", rawResult, aiConfig, deterministic })
  };
}

function applyDecisionMakerVerification({ deterministic = {}, resolved = {}, rawVerification, aiConfig }) {
  const normalized = normalizeAiDecisionMakerVerification(rawVerification);
  if (!normalized) {
    return unverifiedDecisionMakerResult({
      deterministic,
      decisionStatus: "candidate",
      reason: "ai_verification_invalid_response",
      riskFlags: resolved.riskFlags,
      ai: {
        ...(resolved.ai || {}),
        status: "verification_invalid_response",
        verification: aiDecisionMakerVerificationMetadata({
          status: "invalid_response",
          rawVerification,
          aiConfig,
          needsMoreEvidence: true
        })
      }
    });
  }

  if (normalized.confirmed !== true || normalized.found !== true || normalized.decisionStatus !== "verified") {
    return unverifiedDecisionMakerResult({
      deterministic,
      decisionStatus: normalized.decisionStatus === "access_contact" ? "access_contact" : "candidate",
      reason: normalized.status === "unknown" ? "ai_verification_unknown" : normalized.reason || "ai_verification_rejected",
      riskFlags: normalized.riskFlags.length ? normalized.riskFlags : resolved.riskFlags,
      ai: {
        ...(resolved.ai || {}),
        status: normalized.status === "unknown" ? "verification_unknown" : "verification_rejected",
        evidenceSummary: normalized.evidenceSummary || null,
        verification: aiDecisionMakerVerificationMetadata({
          status: normalized.status === "unknown" ? "unknown" : "rejected",
          rawVerification,
          aiConfig,
          evidenceSummary: normalized.evidenceSummary,
          needsMoreEvidence: true,
          riskFlags: normalized.riskFlags
        })
      }
    });
  }

  return {
    ...resolved,
    decisionMaker: {
      ...(resolved.decisionMaker || {}),
      confidence: roundConfidence(Math.min(resolved.decisionMaker?.confidence || 0, normalized.confidence || resolved.decisionMaker?.confidence || 0))
    },
    ai: {
      ...(resolved.ai || {}),
      verification: aiDecisionMakerVerificationMetadata({
        status: "confirmed",
        rawVerification,
        aiConfig,
        evidenceSummary: normalized.evidenceSummary,
        needsMoreEvidence: normalized.needsMoreEvidence,
        riskFlags: normalized.riskFlags
      })
    }
  };
}

function mergeWebsiteDecisionMakerResult({ resolved = {}, websiteDecisionMaker, now = new Date() } = {}) {
  if (!websiteDecisionMaker || !["verified", "candidate"].includes(websiteDecisionMaker.status)) {
    return {
      ...resolved,
      websiteDecisionMaker: websiteDecisionMaker || resolved.websiteDecisionMaker || null
    };
  }
  const existing = resolved.decisionMaker || {};
  const namesCompatible = namesLikelySamePerson(existing.fullName, websiteDecisionMaker.fullName);
  const canAttachWebsiteFields = !existing.fullName || !websiteDecisionMaker.fullName || namesCompatible;
  const mergedDecisionMaker = compactObject({
    ...existing,
    fullName: existing.fullName || websiteDecisionMaker.fullName,
    role: existing.role || websiteDecisionMaker.role,
    phone: canAttachWebsiteFields ? existing.phone || websiteDecisionMaker.phone : existing.phone,
    email: canAttachWebsiteFields ? existing.email || websiteDecisionMaker.email : existing.email,
    sourceUrl: existing.sourceUrl || websiteDecisionMaker.sourceUrl,
    sourceType: existing.linkedinUrl ? "linkedin" : "business_website",
    confidence: roundConfidence(Math.max(existing.confidence || 0, websiteDecisionMaker.confidence || 0))
  });

  if (existing.linkedinUrl || resolved.found === true) {
    return {
      ...resolved,
      decisionMaker: mergedDecisionMaker,
      websiteDecisionMaker,
      recommendedAccessContact: resolved.recommendedAccessContact || websiteDecisionAccessContact(websiteDecisionMaker)
    };
  }

  if (websiteDecisionMaker.status === "verified" && websiteDecisionMaker.fullName) {
    return {
      ...resolved,
      found: true,
      decisionStatus: "verified",
      checkedAt: resolved.checkedAt || websiteDecisionMaker.checkedAt || now.toISOString(),
      decisionMaker: mergedDecisionMaker,
      websiteDecisionMaker,
      recommendedAccessContact: websiteDecisionAccessContact(websiteDecisionMaker) || resolved.recommendedAccessContact || null,
      reason: websiteDecisionMaker.reason || "website_decision_maker_found",
      ai: {
        ...(resolved.ai || {}),
        status: resolved.ai?.status || "resolved",
        website: websiteDecisionMaker.ai || null
      }
    };
  }

  return {
    ...resolved,
    websiteDecisionMaker,
    recommendedAccessContact: resolved.recommendedAccessContact || websiteDecisionAccessContact(websiteDecisionMaker)
  };
}

function websiteDecisionAccessContact(websiteDecisionMaker = {}) {
  if (websiteDecisionMaker.phone) {
    return {
      contactId: "website_decision_phone",
      kind: "phone",
      value: websiteDecisionMaker.phone,
      confidence: websiteDecisionMaker.confidence || 0.75,
      sourceUrl: websiteDecisionMaker.sourceUrl,
      reason: "website_decision_maker_mobile"
    };
  }
  if (websiteDecisionMaker.email) {
    return {
      contactId: "website_decision_email",
      kind: "email",
      value: websiteDecisionMaker.email,
      confidence: Math.min(websiteDecisionMaker.confidence || 0.7, 0.82),
      sourceUrl: websiteDecisionMaker.sourceUrl,
      reason: "website_decision_maker_email"
    };
  }
  return null;
}

function normalizeAiDecisionMakerResult(rawResult) {
  if (!rawResult || typeof rawResult !== "object") return null;
  const selectedCandidateId = String(rawResult.selectedCandidateId || rawResult.selected_candidate_id || "").trim();
  const selectedResultId = String(rawResult.selectedResultId || rawResult.selected_result_id || "").trim();
  const selectedAccessContactId = String(rawResult.selectedAccessContactId || rawResult.selected_access_contact_id || "").trim();
  const found = normalizeAiBoolean(rawResult.found);
  if (found == null) return null;
  const decisionStatus = normalizeExplicitDecisionStatus(rawResult.decisionStatus || rawResult.decision_status);
  if (!decisionStatus) return null;
  return {
    found,
    decisionStatus,
    selectedCandidateId: selectedCandidateId || null,
    selectedResultId: selectedResultId || null,
    selectedAccessContactId: selectedAccessContactId || null,
    confidence: roundConfidence(rawResult.confidence),
    fullName: cleanText(rawResult.fullName || rawResult.full_name),
    role: cleanText(rawResult.role),
    reason: normalizeReason(rawResult.reason),
    riskFlags: normalizeStringArray(rawResult.riskFlags || rawResult.risk_flags).slice(0, 6)
  };
}

function normalizeAiDecisionMakerVerification(rawVerification) {
  if (!rawVerification || typeof rawVerification !== "object") return null;
  const confirmed = normalizeAiBoolean(rawVerification.confirmed);
  if (confirmed == null) return null;
  const status = String(rawVerification.status || "").toLowerCase();
  if (!["confirmed", "rejected", "unknown"].includes(status)) return null;
  if (confirmed === true && status !== "confirmed") return null;
  if (confirmed === false && status === "confirmed") return null;
  const found = normalizeAiBoolean(rawVerification.found);
  if (found == null) return null;
  const decisionStatus = normalizeExplicitDecisionStatus(rawVerification.decisionStatus || rawVerification.decision_status);
  if (!decisionStatus) return null;
  if (confirmed === true && (found !== true || decisionStatus !== "verified")) return null;
  return {
    confirmed,
    status,
    found,
    decisionStatus,
    confidence: roundConfidence(rawVerification.confidence),
    reason: normalizeReason(rawVerification.reason),
    riskFlags: normalizeStringArray(rawVerification.riskFlags || rawVerification.risk_flags).slice(0, 6),
    evidenceSummary: cleanText(rawVerification.evidenceSummary || rawVerification.evidence_summary || rawVerification.summary),
    needsMoreEvidence: rawVerification.needsMoreEvidence === true || String(rawVerification.needs_more_evidence).toLowerCase() === "true"
  };
}

function normalizeAiBoolean(value) {
  if (value === true || String(value).toLowerCase() === "true") return true;
  if (value === false || String(value).toLowerCase() === "false") return false;
  return null;
}

function normalizeExplicitDecisionStatus(value) {
  const status = String(value || "").toLowerCase();
  return ["verified", "candidate", "access_contact", "not_found"].includes(status) ? status : "";
}

function buildDecisionMakerFromRawAiResult({ result = {}, normalized = {}, deterministic = {} } = {}) {
  const linkedinUrl = normalizeLinkedInProfileUrl(result.url);
  if (!linkedinUrl) return null;
  return compactObject({
    candidateId: `raw:${result.resultId}`,
    resultId: result.resultId,
    fullName: normalized.fullName || extractPersonName({ title: result.title, company: deterministic.linkedinCompany?.sourceTitle || "" }),
    role: normalized.role || extractRole({ title: result.title, description: result.snippet }),
    linkedinUrl,
    sourceTitle: result.title,
    sourceSnippet: result.snippet,
    query: result.query,
    plannedBy: result.plannedBy || null,
    discoveryReason: result.discoveryReason || null,
    confidence: roundConfidence(normalized.confidence || 0.55),
    matchedCompanyTokens: []
  });
}

function unverifiedDecisionMakerResult({ deterministic = {}, decisionStatus, reason, riskFlags, ai } = {}) {
  const status = normalizeUnverifiedDecisionStatus({ deterministic, decisionStatus });
  return {
    found: false,
    decisionStatus: status,
    checkedAt: deterministic.checkedAt,
    query: deterministic.query,
    queries: deterministic.queries || [],
    searchPlan: deterministic.searchPlan || null,
    reason,
    linkedinCompany: deterministic.linkedinCompany || null,
    websiteDecisionMaker: deterministic.websiteDecisionMaker || null,
    accessContacts: deterministic.accessContacts || [],
    recommendedAccessContact: status === "access_contact" ? deterministic.recommendedAccessContact || null : null,
    searchResults: deterministic.searchResults || [],
    candidates: deterministic.candidates || [],
    riskFlags: riskFlags || [],
    ai
  };
}

function normalizeUnverifiedDecisionStatus({ deterministic = {}, decisionStatus } = {}) {
  if (decisionStatus) {
    const normalized = normalizeDecisionStatus(decisionStatus, false);
    if (normalized === "access_contact" || normalized === "not_found" || normalized === "candidate") return normalized;
  }
  if (deterministic.recommendedAccessContact) return "access_contact";
  if (deterministic.candidates?.length) return "candidate";
  if (deterministic.decisionStatus === "access_contact") return "access_contact";
  return "not_found";
}

function aiDecisionMakerMetadata({ status, rawResult, aiConfig, deterministic }) {
  return {
    status,
    provider: aiConfig?.provider || "deepinfra",
    model: aiConfig?.model || null,
    deterministicFound: deterministic?.found === true,
    deterministicStatus: deterministic?.decisionStatus || null,
    deterministicReason: deterministic?.reason || null,
    deterministicConfidence: deterministic?.decisionMaker?.confidence || null,
    usage: rawResult?.usage || null,
    cost: estimateDeepseekUsageCost(rawResult?.usage)
  };
}

function aiDecisionMakerVerificationMetadata({
  status,
  rawVerification,
  aiConfig,
  evidenceSummary,
  needsMoreEvidence,
  riskFlags
}) {
  return {
    status,
    provider: aiConfig?.provider || "deepinfra",
    model: aiConfig?.model || null,
    evidenceSummary: evidenceSummary || null,
    needsMoreEvidence: needsMoreEvidence === true,
    riskFlags: riskFlags || [],
    usage: rawVerification?.usage || null,
    cost: estimateDeepseekUsageCost(rawVerification?.usage)
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

function enforceEvidenceBudget(evidence, maxEvidenceChars) {
  let serialized = JSON.stringify(evidence);
  const limit = Math.max(3000, Number(maxEvidenceChars) || DEFAULT_MAX_AI_EVIDENCE_CHARS);
  if (serialized.length <= limit) return evidence;
  const reduced = {
    ...evidence,
    candidates: evidence.candidates.map((candidate) => ({
      ...candidate,
      sourceSnippet: String(candidate.sourceSnippet || "").slice(0, 500)
    })),
    searchResults: evidence.searchResults.map((result) => ({
      ...result,
      snippet: String(result.snippet || "").slice(0, 500)
    }))
  };
  serialized = JSON.stringify(reduced);
  if (serialized.length <= limit) return reduced;
  return {
    ...reduced,
    candidates: reduced.candidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      sourceSnippet: String(candidate.sourceSnippet || "").slice(0, 280)
    })),
    searchResults: reduced.searchResults.slice(0, 8).map((result) => ({
      ...result,
      snippet: String(result.snippet || "").slice(0, 280)
    }))
  };
}

function buildAccessContacts({ business = {}, contacts = [], linkedinCompany }) {
  const values = [];
  const add = ({ kind, value, confidence, sourceUrl, reason }) => {
    const clean = cleanText(value);
    if (!clean) return;
    const key = `${kind}:${clean.toLowerCase()}`;
    if (values.some((item) => `${item.kind}:${String(item.value).toLowerCase()}` === key)) return;
    values.push(compactObject({
      contactId: `a${values.length + 1}`,
      kind,
      value: clean,
      confidence: roundConfidence(confidence),
      sourceUrl,
      reason
    }));
  };

  for (const contact of contacts || []) {
    const kind = normalizeContactKind(contact.kind);
    if (!kind) continue;
    add({
      kind,
      value: contact.value,
      confidence: contact.confidence || contactConfidence(kind),
      sourceUrl: contact.source_url || contact.sourceUrl,
      reason: `existing_${kind}`
    });
  }
  add({ kind: "phone", value: business.phone_e164 || business.phone, confidence: 0.9, sourceUrl: business.source_url, reason: "business_primary_phone" });
  add({ kind: "website", value: business.website, confidence: 0.7, sourceUrl: business.website, reason: "business_website" });
  add({ kind: "instagram", value: business.instagram, confidence: 0.72, sourceUrl: business.instagram, reason: "business_social" });
  add({ kind: "facebook", value: business.facebook, confidence: 0.72, sourceUrl: business.facebook, reason: "business_social" });
  if (linkedinCompany?.linkedinUrl) {
    add({
      kind: "linkedin_company",
      value: linkedinCompany.linkedinUrl,
      confidence: linkedinCompany.confidence || 0.74,
      sourceUrl: linkedinCompany.linkedinUrl,
      reason: "linkedin_company_detected"
    });
  }

  return values.sort((a, b) => accessContactPriority(b) - accessContactPriority(a)).slice(0, 10);
}

function normalizeContactKind(kind) {
  const value = String(kind || "").toLowerCase();
  if (value === "phone" || value === "decision_maker_phone" || value === "email" || value === "decision_maker_email" || value === "whatsapp") {
    if (value.endsWith("_phone")) return "phone";
    if (value.endsWith("_email")) return "email";
    return value;
  }
  if (value === "linkedin" || value === "linkedin_company") return "linkedin_company";
  if (value === "instagram" || value === "facebook" || value === "website") return value;
  return "";
}

function contactConfidence(kind) {
  return {
    phone: 0.85,
    whatsapp: 0.86,
    email: 0.8,
    linkedin_company: 0.74,
    instagram: 0.72,
    facebook: 0.72,
    website: 0.68
  }[kind] || 0.6;
}

function accessContactPriority(contact = {}) {
  const kindScore = {
    whatsapp: 100,
    phone: 95,
    email: 80,
    linkedin_company: 58,
    instagram: 52,
    facebook: 50,
    website: 35
  }[contact.kind] || 10;
  const mobileBonus = contact.kind === "phone" && /^\+34[67]/.test(contact.value) ? 12 : 0;
  return kindScore + mobileBonus + Number(contact.confidence || 0) * 10;
}

function normalizeDecisionStatus(value, found) {
  const status = String(value || "").toLowerCase();
  if (status === "verified" && !found) return "candidate";
  if (["verified", "candidate", "access_contact", "not_found"].includes(status)) return status;
  return found ? "verified" : "not_found";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item)).filter(Boolean);
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const clean = cleanText(value);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
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

function normalizeLinkedInProfileUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value).startsWith("http") ? value : `https://${value}`);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!LINKEDIN_PROFILE_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))) return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "in" || !parts[1]) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = `/in/${parts[1]}`;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normalizeLinkedInCompanyUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value).startsWith("http") ? value : `https://${value}`);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!LINKEDIN_PROFILE_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))) return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "company" || !parts[1]) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = `/company/${parts[1]}`;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normalizeUrlForDedupe(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value).startsWith("http") ? value : `https://${value}`);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function normalizeWebsiteUrl(value, rootUrl) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const base = rootUrl ? new URL(String(rootUrl).startsWith("http") ? rootUrl : `https://${rootUrl}`) : undefined;
    const parsed = new URL(raw, base);
    if (!/^https?:$/i.test(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isSameWebsiteUrl(url, rootUrl) {
  try {
    const parsed = new URL(url);
    const root = new URL(String(rootUrl).startsWith("http") ? rootUrl : `https://${rootUrl}`);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase() === root.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return false;
  }
}

function isBlockedWebsiteDecisionUrl(url) {
  try {
    const parsed = new URL(url);
    const href = parsed.toString().toLowerCase();
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|bmp|tiff|ico|pdf|zip|rar|mp4|mp3)(?:[?#]|$)/i.test(href)) return true;
    if (/facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|wa\.me|whatsapp/i.test(href)) return true;
    return false;
  } catch {
    return true;
  }
}

function websiteDecisionUrlScore(value) {
  const text = normalizeText(value);
  let score = 0;
  if (/contact|contacto|ubicacion|telefono|whatsapp/.test(text)) score += 90;
  if (/conocenos|quienes|sobre-nosotros|sobre nosotros|about|equipo|team/.test(text)) score += 70;
  if (/aviso-legal|legal|privacidad|privacy|politica/.test(text)) score += 55;
  if (/empresa|direccion|administrador|gerente|fundador|propietario|titular/.test(text)) score += 35;
  if (/blog|noticia|news|categoria|tag|producto|servicio|galeria/.test(text)) score -= 35;
  return score;
}

function normalizeWebsiteUrlPlan(rawPlan, rootUrl) {
  const rawUrls = Array.isArray(rawPlan?.urls)
    ? rawPlan.urls
    : Array.isArray(rawPlan?.prioritizedUrls)
      ? rawPlan.prioritizedUrls
      : Array.isArray(rawPlan?.prioritized_urls)
        ? rawPlan.prioritized_urls
        : [];
  const urls = rawUrls
    .map((item) => normalizeWebsiteUrl(typeof item === "string" ? item : item?.url, rootUrl))
    .filter((url) => url && isSameWebsiteUrl(url, rootUrl) && !isBlockedWebsiteDecisionUrl(url));
  return { urls: uniqueStrings(urls) };
}

function normalizeDecisionMakerMobile(value) {
  const phone = normalizeSpanishPhone(value);
  return phone && /^\+34[67]/.test(phone) ? phone : "";
}

function normalizeDecisionMakerEmail(value) {
  const match = cleanText(value).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : "";
}

function cleanPersonName(value, businessName = "") {
  const clean = cleanText(value)
    .replace(/\b(gerente|director|directora|propietario|propietaria|fundador|fundadora|administrador|administradora|ceo|owner)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length < 3) return "";
  const normalized = normalizeText(clean);
  const businessNorm = normalizeText(businessName);
  const cleanBusinessNorm = normalizeText(cleanCompanyName(businessName));
  if ((businessNorm && businessNorm.includes(normalized)) || (cleanBusinessNorm && normalized.includes(cleanBusinessNorm))) return "";
  if (!/[a-záéíóúüñ]{2,}\s+[a-záéíóúüñ]{2,}/i.test(clean) && clean.split(/\s+/).length > 3) return "";
  return clean.slice(0, 120);
}

function namesLikelySamePerson(left, right) {
  if (!left || !right) return true;
  const leftTokens = significantPersonTokens(left);
  const rightTokens = significantPersonTokens(right);
  if (!leftTokens.length || !rightTokens.length) return true;
  return leftTokens.some((token) => rightTokens.includes(token));
}

function significantPersonTokens(value) {
  const blocked = new Set(["de", "del", "la", "las", "los", "el", "y"]);
  return normalizeText(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !blocked.has(token));
}

function cleanHtmlText(value) {
  return String(value || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function compactWebsiteDecisionForAi(value = {}) {
  if (!value || typeof value !== "object") return null;
  return compactObject({
    status: value.status,
    found: value.found,
    fullName: value.fullName,
    role: value.role,
    phone: value.phone,
    email: value.email,
    sourceUrl: value.sourceUrl,
    confidence: value.confidence,
    reason: value.reason,
    evidenceSummary: value.evidenceSummary
  });
}

function cleanCompanyName(value) {
  return String(value || "")
    .replace(/\b(s\.?\s*l\.?u?|s\.?\s*l\.?|s\.?\s*a\.?|s\.?\s*c\.?|s\.?\s*coop\.?|sociedad limitada|sociedad anonima|sociedad anónima)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[,.]+$/g, "")
    .trim();
}

function brandCompanyName(value) {
  const cleaned = cleanCompanyName(value);
  const beforeDescriptor = cleaned
    .split(/\b(?:empresa|compañ[ií]a|servicios?|especialistas?|expertos?|instalaciones?|mantenimiento|tienda|cl[ií]nica|despacho)\s+(?:de|en)\b/i)[0]
    ?.trim();
  if (beforeDescriptor && significantTokens(beforeDescriptor).length >= 1) return beforeDescriptor;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  return tokens.length > 3 ? tokens.slice(0, 2).join(" ") : cleaned;
}

function companySearchNames(business = {}) {
  const names = [brandCompanyName(business.name), cleanCompanyName(business.name)]
    .map((name) => cleanText(name))
    .filter(Boolean);
  return [...new Set(names)].slice(0, 3);
}

function extractPersonName({ title, company }) {
  const cleaned = cleanText(title)
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+-\s*LinkedIn.*$/i, "");
  const firstSegment = cleaned.split(/\s[-|•]\s/)[0]?.trim() || "";
  if (!firstSegment || normalizeText(firstSegment).includes(normalizeText(company))) return "";
  if (ROLE_PATTERNS.some((pattern) => pattern.test(firstSegment))) return "";
  return firstSegment.slice(0, 120);
}

function extractRole({ title, description }) {
  const segments = cleanText(title)
    .split(/\s[-|•]\s/)
    .map((item) => item.trim())
    .filter(Boolean)
    .concat(cleanText(description).split(/[.;]/).map((item) => item.trim()));
  const match = segments.find((segment) => ROLE_PATTERNS.some((pattern) => pattern.test(segment)));
  return match ? match.slice(0, 160) : "";
}

function significantTokens(value) {
  const blocked = new Set(["de", "del", "la", "las", "los", "el", "y", "en", "para", "instalaciones", "servicios", "servicio"]);
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3 && !blocked.has(token))
    .slice(0, 6);
}

function compactCompanyToken(value) {
  return normalizeText(cleanCompanyName(value)).replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanSearchQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 260);
}

function roundConfidence(value) {
  return Math.round(Math.max(0, Math.min(0.95, Number(value) || 0)) * 100) / 100;
}

function emptyDecisionMakerResult({ business, now, reason }) {
  return {
    found: false,
    checkedAt: now.toISOString(),
    query: buildLinkedInDecisionMakerDork(business),
    reason
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== "" && (!Array.isArray(item) || item.length)));
}
