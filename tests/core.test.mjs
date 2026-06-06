import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSpanishPhone } from "../packages/core/src/phone.mjs";
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
  buildLandingEvidencePack,
  classifyAdsLandingIntent,
  classifyLandingPage,
  cleanLandingHtml,
  extractLandingUrlsFromText
} from "../packages/core/src/adsLandingClassifier.mjs";

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
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(classification.type, "lead_generation");
  assert.equal(classification.landingUrl, "https://clinica.example/landing-presupuesto");
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
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, true);
  assert.equal(enrichment.meta.strategy, "instagram_handle");
  assert.equal(enrichment.meta.query, "@disowned_factory");
  assert.equal(enrichment.meta.country, "ALL");
  assert.equal(enrichment.meta.socialDiscovery.instagram, "http://www.instagram.com/disowned_factory");
  assert.ok(calls.some((url) => url.includes("country=ES")));
  assert.ok(calls.some((url) => url.includes("country=ALL")));
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
      assert.equal(input.scrapeAdDetails, false);
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
          start_date: 1780642800
        }
      ];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Disowned Factory", website: "https://disownedfactory.com", city: "Madrid" },
    firecrawl,
    apify,
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, true);
  assert.equal(enrichment.meta.reason, "apify_active_ad_matched");
  assert.equal(enrichment.meta.sourceProvider, "apify");
  assert.deepEqual(enrichment.meta.matchedFields, ["domain", "page_name", "instagram_handle"]);
  assert.equal(enrichment.meta.adArchiveId, "1919274085400585");
  assert.deepEqual(enrichment.meta.landingUrls, [
    "https://disownedfactory.com/sudaderas-para-grupos/",
    "https://disownedfactory.com/sudaderas-personalizadas/"
  ]);
  assert.ok(enrichment.meta.attempts.some((attempt) => attempt.sourceProvider === "apify" && attempt.active === true));
  assert.ok(enrichment.google.attempts.length >= 1);
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
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(apifyCalls.length, 2);
  assert.equal(enrichment.meta.active, true);
  assert.deepEqual(enrichment.meta.landingUrls, ["https://demo.example/landing"]);
  assert.equal(enrichment.classification.type, "lead_generation");
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
          }
        }
      ];
    }
  };

  const enrichment = await enrichBusinessAds({
    business: { name: "Disowned Factory", website: "https://disownedfactory.com", city: "Madrid" },
    firecrawl,
    apify,
    country: "ES",
    now: new Date("2026-06-05T00:00:00Z")
  });

  assert.equal(enrichment.meta.active, null);
  assert.equal(enrichment.meta.reason, "apify_active_items_not_matched");
  assert.equal(enrichment.meta.itemsSeen, 1);
  assert.equal(enrichment.meta.samplePageName, "DT Lite");
});
