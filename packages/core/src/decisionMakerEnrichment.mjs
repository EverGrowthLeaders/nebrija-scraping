const LINKEDIN_PROFILE_HOSTS = ["linkedin.com"];
const ROLE_PATTERNS = [
  /\b(ceo|founder|cofounder|co-founder|owner|partner|managing director)\b/i,
  /\b(gerente|director|directora|propietario|propietaria|fundador|fundadora|socio|socia|administrador|administradora|responsable)\b/i
];

export async function enrichDecisionMaker({ business = {}, searchClient, now = new Date() } = {}) {
  if (!searchClient?.search || !business.name || !business.city) {
    return emptyDecisionMakerResult({ business, now, reason: "missing_required_fields" });
  }

  const query = buildLinkedInDecisionMakerDork(business);
  const results = await searchClient.search(query, { limit: 5 });
  return selectDecisionMakerFromSearchResults({ business, query, results, now });
}

export function buildLinkedInDecisionMakerDork(business = {}) {
  const company = cleanCompanyName(business.name);
  const city = String(business.city || "").trim();
  return `site:linkedin.com/in/ "${company}" "${city}"`;
}

export function selectDecisionMakerFromSearchResults({ business = {}, query, results = [], now = new Date() } = {}) {
  const candidates = results
    .map((result) => buildDecisionMakerCandidate({ business, query, result, now }))
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

function buildDecisionMakerCandidate({ business, query, result, now }) {
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
