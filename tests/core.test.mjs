import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSpanishPhone } from "../packages/core/src/phone.mjs";
import { extractEmails, extractLeadSignals, selectBusinessUrls } from "../packages/core/src/extractors.mjs";
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
import { buildMetaAdsLibraryUrl, inferAdsActivity } from "../packages/core/src/adsEnrichment.mjs";

test("normalizes Spanish phone numbers to E.164", () => {
  assert.equal(normalizeSpanishPhone("600 111 222"), "+34600111222");
  assert.equal(normalizeSpanishPhone("+34 911 222 333"), "+34911222333");
  assert.equal(normalizeSpanishPhone("0034 600 111 222"), "+34600111222");
  assert.equal(normalizeSpanishPhone("123"), null);
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

test("previews and maps CSV lead imports with custom fields", () => {
  const csv = Buffer.from("Nombre;Web;Email;Ciudad;Presupuesto\nBufete Demo;https://bufete.example;hola@bufete.example;Logroño;alto\n", "utf8");
  const preview = previewLeadImport({
    filename: "leads.csv",
    contentBase64: csv.toString("base64")
  });
  assert.equal(preview.totalRows, 1);
  assert.equal(preview.suggestedMapping.Nombre, "name");
  assert.equal(preview.suggestedMapping.Presupuesto, "custom:presupuesto");

  const parsed = parseLeadFile({ filename: "leads.csv", contentBase64: csv.toString("base64") });
  const imported = buildImportedLeadRows(parsed.rows, preview.suggestedMapping);
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.rows[0].business.name, "Bufete Demo");
  assert.equal(imported.rows[0].business.website, "https://bufete.example");
  assert.deepEqual(imported.rows[0].contacts, [{ kind: "email", value: "hola@bufete.example", confidence: 0.75 }]);
  assert.deepEqual(imported.rows[0].customFields, { presupuesto: "alto" });
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
    text: "CR123456789 first shown 2026-05-30 last shown 2026-06-04 total days shown 5"
  });
  assert.equal(google.active, true);
  assert.equal(google.latestDetectedDate, "2026-06-04");
});
