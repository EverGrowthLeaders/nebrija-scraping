export function aiBackedAdsActiveForStorage(providerDetail = {}) {
  if (providerDetail?.ai?.status !== "resolved") return null;
  if (providerDetail?.ai?.verification?.status !== "confirmed") return null;
  if (providerDetail.active === true) return true;
  if (providerDetail.active === false) return false;
  return null;
}

export function adsEnrichmentForStorage(enrichment = {}) {
  const sanitized = {
    ...(enrichment || {}),
    meta: sanitizeProviderForStorage(enrichment?.meta),
    google: sanitizeProviderForStorage(enrichment?.google)
  };
  const hasVerifiedActiveAds = sanitized.meta?.active === true || sanitized.google?.active === true;
  if (!hasVerifiedActiveAds && sanitized.classification?.type && sanitized.classification.type !== "unknown") {
    sanitized.classification = {
      ...sanitized.classification,
      type: "unknown",
      confidence: 0,
      reason: "storage_requires_verified_active_ads",
      storageSanitized: true
    };
  }
  return sanitized;
}

function sanitizeProviderForStorage(providerDetail = {}) {
  if (!providerDetail || typeof providerDetail !== "object") return providerDetail || null;
  const storedActive = aiBackedAdsActiveForStorage(providerDetail);
  if (storedActive !== null) return providerDetail;
  if (typeof providerDetail.active !== "boolean") return providerDetail;
  return {
    ...providerDetail,
    active: null,
    status: "unknown",
    confidence: 0,
    reason: "storage_requires_ai_verification",
    spendEstimate: null,
    storageSanitized: true
  };
}
