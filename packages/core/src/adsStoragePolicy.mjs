export function aiBackedAdsActiveForStorage(providerDetail = {}) {
  if (providerDetail?.ai?.status !== "resolved") return null;
  if (providerDetail?.ai?.verification?.status !== "confirmed") return null;
  if (providerDetail.active === true) return true;
  if (providerDetail.active === false) return false;
  return null;
}

export function operationalAdsActiveForStorage(provider, providerDetail = {}) {
  const aiBacked = aiBackedAdsActiveForStorage(providerDetail);
  if (aiBacked !== null) return aiBacked;
  if (!providerDetail || typeof providerDetail !== "object") return null;

  const evidence = providerEvidenceEntries(providerDetail);
  if (evidence.some((entry) => strongActiveEvidence(provider, entry))) return true;
  if (evidence.some((entry) => strongInactiveEvidence(provider, entry))) return false;
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

function providerEvidenceEntries(providerDetail = {}) {
  return [
    providerDetail,
    ...(Array.isArray(providerDetail.attempts) ? providerDetail.attempts : [])
  ].filter((entry) => entry && typeof entry === "object");
}

function strongActiveEvidence(provider, entry = {}) {
  if (provider === "google") return strongGoogleActiveEvidence(entry);
  if (provider === "meta") return strongMetaActiveEvidence(entry);
  return false;
}

function strongInactiveEvidence(provider, entry = {}) {
  const active = activeSignal(entry);
  const status = String(entry.status || entry.statusSignal || "").toLowerCase();
  const reason = reasonSignal(entry);
  const fields = matchedFields(entry);
  const source = sourceProvider(entry);
  if (active !== false && status !== "inactive") return false;
  if (provider === "google") {
    return source === "apify" &&
      reason === "apify_google_no_recent_domain_ads" &&
      fields.includes("domain");
  }
  return false;
}

function strongGoogleActiveEvidence(entry = {}) {
  const active = activeSignal(entry);
  const status = String(entry.status || entry.statusSignal || "").toLowerCase();
  const reason = reasonSignal(entry);
  const fields = matchedFields(entry);
  const source = sourceProvider(entry);
  const hasOwnedDomain = fields.some((field) => ["domain", "landing_domain", "brand_domain"].includes(field));
  const allowedSource = ["apify", "firecrawl", "browser"].includes(source);
  if (!allowedSource || !hasOwnedDomain) return false;
  if (active !== true && status !== "active") return false;
  return [
    "google_domain_ads_found",
    "apify_google_recent_domain_ad"
  ].includes(reason) || Boolean(entry.adArchiveId || entry.landingUrl || landingUrls(entry).length);
}

function strongMetaActiveEvidence(entry = {}) {
  const active = activeSignal(entry);
  const status = String(entry.status || entry.statusSignal || "").toLowerCase();
  const reason = reasonSignal(entry);
  const fields = matchedFields(entry);
  const source = sourceProvider(entry);
  const allowedSource = ["apify", "browser"].includes(source);
  if (!allowedSource) return false;
  const explicitlyActive = active === true || status === "active" || [
    "apify_meta_active_item_candidate",
    "apify_meta_exact_domain_active_items",
    "browser_meta_active_item_candidate"
  ].includes(reason);
  if (!explicitlyActive) return false;
  if (reason === "apify_meta_exact_domain_active_items") return fields.includes("domain");
  if (reason === "apify_meta_page_scoped_candidate") return false;
  return hasOwnedMetaAdsIdentity(fields);
}

function hasOwnedMetaAdsIdentity(fields = []) {
  const hasDomain = fields.includes("domain");
  const hasLanding = fields.includes("landing_domain");
  const hasPageName = fields.includes("page_name");
  const hasSocial = fields.some((field) => field.endsWith("_handle") || field.endsWith("_url"));
  return hasLanding || (hasDomain && (hasPageName || hasSocial));
}

function activeSignal(entry = {}) {
  if (entry.active === true || entry.activeSignal === true) return true;
  if (entry.active === false || entry.activeSignal === false) return false;
  return null;
}

function reasonSignal(entry = {}) {
  return String(entry.reason || entry.reasonSignal || "").toLowerCase();
}

function sourceProvider(entry = {}) {
  return String(entry.sourceProvider || entry.source_provider || "").toLowerCase();
}

function matchedFields(entry = {}) {
  return Array.isArray(entry.matchedFields)
    ? entry.matchedFields.map((field) => String(field || "").toLowerCase()).filter(Boolean)
    : [];
}

function landingUrls(entry = {}) {
  return Array.isArray(entry.landingUrls) ? entry.landingUrls.filter(Boolean) : [];
}
