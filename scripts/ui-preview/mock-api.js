// Mock API for UI preview. Intercepts window.fetch so the real app.js renders
// against representative data without a live backend. Classic script => runs
// before the deferred app.js module.
(function () {
  const now = Date.now();
  const iso = (minsAgo = 0) => new Date(now - minsAgo * 60000).toISOString();
  const day = (offset = 0) => {
    const d = new Date(now + offset * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const CITIES = ["Madrid", "Barcelona", "Valencia", "Sevilla", "Bilbao", "Málaga", "Zaragoza"];
  const NICHES = ["clínica dental", "estudio de arquitectura", "asesoría fiscal", "gimnasio boutique", "reformas integrales", "clínica estética"];
  const STATUSES = ["new", "scraped", "enriched", "queued_for_call", "called", "qualified", "callback", "disqualified"];
  const CRM_STATUSES = ["Nuevo", "Contactado", "Interesado", "Cita Concertada", "Descartado"];
  const NAMES = [
    "Clínica Dental Sonrisa", "Arquitectura Vértice", "Asesoría Numia", "Gimnasio Forma Studio",
    "Reformas Atlas", "Estética Lumière", "Dental Care Premium", "Estudio Habitat",
    "Fiscalia Norte", "BodyLab Fitness", "Obras Mediterráneo", "Belleza Aurora",
    "Odontología Belmonte", "Taller Croquis", "Gestoría Cuenta Clara", "PowerHouse Gym",
    "Construcciones Riera", "Skin & Glow", "Implantes Vega", "Diseño Paralelo"
  ];

  const pick = (arr, i) => arr[i % arr.length];
  const rnd = (seed) => {
    const x = Math.sin(seed * 99.13) * 10000;
    return x - Math.floor(x);
  };

  function makeBusiness(i) {
    const score = Math.round(20 + rnd(i) * 78);
    const meta = rnd(i + 3) > 0.45;
    const google = rnd(i + 7) > 0.6;
    const hasEstimate = meta && rnd(i + 5) > 0.4;
    const spendMax = hasEstimate ? Math.round((200 + rnd(i + 2) * 4200)) : null;
    const funnels = ["lead_generation", "ecommerce", "other", "unknown"];
    return {
      id: `biz-${i}`,
      name: pick(NAMES, i),
      city: pick(CITIES, i),
      niche: pick(NICHES, i),
      category: pick(["Salud", "Servicios", "Retail", "Fitness"], i),
      score,
      status: pick(STATUSES, i),
      website: rnd(i + 1) > 0.2 ? `https://www.${pick(NAMES, i).toLowerCase().replace(/[^a-z]+/g, "")}.es` : null,
      phone_e164: rnd(i + 9) > 0.25 ? `+34 6${String(10000000 + Math.floor(rnd(i) * 89999999)).slice(0, 8)}` : null,
      phone: null,
      updated_at: iso(i * 37),
      created_at: iso(i * 240 + 600),
      lists: rnd(i + 4) > 0.6 ? [{ id: "list-1", name: "Prioridad Madrid", color: "gold" }] : [],
      extraction_job_id: rnd(i + 6) > 0.3 ? "camp-1" : null,
      campaign_niche: "clínica dental",
      campaign_city: "Madrid",
      ads_meta_active: meta ? true : rnd(i + 11) > 0.5 ? false : null,
      ads_google_active: google ? true : rnd(i + 13) > 0.5 ? false : null,
      ads_funnel_type: pick(funnels, i),
      ads_funnel_confidence: 0.4 + rnd(i + 8) * 0.55,
      meta_ads_estimated_spend_max: spendMax,
      meta_ads_estimated_spend_min: spendMax ? Math.round(spendMax * 0.55) : null,
      meta_ads_impressions_max: spendMax ? spendMax * 30 : 0,
      meta_ads_impressions_min: spendMax ? spendMax * 14 : 0,
      meta_ads_estimate_confidence: hasEstimate ? 0.55 + rnd(i) * 0.35 : null,
      meta_ads_estimate_currency: "EUR",
      meta_ads_estimate_cpm: hasEstimate ? 6.5 : null
    };
  }

  function makeCrmRow(i) {
    const b = makeBusiness(i);
    const called = rnd(i + 21) > 0.45;
    return {
      ...b,
      business_id: b.id,
      crm_status: pick(CRM_STATUSES, i),
      checkpoint: pick(["Llamada 1", "Llamada 2", "Email enviado", ""], i),
      objection: pick(["Sin presupuesto ahora", "Ya tiene proveedor", "Pídeme info por email", ""], i),
      first_contact_at: called ? day(-(i % 12) - 1) : null,
      decision_maker_name: rnd(i + 31) > 0.4 ? pick(["Laura Gómez", "Carlos Ruiz", "Marta Sanz", "Javier León"], i) : null,
      decision_maker_email: rnd(i + 33) > 0.5 ? `contacto${i}@empresa.es` : null,
      fallback_email: `info${i}@empresa.es`,
      answered_by: rnd(i + 35) > 0.5 ? pick(["Recepción", "Gerente", "Secretaría"], i) : null,
      follow_up_date: rnd(i + 37) > 0.6 ? day((i % 9) + 1) : null,
      follow_up_time: rnd(i + 37) > 0.6 ? "10:30" : null,
      next_action: pick(["Llamar de nuevo el lunes", "Enviar propuesta", "Confirmar cita", ""], i),
      observations: pick(["Muy interesado, pide demo", "Llamar después de las 16h", "Decisor de viaje esta semana", ""], i)
    };
  }

  const businesses = Array.from({ length: 24 }, (_, i) => makeBusiness(i));
  const crmRows = Array.from({ length: 18 }, (_, i) => makeCrmRow(i));

  const campaigns = Array.from({ length: 8 }, (_, i) => ({
    id: `camp-${i}`,
    niche: pick(NICHES, i),
    city: pick(CITIES, i),
    source_type: "google_places_api",
    requested_limit: 1000,
    candidates_count: 400 + i * 53,
    leads_count: 120 + i * 22,
    status: pick(["completed", "running", "queued", "completed"], i),
    created_at: iso(i * 600 + 2000),
    started_at: iso(i * 600 + 2400),
    finished_at: i % 3 === 0 ? iso(i * 600 + 1000) : null,
    bbox: [-3.7, 40.3, -3.6, 40.5],
    grid_step: 0.02,
    metrics: { discovered: 400 + i * 53, deduped: 120 + i * 22, enriched: 90 + i * 18 },
    voice_assistant_id: i % 2 === 0 ? "asst-1" : null,
    voice_assistant_name: i % 2 === 0 ? "Nebrija Ventas ES" : null,
    voice_assistant_variables: []
  }));

  const leadLists = Array.from({ length: 6 }, (_, i) => ({
    id: `list-${i}`,
    name: pick(["Prioridad Madrid", "Reformas Q2", "Dental Premium", "Fitness Norte", "Estética", "Cierres Junio"], i),
    description: pick(["Leads calientes para esta semana", "Campaña de reformas integrales", "Clínicas con alto ticket", "", "Captados en feria", "Pipeline de cierre"], i),
    color: pick(["gold", "green", "cyan", "burgundy", "zinc", "gold"], i),
    leads_count: 12 + i * 9,
    created_at: iso(i * 1400 + 1000)
  }));

  const calls = Array.from({ length: 14 }, (_, i) => ({
    id: `call-${i}`,
    business_id: `biz-${i}`,
    business_name: pick(NAMES, i),
    business_city: pick(CITIES, i),
    business_niche: pick(NICHES, i),
    status: pick(["completed", "completed", "failed"], i),
    outcome: pick(["qualified", "callback", "no_qualified"], i),
    qualified: i % 3 === 0,
    duration_seconds: 45 + Math.round(rnd(i) * 360),
    cost: 0.02 + rnd(i) * 0.4,
    created_at: iso(i * 90),
    started_at: iso(i * 90 + 2),
    ended_at: iso(i * 90 - 4),
    ended_reason: "customer-ended-call",
    provider: "nebrija",
    provider_call_id: `pc_${1000 + i}`,
    customer_number: "+34 600 000 000",
    summary: "El decisor mostró interés en una demo. Pidió enviar propuesta por email y agendar seguimiento la próxima semana.",
    transcript: "Agente: Hola, le llamo de...\nCliente: Sí, dígame.\nAgente: Le contactamos porque...\nCliente: Interesante, mándeme información.",
    structured_data: { interested: true, budget: "medio", next_step: "email" },
    recording_url: null
  }));

  const crmOptions = {
    statuses: CRM_STATUSES,
    checkpoints: ["Llamada 1", "Llamada 2", "Email enviado", "Cita"],
    objections: ["Sin presupuesto ahora", "Ya tiene proveedor", "Pídeme info por email", "No es el momento"]
  };

  const metrics = {
    total_leads: 4820, leads_last_24h: 132, qualified_leads: 612,
    active_campaigns: 5, total_campaigns: 23, total_calls: 1894,
    calls_last_24h: 87, total_cost: 421.65
  };

  const analytics = {
    counts: { totalCalls: 1894, scheduledCalls: 214, noAnswerCalls: 690, secretaryCalls: 320, initialObjectionCalls: 410, decisionMakerCalls: 474 },
    rates: { scheduledRate: 0.113 },
    steps: [
      { label: "Llamadas realizadas", count: 1894 },
      { label: "Contactadas", count: 1204 },
      { label: "Decisor al habla", count: 474 },
      { label: "Interesados", count: 286 },
      { label: "Citas agendadas", count: 214 }
    ],
    meta: { firstContactFrom: iso(60 * 24 * 29), firstContactTo: iso(0) }
  };

  const assistants = [
    { id: "asst-1", name: "Nebrija Ventas ES", variableNames: ["nombre", "ciudad", "nicho"] },
    { id: "asst-2", name: "Nebrija Reactivación", variableNames: ["nombre", "ultima_compra"] }
  ];

  const ROUTES = [
    [/^\/healthz$/, () => ({})],
    [/^\/auth\/google\/status$/, () => ({ configured: true, allowedDomains: [] })],
    [/^\/api\/session$/, () => ({ user: { name: "Evergrowth Leaders", email: "evergrowthleaders@gmail.com", avatarUrl: null }, tenant: { name: "Evergrowth", slug: "evergrowth" } })],
    [/^\/api\/metrics$/, () => ({ metrics })],
    [/^\/api\/businesses\/([^/?]+)$/, (m) => {
      const b = businesses.find((x) => x.id === m[1]) || makeBusiness(0);
      return {
        business: {
          ...b, address: "Calle Mayor 12, 28013", external_source: "google_places", source_url: b.website,
          instagram: "https://instagram.com/empresa", facebook: "https://facebook.com/empresa",
          has_online_booking: true, has_chatbot: false, scoring_notes: "", custom_fields: {},
          ads_last_checked_at: iso(120), scoring_breakdown: { matchedRules: [
            { id: "web", label: "Tiene web propia", points: 15 },
            { id: "phone", label: "Teléfono móvil verificado", points: 10 },
            { id: "ads", label: "Meta Ads activos", points: 20 }
          ] },
          ads_enrichment: { meta: { reason: "apify_active_ad_matched", confidence: 0.9, attempts: [] }, google: { reason: "no_strong_signal", attempts: [] }, classification: { type: b.ads_funnel_type, confidence: b.ads_funnel_confidence, signals: [], scores: {} } }
        },
        contacts: [{ kind: "email", value: "info@empresa.es", confidence: 0.8, source_url: b.website }],
        crawlerRuns: [{ root_url: b.website || "https://empresa.es", created_at: iso(200), pages_succeeded: 8, pages_failed: 1, status: "completed" }],
        calls: calls.slice(0, 2),
        lists: b.lists
      };
    }],
    [/^\/api\/businesses/, (_m, q) => ({ rows: businesses.slice(0, Number(q.get("limit")) || businesses.length) })],
    [/^\/api\/calls\/([^/?]+)$/, (m) => ({ call: calls.find((c) => c.id === m[1]) || calls[0] })],
    [/^\/api\/calls/, (_m, q) => ({ rows: calls.slice(0, Number(q.get("limit")) || calls.length) })],
    [/^\/api\/campaigns\/([^/?]+)\/crm$/, (m) => ({ job: campaigns.find((c) => c.id === m[1]) || campaigns[0], rows: crmRows, options: crmOptions })],
    [/^\/api\/campaigns\/([^/?]+)$/, (m) => ({ job: campaigns.find((c) => c.id === m[1]) || campaigns[0] })],
    [/^\/api\/campaigns/, () => ({ rows: campaigns })],
    [/^\/api\/lead-lists\/([^/?]+)\/crm$/, (m) => ({ list: leadLists.find((l) => l.id === m[1]) || leadLists[0], rows: crmRows, options: crmOptions })],
    [/^\/api\/lead-lists/, () => ({ rows: leadLists })],
    [/^\/api\/analytics\/settings$/, () => ({ settings: { appointmentRate: 11.3, qualificationRate: 70, closeRate: 30, showUpRate: 80, offerPrice: 3000, firstMonthPrice: 1000, revenueTarget: 10000 } })],
    [/^\/api\/analytics\/cold-calling/, () => ({ analytics })],
    [/^\/api\/scoring\/rules$/, () => ({ rules: [
      { id: "web", label: "Tiene web propia", description: "Suma si el negocio tiene sitio web", condition: "website != null", points: 15, enabled: true },
      { id: "phone_mobile", label: "Teléfono móvil", description: "Móvil verificado para llamar", condition: "phone is mobile", points: 10, enabled: true },
      { id: "rating", label: "Rating alto en Google", description: "4.5+ estrellas", condition: "rating >= 4.5", points: 12, enabled: true },
      { id: "reviews", label: "Volumen de reseñas", description: "Más de 50 reseñas", condition: "reviews > 50", points: 8, enabled: true },
      { id: "meta_ads", label: "Meta Ads activos", description: "Invierte en publicidad Meta", condition: "ads_meta_active", points: 20, enabled: true },
      { id: "ecommerce", label: "Funnel ecommerce", description: "Penaliza ecommerce puro", condition: "funnel == ecommerce", points: -10, enabled: false }
    ] })],
    [/^\/api\/settings\/nebrija\/assistants$/, () => ({ assistants })],
    [/^\/api\/settings\/nebrija$/, () => ({ settings: { apiBaseUrl: "https://nebrijaai.com/api/v1", defaultPhoneNumberId: "pn_123", configured: true, apiKeyLast4: "a1b2", usingEnvFallback: false } })]
  ];

  window.fetch = function (input, options = {}) {
    const url = typeof input === "string" ? input : input.url;
    const full = url.replace(/^https?:\/\/[^/]+/, "").split("#")[0];
    const [path, queryString] = full.split("?");
    const query = new URLSearchParams(queryString || "");
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET") {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, queued: 3, imported: 0, list: { id: "list-0" }, business: businesses[0], settings: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    for (const [re, handler] of ROUTES) {
      const m = path.match(re);
      if (m) {
        const body = handler(m, query);
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "not_found", rows: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  };
})();
