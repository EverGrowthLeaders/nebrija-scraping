// Company enrichment via the Apify actor `sourabhbgp/linkedin-company-scraper`.
// The actor takes LinkedIn company URLs/slugs and returns rich firmographics
// (employee count, size range, industry, HQ, founded year, followers, ...).
//
// It does NOT do free-text name search, so we need a LinkedIn company URL. The
// decision-maker enrichment already discovers and stores one (contact kind
// "linkedin_company" / custom_fields.decision_maker.linkedinCompany), so this
// step builds on top of it.

const LINKEDIN_COMPANY_URL = /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase)\/[^\s"')]+/i;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function normalizeLinkedinCompanyUrl(value) {
  const match = String(value || "").match(LINKEDIN_COMPANY_URL);
  if (!match) return null;
  return match[0].replace(/[)\].,]+$/, "").replace(/\/+$/, "");
}

// Find a usable LinkedIn company URL from whatever the lead already knows.
export function resolveCompanyLinkedinUrl({ business = {}, contacts = [] } = {}) {
  const contactUrl = contacts
    .filter((c) => c && (c.kind === "linkedin_company" || c.kind === "linkedin_decision_maker"))
    .map((c) => normalizeLinkedinCompanyUrl(c.value))
    .find(Boolean);
  if (contactUrl) return contactUrl;

  const custom = business.custom_fields || business.customFields || {};
  const dm = custom.decision_maker || custom.decisionMaker || {};
  const fromDecisionMaker = normalizeLinkedinCompanyUrl(
    dm?.linkedinCompany?.linkedinUrl ||
      dm?.linkedin_company?.linkedinUrl ||
      dm?.linkedinCompany?.linkedin_url
  );
  if (fromDecisionMaker) return fromDecisionMaker;

  const stored = business.linkedin_company || business.linkedinCompany || {};
  return normalizeLinkedinCompanyUrl(stored.linkedinUrl || stored.companyUrl);
}

// Map one Apify dataset item to a stable shape regardless of minor schema drift.
export function normalizeLinkedinCompany(item = {}) {
  if (!item || typeof item !== "object") return null;
  const address = item.address || item.headquartersAddress || {};
  const headquarters = firstString(
    item.headquarters,
    [address.city, address.state, address.country].filter(Boolean).join(", ") || null
  );
  const employeeCount = firstNumber(
    item.exactEmployeeCount,
    item.employeeCount,
    item.employeesCount,
    item.staffCount,
    item.numberOfEmployees
  );
  const specialties = Array.isArray(item.specialties)
    ? item.specialties.filter((s) => typeof s === "string" && s.trim())
    : firstString(item.specialties)
      ? [firstString(item.specialties)]
      : [];
  return {
    name: firstString(item.companyName, item.name),
    linkedinUrl: normalizeLinkedinCompanyUrl(item.companyUrl || item.url) || firstString(item.companyUrl, item.url),
    slug: firstString(item.companySlug, item.universalName),
    description: firstString(item.description, item.about),
    slogan: firstString(item.slogan, item.tagline),
    website: firstString(item.website, item.companyWebsite),
    industry: firstString(item.industry),
    organizationType: firstString(item.organizationType, item.companyType),
    employeeCount,
    employeeRange: firstString(item.companySizeRange, item.companySize, item.employeeCountRange),
    followerCount: firstNumber(item.followerCount, item.followersCount, item.followers),
    foundedYear: firstNumber(item.foundedYear, item.founded),
    headquarters,
    address: address && typeof address === "object" ? address : null,
    specialties,
    openJobCount: firstNumber(item.openJobCount, item.jobCount),
    logoUrl: firstString(item.logoUrl, item.logo),
    scrapedAt: firstString(item.scrapedAt) || new Date().toISOString()
  };
}

export function emptyCompanyResult({ reason, linkedinUrl = null, now = new Date() } = {}) {
  return { found: false, reason, linkedinUrl, company: null, checkedAt: now.toISOString() };
}

export async function enrichBusinessCompany({ business = {}, contacts = [], apify, now = new Date() } = {}) {
  if (!apify?.enabled) return emptyCompanyResult({ reason: "apify_disabled", now });

  const linkedinUrl = resolveCompanyLinkedinUrl({ business, contacts });
  if (!linkedinUrl) return emptyCompanyResult({ reason: "no_linkedin_company_url", now });

  let items;
  try {
    items = await apify.runLinkedinCompanyScraper({ companies: [linkedinUrl], maxResults: 1, maxConcurrency: 1 });
  } catch (error) {
    return { ...emptyCompanyResult({ reason: "apify_error", linkedinUrl, now }), error: String(error?.message || error) };
  }

  const item = Array.isArray(items) ? items.find((entry) => entry && typeof entry === "object") : null;
  if (!item) return emptyCompanyResult({ reason: "no_results", linkedinUrl, now });

  const company = normalizeLinkedinCompany(item);
  return {
    found: Boolean(company && (company.name || company.employeeCount != null)),
    reason: "ok",
    linkedinUrl: company?.linkedinUrl || linkedinUrl,
    company,
    checkedAt: now.toISOString()
  };
}
