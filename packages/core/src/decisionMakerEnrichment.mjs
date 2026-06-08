import { config } from "./config.mjs";

const LINKEDIN_PROFILE_HOSTS = ["linkedin.com"];
const DEFAULT_MAX_AI_EVIDENCE_CHARS = 12000;
const ROLE_PATTERNS = [
  /\b(ceo|founder|cofounder|co-founder|owner|partner|managing director)\b/i,
  /\b(gerente|director|directora|propietario|propietaria|fundador|fundadora|socio|socia|administrador|administradora|responsable)\b/i
];

export async function enrichDecisionMaker({
  business = {},
  searchClient,
  aiResolver,
  aiConfig = config.decisionMakerAi,
  now = new Date()
} = {}) {
  if (!searchClient?.search || !business.name || !business.city) {
    return emptyDecisionMakerResult({ business, now, reason: "missing_required_fields" });
  }

  const query = buildLinkedInDecisionMakerDork(business);
  const results = await searchClient.search(query, { limit: 5 });
  const deterministic = selectDecisionMakerFromSearchResults({ business, query, results, now });

  if (!shouldUseAiDecisionMakerResolver({ deterministic, aiResolver, aiConfig })) {
    return deterministic;
  }

  try {
    const rawResult = aiResolver
      ? await aiResolver({ business, query, candidates: deterministic.candidates || [], deterministic, aiConfig })
      : await resolveDecisionMakerWithDeepInfra({
          business,
          query,
          candidates: deterministic.candidates || [],
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
  const company = cleanCompanyName(business.name);
  const city = String(business.city || "").trim();
  return `site:linkedin.com/in/ "${company}" "${city}"`;
}

export function selectDecisionMakerFromSearchResults({ business = {}, query, results = [], now = new Date() } = {}) {
  const candidates = results
    .map((result, index) => buildDecisionMakerCandidate({ business, query, result, index, now }))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || null;
  if (!best || best.confidence < 0.55) {
    return {
      found: false,
      checkedAt: now.toISOString(),
      query,
      reason: best ? "low_confidence_match" : "no_linkedin_profile_match",
      candidates: candidates.slice(0, 3)
    };
  }
  return {
    found: true,
    checkedAt: now.toISOString(),
    query,
    decisionMaker: best,
    candidates: candidates.slice(0, 3)
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
    confidence: roundConfidence(confidence),
    matchedCompanyTokens,
    checkedAt: now.toISOString()
  });
}

function shouldUseAiDecisionMakerResolver({ deterministic = {}, aiResolver, aiConfig }) {
  const candidates = deterministic.candidates || [];
  if (!candidates.length) return false;
  if (aiResolver) return true;
  if (!aiConfig || aiConfig.mode === "never" || aiConfig.provider !== "deepinfra" || !aiConfig.apiKey) return false;
  if (aiConfig.mode === "always") return true;

  const [first, second] = candidates;
  if (!first) return false;
  if (!deterministic.found && first.confidence >= 0.45) return true;
  if (!second) return false;
  return first.confidence < 0.82 || first.confidence - second.confidence < 0.18;
}

async function resolveDecisionMakerWithDeepInfra({
  business = {},
  query,
  candidates = [],
  deterministic = {},
  aiConfig = config.decisionMakerAi
} = {}) {
  const baseUrl = String(aiConfig?.baseUrl || "https://api.deepinfra.com/v1/openai").replace(/\/+$/, "");
  const model = aiConfig?.model || "deepseek-ai/DeepSeek-V4-Flash";
  const evidence = buildDecisionMakerEvidencePack({
    business,
    query,
    candidates,
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
            selectedCandidateId: "candidate id or null",
            confidence: "number 0..1",
            fullName: "string or null; copy from evidence only",
            role: "string or null; copy from evidence only",
            reason: "short snake_case reason"
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
  candidates = [],
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
    deterministic: {
      found: deterministic.found,
      reason: deterministic.reason,
      selectedCandidateId: deterministic.decisionMaker?.candidateId || null,
      confidence: deterministic.decisionMaker?.confidence || null
    },
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
    decisionRules: [
      "The selected candidate must be a personal LinkedIn /in/ profile.",
      "The title or snippet should connect the person to the business name or distinctive business tokens.",
      "The title or snippet should connect the person to the city/province when available.",
      "Prefer decision-maker roles over employee, marketing, recruiter, student or unrelated roles.",
      "If several candidates are plausible, choose the highest authority role with the strongest company and location match.",
      "If no candidate clearly matches, return found=false."
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
  const selected = normalized.selectedCandidateId
    ? candidates.find((candidate) => candidate.candidateId === normalized.selectedCandidateId)
    : null;

  if (!normalized.found || !selected || normalized.confidence < 0.55) {
    return {
      found: false,
      checkedAt: deterministic.checkedAt,
      query: deterministic.query,
      reason: normalized.reason || "ai_rejected_candidates",
      candidates,
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
    checkedAt: deterministic.checkedAt,
    query: deterministic.query,
    decisionMaker: compactObject(decisionMaker),
    candidates,
    reason: normalized.reason || "ai_resolved_candidate",
    ai: aiDecisionMakerMetadata({ status: "resolved", rawResult, aiConfig, deterministic })
  };
}

function normalizeAiDecisionMakerResult(rawResult) {
  if (!rawResult || typeof rawResult !== "object") return null;
  const selectedCandidateId = String(rawResult.selectedCandidateId || rawResult.selected_candidate_id || "").trim();
  const found = rawResult.found === true || String(rawResult.found).toLowerCase() === "true";
  return {
    found,
    selectedCandidateId: selectedCandidateId || null,
    confidence: roundConfidence(rawResult.confidence),
    fullName: cleanText(rawResult.fullName || rawResult.full_name),
    role: cleanText(rawResult.role),
    reason: normalizeReason(rawResult.reason)
  };
}

function aiDecisionMakerMetadata({ status, rawResult, aiConfig, deterministic }) {
  return {
    status,
    provider: aiConfig?.provider || "deepinfra",
    model: aiConfig?.model || null,
    deterministicFound: deterministic?.found === true,
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

function cleanCompanyName(value) {
  return String(value || "")
    .replace(/\b(s\.?\s*l\.?u?|s\.?\s*l\.?|s\.?\s*a\.?|s\.?\s*c\.?|s\.?\s*coop\.?|sociedad limitada|sociedad anonima|sociedad anónima)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[,.]+$/g, "")
    .trim();
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
