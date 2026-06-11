export function verifiedDecisionMakerForStorage(enrichment = {}) {
  if (enrichment?.found !== true) return null;
  if (enrichment?.decisionStatus !== "verified") return null;
  if (enrichment?.ai?.status !== "resolved") return null;
  if (enrichment?.ai?.verification?.status !== "confirmed") return null;
  const decisionMaker = enrichment.decisionMaker || {};
  if (!isPersonalLinkedInUrl(decisionMaker.linkedinUrl)) return null;
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
