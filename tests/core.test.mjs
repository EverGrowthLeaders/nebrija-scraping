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
