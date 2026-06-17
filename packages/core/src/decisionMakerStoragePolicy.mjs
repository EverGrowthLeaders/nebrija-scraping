export function verifiedDecisionMakerForStorage(enrichment = {}) {
  if (enrichment?.found !== true) return null;
  if (enrichment?.decisionStatus !== "verified") return null;
  const decisionMaker = enrichment.decisionMaker || {};
  if (isPersonalLinkedInUrl(decisionMaker.linkedinUrl)) {
    if (enrichment?.ai?.status !== "resolved") return null;
    if (enrichment?.ai?.verification?.status !== "confirmed") return null;
    return decisionMaker;
  }
  if (!isVerifiedWebsiteDecisionMaker(enrichment, decisionMaker)) return null;
  return decisionMaker;
}

export function decisionMakerEnrichmentForStorage(enrichment = {}) {
  if (!enrichment || typeof enrichment !== "object") return {};
  if (verifiedDecisionMakerForStorage(enrichment)) return enrichment;
  if (enrichment.found !== true && enrichment.decisionStatus !== "verified" && !enrichment.decisionMaker) {
    return enrichment;
  }
  return {
    ...enrichment,
    found: false,
    decisionStatus: enrichment.recommendedAccessContact ? "access_contact" : "candidate",
    reason: "storage_requires_verified_ai_decision_maker",
    unverifiedDecisionMaker: enrichment.decisionMaker || null,
    decisionMaker: null,
    ai: {
      ...(enrichment.ai || {}),
      storageSanitized: true
    }
  };
}

function isPersonalLinkedInUrl(value) {
  return /(^https?:\/\/)?([a-z]+\.)?linkedin\.com\/in\//i.test(String(value || ""));
}

function isVerifiedWebsiteDecisionMaker(enrichment = {}, decisionMaker = {}) {
  const web = enrichment.websiteDecisionMaker || enrichment.website_decision_maker || {};
  if (web.status !== "verified" || web.found !== true) return false;
  if (!decisionMaker.fullName || !decisionMaker.sourceUrl) return false;
  if (decisionMaker.phone && !/^\+34[67]\d{8}$/.test(String(decisionMaker.phone))) return false;
  return decisionMaker.sourceType === "business_website" || Boolean(web.sourceUrl);
}
