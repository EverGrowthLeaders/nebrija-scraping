import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSpanishPhone } from "../packages/core/src/phone.mjs";
import {
  estimateDeepseekUsageCost,
  summarizeDeepseekEnrichmentCosts,
  validateDeepseekCostBudget
} from "../packages/core/src/aiUsage.mjs";
import { adsEnrichmentForStorage, aiBackedAdsActiveForStorage } from "../packages/core/src/adsStoragePolicy.mjs";
import {
  decisionMakerEnrichmentForStorage,
  verifiedDecisionMakerForStorage
} from "../packages/core/src/decisionMakerStoragePolicy.mjs";
import { validateReformasMadridBatchReport } from "../packages/core/src/enrichmentBatchReportPolicy.mjs";
import {
  createApifyUsageStats,
  recordApifyCall,
  summarizeApifyUsage,
  validateApifyUsage
} from "../packages/core/src/apifyUsagePolicy.mjs";
import { extractEmails, extractLeadSignals, extractPhones, selectBusinessUrls } from "../packages/core/src/extractors.mjs";
import { calculateLeadScore, nextOutreachChannel } from "../packages/core/src/scoring.mjs";
import { parseEndOfCallReport } from "../packages/core/src/vapiReport.mjs";
import {
  buildMapRequestBody,
  normalizeMapResponse,
  normalizeScrapeResponse,
  normalizeSearchResponse
} from "../packages/core/src/firecrawl.mjs";
import { mergePlacesFieldMask, normalizePlaces } from "../packages/core/src/googlePlaces.mjs";
import { isAuthorizedApiKey, parseApiKeys } from "../packages/core/src/auth.mjs";
import { normalizeAssistantsResponse } from "../packages/core/src/nebrija.mjs";
import { buildVariableValues, defaultVariableMap } from "../packages/core/src/leadVariables.mjs";
import { buildCampaignCsv, buildCampaignXlsx, campaignExportFilename } from "../packages/core/src/exporters.mjs";
import { buildImportedLeadRows, parseLeadFile, previewLeadImport } from "../packages/core/src/leadImport.mjs";
import { buildMetaAdProbes, buildMetaAdsLibraryUrl, discoverSocialsForAds, enrichBusinessAds, inferAdsActivity } from "../packages/core/src/adsEnrichment.mjs";
import {
  buildLinkedInDecisionMakerDork,
  buildLinkedInDecisionMakerQueries,
  enrichDecisionMaker,
  selectDecisionMakerFromSearchResults
} from "../packages/core/src/decisionMakerEnrichment.mjs";
import {
  buildLandingEvidencePack,
  classifyAdsLandingIntent,
  classifyLandingPage,
  cleanLandingHtml,
  extractLandingUrlsFromText
} from "../packages/core/src/adsLandingClassifier.mjs";

function adsAiResolverFromEvidence(assertEvidence) {
  return async ({ evidence, phase }) => {
    assertEvidence?.({ evidence, phase });
    const decide = (provider) => {
      const attempts = evidence.providers[provider].attempts || [];
      const active = attempts.find((attempt) => attempt.activeSignal === true && attempt.landingUrls?.length) ||
        attempts.find((attempt) => attempt.activeSignal === true);
      if (active) {
        return {
          active: true,
          status: "active",
          confidence: 0.93,
          reason: `ai_${provider}_active_verified`,
          selectedAttemptIds: [active.attemptId],
          landingUrls: active.landingUrls || [],
          matchedFields: active.matchedFields || [],
          latestDetectedDate: active.latestDetectedDate || null,
          sourceUrl: active.sourceUrl,
          evidenceSummary: "AI verified active ads from supplied evidence.",
          needsMoreEvidence: false
        };
      }
      const inactive = attempts.find((attempt) => attempt.activeSignal === false || attempt.statusSignal === "inactive");
      if (inactive) {
        return {
          active: false,
          status: "inactive",
          confidence: 0.86,
          reason: `ai_${provider}_inactive_verified`,
          selectedAttemptIds: [inactive.attemptId],
          landingUrls: [],
          matchedFields: inactive.matchedFields || [],
          latestDetectedDate: inactive.latestDetectedDate || null,
          sourceUrl: inactive.sourceUrl,
          evidenceSummary: "AI verified no active ads from supplied evidence.",
          needsMoreEvidence: false
        };
      }
      return {
        active: null,
        status: "unknown",
        confidence: 0.41,
        reason: `ai_${provider}_unknown`,
        selectedAttemptIds: attempts[0]?.attemptId ? [attempts[0].attemptId] : [],
        landingUrls: [],
        matchedFields: [],
        latestDetectedDate: null,
        sourceUrl: attempts[0]?.sourceUrl || null,
        evidenceSummary: "Evidence is insufficient or ambiguous.",
        needsMoreEvidence: true
      };
    };
    return {
      meta: decide("meta"),
      google: decide("google")
    };
  };
}

test("normalizes Spanish phone numbers to E.164", () => {
  assert.equal(normalizeSpanishPhone("600 111 222"), "+34600111222");
  assert.equal(normalizeSpanishPhone("+34 911 222 333"), "+34911222333");
  assert.equal(normalizeSpanishPhone("0034 600 111 222"), "+34600111222");
  assert.equal(normalizeSpanishPhone("123"), null);
});

test("estimates Deepseek V4 Flash usage cost with cached tokens", () => {
  const cost = estimateDeepseekUsageCost({
    prompt_tokens: 1_000_000,
    completion_tokens: 500_000,
    prompt_tokens_details: { cached_tokens: 200_000 }
  });

  assert.equal(cost.inputTokens, 1_000_000);
  assert.equal(cost.cachedInputTokens, 200_000);
  assert.equal(cost.billableInputTokens, 800_000);
  assert.equal(cost.outputTokens, 500_000);
  assert.equal(cost.estimatedUsd, 0.184);
});

test("summarizes and validates Deepseek enrichment cost budgets", () => {
  const summary = summarizeDeepseekEnrichmentCosts({
    ads: {
      discoveryPlan: { ai: { status: "planned", cost: { estimatedUsd: 0.001, inputTokens: 100 } } },
      meta: { ai: { status: "resolved", cost: { estimatedUsd: 0.002, outputTokens: 20 }, verification: { status: "confirmed", cost: { estimatedUsd: 0.0007, inputTokens: 7 } } } },
      google: { ai: { status: "resolved", cost: { estimatedUsd: 0.003, cachedInputTokens: 10 }, verification: { status: "confirmed", cost: { estimatedUsd: 0.0008, outputTokens: 8 } } } },
      classification: { ai: { status: "classified", cost: { estimatedUsd: 0.004, totalTokens: 400 } } }
    },
    decisionMaker: {
      searchPlan: { ai: { status: "planned", cost: { estimatedUsd: 0.005 } } },
      ai: { status: "resolved", cost: { estimatedUsd: 0.006 }, verification: { status: "confirmed", cost: { estimatedUsd: 0.0009, inputTokens: 9 } } }
    }
  });

  assert.equal(summary.totalEstimatedUsd, 0.0234);
  assert.equal(summary.items.length, 9);
  assert.equal(summary.inputTokens, 116);
  assert.equal(summary.outputTokens, 28);
  assert.equal(summary.cachedInputTokens, 10);
  assert.deepEqual(validateDeepseekCostBudget({ summary, maxUsd: 0.03, label: "Demo" }), []);
  assert.equal(validateDeepseekCostBudget({ summary, maxUsd: 0.02, label: "Demo" })[0].reason, "deepseek_cost_exceeded");
});

test("stores Ads active flags only when backed by resolved AI", () => {
  assert.equal(aiBackedAdsActiveForStorage({ active: true, ai: { status: "resolved", verification: { status: "confirmed" } } }), true);
  assert.equal(aiBackedAdsActiveForStorage({ active: false, ai: { status: "resolved", verification: { status: "confirmed" } } }), false);
  assert.equal(aiBackedAdsActiveForStorage({ active: true, ai: { status: "resolved" } }), null);
  assert.equal(aiBackedAdsActiveForStorage({ active: false, ai: { status: "resolved", verification: { status: "rejected" } } }), null);
  assert.equal(aiBackedAdsActiveForStorage({ active: true, ai: { status: "invalid_unbacked_decision" } }), null);
  assert.equal(aiBackedAdsActiveForStorage({ active: false, ai: { status: "required_unavailable" } }), null);
  assert.equal(aiBackedAdsActiveForStorage({ active: true }), null);
});

test("sanitizes Ads enrichment JSON before storage when AI verification is missing", () => {
  const sanitized = adsEnrichmentForStorage({
    checkedAt: "2026-06-05T00:00:00.000Z",
    meta: {
      active: true,
      status: "active",
      confidence: 0.91,
      reason: "manual_claim",
      spendEstimate: { estimatedSpendMin: 100 },
      ai: { status: "resolved" }
    },
    google: {
      active: false,
      status: "inactive",
      confidence: 0.82,
      reason: "manual_claim",
      ai: { status: "resolved", verification: { status: "rejected" } }
    },
    classification: {
      type: "lead_generation",
      confidence: 0.8,
      reason: "manual_funnel"
    }
  });

  assert.equal(sanitized.meta.active, null);
  assert.equal(sanitized.meta.status, "unknown");
  assert.equal(sanitized.meta.reason, "storage_requires_ai_verification");
  assert.equal(sanitized.meta.spendEstimate, null);
  assert.equal(sanitized.google.active, null);
  assert.equal(sanitized.classification.type, "unknown");
  assert.equal(sanitized.classification.reason, "storage_requires_verified_active_ads");
});

test("stores decision maker contacts only when resolved and independently verified", () => {
  const verified = {
    found: true,
    decisionStatus: "verified",
    decisionMaker: {
      fullName: "Ana García",
      role: "Socia administradora",
      linkedinUrl: "https://www.linkedin.com/in/ana-riojanas"
    },
    ai: { status: "resolved", verification: { status: "confirmed" } }
  };

  assert.equal(verifiedDecisionMakerForStorage(verified).fullName, "Ana García");
  assert.equal(verifiedDecisionMakerForStorage({ ...verified, ai: { status: "resolved" } }), null);
  assert.equal(verifiedDecisionMakerForStorage({ ...verified, ai: { status: "resolved", verification: { status: "rejected" } } }), null);
  assert.equal(verifiedDecisionMakerForStorage({ ...verified, decisionStatus: "candidate" }), null);
  assert.equal(verifiedDecisionMakerForStorage({
    ...verified,
    decisionMaker: { ...verified.decisionMaker, linkedinUrl: "https://www.linkedin.com/company/riojanas" }
  }), null);
});

test("sanitizes decision maker JSON before storage when AI verification is missing", () => {
  const sanitized = decisionMakerEnrichmentForStorage({
    found: true,
    decisionStatus: "verified",
    reason: "manual_claim",
    decisionMaker: {
      fullName: "Ana García",
      role: "Socia administradora",
      linkedinUrl: "https://www.linkedin.com/in/ana-riojanas"
    },
    ai: { status: "resolved" }
  });

  assert.equal(sanitized.found, false);
  assert.equal(sanitized.decisionStatus, "candidate");
  assert.equal(sanitized.reason, "storage_requires_verified_ai_decision_maker");
  assert.equal(sanitized.decisionMaker, null);
  assert.equal(sanitized.unverifiedDecisionMaker.fullName, "Ana García");
  assert.equal(sanitized.ai.storageSanitized, true);
});

test("validates reformas Madrid batch report completeness and AI verification", () => {
  const report = buildReformasReportFixture({ count: 2 });
  assert.deepEqual(validateReformasMadridBatchReport({ report, expectedLimit: 2 }), []);

  const missingRow = buildReformasReportFixture({ count: 1 });
  assert.equal(
    validateReformasMadridBatchReport({ report: missingRow, expectedLimit: 2 })
      .some((failure) => failure.reason === "result_count_mismatch"),
    true
  );

  const unverifiedAds = buildReformasReportFixture({ count: 2 });
  unverifiedAds.results[0].summary.ads.metaVerificationStatus = null;
  assert.equal(
    validateReformasMadridBatchReport({ report: unverifiedAds, expectedLimit: 2 })
      .some((failure) => failure.reason === "meta_not_ai_verified"),
    true
  );

  const duplicate = buildReformasReportFixture({ count: 2 });
  duplicate.results[1].business.place_id = duplicate.results[0].business.place_id;
  assert.equal(
    validateReformasMadridBatchReport({ report: duplicate, expectedLimit: 2 })
      .some((failure) => failure.reason === "duplicate_business"),
    true
  );

  const apifySpent = buildReformasReportFixture({ count: 2 });
  apifySpent.summary.apify.totalCalls = 1;
  assert.equal(
    validateReformasMadridBatchReport({ report: apifySpent, expectedLimit: 2, apifyFallbackMode: "off" })
      .some((failure) => failure.reason === "apify_called_while_disabled"),
    true
  );
});

function buildReformasReportFixture({ count = 2 } = {}) {
  const results = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    ok: true,
    business: {
      place_id: `place-${index + 1}`,
      name: `Reformas Demo ${index + 1}`,
      city: "Madrid",
      niche: "empresas de reformas",
      category: "reformas",
      address: `Calle Demo ${index + 1}, Madrid`
    },
    summary: {
      ads: {
        discoveryAiStatus: "planned",
        metaActive: index % 2 === 0,
        metaAiStatus: "resolved",
        metaVerificationStatus: "confirmed",
        googleActive: false,
        googleAiStatus: "resolved",
        googleVerificationStatus: "confirmed",
        funnelType: index % 2 === 0 ? "lead_generation" : "unknown",
        funnelAiStatus: index % 2 === 0 ? "classified" : null
      },
      decisionMaker: {
        found: true,
        status: "verified",
        searchAiStatus: "planned",
        aiStatus: "resolved",
        verificationStatus: "confirmed",
        fullName: `Persona Demo ${index + 1}`,
        linkedinUrl: `https://www.linkedin.com/in/persona-demo-${index + 1}`
      },
      apify: {
        mode: "off",
        metaCalls: 0,
        googleCalls: 0,
        totalCalls: 0,
        calls: []
      },
      deepseek: {
        totalEstimatedUsd: 0.001,
        items: [{ area: "ads.discovery", estimatedUsd: 0.001 }]
      }
    },
    failures: []
  }));
  return {
    target: {
      niche: "empresas de reformas",
      city: "Madrid",
      requestedLimit: count,
      processedLimit: count
    },
    summary: {
      processed: results.length,
      ok: results.length,
      failed: 0,
      metaActive: results.filter((row) => row.summary.ads.metaActive === true).length,
      googleActive: 0,
      decisionMakersFound: results.length,
      apify: {
        mode: "off",
        metaCalls: 0,
        googleCalls: 0,
        totalCalls: 0,
        calls: []
      },
      deepseek: {
        totalEstimatedUsd: 0.002,
        items: results.flatMap((row) => row.summary.deepseek.items)
      }
    },
    failures: [],
    results
  };
}

test("counts and validates Apify usage budgets for enrichment smoke", () => {
  const stats = createApifyUsageStats("on_unknown");
  recordApifyCall(stats, "meta", { urls: [{ url: "https://www.facebook.com/ads/library/?q=demo" }], count: 10 });
  recordApifyCall(stats, "google", { searchTerms: ["demo.example"], resultsLimit: 3 });

  assert.deepEqual(summarizeApifyUsage(stats), {
    mode: "on_unknown",
    metaCalls: 1,
    googleCalls: 1,
    totalCalls: 2,
    calls: [
      {
        provider: "meta",
        urls: ["https://www.facebook.com/ads/library/?q=demo"],
        searchTerms: [],
        resultsLimit: 10
      },
      {
        provider: "google",
        urls: [],
        searchTerms: ["demo.example"],
        resultsLimit: 3
      }
    ]
  });
  assert.deepEqual(validateApifyUsage({
    expectedAds: { maxApifyCalls: 2, maxMetaApifyCalls: 1, maxGoogleApifyCalls: 1 },
    stats,
    fallbackMode: "on_unknown",
    label: "Demo"
  }), []);
  assert.equal(validateApifyUsage({
    expectedAds: { maxApifyCalls: 1 },
    stats,
    fallbackMode: "on_unknown",
    label: "Demo"
  })[0].reason, "apify_total_calls_exceeded");
  assert.equal(validateApifyUsage({
    expectedAds: {},
    stats,
    fallbackMode: "off",
    label: "Demo"
  })[0].reason, "apify_called_while_disabled");
});

test("extracts emails and ignores obvious asset matches", () => {
  assert.deepEqual(extractEmails("hola info@example.com image.png css@site.css mailto:ventas@example.es"), [
    "info@example.com",
    "ventas@example.es"
  ]);
});

test("extracts lead signals from crawled content", () => {
  const result = extractLeadSignals({
    markdown: "Contacto: info@clinica.es. Reserva cita online con Calendly.",
    html: '<a href="tel:+34600111222">Llamar</a><form></form>',
    links: [{ url: "https://instagram.com/clinica" }, { url: "https://wa.me/34600111222" }]
  });

  assert.deepEqual(result.emails, ["info@clinica.es"]);
  assert.deepEqual(result.phones, ["+34600111222"]);
  assert.equal(result.socials.instagram, "https://instagram.com/clinica");
  assert.equal(result.signals.hasOnlineBooking, true);
  assert.equal(result.signals.hasContactForm, true);
});

test("extracts only contact-quality phones from crawled pages", () => {
  const noisyHtml = Array.from({ length: 30 }, (_, index) => `<script>window.x${index}=600${String(index).padStart(6, "0")}</script>`).join("");
  const result = extractLeadSignals({
    markdown: "Contacto por WhatsApp o telefono: 600 111 222. Referencia interna 600999888 sin contexto comercial lejano.",
    html: `${noisyHtml}<a href="tel:+34911222333">Llamar</a><a href="https://wa.me/34600333444">WhatsApp</a>`,
    links: [{ url: "https://wa.me/34600333444" }]
  });

  assert.deepEqual(result.phones, ["+34911222333", "+34600333444", "+34600111222"]);
  assert.equal(extractPhones(noisyHtml, { strict: true }).length, 0);
});

test("selects useful business URLs", () => {
  const urls = selectBusinessUrls("https://clinica.es", [
    { url: "https://clinica.es/contacto" },
    { url: "https://clinica.es/aviso-legal" },
    { url: "https://clinica.es/servicios" },
    { url: "https://otro.es/contacto" }
  ]);

  assert.deepEqual(urls.slice(0, 3), [
    "https://clinica.es/",
    "https://clinica.es/contacto",
    "https://clinica.es/servicios"
  ]);
});

test("scores and routes leads", () => {
  const score = calculateLeadScore({
    rating: 4.7,
    review_count: 230,
    website: "https://clinica.es",
    has_online_booking: false,
    phone_e164: "+34600111222",
    email_count: 1
  });
  assert.equal(score, 100);
  assert.equal(nextOutreachChannel({ score, phone_e164: "+34600111222", email_count: 1 }), "voice");
});

test("parses Vapi-style end-of-call-report", () => {
  const report = parseEndOfCallReport({
    message: {
      type: "end-of-call-report",
      endedReason: "customer-ended-call",
      call: {
        id: "call_123",
        status: "ended",
        startedAt: "2026-05-10T10:00:00Z",
        endedAt: "2026-05-10T10:03:00Z"
      },
      artifact: {
        transcript: "assistant: hola\nuser: me interesa"
      },
      analysis: {
        summary: "Lead interesado.",
        structuredData: {
          outcome: "interested",
          qualified: true
        }
      }
    }
  });

  assert.equal(report.isEndOfCallReport, true);
  assert.equal(report.providerCallId, "call_123");
  assert.equal(report.durationSeconds, 180);
  assert.equal(report.qualified, true);
  assert.equal(report.outcome, "interested");
});

test("normalizes Firecrawl response variants", () => {
  assert.deepEqual(normalizeMapResponse({ links: ["https://a.test", { url: "https://b.test" }] }), [
    { url: "https://a.test" },
    { url: "https://b.test", title: undefined, description: undefined }
  ]);
  assert.equal(normalizeScrapeResponse({ data: { markdown: "# Hola", links: ["https://x.test"] } }).links[0].url, "https://x.test");
  assert.equal(normalizeSearchResponse({ data: [{ url: "https://result.test" }] })[0].url, "https://result.test");
});

test("builds Firecrawl map request without unsupported sitemap field", () => {
  assert.deepEqual(buildMapRequestBody("https://example.com", { limit: 2 }), {
    url: "https://example.com",
    limit: 2
  });
});

test("adds lead fields to Google Places field masks", () => {
  const fieldMask = mergePlacesFieldMask("places.id,places.displayName");
  assert.equal(fieldMask.includes("places.id"), true);
  assert.equal(fieldMask.includes("places.websiteUri"), true);
  assert.equal(fieldMask.includes("places.internationalPhoneNumber"), true);
  assert.equal(fieldMask.includes("places.userRatingCount"), true);
});

test("normalizes Google Places lead fields", () => {
  const [place] = normalizePlaces([
    {
      id: "place-1",
      displayName: { text: "Abogados Demo" },
      formattedAddress: "Calle Demo 1, Logroño",
      websiteUri: "https://abogados.example",
      internationalPhoneNumber: "+34 600 111 222",
      rating: 4.7,
      userRatingCount: 42,
      googleMapsUri: "https://maps.google.com/?cid=123",
      location: { latitude: 42.46, longitude: -2.45 }
    }
  ]);

  assert.equal(place.website, "https://abogados.example");
  assert.equal(place.phoneE164, "+34600111222");
  assert.equal(place.rating, 4.7);
  assert.equal(place.reviewCount, 42);
  assert.equal(place.sourceUrl, "https://maps.google.com/?cid=123");
});

test("authorizes test job API keys from bearer or x-api-key headers", () => {
  const keys = parseApiKeys("alpha,\nbravo");
  assert.equal(isAuthorizedApiKey({ "x-api-key": "alpha" }, keys), true);
  assert.equal(isAuthorizedApiKey({ authorization: "Bearer bravo" }, keys), true);
  assert.equal(isAuthorizedApiKey({ authorization: "Bearer charlie" }, keys), false);
});

test("normalizes Nebrija assistants and extracts template variables", () => {
  const [assistant] = normalizeAssistantsResponse({
    data: [
      {
        id: "asst_123",
        name: "Ventas",
        model: {
          messages: [{ content: "Llama a {{business_name}} en {{city}}. Fecha {{now}}" }]
        }
      }
    ]
  });

  assert.equal(assistant.id, "asst_123");
  assert.deepEqual(assistant.variableNames, ["business_name", "city"]);
});

test("builds assistant variable values from lead fields", () => {
  const variableMap = defaultVariableMap(["business_name", "telefono", "ciudad"]);
  assert.deepEqual(variableMap, {
    business_name: "business_name",
    telefono: "phone_e164",
    ciudad: "city"
  });
  const values = buildVariableValues(
    {
      id: "lead-1",
      name: "Abogados Demo",
      city: "Logroño",
      phone_e164: "+34600111222",
      score: 82
    },
    variableMap,
    Object.keys(variableMap)
  );

  assert.deepEqual(values, {
    business_name: "Abogados Demo",
    telefono: "+34600111222",
    ciudad: "Logroño"
  });
});

test("exports campaign leads as CSV and XLSX", () => {
  const rows = [
    {
      id: "lead-1",
      name: "Bufete, Demo",
      city: "Logroño",
      niche: "Abogados",
      score: 82,
      phone_e164: "+34600111222",
      emails: ["info@example.es", "ventas@example.es"],
      website: "https://example.es",
      has_online_booking: false,
      has_chatbot: true
    }
  ];

  const csv = buildCampaignCsv(rows).toString("utf8");
  assert.ok(csv.startsWith("\uFEFFLead ID,Nombre"));
  assert.match(csv, /"Bufete, Demo"/);
  assert.match(csv, /'\+34600111222/);
  assert.match(csv, /info@example\.es; ventas@example\.es/);

  const xlsx = buildCampaignXlsx(rows);
  assert.equal(xlsx.readUInt32LE(0), 0x04034b50);
  assert.ok(xlsx.includes(Buffer.from("xl/worksheets/sheet1.xml")));
  assert.ok(xlsx.includes(Buffer.from("[Content_Types].xml")));

  assert.match(campaignExportFilename({ niche: "Abogados", city: "Logroño" }, "xlsx"), /^leads-abogados-logrono-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test("previews and maps CSV lead imports with contact and CRM fields", () => {
  const csv = Buffer.from(
    "Negocio;First Name;Last Name;Full Name;Web;Email;Ciudad;Hecha;Resultado;Fecha Reintento;Checkpoint;Objeción inicial;Inversión en Ads;Presupuesto\nBufete Demo;Juan;Moreno;Juan Moreno;https://bufete.example;hola@bufete.example;Logroño;05/06/2026;Interesado;06/06/2026;Objeción;Ya tenemos proveedor;1.250,50 €;alto\n",
    "utf8"
  );
  const preview = previewLeadImport({
    filename: "leads.csv",
    contentBase64: csv.toString("base64")
  });
  assert.equal(preview.totalRows, 1);
  assert.equal(preview.suggestedMapping.Negocio, "name");
  assert.equal(preview.suggestedMapping["First Name"], "first_name");
  assert.equal(preview.suggestedMapping["Last Name"], "last_name");
  assert.equal(preview.suggestedMapping["Full Name"], "full_name");
  assert.equal(preview.suggestedMapping.Hecha, "first_contact_at");
  assert.equal(preview.suggestedMapping.Resultado, "crm_status");
  assert.equal(preview.suggestedMapping["Fecha Reintento"], "follow_up_date");
  assert.equal(preview.suggestedMapping.Checkpoint, "checkpoint");
  assert.equal(preview.suggestedMapping["Objeción inicial"], "objection");
  assert.equal(preview.suggestedMapping["Inversión en Ads"], "ignore");
  assert.equal(preview.suggestedMapping.Presupuesto, "custom:presupuesto");

  const parsed = parseLeadFile({ filename: "leads.csv", contentBase64: csv.toString("base64") });
  const imported = buildImportedLeadRows(parsed.rows, preview.suggestedMapping);
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.rows[0].business.name, "Bufete Demo");
  assert.equal(imported.rows[0].business.website, "https://bufete.example");
  assert.deepEqual(imported.rows[0].contact, { firstName: "Juan", lastName: "Moreno", fullName: "Juan Moreno" });
  assert.deepEqual(imported.rows[0].crm, {
    decisionMakerEmail: "hola@bufete.example",
    firstContactAt: "2026-06-05",
    crmStatus: "Interesado",
    followUpDate: "2026-06-06",
    checkpoint: "Objeción inicial",
    objection: "Ya tenemos proveedor",
    decisionMakerName: "Juan Moreno"
  });
  assert.deepEqual(imported.rows[0].contacts, [{ kind: "email", value: "hola@bufete.example", confidence: 0.75 }]);
  assert.deepEqual(imported.rows[0].customFields, {
    contact_first_name: "Juan",
    contact_last_name: "Moreno",
    contact_full_name: "Juan Moreno",
    presupuesto: "alto"
  });
});

test("parses XLSX lead imports generated by the local exporter", () => {
  const xlsx = buildCampaignXlsx([
    {
      id: "lead-1",
      name: "Clínica Demo",
      city: "Madrid",
      niche: "Clínica dental",
      website: "https://clinica.example",
      phone_e164: "+34600111222"
    }
  ]);
  const parsed = parseLeadFile({ filename: "leads.xlsx", contentBase64: xlsx.toString("base64") });
  assert.equal(parsed.format, "xlsx");
  assert.equal(parsed.rows[0].Nombre, "Clínica Demo");
  assert.equal(parsed.rows[0]["Telefono E.164"], "+34600111222");
});

test("builds LinkedIn decision maker dorks from local business data", () => {
  assert.equal(
    buildLinkedInDecisionMakerDork({ name: "Instalaciones Riojanas S.L.", city: "Logroño" }),
    'site:linkedin.com/in/ "Instalaciones Riojanas" "Logroño"'
  );
  assert.equal(
    buildLinkedInDecisionMakerDork({ name: "Instalaciones Riojanas S.L." }),
    'site:linkedin.com/in/ "Instalaciones Riojanas"'
  );
  assert.deepEqual(buildLinkedInDecisionMakerQueries({ name: "ION Proyectos Empresa de climatización y fotovoltaica", city: "Valencia" }).slice(0, 3), [
    'site:linkedin.com/in/ "ION Proyectos" "Valencia"',
    'site:linkedin.com/in/ "ION Proyectos"',
    'site:linkedin.com/in/ "ION Proyectos" gerente OR fundador OR socio OR director'
  ]);
  assert.ok(!buildLinkedInDecisionMakerQueries({ name: "ION Proyectos" }).some((query) => query.includes('""')));
});

test("selects LinkedIn personal profiles for decision makers", () => {
  const result = selectDecisionMakerFromSearchResults({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    query: 'site:linkedin.com/in/ "Instalaciones Riojanas" "Logroño"',
    results: [
      {
        url: "https://www.linkedin.com/company/instalaciones-riojanas/",
        title: "Instalaciones Riojanas | LinkedIn",
        description: "Empresa"
      },
      {
        url: "https://es.linkedin.com/in/juan-perez-riojanas?trk=public_profile",
        title: "Juan Pérez - Gerente en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
        description: "Gerente de Instalaciones Riojanas en Logroño"
      }
    ]
  });

  assert.equal(result.found, true);
  assert.equal(result.decisionMaker.fullName, "Juan Pérez");
  assert.equal(result.decisionMaker.linkedinUrl, "https://es.linkedin.com/in/juan-perez-riojanas");
  assert.ok(result.decisionMaker.confidence >= 0.8);
});

test("rejects weak LinkedIn decision maker matches", () => {
  const result = selectDecisionMakerFromSearchResults({
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    query: 'site:linkedin.com/in/ "Instalaciones Riojanas" "Logroño"',
    results: [
      {
        url: "https://www.linkedin.com/in/persona-generica",
        title: "Persona Genérica - LinkedIn",
        description: "Marketing en Madrid"
      }
    ]
  });

  assert.equal(result.found, false);
});

test("requires AI before verifying strong LinkedIn decision maker matches", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://es.linkedin.com/in/juan-perez-riojanas?trk=public_profile",
            title: "Juan Pérez - Gerente en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
            description: "Gerente de Instalaciones Riojanas en Logroño"
          }
        ];
      }
    }
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "candidate");
  assert.equal(result.reason, "ai_required_but_unavailable");
  assert.equal(result.ai.status, "required_unavailable");
  assert.equal(result.ai.deterministicFound, true);
});

test("does not verify decision maker from local ranking when AI mode is disabled", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://es.linkedin.com/in/juan-perez-riojanas",
            title: "Juan Pérez - Gerente en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
            description: "Gerente de Instalaciones Riojanas en Logroño"
          }
        ];
      }
    },
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", mode: "never" }
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "candidate");
  assert.equal(result.reason, "ai_required_but_unavailable");
  assert.equal(result.ai.status, "required_unavailable");
});

test("passes empty LinkedIn search results through AI resolver", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Sin Huella Digital S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [];
      }
    },
    aiResolver: async ({ searchResults, candidates, queries }) => {
      assert.equal(searchResults.length, 0);
      assert.equal(candidates.length, 0);
      assert.ok(queries.includes('site:linkedin.com/in/ "Sin Huella Digital" "Logroño"'));
      return {
        found: false,
        decisionStatus: "not_found",
        confidence: 0.9,
        reason: "ai_no_search_results"
      };
    }
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "not_found");
  assert.equal(result.reason, "ai_no_search_results");
  assert.equal(result.ai.status, "resolved_no_match");
});

test("searches and resolves decision maker even when city is missing", async () => {
  const searchedQueries = [];
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L." },
    searchClient: {
      async search(query) {
        searchedQueries.push(query);
        assert.ok(!query.includes('""'));
        if (query === 'site:linkedin.com/in/ "Instalaciones Riojanas"') {
          return [
            {
              url: "https://www.linkedin.com/in/ana-riojanas",
              title: "Ana García - Socia administradora en Instalaciones Riojanas S.L. | LinkedIn",
              description: "Socia administradora de Instalaciones Riojanas"
            }
          ];
        }
        return [];
      }
    },
    aiResolver: async ({ searchResults }) => ({
      found: true,
      decisionStatus: "verified",
      selectedResultId: searchResults[0].resultId,
      confidence: 0.89,
      fullName: "Ana García",
      role: "Socia administradora",
      reason: "profile_matches_business_without_city"
    })
  });

  assert.ok(searchedQueries.includes('site:linkedin.com/in/ "Instalaciones Riojanas"'));
  assert.equal(result.found, true);
  assert.equal(result.decisionMaker.fullName, "Ana García");
  assert.equal(result.ai.status, "resolved");
});

test("does not return local not_found when decision maker AI is unavailable", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Sin Huella Digital S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [];
      }
    },
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", mode: "always" }
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "not_found");
  assert.equal(result.reason, "ai_required_but_unavailable");
  assert.equal(result.ai.status, "required_unavailable");
  assert.equal(result.ai.deterministicReason, "no_linkedin_profile_match");
});

test("does not preserve deterministic verified decision maker when AI fails", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://es.linkedin.com/in/juan-perez-riojanas",
            title: "Juan Pérez - Gerente en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
            description: "Gerente de Instalaciones Riojanas en Logroño"
          }
        ];
      }
    },
    aiResolver: async () => {
      throw new Error("deepseek_unavailable");
    }
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "candidate");
  assert.equal(result.decisionMaker, undefined);
  assert.equal(result.reason, "ai_resolution_failed");
  assert.equal(result.ai.status, "failed");
});

test("does not preserve deterministic verified decision maker on invalid AI response", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://es.linkedin.com/in/juan-perez-riojanas",
            title: "Juan Pérez - Gerente en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
            description: "Gerente de Instalaciones Riojanas en Logroño"
          }
        ];
      }
    },
    aiResolver: async () => null
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "candidate");
  assert.equal(result.decisionMaker, undefined);
  assert.equal(result.reason, "ai_invalid_response");
  assert.equal(result.ai.status, "invalid_response");
});

test("does not verify decision maker when AI response has contradictory status", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://es.linkedin.com/in/ana-riojanas",
            title: "Ana García - Socia administradora en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
            description: "Socia administradora de Instalaciones Riojanas en Logroño"
          }
        ];
      }
    },
    aiResolver: async ({ searchResults }) => ({
      found: true,
      decisionStatus: "not_found",
      selectedResultId: searchResults[0].resultId,
      confidence: 0.91,
      fullName: "Ana García",
      role: "Socia administradora",
      reason: "contradictory_status"
    })
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionMaker, undefined);
  assert.equal(result.reason, "ai_inconsistent_response");
  assert.equal(result.ai.status, "inconsistent_response");
});

test("does not verify decision maker from incomplete AI response fields", async () => {
  const baseSearchClient = {
    async search() {
      return [
        {
          url: "https://www.linkedin.com/in/ana-riojanas",
          title: "Ana García - Socia administradora en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
          description: "Socia administradora de Instalaciones Riojanas en Logroño"
        }
      ];
    }
  };
  const missingDecisionStatus = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: baseSearchClient,
    aiResolver: async ({ searchResults }) => ({
      found: true,
      selectedResultId: searchResults[0].resultId,
      confidence: 0.91,
      fullName: "Ana García",
      role: "Socia administradora"
    })
  });
  const missingFound = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: baseSearchClient,
    aiResolver: async ({ searchResults }) => ({
      decisionStatus: "verified",
      selectedResultId: searchResults[0].resultId,
      confidence: 0.91,
      fullName: "Ana García",
      role: "Socia administradora"
    })
  });

  assert.equal(missingDecisionStatus.found, false);
  assert.equal(missingDecisionStatus.reason, "ai_invalid_response");
  assert.equal(missingDecisionStatus.ai.status, "invalid_response");
  assert.equal(missingFound.found, false);
  assert.equal(missingFound.reason, "ai_invalid_response");
  assert.equal(missingFound.ai.status, "invalid_response");
});

test("AI resolver can select a raw LinkedIn search result when local ranking is weak", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Baterías Norte S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://www.linkedin.com/in/carmen-baterias-norte",
            title: "Carmen Martínez - LinkedIn",
            description: "Lidera la empresa desde 2020."
          }
        ];
      }
    },
    aiResolver: async ({ searchResults, candidates }) => {
      assert.ok(searchResults[0].resultId);
      assert.equal(candidates[0].confidence < 0.55, true);
      return {
        found: true,
        decisionStatus: "verified",
        selectedResultId: searchResults[0].resultId,
        confidence: 0.88,
        fullName: "Carmen Martínez",
        role: "Lidera la empresa",
        reason: "raw_search_result_has_decision_role"
      };
    }
  });

  assert.equal(result.found, true);
  assert.equal(result.decisionMaker.linkedinUrl, "https://www.linkedin.com/in/carmen-baterias-norte");
  assert.equal(result.decisionMaker.fullName, "Carmen Martínez");
  assert.equal(result.ai.status, "resolved");
});

test("requires AI-planned LinkedIn search before verifying decision maker when configured", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Semilla Norte S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://www.linkedin.com/in/laura-semilla-norte",
            title: "Laura Ruiz - Gerente de Semilla Norte - Logroño | LinkedIn",
            description: "Gerente de Semilla Norte en Logroño."
          }
        ];
      }
    },
    aiResolver: async ({ searchResults }) => ({
      found: true,
      decisionStatus: "verified",
      selectedResultId: searchResults[0].resultId,
      confidence: 0.91,
      fullName: "Laura Ruiz",
      role: "Gerente",
      reason: "ai_selected_seed_result"
    }),
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", requirePlannedSearch: true }
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "candidate");
  assert.equal(result.decisionMaker, undefined);
  assert.equal(result.reason, "ai_unplanned_decision_maker_search");
  assert.equal(result.ai.status, "invalid_unplanned_search");
});

test("confirms AI-selected decision maker with an independent verifier", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Baterías Norte S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://www.linkedin.com/in/carmen-baterias-norte",
            title: "Carmen Martínez - Gerente propietaria de Baterías Norte - Logroño | LinkedIn",
            description: "Gerente propietaria de Baterías Norte en Logroño."
          }
        ];
      }
    },
    aiResolver: async ({ searchResults }) => ({
      found: true,
      decisionStatus: "verified",
      selectedResultId: searchResults[0].resultId,
      confidence: 0.9,
      fullName: "Carmen Martínez",
      role: "Gerente propietaria",
      reason: "ai_selected_owner_profile"
    }),
    aiVerifier: async ({ evidence, resolved }) => {
      assert.equal(evidence.task, "linkedin_decision_maker_verification");
      assert.equal(evidence.proposedDecision.found, true);
      assert.equal(resolved.decisionMaker.linkedinUrl, "https://www.linkedin.com/in/carmen-baterias-norte");
      return {
        confirmed: true,
        status: "confirmed",
        found: true,
        decisionStatus: "verified",
        confidence: 0.88,
        reason: "verified_owner_role_and_company",
        riskFlags: [],
        evidenceSummary: "Title links Carmen to Baterías Norte as owner-manager.",
        needsMoreEvidence: false,
        usage: { prompt_tokens: 1000, completion_tokens: 500 }
      };
    }
  });

  assert.equal(result.found, true);
  assert.equal(result.ai.status, "resolved");
  assert.equal(result.ai.verification.status, "confirmed");
  assert.equal(result.ai.verification.cost.estimatedUsd, 0.0002);
  assert.equal(result.decisionMaker.confidence, 0.88);
});

test("does not keep AI-selected decision maker when verifier rejects it", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Taller Norte S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://www.linkedin.com/in/pablo-taller-norte",
            title: "Pablo Ruiz - Técnico en Taller Norte - Logroño | LinkedIn",
            description: "Técnico de mantenimiento en Taller Norte."
          }
        ];
      }
    },
    aiResolver: async ({ searchResults }) => ({
      found: true,
      decisionStatus: "verified",
      selectedResultId: searchResults[0].resultId,
      confidence: 0.82,
      fullName: "Pablo Ruiz",
      role: "Técnico",
      reason: "ai_claimed_profile_verified"
    }),
    aiVerifier: async () => ({
      confirmed: false,
      status: "rejected",
      found: false,
      decisionStatus: "candidate",
      confidence: 0.62,
      reason: "role_not_decision_maker",
      riskFlags: ["non_decision_role"],
      evidenceSummary: "The title supports an employee, not a decision maker.",
      needsMoreEvidence: true,
      usage: { prompt_tokens: 1000, completion_tokens: 250 }
    })
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "candidate");
  assert.equal(result.decisionMaker, undefined);
  assert.equal(result.reason, "role_not_decision_maker");
  assert.equal(result.ai.status, "verification_rejected");
  assert.equal(result.ai.verification.status, "rejected");
});

test("does not store AI-selected candidate as verified decision maker", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Taller Norte S.L.", city: "Logroño" },
    searchClient: {
      async search() {
        return [
          {
            url: "https://www.linkedin.com/in/pablo-taller-norte",
            title: "Pablo Ruiz - Responsable de taller en Taller Norte - Logroño | LinkedIn",
            description: "Responsable operativo en Taller Norte"
          }
        ];
      }
    },
    aiResolver: async ({ searchResults }) => ({
      found: false,
      decisionStatus: "candidate",
      selectedResultId: searchResults[0].resultId,
      confidence: 0.74,
      fullName: "Pablo Ruiz",
      role: "Responsable de taller",
      reason: "related_profile_not_decision_maker"
    })
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "candidate");
  assert.equal(result.decisionMaker, undefined);
  assert.equal(result.reason, "related_profile_not_decision_maker");
  assert.equal(result.ai.status, "resolved_candidate");
});

test("uses AI-planned LinkedIn search queries before resolving decision maker", async () => {
  const aiQuery = 'site:linkedin.com/in/ "Baterías Norte" "Logroño" gerente propietaria';
  const searchedQueries = [];
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: {
      name: "Baterías Norte S.L.",
      city: "Logroño",
      website: "https://bateriasnorte.example"
    },
    searchClient: {
      async search(query) {
        searchedQueries.push(query);
        if (query !== aiQuery) return [];
        return [
          {
            url: "https://www.linkedin.com/in/carmen-martinez-baterias",
            title: "Carmen Martínez - Gerente propietaria de Baterías Norte - Logroño | LinkedIn",
            description: "Gerente propietaria de Baterías Norte en Logroño"
          }
        ];
      }
    },
    aiSearchPlanner: async ({ seedPlan }) => {
      assert.ok(seedPlan.queries.some((entry) => entry.query.includes("Baterías Norte")));
      return {
        queries: [
          { query: aiQuery, reason: "ai_role_city_profile" },
          { query: 'site:linkedin.com/company/ "Baterías Norte" "Logroño"', reason: "ai_company_profile" }
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500
        }
      };
    },
    aiResolver: async ({ queries, searchPlan, searchResults, candidates }) => {
      assert.equal(queries[0], aiQuery);
      assert.equal(searchPlan.ai.status, "planned");
      assert.equal(searchPlan.queries[0].plannedBy, "ai");
      assert.equal(searchResults[0].plannedBy, "ai");
      assert.equal(searchResults[0].discoveryReason, "ai_role_city_profile");
      assert.equal(candidates[0].plannedBy, "ai");
      return {
        found: true,
        decisionStatus: "verified",
        selectedResultId: searchResults[0].resultId,
        confidence: 0.93,
        fullName: "Carmen Martínez",
        role: "Gerente propietaria",
        reason: "ai_planned_query_found_profile"
      };
    },
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", requirePlannedSearch: true }
  });

  assert.equal(searchedQueries[0], aiQuery);
  assert.equal(result.found, true);
  assert.equal(result.searchPlan.ai.status, "planned");
  assert.equal(result.searchPlan.ai.cost.estimatedUsd, 0.0002);
  assert.equal(result.decisionMaker.linkedinUrl, "https://www.linkedin.com/in/carmen-martinez-baterias");
  assert.equal(result.decisionMaker.plannedBy, "ai");
});

test("uses AI resolver to choose between ambiguous LinkedIn decision maker candidates", async () => {
  const queries = [];
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-06T10:00:00Z"),
    business: { name: "Instalaciones Riojanas S.L.", city: "Logroño" },
    searchClient: {
      async search(query) {
        queries.push(query);
        return [
          {
            url: "https://www.linkedin.com/in/maria-riojanas",
            title: "María López - Marketing en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
            description: "Marketing en Instalaciones Riojanas"
          },
          {
            url: "https://www.linkedin.com/in/ana-riojanas",
            title: "Ana García - Socia administradora en Instalaciones Riojanas S.L. - Logroño | LinkedIn",
            description: "Socia administradora de Instalaciones Riojanas en Logroño"
          }
        ];
      }
    },
    aiResolver: async ({ candidates }) => {
      const selected = candidates.find((candidate) => candidate.linkedinUrl === "https://www.linkedin.com/in/ana-riojanas");
      return {
        found: true,
        decisionStatus: "verified",
        selectedCandidateId: selected.candidateId,
        confidence: 0.91,
        fullName: "Ana García",
        role: "Socia administradora",
        reason: "highest_authority_role"
      };
    }
  });

  assert.equal(result.found, true);
  assert.equal(result.decisionMaker.fullName, "Ana García");
  assert.equal(result.decisionMaker.linkedinUrl, "https://www.linkedin.com/in/ana-riojanas");
  assert.equal(result.ai.status, "resolved");
  assert.ok(queries.includes('site:linkedin.com/in/ "Instalaciones Riojanas" "Logroño"'));
  assert.ok(result.decisionMaker.confidence >= 0.9);
});

test("falls back to access contact when LinkedIn company exists but no decision maker is verified", async () => {
  const result = await enrichDecisionMaker({
    now: new Date("2026-06-08T10:00:00Z"),
    business: {
      name: "ION Proyectos Empresa de climatización y fotovoltaica",
      city: "Valencia",
      website: "https://www.ionproyectos.com/",
      phone_e164: "+34635766456",
      instagram: "https://www.instagram.com/ion.proyectos/",
      facebook: "https://www.facebook.com/ion.proyectos"
    },
    contacts: [
      { kind: "phone", value: "+34644579123", confidence: 0.85, source_url: "https://www.ionproyectos.com/" },
      { kind: "email", value: "contacto@ionproyectos.com", confidence: 0.8, source_url: "https://www.ionproyectos.com/" }
    ],
    searchClient: {
      async search(query) {
        if (query.includes("company")) {
          return [
            {
              url: "https://www.linkedin.com/company/ionproyectos/",
              title: "ION Proyectos | LinkedIn",
              description: "Empresa de climatización y fotovoltaica en Valencia"
            }
          ];
        }
        return [];
      }
    },
    aiResolver: async ({ accessContacts }) => ({
      found: false,
      decisionStatus: "access_contact",
      selectedAccessContactId: accessContacts.find((contact) => contact.value === "+34635766456").contactId,
      confidence: 0.86,
      reason: "no_person_decision_maker_best_phone"
    })
  });

  assert.equal(result.found, false);
  assert.equal(result.decisionStatus, "access_contact");
  assert.equal(result.linkedinCompany.linkedinUrl, "https://www.linkedin.com/company/ionproyectos");
  assert.equal(result.recommendedAccessContact.kind, "phone");
  assert.equal(result.recommendedAccessContact.value, "+34635766456");
  assert.equal(result.ai.status, "resolved_no_match");
});

test("infers active ads from public transparency page signals", () => {
  const metaUrl = buildMetaAdsLibraryUrl({ query: "Tesla España", country: "ES" });
  assert.match(metaUrl, /facebook\.com\/ads\/library/);
  assert.match(metaUrl, /active_status=active/);

  const meta = inferAdsActivity({
    provider: "meta",
    sourceUrl: metaUrl,
    text: "This Page is currently running ads. Active ads in Ad Library."
  });
  assert.equal(meta.active, true);

  const google = inferAdsActivity({
    provider: "google",
    now: new Date("2026-06-05T00:00:00Z"),
    sourceUrl: "https://adstransparency.google.com/advertiser/AR123?region=ES",
    context: { domain: "tesla.com", businessName: "Tesla España" },
    text: "CR123456789 first shown 2026-05-30 last shown 2026-06-04 total days shown 5"
  });
  assert.equal(google.active, null);
  assert.equal(google.reason, "google_identity_not_matched");

  const matchedGoogle = inferAdsActivity({
    provider: "google",
    now: new Date("2026-06-05T00:00:00Z"),
    sourceUrl: "https://adstransparency.google.com/advertiser/AR123?region=ES",
    context: { domain: "tesla.com", businessName: "Tesla España" },
    text: "Tesla España CR123456789 www.tesla.com first shown 2026-05-30 last shown 2026-06-04 total days shown 5"
  });
  assert.equal(matchedGoogle.active, true);
  assert.equal(matchedGoogle.latestDetectedDate, "2026-06-04");
  assert.deepEqual(matchedGoogle.matchedFields, ["domain", "brand_domain", "business_name"]);

  const unverifiedGoogleSearch = inferAdsActivity({
    provider: "google",
    now: new Date("2026-06-05T00:00:00Z"),
    sourceUrl: "https://adstransparency.google.com/?region=ES&domain=tesla.com",
    context: { domain: "tesla.com", businessName: "Tesla España" },
    text: "Tesla España CR123456789 www.tesla.com first shown 2026-05-30 last shown 2026-06-04"
  });
  assert.equal(unverifiedGoogleSearch.active, null);
  assert.equal(unverifiedGoogleSearch.reason, "google_search_source_not_verified");

  const staleCreativeGoogle = inferAdsActivity({
    provider: "google",
    now: new Date("2026-06-05T00:00:00Z"),
    sourceUrl: "https://adstransparency.google.com/advertiser/AR123?region=ES",
    context: { domain: "tesla.com", businessName: "Tesla España" },
    text: "Tesla España CR123456789 www.tesla.com first shown 2026-01-30 last shown 2026-02-04 total days shown 5"
  });
  assert.notEqual(staleCreativeGoogle.active, true);

  const directDomainGoogle = inferAdsActivity({
    provider: "google",
    now: new Date("2026-06-06T00:00:00Z"),
    sourceUrl: "https://adstransparency.google.com/?region=ES&domain=climatron.net&preset-date=%C3%9Altimos+30%C2%A0d%C3%ADas",
    context: { domain: "climatron.net", businessName: "Climatron", datePreset: "Últimos 30 días" },
    text: "climatron.net Este dominio incluye resultados de varias cuentas de anunciante con anuncios que se orientan a este dominio. 12 anuncios Últimos 30 días"
  });
  assert.equal(directDomainGoogle.active, true);
  assert.equal(directDomainGoogle.reason, "google_domain_ads_found");
  assert.equal(directDomainGoogle.itemsSeen, 12);
});

test("builds Meta ad probes from domain, Facebook and Instagram identifiers", () => {
  const probes = buildMetaAdProbes({
    name: "Bufete Demo",
    city: "Logroño",
    website: "https://www.bufetedemo.es/contacto",
    facebook: "https://www.facebook.com/bufetedemo",
    instagram: "https://www.instagram.com/bufete_demo/"
  });
  const byStrategy = Object.fromEntries(probes.map((probe) => [probe.strategy, probe]));

  assert.equal(byStrategy.business_name_city.query, "Bufete Demo Logroño");
  assert.equal(byStrategy.website_domain.query, "bufetedemo.es");
  assert.equal(byStrategy.facebook_handle.query, "bufetedemo");
  assert.equal(byStrategy.facebook_page.searchType, "page");
  assert.equal(byStrategy.instagram_handle.query, "@bufete_demo");
});

test("ignores generic Facebook share URLs as Meta ad probes", () => {
  const probes = buildMetaAdProbes({
    name: "Climargas",
    website: "https://climargas.es",
    facebook: "https://www.facebook.com/sharer.php?u=https%3A%2F%2Fclimargas.es"
  });
  const byStrategy = Object.fromEntries(probes.map((probe) => [probe.strategy, probe]));

  assert.equal(byStrategy.facebook_handle, undefined);
  assert.equal(byStrategy.facebook_page, undefined);
  assert.equal(byStrategy.website_domain.query, "climargas.es");
});

test("Meta active inference stores matching strategy and query evidence", () => {
  const result = inferAdsActivity({
    provider: "meta",
    sourceUrl: "https://www.facebook.com/ads/library/?q=bufetedemo",
    context: { strategy: "facebook_handle", query: "bufetedemo", searchType: "keyword_unordered", confidence: 0.88 },
    text: "Library ID: 123456789 This Page is currently running ads."
  });
  assert.equal(result.active, true);
  assert.equal(result.reason, "meta_library_id_found");
  assert.equal(result.strategy, "facebook_handle");
  assert.equal(result.query, "bufetedemo");
  assert.equal(result.confidence, 0.88);
});

test("classifies lead-generation ad landings from forms, CRM and CTA copy", async () => {
  const firecrawl = {
    async scrape(url) {
      assert.equal(url, "https://clinica.example/landing-presupuesto");
      return {
        markdown: "Solicita presupuesto. Agenda una consulta gratuita y te llamamos hoy.",
        html: '<script src="https://js.hsforms.net/forms/v2.js"></script><form><input type="email"></form>',
        links: []
      };
    }
  };

  const classification = await classifyAdsLandingIntent({
    business: { website: "https://clinica.example" },
    enrichment: {
      meta: {
        active: true,
        sourceProvider: "apify",
        landingUrls: ["https://clinica.example/landing-presupuesto?utm_source=facebook"]
      }
    },
    firecrawl,
    aiClassifier: async ({ deterministic }) => {
      assert.equal(deterministic.type, "lead_generation");
      assert.ok(deterministic.signals.some((signal) => signal.id === "lead_form_integration"));
      return {
        type: "lead_generation",
        confidence: 0.93,
        reason: "ai_quote_consultation_form",
        scores: { lead_generation: 9, ecommerce: 0, other: 1 },
        winningSignals: ["consulta gratuita", "formulario HubSpot"],
        rejectedSignals: [],
        landingSummary: "Lead capture landing for consultation requests."
      };
    },
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(classification.type, "lead_generation");
  assert.equal(classification.landingUrl, "https://clinica.example/landing-presupuesto");
  assert.equal(classification.ai.status, "classified");
  assert.ok(classification.signals.some((signal) => signal.id === "lead_form_integration"));
  assert.ok(classification.signals.some((signal) => signal.id === "lead_generation_copy"));
});

test("classifies ecommerce ad landings from catalog and checkout signals", () => {
  const result = classifyLandingPage({
    url: "https://shop.example/products/sudadera-premium",
    page: {
      markdown: "Sudadera premium. Precio 59,90 €. Envio gratis. Comprar ahora.",
      html: '<form class="product-form"><button name="add-to-cart">Añadir al carrito</button><script>window.ShopifyAnalytics={}</script></form>',
      links: [{ url: "https://shop.example/cart", text: "Carrito" }]
    },
    business: { website: "https://shop.example" }
  });

  assert.equal(result.type, "ecommerce");
  assert.ok(result.scores.ecommerce > result.scores.lead_generation);
  assert.ok(result.signals.some((signal) => signal.id === "checkout_integration"));
});

test("classifies ecommerce stores as ecommerce despite account forms and register copy", () => {
  const result = classifyLandingPage({
    url: "https://www.branxstore.com.ar/",
    page: {
      markdown: `
        Entrá. Registráte. 0 Carrito (0) $0,00.
        Carrito de compras. Subtotal $0,00. Total $0,00.
        Set Juego Herramientas Maletin Branx $119.175,00 6 x $19.862,50.
        Agregar al carrito. Comprar. Solo quedan 17 en stock.
      `,
      html: `
        <form class="product-form"><button class="add-to-cart" name="add-to-cart">Agregar al carrito</button></form>
        <a href="/cart">Ver carrito</a>
      `,
      links: [{ url: "https://www.branxstore.com.ar/cart", text: "Carrito" }]
    },
    business: { website: "https://www.branxstore.com.ar" }
  });

  assert.equal(result.type, "ecommerce");
  assert.ok(result.scores.ecommerce > result.scores.lead_generation);
  assert.ok(result.signals.some((signal) => signal.id === "catalog_runtime_copy"));
});

test("cleans landing HTML into compact visible text and evidence", () => {
  const html = `
    <style>.hidden{display:none}</style>
    <script>window.analytics = { price: "$999999" };</script>
    <section><h1>Reserva una demo</h1><p>Te llamamos hoy &amp; preparamos presupuesto.</p></section>
    <form class="elementor-form"><input name="email"><button>Solicitar presupuesto</button></form>
  `;
  const cleaned = cleanLandingHtml(html);
  assert.match(cleaned, /Reserva una demo/);
  assert.match(cleaned, /Te llamamos hoy & preparamos presupuesto/);
  assert.doesNotMatch(cleaned, /analytics/);
  assert.doesNotMatch(cleaned, /display:none/);

  const evidence = buildLandingEvidencePack({
    url: "https://demo.example/landing",
    page: { html, markdown: "", links: [{ text: "Comprar", url: "https://demo.example/checkout" }] },
    business: { name: "Demo", website: "https://demo.example" },
    deterministic: classifyLandingPage({ url: "https://demo.example/landing", page: { html, markdown: "", links: [] } })
  });
  assert.ok(evidence.extracted.visibleText.length < html.length);
  assert.ok(evidence.extracted.forms[0].leadIntent);
  assert.ok(evidence.extracted.ctas.some((cta) => cta.intent === "lead_generation"));
});

test("uses AI landing classification when configured and stores auditable signals", async () => {
  const firecrawl = {
    async scrape() {
      return {
        markdown: "Precio $15.000. Agregar al carrito. Carrito de compras. Finalizar compra.",
        html: '<form class="elementor-form"><input name="email"></form><button class="add-to-cart">Agregar al carrito</button>',
        links: [{ text: "Checkout", url: "https://shop.example/checkout" }]
      };
    }
  };
  const classification = await classifyAdsLandingIntent({
    business: { website: "https://shop.example" },
    enrichment: { meta: { active: true, landingUrls: ["https://shop.example/"] } },
    firecrawl,
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", mode: "always" },
    aiClassifier: async ({ evidence }) => {
      assert.equal(evidence.extracted.forms[0].leadIntent, true);
      assert.ok(evidence.extracted.keyLinks.some((link) => link.intent === "ecommerce"));
      return {
        type: "ecommerce",
        confidence: 0.94,
        reason: "ai_direct_checkout_and_cart",
        scores: { lead_generation: 2, ecommerce: 9, other: 0 },
        winningSignals: ["add-to-cart button", "checkout link", "cart copy"],
        rejectedSignals: ["generic email form without quote/demo intent"],
        landingSummary: "Direct ecommerce checkout landing."
      };
    },
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(classification.type, "ecommerce");
  assert.equal(classification.reason, "ai_direct_checkout_and_cart");
  assert.equal(classification.ai.status, "classified");
  assert.ok(classification.signals.some((signal) => signal.id === "ai_landing_classifier"));
});

test("does not classify Ads landing from local signals when funnel AI is unavailable", async () => {
  const firecrawl = {
    async scrape() {
      return {
        markdown: "Solicita presupuesto. Agenda una consulta gratuita y te llamamos hoy.",
        html: '<script src="https://js.hsforms.net/forms/v2.js"></script><form><input type="email"></form>',
        links: []
      };
    }
  };

  const classification = await classifyAdsLandingIntent({
    business: { website: "https://clinica.example" },
    enrichment: {
      meta: {
        active: true,
        landingUrls: ["https://clinica.example/landing-presupuesto"]
      }
    },
    firecrawl,
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", mode: "always" },
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(classification.type, "unknown");
  assert.equal(classification.reason, "ai_required_but_unavailable");
  assert.equal(classification.ai.status, "required_unavailable");
  assert.equal(classification.ai.deterministicType, "lead_generation");
  assert.equal(classification.signals.length, 0);
});

test("does not classify Ads landing when funnel AI fails or returns invalid JSON", async () => {
  const firecrawl = {
    async scrape() {
      return {
        markdown: "Comprar ahora. Carrito de compras. Finalizar compra.",
        html: '<button class="add-to-cart">Agregar al carrito</button>',
        links: [{ text: "Checkout", url: "https://shop.example/checkout" }]
      };
    }
  };

  const failed = await classifyAdsLandingIntent({
    business: { website: "https://shop.example" },
    enrichment: { google: { active: true, landingUrls: ["https://shop.example/"] } },
    firecrawl,
    aiClassifier: async () => {
      throw new Error("deepseek_down");
    },
    now: new Date("2026-06-05T00:00:00Z")
  });
  const invalid = await classifyAdsLandingIntent({
    business: { website: "https://shop.example" },
    enrichment: { google: { active: true, landingUrls: ["https://shop.example/"] } },
    firecrawl,
    aiClassifier: async () => null,
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(failed.type, "unknown");
  assert.equal(failed.reason, "ai_classification_failed");
  assert.equal(failed.ai.status, "failed");
  assert.equal(failed.ai.deterministicType, "ecommerce");
  assert.equal(invalid.type, "unknown");
  assert.equal(invalid.reason, "ai_invalid_response");
  assert.equal(invalid.ai.status, "invalid_response");
  assert.equal(invalid.ai.deterministicType, "ecommerce");
});

test("classifies custom quote apparel landing as lead generation despite WooCommerce", () => {
  const result = classifyLandingPage({
    url: "https://disownedfactory.com/sudaderas-para-grupos/",
    page: {
      markdown: `
        Sudaderas para grupos personalizadas. Quiero un diseño único.
        En 5 minutos te enviamos maqueta + presupuesto y alternativas para ahorrar.
        Sin compromiso. Incluye diseño/fotomontaje y asesoramiento para ajustar coste.
        Testimonio: volveré a comprar. Desde 1 unidad.
      `,
      html: `
        <div class="woocommerce"></div>
        <form class="elementor-form"><input type="email" name="email"></form>
      `,
      links: []
    },
    business: { website: "https://disownedfactory.com" }
  });

  assert.equal(result.type, "lead_generation");
  assert.ok(result.scores.lead_generation > result.scores.ecommerce);
  assert.ok(result.signals.some((signal) => signal.id === "custom_quote_landing"));
  assert.ok(result.signals.some((signal) => signal.id === "ecommerce_infrastructure"));
});

test("does not treat generic contact pages as lead-generation landings", () => {
  const result = classifyLandingPage({
    url: "https://bufete.example/contacto",
    page: {
      markdown: "Contacto. Nombre, email y mensaje.",
      html: "<form><input name='email'><textarea name='mensaje'></textarea></form>",
      links: []
    },
    business: { website: "https://bufete.example" }
  });

  assert.notEqual(result.type, "lead_generation");
  assert.equal(result.genericContactPage, true);
});

test("extracts landing URLs from escaped ad snapshots and strips tracking noise", () => {
  const urls = extractLandingUrlsFromText(
    'caption":"https:\\/\\/disownedfactory.com\\/sudaderas-para-grupos\\/?utm_source=facebook&fbclid=abc","ad":"https://facebook.com/ads/library/?id=1"',
    { business: { website: "https://disownedfactory.com" } }
  );

  assert.deepEqual(urls, ["https://disownedfactory.com/sudaderas-para-grupos/"]);
});

test("discovers social profiles from business website for Meta ad probes", async () => {
  const firecrawl = {
    async scrape(url) {
      assert.equal(url, "https://disownedfactory.com");
      return {
        markdown: "[Instagram](http://www.instagram.com/disowned_factory)",
        html: '<a href="https://www.facebook.com/disownedfactory">Facebook</a>',
        links: [{ url: "http://www.instagram.com/disowned_factory" }]
      };
    }
  };

  const discovery = await discoverSocialsForAds({
    business: { website: "https://disownedfactory.com" },
    firecrawl
  });

  assert.equal(discovery.status, "found");
  assert.equal(discovery.instagram, "http://www.instagram.com/disowned_factory");
  assert.equal(discovery.facebook, "https://www.facebook.com/disownedfactory");
});

test("enriches Meta ads from discovered Instagram and retries all-country library", async () => {
  const calls = [];
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      calls.push(url);
      if (url === "https://disownedfactory.com") {
        return {
          markdown: "[Instagram](http://www.instagram.com/disowned_factory)",
          html: "",
          links: [{ url: "http://www.instagram.com/disowned_factory" }]
        };
      }
      if (url.includes("facebook.com/ads/library") && url.includes("country=ALL") && url.includes("%40disowned_factory")) {
        return {
          markdown: "Library ID: 123456789 This Page is currently running ads.",
          html: ""
        };
      }
      if (url.includes("adstransparency.google.com")) {
        return { markdown: "No ads found", html: "" };
      }
      return { markdown: "No results", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Disowned Factory", website: "https://disownedfactory.com", city: "Madrid" },
    firecrawl,
    aiResolver: adsAiResolverFromEvidence(({ evidence, phase }) => {
      assert.equal(phase, "firecrawl");
      assert.ok(evidence.providers.meta.attempts.some((attempt) => attempt.query === "@disowned_factory"));
      assert.ok(evidence.providers.meta.attempts.some((attempt) => /Library ID/.test(attempt.evidenceSnippet)));
    }),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, true);
  assert.equal(enrichment.meta.ai.status, "resolved");
  assert.equal(enrichment.meta.strategy, "instagram_handle");
  assert.equal(enrichment.meta.query, "@disowned_factory");
  assert.equal(enrichment.meta.country, "ALL");
  assert.equal(enrichment.meta.socialDiscovery.instagram, "http://www.instagram.com/disowned_factory");
  assert.ok(calls.some((url) => url.includes("country=ES")));
  assert.ok(calls.some((url) => url.includes("country=ALL")));
});

test("uses AI discovery plan to locate Ads Library evidence with Firecrawl", async () => {
  const searches = [];
  const scrapes = [];
  const firecrawl = {
    async search(query) {
      searches.push(query);
      if (query.includes("Acme Solar") && query.includes("acme.example")) {
        return [{ url: "https://adstransparency.google.com/advertiser/AR-AI?region=ES" }];
      }
      return [];
    },
    async scrape(url) {
      scrapes.push(url);
      if (url === "https://acme.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library") && url.includes("%40acme_ai")) {
        return { markdown: "Library ID: 987654321 This Page is currently running ads.", html: "" };
      }
      if (url.includes("adstransparency.google.com/advertiser/AR-AI")) {
        return { markdown: "Acme Solar acme.example CR987654321 first shown 2026-06-04 last shown 2026-06-05", html: "" };
      }
      if (url.includes("adstransparency.google.com")) return { markdown: "Google Ads Transparency Center", html: "" };
      return { markdown: "No results", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Acme Solar", website: "https://acme.example", city: "Madrid" },
    firecrawl,
    aiDiscoveryPlanner: async ({ seedPlan }) => {
      assert.ok(seedPlan.metaProbes.some((probe) => probe.query === "acme.example"));
      return {
        metaProbes: [
          { query: "@acme_ai", searchType: "keyword_unordered", country: "ALL", reason: "official_instagram_handle" }
        ],
        googleSearchQueries: [
          { query: 'site:adstransparency.google.com/advertiser "Acme Solar" "acme.example"', reason: "brand_domain_search" }
        ],
        googleUrls: [
          { url: "https://adstransparency.google.com/advertiser/AR-AI?region=ES", reason: "candidate_advertiser_url" }
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } }
      };
    },
    aiResolver: async ({ evidence, phase }) => {
      assert.equal(phase, "firecrawl");
      const metaAttempt = evidence.providers.meta.attempts.find((attempt) => attempt.plannedBy === "ai" && attempt.query === "@acme_ai");
      const googleAttempt = evidence.providers.google.attempts.find((attempt) => attempt.plannedBy === "ai" && attempt.sourceUrl.includes("AR-AI"));
      assert.ok(metaAttempt);
      assert.ok(googleAttempt);
      return {
        meta: {
          active: true,
          status: "active",
          confidence: 0.94,
          reason: "ai_meta_active_verified",
          selectedAttemptIds: [metaAttempt.attemptId],
          landingUrls: [],
          matchedFields: metaAttempt.matchedFields || [],
          sourceUrl: metaAttempt.sourceUrl,
          evidenceSummary: "AI-planned Meta probe found active ad evidence.",
          needsMoreEvidence: false
        },
        google: {
          active: true,
          status: "active",
          confidence: 0.92,
          reason: "ai_google_active_verified",
          selectedAttemptIds: [googleAttempt.attemptId],
          landingUrls: [],
          matchedFields: googleAttempt.matchedFields || [],
          latestDetectedDate: googleAttempt.latestDetectedDate,
          sourceUrl: googleAttempt.sourceUrl,
          evidenceSummary: "AI-planned Google advertiser URL matched the business domain.",
          needsMoreEvidence: false
        }
      };
    },
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", requirePlannedEvidence: true },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.discoveryPlan.ai.status, "planned");
  assert.equal(enrichment.discoveryPlan.ai.cost.estimatedUsd, 0.000184);
  assert.equal(enrichment.meta.active, true);
  assert.equal(enrichment.google.active, true);
  assert.ok(searches.includes('site:adstransparency.google.com/advertiser "Acme Solar" "acme.example"'));
  assert.ok(scrapes.some((url) => url.includes("%40acme_ai")));
  assert.ok(!searches.includes("site:adstransparency.google.com/advertiser acme.example"));
  assert.ok(!scrapes.some((url) => url.includes("q=acme.example")));
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.plannedBy === "ai"));
  assert.ok(enrichment.google.attempts.some((attempt) => attempt.plannedBy === "ai"));
});

test("does not verify Ads activity from heuristics when activity AI is unavailable", async () => {
  const firecrawl = {
    async search() {
      return [{ url: "https://adstransparency.google.com/advertiser/AR123?region=ES" }];
    },
    async scrape(url) {
      if (url === "https://demo.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) {
        return { markdown: "Library ID: 123456789 This Page is currently running ads.", html: "" };
      }
      if (url.includes("adstransparency.google.com")) {
        return { markdown: "Demo Factory demo.example CR123456789 first shown 2026-06-04 last shown 2026-06-05", html: "" };
      }
      return { markdown: "", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Demo Factory", website: "https://demo.example", city: "Madrid" },
    firecrawl,
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", mode: "never" },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.google.active, null);
  assert.equal(enrichment.meta.reason, "ai_required_but_unavailable");
  assert.equal(enrichment.google.reason, "ai_required_but_unavailable");
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.active === true));
  assert.ok(enrichment.google.attempts.some((attempt) => attempt.active === true));
});

test("does not scrape broad Google Transparency page when no domain is available", async () => {
  const searched = [];
  const scraped = [];
  const plannedQuery = 'site:adstransparency.google.com/advertiser "Sin Web Solar" "Madrid"';
  const firecrawl = {
    async search(query) {
      searched.push(query);
      if (query === plannedQuery) {
        return [{ url: "https://adstransparency.google.com/advertiser/AR-NODOMAIN?region=ES" }];
      }
      return [];
    },
    async scrape(url) {
      scraped.push(url);
      if (url.includes("adstransparency.google.com/?")) {
        throw new Error("broad_google_transparency_should_not_be_scraped");
      }
      if (url.includes("facebook.com/ads/library")) return { markdown: "No ads found", html: "" };
      if (url.includes("AR-NODOMAIN")) {
        return { markdown: "Sin Web Solar Madrid CR123456789 first shown 2026-06-04 last shown 2026-06-05", html: "" };
      }
      return { markdown: "", html: "", links: [] };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Sin Web Solar", city: "Madrid" },
    firecrawl,
    aiDiscoveryPlanner: async () => ({
      googleSearchQueries: [{ query: plannedQuery, reason: "ai_business_name_city_transparency_search" }]
    }),
    aiResolver: adsAiResolverFromEvidence(({ evidence }) => {
      const googleAttempts = evidence.providers.google.attempts;
      assert.equal(googleAttempts.length, 1);
      assert.equal(googleAttempts[0].plannedBy, "ai");
      assert.equal(googleAttempts[0].sourceUrl, "https://adstransparency.google.com/advertiser/AR-NODOMAIN?region=ES");
      return {
        meta: {
          active: null,
          status: "unknown",
          confidence: 0.4,
          reason: "ai_meta_unknown",
          selectedAttemptIds: [],
          landingUrls: [],
          matchedFields: [],
          sourceUrl: null,
          evidenceSummary: "No Meta identity evidence.",
          needsMoreEvidence: false
        },
        google: {
          active: true,
          status: "active",
          confidence: 0.91,
          reason: "ai_google_business_name_active_verified",
          selectedAttemptIds: [googleAttempts[0].attemptId],
          landingUrls: [],
          matchedFields: ["business_name"],
          sourceUrl: googleAttempts[0].sourceUrl,
          latestDetectedDate: googleAttempts[0].latestDetectedDate,
          evidenceSummary: "AI planned search found a matching Google advertiser page.",
          needsMoreEvidence: false
        }
      };
    }),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.ok(searched.includes(plannedQuery));
  assert.ok(scraped.every((url) => !url.includes("adstransparency.google.com/?")));
  assert.equal(enrichment.google.active, true);
  assert.equal(enrichment.google.sourceProvider, "firecrawl");
});

test("rejects AI Ads activity decisions that are not backed by selected evidence", async () => {
  const firecrawl = {
    async search() {
      return [{ url: "https://adstransparency.google.com/advertiser/AR-UNBACKED?region=ES" }];
    },
    async scrape(url) {
      if (url === "https://unbacked.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) {
        return { markdown: "Library ID: 123456789 This Page is currently running ads.", html: "" };
      }
      if (url.includes("adstransparency.google.com")) {
        return { markdown: "No ads found for Unbacked Demo", html: "" };
      }
      return { markdown: "", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Unbacked Demo", website: "https://unbacked.example", city: "Madrid" },
    firecrawl,
    aiResolver: async () => ({
      meta: {
        active: true,
        status: "active",
        confidence: 0.9,
        reason: "ai_claimed_active_without_attempt",
        selectedAttemptIds: [],
        landingUrls: [],
        matchedFields: ["business_name"],
        sourceUrl: null,
        evidenceSummary: "No selected attempt.",
        needsMoreEvidence: false
      },
      google: {
        active: false,
        status: "inactive",
        confidence: 0.9,
        reason: "ai_claimed_inactive_without_attempt",
        selectedAttemptIds: [],
        landingUrls: [],
        matchedFields: ["business_name"],
        sourceUrl: null,
        evidenceSummary: "No selected attempt.",
        needsMoreEvidence: false
      }
    }),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.google.active, null);
  assert.equal(enrichment.meta.reason, "ai_unbacked_activity_decision");
  assert.equal(enrichment.google.reason, "ai_unbacked_activity_decision");
  assert.equal(enrichment.meta.ai.status, "invalid_unbacked_decision");
  assert.equal(enrichment.google.ai.status, "invalid_unbacked_decision");
});

test("rejects incomplete or contradictory AI Ads activity fields", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://strict.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) {
        return { markdown: "Library ID: 123456789 This Page is currently running ads.", html: "" };
      }
      if (url.includes("adstransparency.google.com")) return { markdown: "No ads found", html: "" };
      return { markdown: "", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Strict Demo", website: "https://strict.example", city: "Madrid" },
    firecrawl,
    aiResolver: async ({ evidence }) => {
      const metaAttempt = evidence.providers.meta.attempts[0];
      const googleAttempt = evidence.providers.google.attempts[0];
      return {
        meta: {
          active: true,
          confidence: 0.9,
          reason: "missing_status",
          selectedAttemptIds: [metaAttempt.attemptId],
          landingUrls: [],
          matchedFields: [],
          sourceUrl: metaAttempt.sourceUrl,
          evidenceSummary: "Missing status.",
          needsMoreEvidence: false
        },
        google: {
          active: true,
          status: "inactive",
          confidence: 0.9,
          reason: "contradictory_status",
          selectedAttemptIds: [googleAttempt.attemptId],
          landingUrls: [],
          matchedFields: [],
          sourceUrl: googleAttempt.sourceUrl,
          evidenceSummary: "Contradictory active/status.",
          needsMoreEvidence: false
        }
      };
    },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.google.active, null);
  assert.equal(enrichment.meta.reason, "ai_invalid_response");
  assert.equal(enrichment.google.reason, "ai_invalid_response");
  assert.equal(enrichment.meta.ai.status, "invalid_response");
  assert.equal(enrichment.google.ai.status, "invalid_response");
});

test("accepts AI Ads activity decisions backed by an evidence source URL", async () => {
  const firecrawl = {
    async search() {
      return [{ url: "https://adstransparency.google.com/advertiser/AR-SOURCE?region=ES" }];
    },
    async scrape(url) {
      if (url === "https://source-backed.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) return { markdown: "No ads found", html: "" };
      if (url.includes("adstransparency.google.com")) {
        return { markdown: "Source Backed source-backed.example CR123456789 first shown 2026-06-04 last shown 2026-06-05", html: "" };
      }
      return { markdown: "", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Source Backed", website: "https://source-backed.example", city: "Madrid" },
    firecrawl,
    aiResolver: async ({ evidence }) => {
      const googleAttempt = evidence.providers.google.attempts.find((attempt) => attempt.sourceUrl.includes("AR-SOURCE"));
      return {
        meta: {
          active: null,
          status: "unknown",
          confidence: 0.4,
          reason: "ai_meta_unknown",
          selectedAttemptIds: [],
          landingUrls: [],
          matchedFields: [],
          sourceUrl: null,
          evidenceSummary: "No Meta evidence.",
          needsMoreEvidence: false
        },
        google: {
          active: true,
          status: "active",
          confidence: 0.92,
          reason: "ai_source_url_backed_active",
          selectedAttemptIds: ["wrong_attempt_id"],
          landingUrls: [],
          matchedFields: ["domain"],
          sourceUrl: googleAttempt.sourceUrl,
          latestDetectedDate: googleAttempt.latestDetectedDate,
          evidenceSummary: "The source URL matches a supplied attempt.",
          needsMoreEvidence: false
        }
      };
    },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.google.active, true);
  assert.equal(enrichment.google.sourceUrl, "https://adstransparency.google.com/advertiser/AR-SOURCE?region=ES");
  assert.equal(enrichment.google.reason, "ai_source_url_backed_active");
});

test("requires AI-planned Ads evidence when configured", async () => {
  const firecrawl = {
    async search(query) {
      if (query.includes("planned.example")) {
        return [{ url: "https://adstransparency.google.com/advertiser/AR-PLANNED?region=ES" }];
      }
      return [];
    },
    async scrape(url) {
      if (url === "https://planned.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) return { markdown: "No ads found", html: "" };
      if (url.includes("AR-PLANNED") || url.includes("adstransparency.google.com")) {
        return { markdown: "Planned Demo planned.example CR123456789 first shown 2026-06-04 last shown 2026-06-05", html: "" };
      }
      return { markdown: "", html: "" };
    }
  };
  const resolver = async ({ evidence }) => {
    const googleAttempt =
      evidence.providers.google.attempts.find((attempt) => attempt.plannedBy === "ai" && attempt.sourceUrl?.includes("AR-PLANNED")) ||
      evidence.providers.google.attempts.find((attempt) => attempt.sourceUrl?.includes("adstransparency.google.com"));
    const unknownProvider = (provider) => ({
      active: null,
      status: "unknown",
      confidence: 0.4,
      reason: `ai_${provider}_unknown`,
      selectedAttemptIds: [],
      landingUrls: [],
      matchedFields: [],
      sourceUrl: null,
      evidenceSummary: "No AI-planned evidence.",
      needsMoreEvidence: true
    });
    if (!googleAttempt) {
      return {
        meta: unknownProvider("meta"),
        google: unknownProvider("google")
      };
    }
    return {
      meta: {
        active: null,
        status: "unknown",
        confidence: 0.4,
        reason: "ai_meta_unknown",
        selectedAttemptIds: [],
        landingUrls: [],
        matchedFields: [],
        sourceUrl: null,
        evidenceSummary: "No Meta evidence.",
        needsMoreEvidence: false
      },
      google: {
        active: true,
        status: "active",
        confidence: 0.9,
        reason: "ai_google_active",
        selectedAttemptIds: [googleAttempt.attemptId],
        landingUrls: [],
        matchedFields: ["domain"],
        sourceUrl: googleAttempt.sourceUrl,
        latestDetectedDate: googleAttempt.latestDetectedDate,
        evidenceSummary: "Google evidence says active.",
        needsMoreEvidence: false
      }
    };
  };

  const seedOnly = await enrichBusinessAds({
    business: { name: "Planned Demo", website: "https://planned.example", city: "Madrid" },
    firecrawl,
    aiResolver: resolver,
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", requirePlannedEvidence: true },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });
  const aiPlanned = await enrichBusinessAds({
    business: { name: "Planned Demo", website: "https://planned.example", city: "Madrid" },
    firecrawl,
    aiDiscoveryPlanner: async () => ({
      googleUrls: [{ url: "https://adstransparency.google.com/advertiser/AR-PLANNED?region=ES", reason: "ai_domain_advertiser_match" }]
    }),
    aiResolver: resolver,
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", requirePlannedEvidence: true },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(seedOnly.google.active, null);
  assert.equal(seedOnly.google.reason, "ai_unplanned_activity_decision");
  assert.equal(seedOnly.google.ai.status, "invalid_unplanned_decision");
  assert.equal(aiPlanned.google.active, true);
  assert.equal(aiPlanned.google.ai.status, "resolved");
  assert.ok(aiPlanned.google.attempts.some((attempt) => attempt.plannedBy === "ai"));
});

test("requires independent AI verification before keeping boolean Ads activity", async () => {
  const firecrawl = {
    async search() {
      return [{ url: "https://adstransparency.google.com/advertiser/AR-VERIFY?region=ES" }];
    },
    async scrape(url) {
      if (url === "https://verify.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) return { markdown: "Library ID: 456789123 This Page is currently running ads.", html: "" };
      if (url.includes("adstransparency.google.com")) return { markdown: "No ads found for Verify Demo", html: "" };
      return { markdown: "", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Verify Demo", website: "https://verify.example", city: "Madrid" },
    firecrawl,
    aiResolver: async ({ evidence }) => {
      const metaAttempt = evidence.providers.meta.attempts.find((attempt) => attempt.activeSignal === true);
      const googleAttempt = evidence.providers.google.attempts.find((attempt) => attempt.activeSignal === false);
      return {
        meta: {
          active: true,
          status: "active",
          confidence: 0.92,
          reason: "ai_meta_active_verified",
          selectedAttemptIds: [metaAttempt.attemptId],
          landingUrls: [],
          matchedFields: ["business_name"],
          sourceUrl: metaAttempt.sourceUrl,
          evidenceSummary: "Resolver believes Meta is active.",
          needsMoreEvidence: false
        },
        google: {
          active: false,
          status: "inactive",
          confidence: 0.88,
          reason: "ai_google_inactive_verified",
          selectedAttemptIds: [googleAttempt.attemptId],
          landingUrls: [],
          matchedFields: ["domain"],
          sourceUrl: googleAttempt.sourceUrl,
          evidenceSummary: "Resolver believes Google is inactive.",
          needsMoreEvidence: false
        }
      };
    },
    aiVerifier: async ({ evidence, resolved }) => {
      assert.equal(evidence.task, "ads_activity_verification");
      assert.equal(evidence.proposedDecision.meta.active, true);
      assert.equal(resolved.meta.active, true);
      return {
        meta: {
          confirmed: false,
          status: "rejected",
          active: null,
          confidence: 0.51,
          reason: "meta_identity_not_proven",
          selectedAttemptIds: resolved.meta.ai.selectedAttemptIds,
          evidenceSummary: "The Meta page identity is not proven enough.",
          needsMoreEvidence: true
        },
        google: {
          confirmed: true,
          status: "confirmed",
          active: false,
          confidence: 0.9,
          reason: "google_official_no_active_ads",
          selectedAttemptIds: resolved.google.ai.selectedAttemptIds,
          evidenceSummary: "Official Google evidence supports inactive.",
          needsMoreEvidence: false
        },
        usage: { prompt_tokens: 1000, completion_tokens: 250 }
      };
    },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.meta.reason, "ai_verification_rejected");
  assert.equal(enrichment.meta.ai.status, "verification_rejected");
  assert.equal(enrichment.meta.ai.verification.status, "rejected");
  assert.equal(enrichment.google.active, false);
  assert.equal(enrichment.google.ai.status, "resolved");
  assert.equal(enrichment.google.ai.verification.status, "confirmed");
  assert.equal(enrichment.google.ai.verification.cost.estimatedUsd, 0.00015);
});

test("does not spend Apify fallback when Deepseek resolves Firecrawl evidence", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://demo.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) return { markdown: "No ads found", html: "" };
      if (url.includes("adstransparency.google.com")) return { markdown: "No ads found", html: "" };
      return { markdown: "", html: "" };
    }
  };
  const apify = {
    enabled: true,
    async runFacebookAdsLibrary() {
      throw new Error("apify_meta_should_not_run");
    },
    async runGoogleAdsTransparency() {
      throw new Error("apify_google_should_not_run");
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Demo Factory", website: "https://demo.example", city: "Madrid" },
    firecrawl,
    apify,
    apifyFallbackMode: "on_unknown",
    aiResolver: async ({ evidence, phase }) => {
      assert.equal(phase, "firecrawl");
      assert.ok(evidence.providers.meta.attempts.length);
      assert.ok(evidence.providers.google.attempts.length);
      return {
        meta: {
          active: false,
          status: "inactive",
          confidence: 0.9,
          reason: "ai_firecrawl_inactive",
          selectedAttemptIds: [evidence.providers.meta.attempts[0].attemptId],
          landingUrls: [],
          matchedFields: [],
          sourceUrl: evidence.providers.meta.attempts[0].sourceUrl,
          evidenceSummary: "No active Meta ads found for exact probes.",
          needsMoreEvidence: false
        },
        google: {
          active: false,
          status: "inactive",
          confidence: 0.9,
          reason: "ai_firecrawl_inactive",
          selectedAttemptIds: [evidence.providers.google.attempts[0].attemptId],
          landingUrls: [],
          matchedFields: [],
          sourceUrl: evidence.providers.google.attempts[0].sourceUrl,
          evidenceSummary: "No active Google ads found for exact domain.",
          needsMoreEvidence: false
        }
      };
    },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, false);
  assert.equal(enrichment.google.active, false);
  assert.equal(enrichment.meta.ai.phase, "firecrawl");
  assert.equal(enrichment.google.ai.phase, "firecrawl");
});

test("keeps Apify disabled when fallback flag is off even if Deepseek is unsure", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://demo.example") return { markdown: "", html: "", links: [] };
      return { markdown: "Ad Library loading", html: "" };
    }
  };
  const apify = {
    enabled: true,
    async runFacebookAdsLibrary() {
      throw new Error("apify_meta_should_not_run");
    },
    async runGoogleAdsTransparency() {
      throw new Error("apify_google_should_not_run");
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Demo Factory", website: "https://demo.example", city: "Madrid" },
    firecrawl,
    apify,
    apifyFallbackMode: "off",
    aiResolver: adsAiResolverFromEvidence(),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.google.active, null);
  assert.equal(enrichment.meta.ai.phase, "firecrawl");
  assert.equal(enrichment.google.ai.phase, "firecrawl");
});

test("does not spend Apify when Deepseek discovery planning fails", async () => {
  const adsLibraryCalls = [];
  const searches = [];
  const firecrawl = {
    async search(query) {
      searches.push(query);
      return [];
    },
    async scrape(url) {
      adsLibraryCalls.push(url);
      if (url === "https://planner-fail.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) throw new Error("meta_ads_library_should_not_be_scraped_without_ai_plan");
      if (url.includes("adstransparency.google.com")) throw new Error("google_ads_library_should_not_be_scraped_without_ai_plan");
      return { markdown: "", html: "" };
    }
  };
  const apify = {
    enabled: true,
    async runFacebookAdsLibrary() {
      throw new Error("apify_meta_should_not_run_without_ai_plan");
    },
    async runGoogleAdsTransparency() {
      throw new Error("apify_google_should_not_run_without_ai_plan");
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Planner Fail", website: "https://planner-fail.example", city: "Madrid" },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => {
      throw new Error("planner_down");
    },
    aiResolver: adsAiResolverFromEvidence(),
    aiConfig: { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash", requirePlannedEvidence: true },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.discoveryPlan.ai.status, "failed");
  assert.deepEqual(searches, []);
  assert.deepEqual(adsLibraryCalls, ["https://planner-fail.example"]);
  assert.equal(enrichment.meta.ai.phase, "firecrawl");
  assert.equal(enrichment.google.ai.phase, "firecrawl");
  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.google.active, null);
});

test("uses AI-planned Meta sources when Apify fallback is enabled", async () => {
  const apifyUrls = [];
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://planned.example") return { markdown: "", html: "", links: [] };
      if (url.includes("facebook.com/ads/library")) return { markdown: "Ad Library loading", html: "" };
      if (url.includes("adstransparency.google.com")) return { markdown: "No ads found", html: "" };
      return { markdown: "", html: "" };
    }
  };
  const apify = {
    maxChargedResults: 10,
    facebookAdsActorId: "actor/meta",
    async runFacebookAdsLibrary(input) {
      apifyUrls.push(input.urls[0].url);
      if (input.urls[0].url.includes("%40planned_handle")) {
        return [
          {
            ad_archive_id: "999888777666555",
            is_active: true,
            page_name: "Planned Demo",
            total: 1,
            ad_library_url: "https://www.facebook.com/ads/library/?id=999888777666555",
            snapshot: {
              page_name: "Planned Demo",
              caption: "https://planned.example",
              body: { text: "Reserva ahora en planned.example" }
            }
          }
        ];
      }
      return [];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Planned Demo", website: "https://planned.example", city: "Madrid" },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => ({
      metaProbes: [
        { query: "@planned_handle", searchType: "keyword_unordered", country: "ALL", reason: "ai_official_instagram_handle" }
      ]
    }),
    aiResolver: async ({ evidence, phase }) => {
      if (phase === "firecrawl") {
        return {
          meta: {
            active: null,
            status: "unknown",
            confidence: 0.4,
            reason: "ai_needs_apify_meta_evidence",
            selectedAttemptIds: [],
            landingUrls: [],
            matchedFields: [],
            sourceUrl: null,
            evidenceSummary: "Firecrawl evidence is blocked.",
            needsMoreEvidence: true
          },
          google: {
            active: null,
            status: "unknown",
            confidence: 0.4,
            reason: "ai_google_unknown",
            selectedAttemptIds: [],
            landingUrls: [],
            matchedFields: [],
            sourceUrl: null,
            evidenceSummary: "No Google evidence.",
            needsMoreEvidence: false
          }
        };
      }
      const apifyAttempt = evidence.providers.meta.attempts.find((attempt) =>
        attempt.sourceProvider === "apify" &&
        attempt.plannedBy === "ai" &&
        attempt.query === "@planned_handle"
      );
      assert.ok(apifyAttempt);
      return {
        meta: {
          active: true,
          status: "active",
          confidence: 0.94,
          reason: "ai_apify_planned_source_active",
          selectedAttemptIds: [apifyAttempt.attemptId],
          landingUrls: apifyAttempt.landingUrls || [],
          matchedFields: apifyAttempt.matchedFields || [],
          sourceUrl: apifyAttempt.sourceUrl,
          evidenceSummary: "Apify evidence came from the AI-planned Meta source.",
          needsMoreEvidence: false
        },
        google: {
          active: null,
          status: "unknown",
          confidence: 0.4,
          reason: "ai_google_unknown",
          selectedAttemptIds: [],
          landingUrls: [],
          matchedFields: [],
          sourceUrl: null,
          evidenceSummary: "No Google evidence.",
          needsMoreEvidence: false
        }
      };
    },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.ok(apifyUrls[0].includes("%40planned_handle"));
  assert.equal(enrichment.meta.active, true);
  assert.equal(enrichment.meta.sourceProvider, "apify");
  assert.equal(enrichment.meta.ai.phase, "firecrawl_apify");
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.sourceProvider === "apify" && attempt.plannedBy === "ai"));
});

test("falls back to Apify for matched active Meta ads only", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://disownedfactory.com") {
        return {
          markdown: "[Instagram](https://www.instagram.com/disowned_factory)",
          html: "",
          links: [{ url: "https://www.instagram.com/disowned_factory" }]
        };
      }
      if (url.includes("adstransparency.google.com")) {
        return { markdown: "CR123456789 first shown 2026-06-04", html: "" };
      }
      return { markdown: "Ad Library", html: "" };
    }
  };
  const apify = {
    maxChargedResults: 10,
    async runFacebookAdsLibrary(input) {
      assert.equal(input.limitPerSource, 1);
      assert.equal(input.count, 10);
      assert.equal(input.scrapeAdDetails, true);
      assert.equal(input["scrapePageAds.activeStatus"], "active");
      assert.match(input.urls[0].url, /%40disowned_factory/);
      return [
        {
          ad_archive_id: "1919274085400585",
          is_active: true,
          page_name: "Disowned Factory",
          total: 13,
          ad_library_url: "https://www.facebook.com/ads/library/?id=1919274085400585",
          snapshot: {
            page_name: "Disowned Factory",
            caption: "https://disownedfactory.com/sudaderas-para-grupos/",
            body: { text: "Escríbenos @disowned_factory" },
            cards: [{ link_url: "https://disownedfactory.com/sudaderas-personalizadas/" }]
          },
          impressions_with_index: { impressions_text: "1K-5K", impressions_index: 2 },
          start_date: 1780642800
        }
      ];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Disowned Factory", website: "https://disownedfactory.com", city: "Madrid" },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => ({}),
    aiResolver: adsAiResolverFromEvidence(({ evidence, phase }) => {
      if (phase === "firecrawl_apify") {
        assert.ok(evidence.providers.meta.attempts.some((attempt) => attempt.sourceProvider === "apify"));
      }
    }),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, true);
  assert.equal(enrichment.meta.reason, "ai_meta_active_verified");
  assert.equal(enrichment.meta.sourceProvider, "apify");
  assert.equal(enrichment.meta.ai.phase, "firecrawl_apify");
  assert.deepEqual(enrichment.meta.matchedFields, ["domain", "page_name", "instagram_handle"]);
  assert.equal(enrichment.meta.adArchiveId, "1919274085400585");
  assert.deepEqual(enrichment.meta.landingUrls, [
    "https://disownedfactory.com/sudaderas-para-grupos/",
    "https://disownedfactory.com/sudaderas-personalizadas/"
  ]);
  assert.deepEqual(enrichment.meta.spendEstimate, {
    status: "estimated",
    source: "public_impressions_cpm_benchmark",
    currency: "EUR",
    impressionsMin: 1000,
    impressionsMax: 5000,
    estimatedSpendMin: 8,
    estimatedSpendMax: 40,
    cpm: 8,
    confidence: 0.49,
    matchedAds: 1,
    adsWithImpressions: 1,
    checkedAt: "2026-06-05T00:00:00.000Z",
    note: "Estimación por impresiones públicas de Meta Ads Library multiplicadas por CPM benchmark del nicho."
  });
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.sourceProvider === "apify" && attempt.active === true));
  assert.ok(enrichment.google.attempts.length >= 1);
});

test("does not verify Google ads from unrelated transparency advertisers", async () => {
  const firecrawl = {
    async search() {
      return [{ url: "https://adstransparency.google.com/advertiser/AR17189016863045058561?region=US" }];
    },
    async scrape(url) {
      if (url === "https://boudevin-abogadoslogrono.com") return { markdown: "", html: "", links: [] };
      if (url.includes("domain=boudevin-abogadoslogrono.com")) return { markdown: "Google Ads Transparency Center", html: "" };
      if (url.includes("AR17189016863045058561")) {
        return {
          markdown: "Slotted, Inc www.slotted.com CR123456789 first shown 2026-05-30 last shown 2026-06-04 total days shown 5",
          html: ""
        };
      }
      return { markdown: "No ads found", html: "" };
    }
  };

  const enrichment = await enrichBusinessAds({
    business: {
      name: "Boudevin Abogados",
      website: "https://boudevin-abogadoslogrono.com",
      city: "Logroño",
      niche: "Abogados"
    },
    firecrawl,
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.notEqual(enrichment.google.active, true);
  assert.ok(enrichment.google.attempts.some((attempt) => attempt.reason === "google_identity_not_matched"));
});

test("uses Apify Google Transparency fallback for recent domain ads", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://climatron.net") return { markdown: "", html: "", links: [] };
      if (url.includes("adstransparency.google.com")) return { markdown: "Google Ads Transparency Center", html: "" };
      return { markdown: "", html: "" };
    }
  };
  const apify = {
    enabled: true,
    maxChargedResults: 3,
    async runFacebookAdsLibrary() {
      return [];
    },
    async runGoogleAdsTransparency(input) {
      assert.deepEqual(input.searchTerms, ["climatron.net"]);
      assert.equal(input.region, "ES");
      assert.equal(input.resultsLimit, 3);
      assert.equal(input.skipDetails, true);
      return [
        {
          advertiserName: "Rodrigo Carpio Serrano",
          creativeId: "CR01919845296070721537",
          adLibraryUrl: "https://adstransparency.google.com/advertiser/AR123/creative/CR01919845296070721537",
          searchTerm: "climatron.net",
          lastShown: "2026-06-06"
        }
      ];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Climatron", website: "https://climatron.net", city: "Valencia" },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => ({}),
    aiResolver: adsAiResolverFromEvidence(({ evidence, phase }) => {
      if (phase === "firecrawl_apify") {
        assert.ok(evidence.providers.google.attempts.some((attempt) => attempt.sourceProvider === "apify"));
      }
    }),
    country: "ES",
    now: new Date("2026-06-06T00:00:00Z")
  });

  assert.equal(enrichment.google.active, true);
  assert.equal(enrichment.google.reason, "ai_google_active_verified");
  assert.equal(enrichment.google.sourceProvider, "apify");
  assert.deepEqual(enrichment.google.matchedFields, ["domain"]);
  assert.equal(enrichment.google.latestDetectedDate, "2026-06-06");
});

test("continues Apify sources when the first active match has no landing URL", async () => {
  const apifyCalls = [];
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://demo.example") return { markdown: "", html: "", links: [] };
      if (url.includes("adstransparency.google.com")) return { markdown: "No ads found", html: "" };
      if (url === "https://demo.example/landing") {
        return {
          markdown: "Solicita presupuesto y agenda una demo.",
          html: '<form class="elementor-form"></form>',
          links: []
        };
      }
      return { markdown: "Ad Library", html: "" };
    }
  };
  const apify = {
    maxChargedResults: 10,
    async runFacebookAdsLibrary(input) {
      apifyCalls.push(input.urls[0].url);
      if (apifyCalls.length === 1) {
        return [{
          is_active: true,
          page_name: "Demo Factory",
          snapshot: { body: { text: "demo.example" } }
        }];
      }
      return [{
        ad_archive_id: "123456789",
        is_active: true,
        page_name: "Demo Factory",
        snapshot: {
          caption: "https://demo.example/landing",
          body: { text: "demo.example" }
        }
      }];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Demo Factory", website: "https://demo.example", facebook: "https://facebook.com/demofactory" },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => ({}),
    aiResolver: adsAiResolverFromEvidence(),
    landingAiClassifier: async ({ deterministic }) => {
      assert.equal(deterministic.type, "lead_generation");
      return {
        type: "lead_generation",
        confidence: 0.91,
        reason: "ai_demo_quote_landing",
        scores: { lead_generation: 8, ecommerce: 0, other: 1 },
        winningSignals: ["Solicita presupuesto", "agenda una demo"],
        rejectedSignals: [],
        landingSummary: "Demo and quote capture landing."
      };
    },
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(apifyCalls.length, 3);
  assert.equal(enrichment.meta.active, true);
  assert.deepEqual(enrichment.meta.landingUrls, ["https://demo.example/landing"]);
  assert.equal(enrichment.classification.type, "lead_generation");
  assert.equal(enrichment.classification.ai.status, "classified");
});

test("ignores active Apify Meta ads that do not match the business", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://disownedfactory.com") {
        return { markdown: "", html: "", links: [{ url: "https://www.instagram.com/disowned_factory" }] };
      }
      return { markdown: "Ad Library loading", html: "" };
    }
  };
  const apify = {
    maxChargedResults: 10,
    async runFacebookAdsLibrary() {
      return [
        {
          ad_archive_id: "890683230705549",
          is_active: true,
          page_name: "DT Lite",
          total: 13,
          ad_library_url: "https://www.facebook.com/ads/library/?id=890683230705549",
          snapshot: {
            page_name: "DT Lite",
            caption: "play.google.com",
            body: { text: "A story where someone is disowned by family" }
          },
          impressions_with_index: { impressions_text: "10K-20K", impressions_index: 4 }
        }
      ];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Disowned Factory", website: "https://disownedfactory.com", city: "Madrid" },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => ({}),
    aiResolver: adsAiResolverFromEvidence(),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.meta.reason, "ai_meta_unknown");
  assert.equal(enrichment.meta.ai.status, "resolved");
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.reason === "apify_active_items_not_matched"));
  assert.equal(enrichment.meta.itemsSeen, 1);
  assert.equal(enrichment.meta.samplePageName, "DT Lite");
  assert.equal(enrichment.meta.spendEstimate, null);
});

test("does not verify Meta ads from Apify social-only matches", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://ionproyectos.com") return { markdown: "", html: "", links: [] };
      if (url.includes("adstransparency.google.com")) return { markdown: "No ads found", html: "" };
      return { markdown: "Ad Library loading", html: "" };
    }
  };
  const apify = {
    maxChargedResults: 10,
    async runFacebookAdsLibrary() {
      return [
        {
          ad_archive_id: "1899459720673591",
          is_active: true,
          page_name: "Utel Universidad",
          total: 417,
          ad_library_url: "https://www.facebook.com/ads/library/?id=1899459720673591",
          snapshot: {
            page_name: "Utel Universidad",
            body: { text: "Síguenos en facebook.com/ion.proyectos" },
            caption: "https://utel.edu.mx"
          }
        }
      ];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: {
      name: "ION Proyectos",
      website: "https://ionproyectos.com",
      facebook: "https://facebook.com/ion.proyectos"
    },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => ({}),
    aiResolver: adsAiResolverFromEvidence(),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.notEqual(enrichment.meta.active, true);
  assert.equal(enrichment.meta.reason, "ai_meta_unknown");
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.reason === "apify_active_items_not_matched"));
});

test("does not verify Meta ads from Apify domain-only matches", async () => {
  const firecrawl = {
    async search() {
      return [];
    },
    async scrape(url) {
      if (url === "https://boudevin-abogadoslogrono.com") return { markdown: "", html: "", links: [] };
      if (url.includes("adstransparency.google.com")) return { markdown: "No ads found", html: "" };
      return { markdown: "Ad Library loading", html: "" };
    }
  };
  const apify = {
    maxChargedResults: 10,
    async runFacebookAdsLibrary() {
      return [
        {
          ad_archive_id: "111222333444555",
          is_active: true,
          page_name: "Slotted",
          total: 1,
          ad_library_url: "https://www.facebook.com/ads/library/?id=111222333444555",
          snapshot: {
            page_name: "Slotted",
            caption: "https://boudevin-abogadoslogrono.com",
            body: { text: "Directory mention for boudevin-abogadoslogrono.com" }
          }
        }
      ];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: {
      name: "Boudevin Abogados",
      website: "https://boudevin-abogadoslogrono.com",
      city: "Logroño",
      niche: "Abogados"
    },
    firecrawl,
    apify,
    apifyFallbackMode: "always",
    aiDiscoveryPlanner: async () => ({}),
    aiResolver: adsAiResolverFromEvidence(),
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.notEqual(enrichment.meta.active, true);
  assert.equal(enrichment.meta.reason, "ai_meta_unknown");
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.reason === "apify_active_items_not_matched"));
});
