import { config } from "./config.mjs";

const LINKEDIN_PROFILE_HOSTS = ["linkedin.com"];
const DEFAULT_MAX_AI_EVIDENCE_CHARS = 12000;
const ROLE_PATTERNS = [
  /\b(ceo|founder|cofounder|co-founder|owner|partner|managing director)\b/i,
  /\b(gerente|director|directora|propietario|propietaria|fundador|fundadora|socio|socia|administrador|administradora|responsable)\b/i
];

export async function enrichDecisionMaker({
  business = {},
  contacts = [],
  searchClient,
  aiResolver,
  aiConfig = config.decisionMakerAi,
  now = new Date()
} = {}) {
  if (!searchClient?.search || !business.name || !business.city) {
    return emptyDecisionMakerResult({ business, now, reason: "missing_required_fields" });
  }

  const search = await runEscalatedDecisionMakerSearch({ business, searchClient });
  const deterministic = selectDecisionMakerFromSearchResults({
    business,
    query: search.queries[0],
    queries: search.queries,
    results: search.results,
    linkedinCompany: search.linkedinCompany,
    accessContacts: buildAccessContacts({ business, contacts, linkedinCompany: search.linkedinCompany }),
    now
  });

  if (!shouldUseAiDecisionMakerResolver({ deterministic, aiResolver, aiConfig })) {
    return deterministic;
  }

  try {
    const rawResult = aiResolver
      ? await aiResolver({
          business,
          query: deterministic.query,
          queries: deterministic.queries || [],
          candidates: deterministic.candidates || [],
          accessContacts: deterministic.accessContacts || [],
          linkedinCompany: deterministic.linkedinCompany || null,
          deterministic,
          aiConfig
        })
      : await resolveDecisionMakerWithDeepInfra({
          business,
          query: deterministic.query,
          queries: deterministic.queries || [],
          candidates: deterministic.candidates || [],
          accessContacts: deterministic.accessContacts || [],
          linkedinCompany: deterministic.linkedinCompany || null,
          deterministic,
          aiConfig
        });
    return mergeAiDecisionMakerResult({ deterministic, rawResult, aiConfig });
  } catch (error) {
    return {
      ...deterministic,
      ai: {
        status: "failed",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null,
        error: error.message
      }
    };
  }
}

export function buildLinkedInDecisionMakerDork(business = {}) {
  const [company] = companySearchNames(business);
  const city = String(business.city || "").trim();
  return `site:linkedin.com/in/ "${company}" "${city}"`;
}

export function buildLinkedInDecisionMakerQueries(business = {}) {
  const names = companySearchNames(business);
  const company = names[0];
  const city = String(business.city || "").trim();
  const compact = compactCompanyToken(company);
  const queries = [
    ...names.flatMap((name) => [
      `site:linkedin.com/in/ "${name}" "${city}"`,
      `site:linkedin.com/in/ "${name}"`,
      `site:linkedin.com/in/ "${name}" gerente OR fundador OR socio OR director`,
      `site:linkedin.com/company/ "${name}" "${city}"`
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
  results = [],
  linkedinCompany,
  accessContacts,
  now = new Date()
} = {}) {
  const candidates = results
    .map((result, index) => buildDecisionMakerCandidate({ business, query, result, index, now }))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || null;
  const company = linkedinCompany || selectLinkedInCompanyFromSearchResults({ business, results });
  const contacts = accessContacts || buildAccessContacts({ business, contacts: [], linkedinCompany: company });
  if (!best || best.confidence < 0.55) {
    return {
      found: false,
      decisionStatus: contacts.length || company ? "access_contact" : "not_found",
      checkedAt: now.toISOString(),
      query,
      queries: queries || (query ? [query] : []),
      reason: best ? "low_confidence_match" : "no_linkedin_profile_match",
      linkedinCompany: company || null,
      accessContacts: contacts,
      recommendedAccessContact: contacts[0] || null,
      candidates: candidates.slice(0, 5)
    };
  }
  return {
    found: true,
    decisionStatus: "verified",
    checkedAt: now.toISOString(),
    query,
    queries: queries || (query ? [query] : []),
    decisionMaker: best,
    linkedinCompany: company || null,
    accessContacts: contacts,
    recommendedAccessContact: contacts[0] || null,
    candidates: candidates.slice(0, 5)
  };
}

async function runEscalatedDecisionMakerSearch({ business = {}, searchClient }) {
  const baseQueries = buildLinkedInDecisionMakerQueries(business);
  const collected = [];
  const queries = [];
  for (const query of baseQueries) {
    const results = await safeSearch(searchClient, query, { limit: 5 });
    queries.push(query);
    addSearchResults(collected, results);
    const strong = selectDecisionMakerFromSearchResults({ business, query, queries, results: collected });
    if (strong.found && strong.decisionMaker?.confidence >= 0.82) break;
  }

  const firstPassCandidates = collected
    .map((result, index) => buildDecisionMakerCandidate({ business, query: baseQueries[0], result, index, now: new Date() }))
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
      addSearchResults(collected, results);
    }
  }

  return {
    queries,
    results: collected,
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

function addSearchResults(target, results = []) {
  const seen = new Set(target.map((item) => normalizeUrlForDedupe(item.url)));
  for (const result of results || []) {
    const key = normalizeUrlForDedupe(result?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.push(result);
  }
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
  const hasContext = candidates.length || deterministic.linkedinCompany || deterministic.accessContacts?.length;
  if (!hasContext) return false;
  if (aiResolver) return true;
  if (!aiConfig || aiConfig.mode === "never" || aiConfig.provider !== "deepinfra" || !aiConfig.apiKey) return false;
  if (aiConfig.mode === "always") return true;

  const [first, second] = candidates;
  if (!first) return Boolean(deterministic.linkedinCompany || deterministic.accessContacts?.length);
  if (!deterministic.found && first.confidence >= 0.45) return true;
  if (!second) return false;
  return first.confidence < 0.82 || first.confidence - second.confidence < 0.18;
}

async function resolveDecisionMakerWithDeepInfra({
  business = {},
  query,
  queries = [],
  candidates = [],
  accessContacts = [],
  linkedinCompany,
  deterministic = {},
  aiConfig = config.decisionMakerAi
} = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const evidence = buildDecisionMakerEvidencePack({
    business,
    query,
    queries,
    candidates,
    accessContacts,
    linkedinCompany,
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

function buildDecisionMakerEvidencePack({
  business = {},
  query,
  queries = [],
  candidates = [],
  accessContacts = [],
  linkedinCompany,
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
      matchedCompanyTokens: candidate.matchedCompanyTokens || []
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

async function postDeepInfraJson({ baseUrl, apiKey, body, timeoutMs }) {
  if (!apiKey) throw new Error("deepinfra_api_key_missing");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`deepinfra_http_${response.status}:${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function mergeAiDecisionMakerResult({ deterministic = {}, rawResult, aiConfig }) {
  const normalized = normalizeAiDecisionMakerResult(rawResult);
  if (!normalized) {
    return {
      ...deterministic,
      ai: {
        status: "invalid_response",
        provider: aiConfig?.provider || "deepinfra",
        model: aiConfig?.model || null
      }
    };
  }

  const candidates = deterministic.candidates || [];
  const accessContacts = deterministic.accessContacts || [];
  const selected = normalized.selectedCandidateId
    ? candidates.find((candidate) => candidate.candidateId === normalized.selectedCandidateId)
    : null;
  const selectedAccessContact = normalized.selectedAccessContactId
    ? accessContacts.find((contact) => contact.contactId === normalized.selectedAccessContactId)
    : deterministic.recommendedAccessContact || null;

  if (normalized.decisionStatus === "access_contact" || (!normalized.found && !selected)) {
    return {
      found: false,
      decisionStatus: selectedAccessContact ? "access_contact" : normalized.decisionStatus || deterministic.decisionStatus || "not_found",
      checkedAt: deterministic.checkedAt,
      query: deterministic.query,
      queries: deterministic.queries || [],
      reason: normalized.reason || (selectedAccessContact ? "ai_selected_access_contact" : "ai_rejected_candidates"),
      linkedinCompany: deterministic.linkedinCompany || null,
      accessContacts,
      recommendedAccessContact: selectedAccessContact || null,
      candidates,
      riskFlags: normalized.riskFlags,
      ai: aiDecisionMakerMetadata({ status: "resolved_no_match", rawResult, aiConfig, deterministic })
    };
  }

  if (!normalized.found || !selected || normalized.confidence < 0.55) {
    return {
      ...deterministic,
      decisionStatus: normalized.decisionStatus || deterministic.decisionStatus || "candidate",
      reason: normalized.reason || "ai_rejected_candidates",
      riskFlags: normalized.riskFlags,
      ai: aiDecisionMakerMetadata({ status: "resolved_no_match", rawResult, aiConfig, deterministic })
    };
  }

  const decisionMaker = {
    ...selected,
    fullName: normalized.fullName || selected.fullName,
    role: normalized.role || selected.role,
    confidence: roundConfidence(Math.max(selected.confidence || 0, normalized.confidence || 0))
  };

  return {
    found: true,
    decisionStatus: normalized.decisionStatus === "candidate" ? "candidate" : "verified",
    checkedAt: deterministic.checkedAt,
    query: deterministic.query,
    queries: deterministic.queries || [],
    decisionMaker: compactObject(decisionMaker),
    linkedinCompany: deterministic.linkedinCompany || null,
    accessContacts,
    recommendedAccessContact: selectedAccessContact || deterministic.recommendedAccessContact || null,
    candidates,
    reason: normalized.reason || "ai_resolved_candidate",
    riskFlags: normalized.riskFlags,
    ai: aiDecisionMakerMetadata({ status: "resolved", rawResult, aiConfig, deterministic })
  };
}

function normalizeAiDecisionMakerResult(rawResult) {
  if (!rawResult || typeof rawResult !== "object") return null;
  const selectedCandidateId = String(rawResult.selectedCandidateId || rawResult.selected_candidate_id || "").trim();
  const selectedAccessContactId = String(rawResult.selectedAccessContactId || rawResult.selected_access_contact_id || "").trim();
  const found = rawResult.found === true || String(rawResult.found).toLowerCase() === "true";
  const decisionStatus = normalizeDecisionStatus(rawResult.decisionStatus || rawResult.decision_status, found);
  return {
    found,
    decisionStatus,
    selectedCandidateId: selectedCandidateId || null,
    selectedAccessContactId: selectedAccessContactId || null,
    confidence: roundConfidence(rawResult.confidence),
    fullName: cleanText(rawResult.fullName || rawResult.full_name),
    role: cleanText(rawResult.role),
    reason: normalizeReason(rawResult.reason),
    riskFlags: normalizeStringArray(rawResult.riskFlags || rawResult.risk_flags).slice(0, 6)
  };
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
    usage: rawResult?.usage || null
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
    return match ? JSON.parse(match[0]) : null;
  }
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
    }))
  };
  serialized = JSON.stringify(reduced);
  if (serialized.length <= limit) return reduced;
  return {
    ...reduced,
    candidates: reduced.candidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      sourceSnippet: String(candidate.sourceSnippet || "").slice(0, 280)
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
  if (value === "phone" || value === "email" || value === "whatsapp") return value;
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
  if (["verified", "candidate", "access_contact", "not_found"].includes(status)) return status;
  return found ? "verified" : "not_found";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item)).filter(Boolean);
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
