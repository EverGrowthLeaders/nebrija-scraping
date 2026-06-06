// ── Tiny utils ────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const view = $("#view");
const appShell = $(".app");

let currentSession = null;
let healthTimer = null;

const escape = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const cx = (...parts) => parts.filter(Boolean).join(" ");

const fmtNumber = (n) => (n == null ? "—" : new Intl.NumberFormat("es-ES").format(Number(n)));

const fmtCurrency = (n) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 4 }).format(
        Number(n) || 0
      );

const fmtDuration = (seconds) => {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const fmtRel = (iso) => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d`;
  return fmtDate(iso);
};

const STATUS_BADGES = {
  new: ["zinc", "Nuevo"],
  scraped: ["zinc", "Capturado"],
  enrichment_pending: ["zinc", "Enriqueciendo"],
  enriched: ["cyan", "Enriquecido"],
  queued_for_call: ["lila", "En cola"],
  called: ["lila", "Llamado"],
  connected: ["cyan", "Conectado"],
  qualified: ["gold", "Cualificado"],
  disqualified: ["zinc", "Descartado"],
  callback: ["cyan", "Callback"],
  failed: ["burgundy", "Fallido"],
  suppressed: ["zinc", "Suprimido"],
  queued: ["lila", "En cola"],
  running: ["cyan", "Ejecutando"],
  completed: ["green", "Completada"],
  cancelled: ["zinc", "Cancelada"]
};

const renderStatus = (status) => {
  const [tone, label] = STATUS_BADGES[status] || ["zinc", status || "—"];
  return `<span class="badge badge--${tone}">${escape(label)}</span>`;
};

const renderScore = (score) => {
  const n = Number(score) || 0;
  const cls = n >= 70 ? "score--high" : n >= 40 ? "score--mid" : "";
  return `<span class="score ${cls}">${n}</span>`;
};

const renderAdsBadge = (value, label) => {
  if (value === true) return `<span class="badge badge--green">${escape(label)} activo</span>`;
  if (value === false) return `<span class="badge badge--zinc">${escape(label)} sin señal</span>`;
  return `<span class="badge badge--zinc">${escape(label)} sin revisar</span>`;
};

const renderAdsEvidenceBadge = (value, label, evidence = {}) => {
  if (value === true) return `<span class="badge badge--green">${escape(label)} activo</span>`;
  if (value === false) return `<span class="badge badge--zinc">${escape(label)} sin señal</span>`;
  if (evidence.status === "error") return `<span class="badge badge--burgundy">${escape(label)} error</span>`;
  if (evidence.status === "unknown") return `<span class="badge badge--zinc">${escape(label)} sin señal fuerte</span>`;
  return `<span class="badge badge--zinc">${escape(label)} pendiente</span>`;
};

const renderAdsState = (business) => `
  <div class="ads-badges">
    ${renderAdsBadge(business.ads_meta_active, "Meta")}
    ${renderMetaAdsEstimateBadge(business, { compact: true })}
    ${renderAdsBadge(business.ads_google_active, "Google")}
  </div>
`;

function metaAdsEstimateFromRow(row = {}) {
  const max = Number(row.meta_ads_estimated_spend_max);
  if (!Number.isFinite(max) || max <= 0) return null;
  const min = Number(row.meta_ads_estimated_spend_min);
  const impressionsMax = Number(row.meta_ads_impressions_max);
  return {
    estimatedSpendMin: Number.isFinite(min) ? min : max,
    estimatedSpendMax: max,
    impressionsMin: Number(row.meta_ads_impressions_min) || 0,
    impressionsMax: Number.isFinite(impressionsMax) ? impressionsMax : 0,
    currency: row.meta_ads_estimate_currency || "EUR",
    confidence: Number(row.meta_ads_estimate_confidence) || null,
    source: row.meta_ads_estimate_source || "public_impressions_cpm_benchmark",
    cpm: Number(row.meta_ads_estimate_cpm) || null,
    checkedAt: row.meta_ads_estimate_checked_at || null
  };
}

function metaAdsEstimateFromEvidence(evidence = {}) {
  const estimate = evidence?.spendEstimate;
  if (!estimate) return null;
  const max = Number(estimate.estimatedSpendMax);
  if (!Number.isFinite(max) || max <= 0) return null;
  return estimate;
}

function hasMetaAdsEstimate(row = {}) {
  return Boolean(metaAdsEstimateFromRow(row));
}

function formatCurrencyRange(min, max, currency = "EUR") {
  const formatter = new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: currency || "EUR",
    maximumFractionDigits: max >= 100 ? 0 : 2
  });
  const safeMin = Number.isFinite(Number(min)) ? Number(min) : Number(max);
  const safeMax = Number.isFinite(Number(max)) ? Number(max) : safeMin;
  if (Math.round(safeMin * 100) === Math.round(safeMax * 100)) return formatter.format(safeMax);
  return `${formatter.format(safeMin)}-${formatter.format(safeMax)}`;
}

function formatImpressionRange(min, max) {
  const safeMin = Number(min) || 0;
  const safeMax = Number(max) || 0;
  if (!safeMax) return "sin impresiones públicas";
  if (safeMin === safeMax) return `${fmtNumber(safeMax)} impresiones`;
  if (safeMin <= 0) return `<${fmtNumber(safeMax + 1)} impresiones`;
  return `${fmtNumber(safeMin)}-${fmtNumber(safeMax)} impresiones`;
}

function metaAdsEstimateTitle(estimate = {}) {
  const confidence = estimate.confidence != null ? ` · conf ${Math.round(Number(estimate.confidence) * 100)}%` : "";
  const cpm = estimate.cpm ? ` · CPM ref. ${formatCurrencyRange(estimate.cpm, estimate.cpm, estimate.currency || "EUR")}` : "";
  return `Estimación por impresiones públicas de Meta Ads Library${confidence}${cpm}. ${formatImpressionRange(estimate.impressionsMin, estimate.impressionsMax)}.`;
}

function renderMetaAdsEstimateBadge(row = {}, { compact = false } = {}) {
  const estimate = metaAdsEstimateFromRow(row);
  if (!estimate) {
    return compact
      ? `<span class="meta-estimate meta-estimate--empty" title="Sin impresiones públicas suficientes en anuncios matcheados">Sin dato</span>`
      : `<span class="badge badge--zinc">Sin dato suficiente</span>`;
  }
  const label = formatCurrencyRange(estimate.estimatedSpendMin, estimate.estimatedSpendMax, estimate.currency);
  const confidence = estimate.confidence != null ? `${Math.round(Number(estimate.confidence) * 100)}%` : "est.";
  return `
    <span class="meta-estimate" title="${escape(metaAdsEstimateTitle(estimate))}">
      <strong>${escape(label)}</strong>
      ${compact ? `<small>${escape(confidence)}</small>` : `<small>conf ${escape(confidence)}</small>`}
    </span>
  `;
}

const ADS_FUNNEL_LABELS = {
  lead_generation: ["cyan", "Captación"],
  ecommerce: ["gold", "Ecommerce"],
  other: ["zinc", "Otro"],
  unknown: ["zinc", "Sin clasificar"]
};

const renderAdsFunnelBadge = (type, confidence) => {
  const [tone, label] = ADS_FUNNEL_LABELS[type] || ADS_FUNNEL_LABELS.unknown;
  const suffix = confidence != null ? ` · ${Math.round(Number(confidence) * 100)}%` : "";
  return `<span class="badge badge--${tone}">${escape(label)}${escape(suffix)}</span>`;
};

const CRM_PAGE_SIZE = 120;
const CRM_COLUMN_ORDER_KEY = "nebrija.crm.columnOrder.v4";
const CRM_DEFAULT_COLUMNS = [
  "decision_maker_name",
  "first_contact_at",
  "business",
  "crm_status",
  "checkpoint",
  "answered_by",
  "category",
  "ads_meta_active",
  "meta_ads_estimate",
  "ads_google_active",
  "ads_funnel_type",
  "phone",
  "decision_maker_email",
  "website",
  "objection",
  "follow_up_date",
  "follow_up_time",
  "next_action",
  "observations",
  "city",
  "niche"
];

const renderListBadges = (lists = []) =>
  lists?.length
    ? `<div class="list-badges">${lists
        .map((list) => `<span class="badge badge--${escape(list.color || "zinc")}">${escape(list.name)}</span>`)
        .join("")}</div>`
    : `<span class="faint">Sin lista</span>`;

// ── HTTP ──────────────────────────────────────────────────
async function api(path, options = {}) {
  const { skipAuthRedirect = false, ...fetchOptions } = options;
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(fetchOptions.headers || {}) },
    ...fetchOptions
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    const err = new Error(message);
    err.status = res.status;
    if (res.status === 401 && !skipAuthRedirect) showLogin();
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Auth shell ────────────────────────────────────────────
async function bootstrap() {
  appShell.hidden = true;
  showAuthLoading();
  await pingHealth();
  try {
    const session = await api("/api/session", { skipAuthRedirect: true });
    setSession(session);
    showAppShell();
    if (!location.hash) location.hash = "#/";
    await router();
  } catch (err) {
    if (err.status === 401) {
      const params = new URLSearchParams(location.search);
      const reason = params.get("reason");
      const message = params.get("auth") === "failed"
        ? `No se pudo completar el acceso con Google${reason ? ` (${reason})` : ""}.`
        : "";
      await showLogin(message);
    } else {
      await showLogin("No se pudo comprobar la sesión.");
    }
  }
  healthTimer = setInterval(pingHealth, 30_000);
}

function setSession(session) {
  currentSession = session;
  renderSessionChip();
}

function showAppShell() {
  $("#login-shell")?.remove();
  appShell.hidden = false;
  renderSessionChip();
}

function showAuthLoading() {
  renderLoginShell(`
    <div class="login-card__status">
      <span class="spinner"></span>
      <span>Comprobando sesión...</span>
    </div>
  `);
}

async function showLogin(message = "") {
  appShell.hidden = true;
  closeModal();
  let status = { configured: true, allowedDomains: [] };
  try {
    status = await api("/auth/google/status", { skipAuthRedirect: true });
  } catch {
    status = { configured: false, allowedDomains: [] };
  }
  const domainCopy = "Acceso por cuenta Google verificada.";
  renderLoginShell(`
    <div class="login-card__mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="24" height="24">
        <path fill="currentColor" d="M16 2.5 4.5 8.7v9.7c0 6.6 4.7 10.7 11.5 13.1 6.8-2.4 11.5-6.5 11.5-13.1V8.7L16 2.5Zm0 4.4 7.5 4v7.5c0 4.5-3.1 7.5-7.5 9.4-4.4-1.9-7.5-4.9-7.5-9.4V10.9l7.5-4Z"/>
      </svg>
    </div>
    <h1>Acceso seguro</h1>
    <p>${escape(domainCopy)}</p>
    ${message ? `<div class="login-card__error">${escape(message)}</div>` : ""}
    ${
      status.configured
        ? `<a class="btn btn--google" href="/auth/google/start" data-action="google-login">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path fill="#4285F4" d="M21.6 12.23c0-.78-.07-1.53-.2-2.23H12v4.22h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.89-1.74 2.99-4.3 2.99-7.51Z"/>
              <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.44l-3.23-2.5c-.9.6-2.04.95-3.38.95-2.6 0-4.8-1.76-5.59-4.12H3.08v2.59A10 10 0 0 0 12 22Z"/>
              <path fill="#FBBC05" d="M6.41 13.89A6 6 0 0 1 6.1 12c0-.65.11-1.29.31-1.89V7.52H3.08A10 10 0 0 0 2 12c0 1.61.39 3.14 1.08 4.48l3.33-2.59Z"/>
              <path fill="#EA4335" d="M12 5.99c1.47 0 2.79.5 3.83 1.5l2.85-2.85C16.95 3.03 14.69 2 12 2a10 10 0 0 0-8.92 5.52l3.33 2.59C7.2 7.75 9.4 5.99 12 5.99Z"/>
            </svg>
            Entrar con Google
          </a>`
        : `<button class="btn btn--google" type="button" disabled>Google OAuth no configurado</button>`
    }
  `);
}

function renderLoginShell(inner) {
  let shell = $("#login-shell");
  if (!shell) {
    shell = document.createElement("section");
    shell.id = "login-shell";
    shell.className = "login-shell";
    document.body.appendChild(shell);
  }
  shell.innerHTML = `<div class="login-card">${inner}</div>`;
}

async function logout() {
  try {
    await api("/auth/logout", { method: "POST", body: "{}", skipAuthRedirect: true });
  } finally {
    currentSession = null;
    await showLogin();
  }
}

function renderSessionChip() {
  const host = $("[data-bind='session-chip']");
  if (!host || !currentSession) return;
  const user = currentSession.user || {};
  const tenant = currentSession.tenant || {};
  host.hidden = false;
  host.innerHTML = `
    <div class="session-chip">
      ${
        user.avatarUrl
          ? `<img src="${escape(user.avatarUrl)}" alt="" />`
          : `<span class="session-chip__avatar">${escape((user.name || user.email || "?").slice(0, 1).toUpperCase())}</span>`
      }
      <span class="session-chip__text">
        <strong>${escape(user.name || user.email || "Usuario")}</strong>
        <span>${escape(tenant.name || tenant.slug || "Workspace")}</span>
      </span>
      <button class="btn btn--icon btn--ghost" data-action="logout" type="button" title="Salir" aria-label="Salir">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path fill="currentColor" d="M10 17v-2h4v-2h-4v-2l-4 3 4 3ZM4 3h9a2 2 0 0 1 2 2v3h-2V5H4v14h9v-3h2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm13.6 5.4L22.2 13l-4.6 4.6-1.4-1.4 2.2-2.2H12v-2h6.4l-2.2-2.2 1.4-1.4Z"/>
        </svg>
      </button>
    </div>
  `;
}

// ── Toast ─────────────────────────────────────────────────
function toast(message, tone = "info") {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = cx("toast", tone === "error" && "toast--error", tone === "ok" && "toast--ok");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .25s ease";
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

// ── Modal ─────────────────────────────────────────────────
function openModal({ title, body, footer }) {
  const modal = $("#modal");
  const panel = $(".modal__panel", modal);
  panel.innerHTML = `
    <div class="modal__header">
      <h3 class="modal__title" id="modal-title">${escape(title)}</h3>
      <button class="modal__close" type="button" aria-label="Cerrar" data-action="close-modal">×</button>
    </div>
    <div class="modal__body"></div>
    ${footer ? '<div class="modal__footer"></div>' : ""}
  `;
  $(".modal__body", panel).append(body);
  if (footer) $(".modal__footer", panel).append(footer);
  modal.hidden = false;
  setTimeout(() => panel.querySelector("input,select,textarea,button")?.focus(), 30);
}
function closeModal() {
  $("#modal").hidden = true;
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-action='close-modal']")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ── Health ping ───────────────────────────────────────────
async function pingHealth() {
  const dot = $(".status__dot");
  const label = $("[data-bind='health-label']");
  try {
    await api("/healthz");
    dot.dataset.health = "ok";
    label.textContent = "API operativa";
  } catch {
    dot.dataset.health = "error";
    label.textContent = "API no disponible";
  }
}

// ── Router ────────────────────────────────────────────────
const routes = [
  { match: /^\/?$/, render: renderOverview, key: "overview", title: "Overview" },
  { match: /^\/campaigns$/, render: renderCampaignsList, key: "campaigns", title: "Campañas" },
  { match: /^\/campaigns\/([^/]+)$/, render: renderCampaignDetail, key: "campaigns", title: "Campaña" },
  { match: /^\/leads$/, render: renderLeadsList, key: "leads", title: "Leads" },
  { match: /^\/leads\/([^/]+)$/, render: renderLeadDetail, key: "leads", title: "Lead" },
  { match: /^\/lists$/, render: renderLists, key: "lists", title: "Listas" },
  { match: /^\/lists\/([^/]+)$/, render: renderListDetail, key: "lists", title: "Lista" },
  { match: /^\/analytics$/, render: renderAnalytics, key: "analytics", title: "Analítica" },
  { match: /^\/scoring$/, render: renderScoring, key: "scoring", title: "Scoring" },
  { match: /^\/calls$/, render: renderCallsList, key: "calls", title: "Llamadas" },
  { match: /^\/calls\/([^/]+)$/, render: renderCallDetail, key: "calls", title: "Llamada" },
  { match: /^\/settings$/, render: renderSettings, key: "settings", title: "Settings" }
];

let currentRoute = null;

function parseHash() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const [pathname, queryString] = raw.split("?");
  const search = new URLSearchParams(queryString || "");
  return { pathname: pathname || "/", search };
}

async function router() {
  const { pathname, search } = parseHash();
  for (const r of routes) {
    const match = pathname.match(r.match);
    if (match) {
      currentRoute = r;
      setActiveNav(r.key);
      setCrumbs(r);
      view.innerHTML = `<div class="row" style="padding: 60px 0; justify-content:center"><span class="spinner"></span></div>`;
      try {
        await r.render({ params: match.slice(1), search });
      } catch (err) {
        console.error(err);
        if (err.status === 401) {
          await showLogin();
          return;
        }
        view.innerHTML = `<div class="empty"><h4>Error al cargar</h4><p>${escape(err.message)}</p></div>`;
      }
      window.scrollTo({ top: 0 });
      return;
    }
  }
  view.innerHTML = `<div class="empty"><h4>404</h4><p>Ruta no encontrada</p></div>`;
}

function setActiveNav(key) {
  $$(".nav__item").forEach((el) =>
    el.classList.toggle("is-active", el.dataset.route === key)
  );
}
function setCrumbs(route) {
  $("[data-bind='crumb-section']").textContent = route.title;
  $("[data-bind='crumb-current']").textContent = "";
}
function setCurrentCrumb(text) {
  $("[data-bind='crumb-current']").textContent = text;
}

window.addEventListener("hashchange", router);

// ── Top bar actions ───────────────────────────────────────
$(".topbar").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "refresh") router();
  if (btn.dataset.action === "new-campaign") openCampaignModal();
  if (btn.dataset.action === "logout") await logout();
});

// ── Overview ──────────────────────────────────────────────
async function renderOverview() {
  view.innerHTML = `
    <h1 class="headline">Command Center</h1>
    <p class="subhead">Captura, cualifica y llama. <span class="muted">Hecha para España.</span></p>

    <div class="kpi-grid" data-bind="kpis">
      ${kpiSkeleton(4)}
    </div>

    <div class="grid-2" style="margin-top:20px">
      <div class="card">
        <h3>Últimos leads</h3>
        <div data-bind="recent-leads">${rowSkeleton(5)}</div>
      </div>
      <div class="card">
        <h3>Últimas llamadas</h3>
        <div data-bind="recent-calls">${rowSkeleton(5)}</div>
      </div>
    </div>
  `;

  const [{ metrics }, leads, calls] = await Promise.all([
    api("/api/metrics"),
    api("/api/businesses?limit=6"),
    api("/api/calls?limit=6")
  ]);

  $("[data-bind='kpis']").innerHTML = `
    ${kpiCard("Leads totales", fmtNumber(metrics.total_leads), `+${fmtNumber(metrics.leads_last_24h)} en 24h`, "accent")}
    ${kpiCard("Cualificados", fmtNumber(metrics.qualified_leads), `${pct(metrics.qualified_leads, metrics.total_leads)}% del total`, "accent")}
    ${kpiCard("Campañas activas", fmtNumber(metrics.active_campaigns), `${fmtNumber(metrics.total_campaigns)} totales`)}
    ${kpiCard("Llamadas", fmtNumber(metrics.total_calls), `${fmtNumber(metrics.calls_last_24h)} hoy · ${fmtCurrency(metrics.total_cost)}`, "burgundy")}
  `;

  $("[data-bind='recent-leads']").innerHTML = leads.rows.length
    ? `<div class="list">${leads.rows
        .map(
          (b) => `
        <a class="list__item" href="#/leads/${escape(b.id)}">
          <div class="list__main">
            <div class="list__title">${escape(b.name)}</div>
            <div class="list__meta">${escape(b.city || "—")} · ${escape(b.niche || "—")}</div>
          </div>
          ${renderScore(b.score)}
          ${renderStatus(b.status)}
        </a>`
        )
        .join("")}</div>`
    : emptyState("Sin leads aún", "Crea una campaña para empezar a capturar negocios.");

  $("[data-bind='recent-calls']").innerHTML = calls.rows.length
    ? `<div class="list">${calls.rows
        .map(
          (c) => `
        <a class="list__item" href="#/calls/${escape(c.id)}">
          <div class="list__main">
            <div class="list__title">${escape(c.business_name || "Llamada sin lead")}</div>
            <div class="list__meta">${escape(c.business_city || "—")} · ${fmtDuration(c.duration_seconds)} · ${fmtRel(c.created_at)}</div>
          </div>
          ${callBadge(c)}
        </a>`
        )
        .join("")}</div>`
    : emptyState("Aún no hay llamadas", "Lanza una llamada desde el detalle de un lead.");
}

function kpiSkeleton(n) {
  return Array.from({ length: n })
    .map(
      () => `
    <div class="kpi"><div class="kpi__label"><span class="skeleton" style="width:80px"></span></div>
    <div class="kpi__value"><span class="skeleton" style="width:60px;height:24px"></span></div>
    <div class="kpi__hint"><span class="skeleton" style="width:120px"></span></div></div>`
    )
    .join("");
}
function rowSkeleton(n) {
  return `<div class="list">${Array.from({ length: n })
    .map(
      () =>
        `<div class="list__item"><div class="list__main"><div class="list__title"><span class="skeleton" style="width:160px"></span></div><div class="list__meta"><span class="skeleton" style="width:100px"></span></div></div></div>`
    )
    .join("")}</div>`;
}
function kpiCard(label, value, hint, variant) {
  return `
    <div class="kpi ${variant ? "kpi--" + variant : ""}">
      <div class="kpi__label">${escape(label)}</div>
      <div class="kpi__value">${value}</div>
      <div class="kpi__hint">${hint || ""}</div>
    </div>
  `;
}
function pct(part, total) {
  if (!total) return 0;
  return Math.round((Number(part) / Number(total)) * 100);
}
function emptyState(title, body, action) {
  return `<div class="empty"><h4>${escape(title)}</h4><p>${escape(body)}</p>${action || ""}</div>`;
}

function fmtPercentRatio(value, digits = 0) {
  return `${((Number(value) || 0) * 100).toLocaleString("es-ES", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  })}%`;
}
function callBadge(c) {
  if (c.qualified) return `<span class="badge badge--gold">Cualificado</span>`;
  if (c.outcome === "callback") return `<span class="badge badge--cyan">Callback</span>`;
  if (c.outcome === "no_qualified" || c.qualified === false) return `<span class="badge badge--zinc">No cualificado</span>`;
  if (c.status) return renderStatus(c.status);
  return `<span class="badge badge--zinc">—</span>`;
}

// ── Campaigns list ────────────────────────────────────────
async function renderCampaignsList() {
  setCurrentCrumb("Lista");
  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Campañas</h1>
        <p class="subhead">Trabajos de descubrimiento por nicho y ciudad.</p>
      </div>
      <button class="btn btn--primary" data-action="new-campaign" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>
        Nueva campaña
      </button>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Nicho</th>
            <th>Ciudad</th>
            <th>Origen</th>
            <th class="col-num">Solicitados</th>
            <th class="col-num">Candidatos</th>
            <th class="col-num">Leads</th>
            <th>Estado</th>
            <th>Creada</th>
          </tr>
        </thead>
        <tbody data-bind="rows"><tr><td colspan="8" style="padding:40px;text-align:center"><span class="spinner"></span></td></tr></tbody>
      </table>
    </div>
  `;

  $$(".btn[data-action='new-campaign']", view).forEach((el) =>
    el.addEventListener("click", openCampaignModal)
  );

  const data = await api("/api/campaigns?limit=100");
  const tbody = $("[data-bind='rows']");
  if (!data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="8">${emptyState(
      "Sin campañas todavía",
      "Crea tu primera campaña para descubrir leads.",
      `<button class="btn btn--primary" data-action="new-campaign">Nueva campaña</button>`
    )}</td></tr>`;
    $$(".btn[data-action='new-campaign']", tbody).forEach((el) =>
      el.addEventListener("click", openCampaignModal)
    );
    return;
  }
  tbody.innerHTML = data.rows
    .map(
      (j) => `
      <tr data-href="#/campaigns/${escape(j.id)}">
        <td class="cell-primary">${escape(j.niche)}</td>
        <td>${escape(j.city)}</td>
        <td><span class="mono faint">${escape(j.source_type)}</span></td>
        <td class="col-num">${fmtNumber(j.requested_limit)}</td>
        <td class="col-num">${fmtNumber(j.candidates_count)}</td>
        <td class="col-num">${fmtNumber(j.leads_count)}</td>
        <td>${renderStatus(j.status)}</td>
        <td>${fmtRel(j.created_at)}</td>
      </tr>`
    )
    .join("");
  bindRowNav(tbody);
}

// ── Campaign detail ───────────────────────────────────────
async function renderCampaignDetail({ params }) {
  const id = params[0];
  setCurrentCrumb(id.slice(0, 8));
  const { job, rows = [], options = {} } = await api(`/api/campaigns/${id}/crm`);
  const calledRows = rows.filter((row) => row.first_contact_at).length;
  view.innerHTML = `
    <a class="back-link" href="#/campaigns">← Volver a campañas</a>
    <div class="row">
      <div class="grow">
        <h1 class="headline">${escape(job.niche)} <span class="muted" style="font-weight:500">en ${escape(job.city)}</span></h1>
        <p class="subhead mono">${escape(job.id)}</p>
      </div>
      <div class="row" style="gap:6px">
        <button class="btn" data-action="campaign-ads" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2 3 6.5v6.7c0 4.7 3.8 7.5 9 8.8 5.2-1.3 9-4.1 9-8.8V6.5L12 2Zm0 2.2 7 3.5v5.5c0 3.5-2.7 5.6-7 6.8-4.3-1.2-7-3.3-7-6.8V7.7l7-3.5Zm-1 5.3h2v3h3v2h-3v3h-2v-3H8v-2h3v-3Z"/></svg>
          Enriquecer Ads
        </button>
        <a class="btn" href="/api/campaigns/${escape(job.id)}/export.xlsx">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 3h9l5 5v13H5V3Zm8 1.8V9h4.2L13 4.8ZM8 12v6h8v-1.5h-6.5v-1h5.6V14H9.5v-1H16v-1.5H8V12Z"/></svg>
          Excel
        </a>
        <a class="btn" href="/api/campaigns/${escape(job.id)}/export.csv">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 4h16v16H4V4Zm2 2v12h12V6H6Zm1 2h10v2H7V8Zm0 3h10v2H7v-2Zm0 3h6v2H7v-2Z"/></svg>
          CSV
        </a>
        ${renderStatus(job.status)}
      </div>
    </div>

    <div class="kpi-grid" style="margin-top:8px">
      ${kpiCard("Candidatos", fmtNumber(job.candidates_count), "Lugares descubiertos")}
      ${kpiCard("Leads creados", fmtNumber(job.leads_count), "Negocios en pipeline", "accent")}
      ${kpiCard("Llamados", fmtNumber(calledRows), "Con primer contacto registrado")}
      ${kpiCard("Solicitados", fmtNumber(job.requested_limit) || "—", "Límite de la campaña")}
    </div>

    <div class="crm-board crm-board--campaign" data-campaign-id="${escape(job.id)}" style="margin-top:18px">
      <datalist id="crm-objection-options">
        ${(options.objections || []).map((option) => `<option value="${escape(option)}"></option>`).join("")}
      </datalist>

      ${renderCrmFilterBar(rows)}

      <div class="crm-section-head">
        <div>
          <h2>Leads de campaña</h2>
          <p data-bind="crm-active-count">${fmtNumber(rows.length)} leads</p>
        </div>
      </div>
      <div data-bind="crm-active-table"></div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card__head">
        <h3>Asistente NebrijaAI</h3>
        ${job.voice_assistant_id ? `<span class="badge badge--green">Asignado</span>` : `<span class="badge badge--zinc">Sin asignar</span>`}
      </div>
      <form class="settings-card" id="campaign-voice-settings">
        <div class="field">
          <label>Asistente para llamadas</label>
          <select class="select" name="voiceAssistantId" data-bind="campaign-assistant">
            <option value="">Cargando asistentes...</option>
          </select>
          <div class="form-hint" data-bind="campaign-assistant-hint">
            ${job.voice_assistant_name ? `Actual: ${escape(job.voice_assistant_name)}` : "Selecciona el asistente que usará esta campaña al lanzar llamadas."}
          </div>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn btn--primary" type="submit">Guardar asistente</button>
        </div>
      </form>
    </div>

    <div class="card" style="margin-top:18px">
      <h3>Detalle</h3>
      <dl class="kv">
        <dt>Nicho</dt><dd>${escape(job.niche)}</dd>
        <dt>Ciudad</dt><dd>${escape(job.city)}</dd>
        <dt>Origen</dt><dd class="mono">${escape(job.source_type)}</dd>
        <dt>Bbox</dt><dd class="mono">${escape(JSON.stringify(job.bbox || null))}</dd>
        <dt>Grid step</dt><dd>${job.grid_step ?? "—"}</dd>
        <dt>Iniciada</dt><dd>${fmtDate(job.started_at)}</dd>
        <dt>Finalizada</dt><dd>${fmtDate(job.finished_at)}</dd>
        <dt>Creada</dt><dd>${fmtDate(job.created_at)}</dd>
        ${job.error ? `<dt>Error</dt><dd class="mono" style="color:#ff7a8a">${escape(job.error)}</dd>` : ""}
      </dl>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Métricas</h3>
      <pre class="transcript">${escape(JSON.stringify(job.metrics || {}, null, 2))}</pre>
    </div>

    <div style="margin-top:16px">
      <a class="btn" href="#/leads?campaignId=${encodeURIComponent(job.id)}">
        Ver leads de esta campaña →
      </a>
    </div>
  `;

  const voiceForm = $("#campaign-voice-settings", view);
  await hydrateCampaignAssistants(voiceForm, {
    selectedAssistantId: job.voice_assistant_id,
    selectedAssistantName: job.voice_assistant_name,
    selectedAssistantVariables: job.voice_assistant_variables || []
  });
  voiceForm.addEventListener("submit", (event) => saveCampaignVoiceSettings(event, job.id));
  $("[data-action='campaign-ads']", view).addEventListener("click", () => campaignAdsAction(job.id));
  hydrateCrmBoard(view, {
    rows,
    options,
    editable: false,
    showDiscarded: false,
    title: "Leads",
    emptyCopy: "Esta campaña todavía no tiene leads."
  });
}

// ── Leads list ────────────────────────────────────────────
async function renderLeadsList({ search }) {
  setCurrentCrumb("Lista");
  rememberLeadListRoute();
  const status = search.get("status") || "";
  const niche = search.get("niche") || "";
  const city = search.get("city") || "";
  const campaignId = search.get("campaignId") || "";
  const listId = search.get("listId") || "";
  const phoneType = search.get("phoneType") || "";
  const adsActive = search.get("adsActive") || "";
  const adsFunnelType = search.get("adsFunnelType") || "";
  const hasMetaAdsEstimate = search.get("hasMetaAdsEstimate") || "";
  const metaAdsEstimateMin = search.get("metaAdsEstimateMin") || "";
  const term = search.get("search") || "";
  const [leadLists, campaigns, selectedCampaignResult] = await Promise.all([
    api("/api/lead-lists"),
    api("/api/campaigns?limit=200"),
    campaignId ? api(`/api/campaigns/${encodeURIComponent(campaignId)}`).catch(() => null) : null
  ]);
  const campaignRows = [...(campaigns.rows || [])];
  if (selectedCampaignResult?.job && !campaignRows.some((job) => job.id === selectedCampaignResult.job.id)) {
    campaignRows.unshift(selectedCampaignResult.job);
  }
  const selectedCampaign = campaignRows.find((job) => job.id === campaignId);

  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Leads</h1>
        <p class="subhead">Negocios capturados, enriquecidos y cualificados.${selectedCampaign ? ` · Campaña: ${escape(formatCampaignLabel(selectedCampaign))}` : ""}</p>
      </div>
      <button class="btn btn--primary" data-action="new-lead" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>
        Importar lead
      </button>
      <button class="btn" data-action="import-leads" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 3h9l5 5v13H5V3Zm8 1.8V9h4.2L13 4.8ZM8 12h8v2H8v-2Zm0 3h8v2H8v-2Z"/></svg>
        Importar lista
      </button>
    </div>

    <form class="table-wrap" id="leads-filters" style="margin-bottom:14px">
      <div class="table-toolbar">
        <div class="search">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.32 12.9l4.39 4.39-1.42 1.42-4.39-4.39A8 8 0 1 1 10 2Zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"/></svg>
          <input class="input" name="search" placeholder="Buscar nombre, web, dirección…" value="${escape(term)}" />
        </div>
        <select class="select" name="status" style="max-width:180px">
          <option value="">Todos los estados</option>
          ${["new","scraped","enriched","queued_for_call","called","qualified","disqualified","callback","failed"]
            .map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${(STATUS_BADGES[s] || [, s])[1]}</option>`)
            .join("")}
        </select>
        <input class="input" name="niche" placeholder="Nicho" value="${escape(niche)}" style="max-width:160px" />
        <input class="input" name="city" placeholder="Ciudad" value="${escape(city)}" style="max-width:140px" />
        <label class="lead-filter">
          <span>Campaña</span>
          <select class="select" name="campaignId">
            <option value="">Todas las campañas</option>
            ${campaignRows.map((j) => renderCampaignOption(j, campaignId)).join("")}
          </select>
        </label>
        <select class="select" name="listId" style="max-width:200px">
          <option value="">Todas las listas</option>
          ${(leadLists.rows || [])
            .map((list) => `<option value="${escape(list.id)}" ${list.id === listId ? "selected" : ""}>${escape(list.name)}</option>`)
            .join("")}
        </select>
        <select class="select" name="phoneType" style="max-width:170px">
          <option value="">Cualquier teléfono</option>
          ${renderPhoneTypeOptions(phoneType)}
        </select>
        <select class="select" name="adsActive" style="max-width:180px">
          <option value="">Cualquier Ads</option>
          <option value="any" ${adsActive === "any" ? "selected" : ""}>Ads activos</option>
          <option value="meta" ${adsActive === "meta" ? "selected" : ""}>Meta activo</option>
          <option value="google" ${adsActive === "google" ? "selected" : ""}>Google activo</option>
          <option value="both" ${adsActive === "both" ? "selected" : ""}>Meta + Google</option>
        </select>
        <select class="select" name="hasMetaAdsEstimate" style="max-width:170px">
          <option value="">Estim. Meta</option>
          <option value="true" ${hasMetaAdsEstimate === "true" ? "selected" : ""}>Con estimación</option>
          <option value="false" ${hasMetaAdsEstimate === "false" ? "selected" : ""}>Sin dato suficiente</option>
        </select>
        <input class="input" name="metaAdsEstimateMin" type="number" min="0" step="1" placeholder="Est. min €" value="${escape(metaAdsEstimateMin)}" style="max-width:120px" />
        <select class="select" name="adsFunnelType" style="max-width:200px">
          <option value="">Cualquier funnel</option>
          <option value="lead_generation" ${adsFunnelType === "lead_generation" ? "selected" : ""}>Captación</option>
          <option value="ecommerce" ${adsFunnelType === "ecommerce" ? "selected" : ""}>Ecommerce</option>
          <option value="not_ecommerce" ${adsFunnelType === "not_ecommerce" ? "selected" : ""}>No Ecommerce</option>
          <option value="other" ${adsFunnelType === "other" ? "selected" : ""}>Otro</option>
          <option value="unknown" ${adsFunnelType === "unknown" ? "selected" : ""}>Sin clasificar</option>
        </select>
        <button class="btn" type="submit">Filtrar</button>
        <a class="btn btn--ghost" href="#/leads">Reset</a>
      </div>
    </form>

    <div class="bulk-actions" data-bind="lead-bulk-actions" hidden>
      <div class="bulk-actions__copy">
        <strong data-bind="lead-selected-count">0</strong>
        <span>leads seleccionados</span>
      </div>
      <div class="bulk-actions__controls">
        <button class="btn btn--ghost btn--sm" data-action="clear-lead-selection" type="button">Limpiar</button>
        <button class="btn btn--gold btn--sm" data-action="enrich-selected-ads" type="button">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 4h16v3H4V4Zm0 5h10v3H4V9Zm0 5h16v3H4v-3Zm0 5h10v2H4v-2Zm13.5-9 1.6 3.2 3.4.5-2.5 2.4.6 3.4-3.1-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5L17.5 10Z"/></svg>
          Enriquecer Ads/Funnel
        </button>
        <button class="btn btn--danger btn--sm" data-action="delete-selected-leads" type="button">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 12H7.7L7 9Zm2.1 2 .4 8h1.7l-.3-8H9.1Zm3 0v8h1.8v-8h-1.8Zm3 0-.3 8h1.7l.4-8h-1.8Z"/></svg>
          Eliminar
        </button>
      </div>
    </div>

    <div class="table-wrap table-wrap--scroll">
      <table class="table leads-table">
        <colgroup>
          <col style="width:44px" />
          <col style="width:250px" />
          <col style="width:190px" />
          <col style="width:220px" />
          <col style="width:260px" />
          <col style="width:150px" />
          <col style="width:94px" />
          <col style="width:170px" />
          <col style="width:210px" />
          <col style="width:170px" />
          <col style="width:145px" />
          <col style="width:125px" />
          <col style="width:96px" />
        </colgroup>
        <thead>
          <tr>
            <th class="col-select">
              <input class="row-check" data-action="toggle-all-leads" type="checkbox" aria-label="Seleccionar todos los leads visibles" />
            </th>
            <th>Lead</th>
            <th>Ciudad / Nicho</th>
            <th>Campaña</th>
            <th>Web</th>
            <th>Teléfono</th>
            <th class="col-num">Score</th>
            <th>Listas</th>
            <th>Ads</th>
            <th>Funnel Ads</th>
            <th>Estado</th>
            <th>Actualizado</th>
            <th class="col-actions">Acciones</th>
          </tr>
        </thead>
        <tbody data-bind="rows"><tr><td colspan="13" style="padding:40px;text-align:center"><span class="spinner"></span></td></tr></tbody>
      </table>
    </div>
  `;

  $("#leads-filters").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (v) params.set(k, v);
    location.hash = `#/leads${params.toString() ? "?" + params.toString() : ""}`;
  });
  $("[data-action='new-lead']", view).addEventListener("click", openLeadModal);
  $("[data-action='import-leads']", view).addEventListener("click", openLeadImportModal);

  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (niche) params.set("niche", niche);
  if (city) params.set("city", city);
  if (campaignId) params.set("campaignId", campaignId);
  if (listId) params.set("listId", listId);
  if (phoneType) params.set("phoneType", phoneType);
  if (adsActive) params.set("adsActive", adsActive);
  if (adsFunnelType) params.set("adsFunnelType", adsFunnelType);
  if (hasMetaAdsEstimate) params.set("hasMetaAdsEstimate", hasMetaAdsEstimate);
  if (metaAdsEstimateMin) params.set("metaAdsEstimateMin", metaAdsEstimateMin);
  if (term) params.set("search", term);
  params.set("limit", "100");

  const data = await api(`/api/businesses?${params.toString()}`);
  const tbody = $("[data-bind='rows']");
  if (!data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="13">${emptyState(
      "Sin resultados",
      "Ajusta los filtros o lanza una campaña."
    )}</td></tr>`;
    return;
  }
  tbody.innerHTML = data.rows
    .map(
      (b) => `
      <tr data-href="#/leads/${escape(b.id)}">
        <td class="col-select">
          <input class="row-check" data-action="toggle-lead" data-lead-id="${escape(b.id)}" type="checkbox" aria-label="Seleccionar ${escape(b.name)}" />
        </td>
        <td class="cell-primary">${escape(b.name)}</td>
        <td>${escape(b.city || "—")} <span class="muted">·</span> ${escape(b.niche || "—")}</td>
        <td>${renderLeadCampaignCell(b)}</td>
        <td>${b.website ? `<span class="mono ellipsis" style="display:inline-block;max-width:220px">${escape(stripScheme(b.website))}</span>` : "<span class='faint'>—</span>"}</td>
        <td>${renderLeadPhoneCell(b)}</td>
        <td class="col-num">${renderScore(b.score)}</td>
        <td>${renderListBadges(b.lists || [])}</td>
        <td>${renderAdsState(b)}</td>
        <td>${renderAdsFunnelBadge(b.ads_funnel_type || "unknown", b.ads_funnel_confidence)}</td>
        <td>${renderStatus(b.status)}</td>
        <td>${fmtRel(b.updated_at)}</td>
        <td class="col-actions">
          <button class="btn btn--icon btn--ghost btn--danger-soft" data-action="delete-lead" data-lead-id="${escape(b.id)}" data-lead-name="${escape(b.name)}" type="button" title="Eliminar lead" aria-label="Eliminar lead">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 12H7.7L7 9Zm2.1 2 .4 8h1.7l-.3-8H9.1Zm3 0v8h1.8v-8h-1.8Zm3 0-.3 8h1.7l.4-8h-1.8Z"/></svg>
          </button>
        </td>
      </tr>`
    )
    .join("");
  bindRowNav(tbody);
  bindLeadSelection(data.rows || []);
  $$("[data-action='delete-lead']", tbody).forEach((button) =>
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      confirmDeleteLead({ id: button.dataset.leadId, name: button.dataset.leadName }, { afterDelete: router });
    })
  );
}

function renderCampaignOption(job, selectedId = "") {
  const count = job.leads_count != null ? ` · ${fmtNumber(job.leads_count)} leads` : "";
  return `<option value="${escape(job.id)}" ${job.id === selectedId ? "selected" : ""}>${escape(formatCampaignLabel(job))}${escape(count)}</option>`;
}

function renderPhoneTypeOptions(selected = "") {
  return [
    ["mobile", "Solo móviles"],
    ["fixed", "Solo fijos"],
    ["with_phone", "Con teléfono"],
    ["without_phone", "Sin teléfono"],
    ["unknown", "Otro formato"]
  ]
    .map(([value, label]) => `<option value="${escape(value)}" ${value === selected ? "selected" : ""}>${escape(label)}</option>`)
    .join("");
}

function renderBooleanFilterOptions(selected = "") {
  return [
    ["true", "Activo"],
    ["false", "Sin señal"],
    ["unknown", "Sin revisar"]
  ]
    .map(([value, label]) => `<option value="${escape(value)}" ${value === selected ? "selected" : ""}>${escape(label)}</option>`)
    .join("");
}

function renderAdsFunnelFilterOptions(selected = "") {
  return [
    ["lead_generation", "Captación"],
    ["ecommerce", "Ecommerce"],
    ["not_ecommerce", "No Ecommerce"],
    ["other", "Otro"],
    ["unknown", "Sin clasificar"]
  ]
    .map(([value, label]) => `<option value="${escape(value)}" ${value === selected ? "selected" : ""}>${escape(label)}</option>`)
    .join("");
}

function formatCampaignLabel(job = {}) {
  const main = [job.niche, job.city].filter(Boolean).join(" · ");
  return main || job.name || `Campaña ${String(job.id || "").slice(0, 8)}`;
}

function renderLeadPhoneCell(row = {}) {
  const phone = row.phone_e164 || row.phone;
  const type = crmPhoneType(row);
  return phone
    ? `<div class="crm-phone-cell"><span class="mono crm-phone">${escape(phone)}</span>${type !== "none" ? `<span class="crm-phone-type crm-phone-type--${escape(type)}">${escape(crmPhoneLabel(type))}</span>` : ""}</div>`
    : `<span class="faint">—</span>`;
}

function renderLeadCampaignCell(business = {}) {
  if (!business.extraction_job_id) return `<span class="faint">Sin campaña</span>`;
  const label = formatCampaignLabel({ niche: business.campaign_niche, city: business.campaign_city, id: business.extraction_job_id });
  return `
    <a class="campaign-mini" href="#/leads?campaignId=${encodeURIComponent(business.extraction_job_id)}" title="Filtrar por esta campaña">
      <span>${escape(label)}</span>
    </a>
  `;
}

function rememberLeadListRoute() {
  const hash = location.hash || "#/leads";
  if (!hash.startsWith("#/leads/")) {
    try {
      sessionStorage.setItem("nebrija.lastLeadsRoute", hash.startsWith("#/leads") ? hash : "#/leads");
    } catch {}
  }
}

function leadListReturnHash() {
  try {
    const stored = sessionStorage.getItem("nebrija.lastLeadsRoute");
    if (stored?.startsWith("#/leads") && !stored.startsWith("#/leads/")) return stored;
  } catch {}
  return "#/leads";
}

function bindLeadSelection(rows) {
  const selected = new Set();
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const bulkBar = $("[data-bind='lead-bulk-actions']", view);
  const selectedCount = $("[data-bind='lead-selected-count']", view);
  const selectAll = $("[data-action='toggle-all-leads']", view);
  const clearButton = $("[data-action='clear-lead-selection']", view);
  const enrichAdsButton = $("[data-action='enrich-selected-ads']", view);
  const deleteButton = $("[data-action='delete-selected-leads']", view);
  const checks = $$("[data-action='toggle-lead']", view);

  const sync = () => {
    const count = selected.size;
    bulkBar.hidden = count === 0;
    selectedCount.textContent = fmtNumber(count);
    checks.forEach((check) => {
      const isSelected = selected.has(check.dataset.leadId);
      check.checked = isSelected;
      check.closest("tr")?.classList.toggle("is-selected", isSelected);
    });
    selectAll.checked = checks.length > 0 && count === checks.length;
    selectAll.indeterminate = count > 0 && count < checks.length;
  };

  checks.forEach((check) => {
    check.addEventListener("change", () => {
      if (check.checked) selected.add(check.dataset.leadId);
      else selected.delete(check.dataset.leadId);
      sync();
    });
  });

  selectAll.addEventListener("change", () => {
    selected.clear();
    if (selectAll.checked) checks.forEach((check) => selected.add(check.dataset.leadId));
    sync();
  });

  clearButton.addEventListener("click", () => {
    selected.clear();
    sync();
  });

  enrichAdsButton.addEventListener("click", () => {
    const leads = Array.from(selected)
      .map((id) => byId.get(id))
      .filter(Boolean);
    if (leads.length) bulkLeadAdsAction(leads, enrichAdsButton);
  });

  deleteButton.addEventListener("click", () => {
    const leads = Array.from(selected)
      .map((id) => byId.get(id))
      .filter(Boolean);
    if (leads.length) confirmDeleteLeads(leads, { afterDelete: router });
  });
}

function stripScheme(url) {
  return String(url || "").replace(/^https?:\/\//, "");
}

// ── Lead detail ───────────────────────────────────────────
async function renderLeadDetail({ params }) {
  const id = params[0];
  const [data, leadLists] = await Promise.all([
    api(`/api/businesses/${id}`),
    api("/api/lead-lists")
  ]);
  const b = data.business;
  setCurrentCrumb(b.name);
  const returnHash = leadListReturnHash();

  view.innerHTML = `
    <a class="back-link" href="${escape(returnHash)}">← Volver a leads</a>
    <div class="row">
      <div class="grow">
        <h1 class="headline">${escape(b.name)}</h1>
        <p class="subhead">${escape(b.city || "—")} · ${escape(b.niche || "—")} · ${renderStatus(b.status)} ${renderScore(b.score)}</p>
      </div>
      <div class="row" style="gap:6px">
        <button class="btn" data-action="lead-crawl" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 4h16v4H4V4Zm0 6h16v4H4v-4Zm0 6h10v4H4v-4Z"/></svg>
          Crawl
        </button>
        <button class="btn" data-action="lead-score" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2 9.2 8.6 2 9.3l5.5 4.8L5.8 21 12 17.3 18.2 21l-1.7-6.9L22 9.3l-7.2-.7Z"/></svg>
          Re-scorear
        </button>
        <button class="btn" data-action="lead-ads" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 4h16v3H4V4Zm0 5h10v3H4V9Zm0 5h16v3H4v-3Zm0 5h10v2H4v-2Zm13.5-9 1.6 3.2 3.4.5-2.5 2.4.6 3.4-3.1-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5L17.5 10Z"/></svg>
          Enriquecer Ads
        </button>
        <button class="btn btn--gold" data-action="lead-call" type="button" ${!b.phone_e164 ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6.6 10.8a15.4 15.4 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.3a11 11 0 0 0 3.4.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11 11 0 0 0 .6 3.4 1 1 0 0 1-.3 1l-2.2 2.4Z"/></svg>
          Llamar ahora
        </button>
        <button class="btn btn--danger" data-action="lead-delete" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 12H7.7L7 9Zm2.1 2 .4 8h1.7l-.3-8H9.1Zm3 0v8h1.8v-8h-1.8Zm3 0-.3 8h1.7l.4-8h-1.8Z"/></svg>
          Eliminar
        </button>
      </div>
    </div>

    <div class="detail-grid detail-grid--lead">
      <div class="card lead-identity-card">
        <h3>Identidad</h3>
        <dl class="kv">
          <dt>Nombre</dt><dd>${escape(b.name)}</dd>
          <dt>Web</dt><dd>${b.website ? `<a href="${escape(b.website)}" target="_blank" rel="noopener">${escape(stripScheme(b.website))}</a>` : "—"}</dd>
          <dt>Teléfono</dt><dd class="mono">${escape(b.phone_e164 || b.phone || "—")}</dd>
          <dt>Dirección</dt><dd>${escape(b.address || "—")}</dd>
          <dt>Ciudad</dt><dd>${escape(b.city || "—")}</dd>
          <dt>Nicho</dt><dd>${escape(b.niche || "—")}</dd>
          <dt>Categoría</dt><dd>${escape(b.category || "—")}</dd>
          <dt>Instagram</dt><dd>${b.instagram ? `<a href="${escape(b.instagram)}" target="_blank">${escape(b.instagram)}</a>` : "—"}</dd>
          <dt>Facebook</dt><dd>${b.facebook ? `<a href="${escape(b.facebook)}" target="_blank">${escape(b.facebook)}</a>` : "—"}</dd>
          <dt>Reservas online</dt><dd>${b.has_online_booking ? `<span class="badge badge--green">Sí</span>` : `<span class="badge badge--zinc">No</span>`}</dd>
          <dt>Chatbot</dt><dd>${b.has_chatbot ? `<span class="badge badge--green">Sí</span>` : `<span class="badge badge--zinc">No</span>`}</dd>
          <dt>Origen</dt><dd class="mono">${escape(b.external_source)}</dd>
          <dt>Source URL</dt><dd>${b.source_url ? `<a href="${escape(b.source_url)}" target="_blank">${escape(stripScheme(b.source_url))}</a>` : "—"}</dd>
          <dt>Creado</dt><dd>${fmtDate(b.created_at)}</dd>
          <dt>Actualizado</dt><dd>${fmtDate(b.updated_at)}</dd>
        </dl>
        ${renderCustomFields(b.custom_fields)}
      </div>

      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card">
          <div class="card__head">
            <h3>Ads activos</h3>
            <span class="muted">${b.ads_last_checked_at ? fmtDate(b.ads_last_checked_at) : "Sin revisar"}</span>
          </div>
          <div class="ads-panel">
            ${renderAdsDetail("Meta", b.ads_meta_active, b.ads_enrichment?.meta)}
            ${renderAdsDetail("Google", b.ads_google_active, b.ads_enrichment?.google)}
            ${renderAdsFunnelDetail(b.ads_enrichment?.classification, b)}
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <h3>Listas</h3>
            <button class="btn btn--sm" data-action="add-to-list" type="button">Añadir</button>
          </div>
          <div class="list-picker">
            <select class="select" data-bind="lead-list-select">
              <option value="">Selecciona lista</option>
              ${(leadLists.rows || []).map((list) => `<option value="${escape(list.id)}">${escape(list.name)}</option>`).join("")}
            </select>
          </div>
          <div data-bind="lead-lists" style="margin-top:10px">
            ${renderLeadListMembership(data.lists || [], b.id)}
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <h3>Breakdown scoring</h3>
            ${renderScore(b.score)}
          </div>
          ${renderScoringBreakdown(b.scoring_breakdown)}
        </div>

        <div class="card">
          <div class="card__head">
            <h3>Notas de scoring</h3>
            <button class="btn btn--sm" data-action="save-scoring-notes" type="button">Guardar</button>
          </div>
          <textarea class="textarea textarea--notes" data-bind="scoring-notes" placeholder="Añade contexto comercial, objeciones o criterios de priorización...">${escape(b.scoring_notes || "")}</textarea>
          <div class="form-hint">Visible solo dentro de este workspace.</div>
        </div>

        <div class="card">
          <h3>Contactos (${data.contacts.length})</h3>
          ${
            data.contacts.length
              ? `<div class="list">${data.contacts
                  .map(
                    (c) => `
                <div class="list__item" style="cursor:default">
                  <span class="badge badge--zinc">${escape(c.kind)}</span>
                  <div class="list__main"><div class="list__title mono ellipsis">${escape(c.value)}</div>
                  <div class="list__meta">conf ${Math.round((c.confidence || 0) * 100)}%${c.source_url ? ` · <a href="${escape(c.source_url)}" target="_blank">fuente</a>` : ""}</div></div>
                </div>`
                  )
                  .join("")}</div>`
              : `<p class="muted" style="margin:0">Sin contactos descubiertos.</p>`
          }
        </div>

        <div class="card">
          <h3>Crawls (${data.crawlerRuns.length})</h3>
          ${
            data.crawlerRuns.length
              ? `<div class="list">${data.crawlerRuns
                  .map(
                    (r) => `
                <div class="list__item" style="cursor:default">
                  <div class="list__main">
                    <div class="list__title mono ellipsis">${escape(stripScheme(r.root_url))}</div>
                    <div class="list__meta">${fmtRel(r.created_at)} · ${r.pages_succeeded || 0}/${(r.pages_succeeded || 0) + (r.pages_failed || 0)} páginas</div>
                  </div>
                  ${renderStatus(r.status)}
                </div>`
                  )
                  .join("")}</div>`
              : `<p class="muted" style="margin:0">Aún no se ha rastreado.</p>`
          }
        </div>
      </div>
    </div>

    <div class="section-title">
      <h2>Llamadas (${data.calls.length})</h2>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Inicio</th><th>Estado</th><th>Outcome</th><th class="col-num">Duración</th><th>Resumen</th></tr></thead>
        <tbody>
          ${
            data.calls.length
              ? data.calls
                  .map(
                    (c) => `
            <tr data-href="#/calls/${escape(c.id)}">
              <td>${fmtDate(c.started_at || c.created_at)}</td>
              <td>${renderStatus(c.status || "—")}</td>
              <td>${callBadge(c)}</td>
              <td class="col-num mono">${fmtDuration(c.duration_seconds)}</td>
              <td class="ellipsis" style="max-width:520px">${escape(c.summary || "—")}</td>
            </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5"><div class="muted" style="padding:14px">Aún no se ha llamado a este lead.</div></td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;

  bindRowNav(view);
  $("[data-action='lead-crawl']", view).addEventListener("click", () => leadAction(b, "crawl"));
  $("[data-action='lead-score']", view).addEventListener("click", () => leadAction(b, "score"));
  $("[data-action='lead-ads']", view).addEventListener("click", () => leadAction(b, "ads"));
  $("[data-action='lead-call']", view).addEventListener("click", () => leadAction(b, "call"));
  $("[data-action='lead-delete']", view).addEventListener("click", () =>
    confirmDeleteLead(b, { afterDelete: () => { location.hash = leadListReturnHash(); } })
  );
  $("[data-action='save-scoring-notes']", view).addEventListener("click", () => saveScoringNotes(b.id));
  $("[data-action='add-to-list']", view).addEventListener("click", () => addLeadToSelectedList(b.id));
  $$("[data-action='remove-from-list']", view).forEach((button) =>
    button.addEventListener("click", () => removeLeadFromList(button.dataset.listId, b.id))
  );
}

function renderLeadListMembership(lists, businessId) {
  if (!lists.length) return `<p class="muted" style="margin:0">Este lead todavía no está en ninguna lista.</p>`;
  return `<div class="list">${lists
    .map(
      (list) => `
      <div class="list__item" style="cursor:default">
        <span class="badge badge--${escape(list.color || "zinc")}">${escape(list.name)}</span>
        <div class="list__main"><div class="list__meta">Añadido ${fmtRel(list.added_at)}</div></div>
        <button class="btn btn--sm btn--ghost" data-action="remove-from-list" data-list-id="${escape(list.id)}" type="button">Quitar</button>
      </div>`
    )
    .join("")}</div>`;
}

function renderScoringBreakdown(breakdown = {}) {
  const rules = breakdown?.matchedRules || [];
  if (!rules.length) return `<p class="muted" style="margin:0">Sin reglas aplicadas todavía. Re-scorea el lead para generar detalle.</p>`;
  return `<div class="score-breakdown">${rules
    .map(
      (rule) => `
      <div class="score-breakdown__row">
        <span>${escape(rule.label || rule.id)}</span>
        <strong class="mono">${Number(rule.points) > 0 ? "+" : ""}${escape(rule.points)}</strong>
      </div>`
    )
    .join("")}</div>`;
}

async function addLeadToSelectedList(businessId) {
  const select = $("[data-bind='lead-list-select']", view);
  const listId = select.value;
  if (!listId) return toast("Selecciona una lista", "error");
  try {
    await api(`/api/lead-lists/${listId}/businesses`, {
      method: "POST",
      body: JSON.stringify({ businessId })
    });
    toast("Lead añadido a la lista", "ok");
    await router();
  } catch (err) {
    toast(`No se pudo añadir (${err.message})`, "error");
  }
}

async function removeLeadFromList(listId, businessId) {
  try {
    await api(`/api/lead-lists/${listId}/businesses/${businessId}`, { method: "DELETE" });
    toast("Lead retirado de la lista", "ok");
    await router();
  } catch (err) {
    toast(`No se pudo quitar (${err.message})`, "error");
  }
}

function confirmDeleteLead(business, { afterDelete } = {}) {
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="delete-confirm">
      <div class="delete-confirm__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 12H7.7L7 9Zm2.1 2 .4 8h1.7l-.3-8H9.1Zm3 0v8h1.8v-8h-1.8Zm3 0-.3 8h1.7l.4-8h-1.8Z"/></svg>
      </div>
      <div>
        <p class="delete-confirm__title">Eliminar ${escape(business.name || "este lead")}</p>
        <p class="delete-confirm__copy">Se eliminará el lead del workspace junto con sus contactos, listas, scoring y datos de prospección asociados. Esta acción no se puede deshacer.</p>
      </div>
    </div>
  `;
  const footer = document.createDocumentFragment();
  const cancel = btn("Cancelar", "ghost");
  const submit = btn("Eliminar lead", "danger");
  cancel.addEventListener("click", closeModal);
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      await api(`/api/businesses/${business.id}`, { method: "DELETE" });
      toast("Lead eliminado", "ok");
      closeModal();
      if (afterDelete) await afterDelete();
    } catch (err) {
      toast(`No se pudo eliminar (${err.message})`, "error");
    } finally {
      submit.disabled = false;
    }
  });
  footer.append(cancel, submit);
  openModal({ title: "Eliminar lead", body, footer });
}

function confirmDeleteLeads(leads, { afterDelete } = {}) {
  const count = leads.length;
  const previewNames = leads.slice(0, 4).map((lead) => lead.name).filter(Boolean);
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="delete-confirm">
      <div class="delete-confirm__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 12H7.7L7 9Zm2.1 2 .4 8h1.7l-.3-8H9.1Zm3 0v8h1.8v-8h-1.8Zm3 0-.3 8h1.7l.4-8h-1.8Z"/></svg>
      </div>
      <div>
        <p class="delete-confirm__title">Eliminar ${fmtNumber(count)} leads seleccionados</p>
        <p class="delete-confirm__copy">Se eliminarán del workspace junto con sus contactos, listas, scoring y datos de prospección asociados. Esta acción no se puede deshacer.</p>
        ${
          previewNames.length
            ? `<p class="delete-confirm__copy delete-confirm__preview">${escape(previewNames.join(", "))}${count > previewNames.length ? ` y ${fmtNumber(count - previewNames.length)} más` : ""}</p>`
            : ""
        }
      </div>
    </div>
  `;
  const footer = document.createDocumentFragment();
  const cancel = btn("Cancelar", "ghost");
  const submit = btn(`Eliminar ${fmtNumber(count)}`, "danger");
  cancel.addEventListener("click", closeModal);
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      let deleted = 0;
      for (const lead of leads) {
        await api(`/api/businesses/${encodeURIComponent(lead.id)}`, { method: "DELETE" });
        deleted += 1;
      }
      toast(`${fmtNumber(deleted)} leads eliminados`, "ok");
      closeModal();
      if (afterDelete) await afterDelete();
    } catch (err) {
      toast(`No se pudo completar el borrado (${err.message})`, "error");
    } finally {
      submit.disabled = false;
    }
  });
  footer.append(cancel, submit);
  openModal({ title: "Eliminar leads", body, footer });
}

async function leadAction(business, kind) {
  try {
    const url = kind === "ads" ? `/api/businesses/${business.id}/ads-enrichment` : `/businesses/${business.id}/${kind}`;
    await api(url, { method: "POST", body: "{}" });
    toast(
      kind === "call"
        ? "Llamada en cola"
        : kind === "crawl"
          ? "Crawl en cola"
          : kind === "ads"
            ? "Enriquecimiento Ads en cola"
            : "Re-scoring en cola",
      "ok"
    );
  } catch (err) {
    toast(`No se pudo lanzar (${err.message})`, "error");
  }
}

async function campaignAdsAction(campaignId) {
  const button = $("[data-action='campaign-ads']", view);
  button.disabled = true;
  try {
    const result = await api(`/api/campaigns/${campaignId}/ads-enrichment`, { method: "POST", body: "{}" });
    toast(`${fmtNumber(result.queued)} leads enviados a enriquecimiento Ads`, "ok");
  } catch (err) {
    toast(`No se pudo enriquecer la campaña (${err.message})`, "error");
  } finally {
    button.disabled = false;
  }
}

async function bulkLeadAdsAction(leads, button) {
  const businessIds = leads.map((lead) => lead.id).filter(Boolean);
  if (!businessIds.length) return;
  if (button) button.disabled = true;
  try {
    const result = await api("/api/businesses/ads-enrichment", {
      method: "POST",
      body: JSON.stringify({ businessIds })
    });
    const skipped = result.skipped ? ` · ${fmtNumber(result.skipped)} omitidos` : "";
    toast(`${fmtNumber(result.queued)} leads enviados a Ads/Funnel${skipped}`, result.queued ? "ok" : "error");
  } catch (err) {
    toast(`No se pudo lanzar Ads/Funnel (${err.message})`, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function renderAdsDetail(label, value, evidence = {}) {
  const attempts = Array.isArray(evidence.attempts) ? evidence.attempts : [];
  const visibleAttempts = attempts.filter((attempt) => attempt.active === true || attempt.status === "error").slice(-3);
  const hiddenAttempts = attempts.filter((attempt) => !visibleAttempts.includes(attempt));
  return `
    <div class="ads-row">
      <div class="ads-row__head">
        <div>
          <div class="ads-row__title">${escape(label)}</div>
          <div class="ads-row__meta">${escape(adsReasonLabel(evidence.reason || evidence.status || "pendiente"))}${evidence.confidence != null ? ` · conf ${Math.round(Number(evidence.confidence) * 100)}%` : ""}</div>
        </div>
        <div class="ads-row__side">
          ${renderAdsEvidenceBadge(value, label, evidence)}
          ${evidence.sourceUrl ? `<a class="mini-link" href="${escape(evidence.sourceUrl)}" target="_blank" rel="noopener">fuente principal</a>` : ""}
        </div>
      </div>
      ${label === "Meta" ? renderMetaAdsEstimateDetail(evidence) : ""}
      ${renderAdsDiscovery(evidence)}
      ${visibleAttempts.length ? `<div class="ads-signals">${visibleAttempts.map(renderAdsAttempt).join("")}</div>` : ""}
      ${renderAdsAttemptsDisclosure(hiddenAttempts)}
      ${!attempts.length ? `<div class="ads-empty">Sin trazas guardadas todavía.</div>` : ""}
    </div>
  `;
}

function renderMetaAdsEstimateDetail(evidence = {}) {
  const estimate = metaAdsEstimateFromEvidence(evidence);
  if (!estimate) {
    return `
      <div class="meta-estimate-detail meta-estimate-detail--empty">
        <strong>Estimación Meta Ads</strong>
        <span>Sin dato suficiente: no hay impresiones públicas en anuncios matcheados con este lead.</span>
      </div>
    `;
  }
  const confidence = estimate.confidence != null ? `${Math.round(Number(estimate.confidence) * 100)}%` : "estimada";
  return `
    <div class="meta-estimate-detail">
      <strong>${escape(formatCurrencyRange(estimate.estimatedSpendMin, estimate.estimatedSpendMax, estimate.currency))}</strong>
      <span>${escape(formatImpressionRange(estimate.impressionsMin, estimate.impressionsMax))} · CPM ref. ${escape(formatCurrencyRange(estimate.cpm || 0, estimate.cpm || 0, estimate.currency))} · conf ${escape(confidence)}</span>
      <small>Fuente: impresiones públicas de Meta Ads Library en anuncios activos matcheados. No es inversión real declarada.</small>
    </div>
  `;
}

function renderAdsFunnelDetail(classification = {}, business = {}) {
  const type = classification?.type || business.ads_funnel_type || "unknown";
  const confidence = classification?.confidence ?? business.ads_funnel_confidence;
  const signals = Array.isArray(classification?.signals) ? classification.signals : [];
  const scores = classification?.scores || {};
  const landingUrl = classification?.landingUrl || business.ads_funnel_landing_url;
  const visibleSignals = signals.slice(0, 3);
  const hiddenSignals = signals.slice(3);
  return `
    <div class="ads-row ads-row--funnel">
      <div class="ads-row__head">
        <div>
          <div class="ads-row__title">Funnel Ads</div>
          <div class="ads-row__meta">${escape(adsFunnelReasonLabel(classification?.reason || type))}${confidence != null ? ` · conf ${Math.round(Number(confidence) * 100)}%` : ""}</div>
        </div>
        <div class="ads-row__side">
          ${renderAdsFunnelBadge(type, confidence)}
          ${landingUrl ? `<a class="mini-link" href="${escape(landingUrl)}" target="_blank" rel="noopener">landing</a>` : ""}
        </div>
      </div>
      ${renderAdsFunnelScores(scores)}
      ${
        visibleSignals.length
          ? `<div class="ads-signals">${visibleSignals.map(renderAdsFunnelSignal).join("")}</div>`
          : `<div class="ads-empty">Sin señales de landing guardadas todavía.</div>`
      }
      ${renderAdsFunnelDisclosure(hiddenSignals, classification)}
    </div>
  `;
}

function renderAdsFunnelScores(scores = {}) {
  const items = [
    ["lead_generation", "Captación", scores.lead_generation],
    ["ecommerce", "Ecommerce", scores.ecommerce],
    ["other", "Otro", scores.other]
  ];
  if (!items.some(([, , value]) => Number(value) > 0)) return "";
  return `<div class="ads-funnel-scores">${items
    .map(([key, label, value]) => `<span class="ads-funnel-score ads-funnel-score--${escape(key)}"><strong>${escape(label)}</strong><span>${escape(value ?? 0)}</span></span>`)
    .join("")}</div>`;
}

function renderAdsFunnelSignal(signal = {}) {
  const target = signal.target || "other";
  return `
    <div class="ads-signal ads-signal--${target === "lead_generation" || target === "ecommerce" ? "ok" : "unknown"}">
      <div class="ads-signal__main">
        <div class="ads-signal__title">${escape(signal.label || signal.id || "Señal")}</div>
        <div class="ads-signal__meta">${escape(adsFunnelLabel(target))} · peso ${escape(signal.weight ?? 0)}${signal.snippet ? ` · ${escape(signal.snippet)}` : ""}</div>
      </div>
    </div>
  `;
}

function renderAdsAttemptsDisclosure(attempts = []) {
  if (!attempts.length) return "";
  const failed = attempts.filter((attempt) => attempt.active !== true).length;
  return `
    <details class="ads-disclosure">
      <summary>${fmtNumber(attempts.length)} traza${attempts.length === 1 ? "" : "s"} secundaria${failed ? ` · ${fmtNumber(failed)} sin señal` : ""}</summary>
      <div class="ads-signals">${attempts.slice(-12).map(renderAdsAttempt).join("")}</div>
    </details>
  `;
}

function renderAdsFunnelDisclosure(signals = [], classification = {}) {
  const evaluated = Array.isArray(classification?.evaluated) ? classification.evaluated : [];
  const rejected = Array.isArray(classification?.rejected) ? classification.rejected : [];
  if (!signals.length && !evaluated.length && !rejected.length) return "";
  return `
    <details class="ads-disclosure">
      <summary>Ver análisis completo de landing</summary>
      ${
        signals.length
          ? `<div class="ads-signals">${signals.map(renderAdsFunnelSignal).join("")}</div>`
          : ""
      }
      ${
        evaluated.length || rejected.length
          ? `<div class="ads-debug-grid">
              ${evaluated.map(renderAdsEvaluatedLanding).join("")}
              ${rejected.map(renderAdsRejectedLanding).join("")}
            </div>`
          : ""
      }
    </details>
  `;
}

function renderAdsEvaluatedLanding(item = {}) {
  return `
    <div class="ads-debug-card">
      <strong>${escape(adsFunnelLabel(item.type))} · ${item.confidence != null ? `${Math.round(Number(item.confidence) * 100)}%` : "—"}</strong>
      <span>${item.landingUrl ? escape(stripScheme(item.landingUrl)) : "Landing sin URL"}</span>
    </div>
  `;
}

function renderAdsRejectedLanding(item = {}) {
  return `
    <div class="ads-debug-card ads-debug-card--muted">
      <strong>${escape(item.reason || "Descartada")}</strong>
      <span>${item.url ? escape(stripScheme(item.url)) : escape(item.error || "Sin URL")}</span>
    </div>
  `;
}

function renderAdsDiscovery(evidence = {}) {
  const discovery = evidence.socialDiscovery;
  if (!discovery) return "";
  if (discovery.status === "found") {
    const socials = [
      discovery.instagram ? `Instagram: ${stripScheme(discovery.instagram)}` : "",
      discovery.facebook ? `Facebook: ${stripScheme(discovery.facebook)}` : ""
    ].filter(Boolean).join(" · ");
    return `<div class="ads-discovery">Social detectado en web · ${escape(socials)}</div>`;
  }
  if (discovery.status === "error") return `<div class="ads-discovery ads-discovery--warn">No se pudieron leer sociales de la web.</div>`;
  return "";
}

function renderAdsAttempt(attempt = {}) {
  const tone = attempt.active === true ? "ok" : attempt.status === "error" ? "error" : attempt.active === false ? "off" : "unknown";
  const title = [adsProviderLabel(attempt.sourceProvider), adsStrategyLabel(attempt.strategy), attempt.country].filter(Boolean).join(" · ");
  const meta = [
    attempt.query ? `q=${attempt.query}` : "",
    attempt.itemsSeen != null ? `${fmtNumber(attempt.itemsSeen)} item${Number(attempt.itemsSeen) === 1 ? "" : "s"}` : "",
    attempt.total != null ? `total ${fmtNumber(attempt.total)}` : "",
    attempt.samplePageName ? `page ${attempt.samplePageName}` : "",
    Array.isArray(attempt.matchedFields) && attempt.matchedFields.length ? `match ${attempt.matchedFields.join("+")}` : "",
    attempt.actorId ? `actor ${formatActorId(attempt.actorId)}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <div class="ads-signal ads-signal--${tone}">
      <div class="ads-signal__main">
        <div class="ads-signal__title">${escape(title || "Intento")}</div>
        <div class="ads-signal__meta">${escape(adsReasonLabel(attempt.reason || attempt.status || "sin resultado"))}${attempt.confidence != null ? ` · conf ${Math.round(Number(attempt.confidence) * 100)}%` : ""}${meta ? ` · ${escape(meta)}` : ""}</div>
      </div>
      ${attempt.sourceUrl ? `<a class="mini-link" href="${escape(attempt.sourceUrl)}" target="_blank" rel="noopener">fuente</a>` : ""}
    </div>
  `;
}

function formatActorId(actorId) {
  return String(actorId || "").replace("~", "/");
}

function adsProviderLabel(provider) {
  return {
    firecrawl: "Firecrawl",
    apify: "Apify"
  }[provider] || provider || "";
}

function adsStrategyLabel(strategy) {
  return {
    direct_transparency: "Transparency directo",
    search_transparency: "Transparency búsqueda",
    website_domain: "Dominio",
    website_domain_apify: "Dominio",
    facebook_url: "Facebook URL",
    facebook_handle: "Facebook handle",
    facebook_page: "Facebook página",
    facebook_page_apify: "Facebook página",
    instagram_url: "Instagram URL",
    instagram_handle: "Instagram handle",
    instagram_handle_apify: "Instagram handle",
    instagram_account: "Instagram cuenta",
    business_name_city: "Nombre + ciudad",
    business_name: "Nombre",
    business_name_apify: "Nombre",
    website_brand: "Marca web"
  }[strategy] || strategy || "";
}

function adsReasonLabel(reason) {
  return {
    active_ad_library_copy: "Texto activo en Ad Library",
    apify_active_ad_matched: "Anuncio activo verificado",
    apify_active_items_not_matched: "Items activos sin match del lead",
    apify_error: "Error en Apify",
    apify_no_active_items: "Apify sin anuncios activos",
    creative_id_found: "Creative ID encontrado",
    generic_ad_library_copy: "Texto genérico de Ad Library",
    meta_library_id_found: "Library ID encontrado",
    negative_copy: "Fuente indica sin anuncios",
    no_meta_probe_matched: "Sin query Meta útil",
    no_strong_signal: "Sin señal fuerte",
    recent_last_shown_date: "Fecha reciente detectada"
  }[reason] || reason || "Pendiente";
}

function adsFunnelLabel(type) {
  return {
    lead_generation: "Captación",
    ecommerce: "Ecommerce",
    other: "Otro",
    unknown: "Sin clasificar"
  }[type] || type || "Sin clasificar";
}

function adsFunnelReasonLabel(reason) {
  if (String(reason || "").startsWith("ai_")) return "Clasificación DeepSeek";
  return {
    ai_landing_classification: "Clasificación DeepSeek",
    ecommerce_signals_won: "Señales de compra y catálogo",
    firecrawl_client_missing: "Firecrawl no disponible",
    insufficient_campaign_intent_signal: "Señal insuficiente",
    lead_generation_signals_won: "Señales de captación",
    lead_specific_contact_page: "Contacto con intención específica",
    no_active_ads: "Sin Ads activos verificados",
    no_landing_page_classified: "Landing no clasificada",
    unknown: "Sin clasificar"
  }[reason] || adsFunnelLabel(reason);
}

function renderCustomFields(fields = {}) {
  const entries = Object.entries(fields || {}).filter(([, value]) => value != null && value !== "");
  if (!entries.length) return "";
  return `
    <div class="custom-fields">
      <div class="custom-fields__title">Campos personalizados</div>
      <dl class="kv">
        ${entries.map(([key, value]) => `<dt>${escape(key)}</dt><dd>${renderCustomFieldValue(key, value)}</dd>`).join("")}
      </dl>
    </div>
  `;
}

function renderCustomFieldValue(key, value) {
  if (key === "decision_maker" && value && typeof value === "object") {
    return renderDecisionMakerCustomField(value);
  }
  if (value && typeof value === "object") {
    return `<pre class="json-field">${escape(JSON.stringify(value, null, 2))}</pre>`;
  }
  return escape(value);
}

function renderDecisionMakerCustomField(value) {
  const decisionMaker = value.decisionMaker || value.decision_maker || {};
  const confidence = decisionMaker.confidence != null ? `${Math.round(Number(decisionMaker.confidence) * 100)}%` : "—";
  if (!value.found) {
    return `
      <div class="decision-maker-field">
        <span class="muted">Sin decisor encontrado</span>
        ${value.query ? `<span class="decision-maker-field__query">${escape(value.query)}</span>` : ""}
      </div>
    `;
  }
  return `
    <div class="decision-maker-field">
      <strong>${escape(decisionMaker.fullName || "Decisor detectado")}</strong>
      ${decisionMaker.role ? `<span>${escape(decisionMaker.role)}</span>` : ""}
      ${decisionMaker.linkedinUrl ? `<a href="${escape(decisionMaker.linkedinUrl)}" target="_blank" rel="noopener">Perfil de LinkedIn</a>` : ""}
      <span class="muted">Confianza ${escape(confidence)}</span>
      ${value.query ? `<span class="decision-maker-field__query">${escape(value.query)}</span>` : ""}
    </div>
  `;
}

async function saveScoringNotes(businessId) {
  const button = $("[data-action='save-scoring-notes']", view);
  const textarea = $("[data-bind='scoring-notes']", view);
  button.disabled = true;
  try {
    await api(`/api/businesses/${businessId}/scoring-notes`, {
      method: "PATCH",
      body: JSON.stringify({ scoringNotes: textarea.value })
    });
    toast("Notas guardadas", "ok");
  } catch (err) {
    toast(`No se pudieron guardar las notas (${err.message})`, "error");
  } finally {
    button.disabled = false;
  }
}

// ── Lists ────────────────────────────────────────────────
async function renderLists() {
  setCurrentCrumb("Manual");
  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Listas</h1>
        <p class="subhead">Agrupa leads manualmente sin sacarlos de sus campañas.</p>
      </div>
      <button class="btn btn--primary" data-action="new-list" type="button">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>
        Nueva lista
      </button>
    </div>
    <div data-bind="lists-grid" class="lists-grid">${rowSkeleton(4)}</div>
  `;
  $("[data-action='new-list']", view).addEventListener("click", openListModal);
  const data = await api("/api/lead-lists");
  const host = $("[data-bind='lists-grid']", view);
  host.innerHTML = data.rows.length
    ? data.rows.map(renderLeadListCard).join("")
    : emptyState("Sin listas", "Crea listas para separar leads por intención, cliente o prioridad.", `<button class="btn btn--primary" data-action="new-list">Nueva lista</button>`);
  $$("[data-action='new-list']", host).forEach((button) => button.addEventListener("click", openListModal));
}

function renderLeadListCard(list) {
  return `
    <a class="list-card list-card--${escape(list.color || "gold")}" href="#/lists/${escape(list.id)}">
      <div class="list-card__top">
        <span class="badge badge--${escape(list.color || "gold")}">${escape(list.color || "gold")}</span>
        <span class="mono faint">${fmtRel(list.created_at)}</span>
      </div>
      <h3>${escape(list.name)}</h3>
      <p>${escape(list.description || "Lista manual de leads.")}</p>
      <div class="list-card__count">${fmtNumber(list.leads_count)} <span>leads</span></div>
    </a>
  `;
}

async function renderListDetail({ params }) {
  const id = params[0];
  const { list, rows, options } = await api(`/api/lead-lists/${id}/crm`);
  const activeRows = rows.filter((row) => row.crm_status !== "Descartado");
  const discardedRows = rows.filter((row) => row.crm_status === "Descartado");
  const interested = rows.filter((row) => ["Interesado", "Cita Concertada"].includes(row.crm_status)).length;
  const followUps = rows.filter((row) => row.follow_up_date).length;
  setCurrentCrumb(list.name);
  view.innerHTML = `
    <a class="back-link" href="#/lists">← Volver a listas</a>
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">${escape(list.name)}</h1>
        <p class="subhead">${escape(list.description || "CRM de cold calling")} · ${fmtNumber(list.leads_count)} leads</p>
      </div>
      <a class="btn" href="#/leads?listId=${encodeURIComponent(list.id)}">Ver en Leads</a>
    </div>

    <div class="crm-board" data-list-id="${escape(list.id)}">
      <div class="crm-kpis">
        ${kpiCard("Prospectos", fmtNumber(activeRows.length), "Activos para llamar", "accent")}
        ${kpiCard("Interesados", fmtNumber(interested), "Interesado o cita concertada")}
        ${kpiCard("Seguimientos", fmtNumber(followUps), "Con fecha asignada")}
        ${kpiCard("No interesados", fmtNumber(discardedRows.length), "Histórico descartado")}
      </div>

      <datalist id="crm-objection-options">
        ${(options.objections || []).map((option) => `<option value="${escape(option)}"></option>`).join("")}
      </datalist>

      ${renderCrmFilterBar(rows)}

      <div class="crm-section-head">
        <div>
          <h2>Prospectos</h2>
          <p data-bind="crm-active-count">${fmtNumber(activeRows.length)} contactos activos</p>
        </div>
        <span class="crm-save-state" data-bind="crm-save-state">Listo</span>
      </div>
      <div data-bind="crm-active-table"></div>

      <div class="crm-section-head crm-section-head--secondary">
        <div>
          <h2>No Interesados</h2>
          <p data-bind="crm-discarded-count">${fmtNumber(discardedRows.length)} descartados para evitar rellamadas</p>
        </div>
      </div>
      <div data-bind="crm-discarded-table"></div>
    </div>
  `;
  hydrateCrmBoard(view, { rows, options });
}

function renderCrmFilterBar(rows = []) {
  return `
    <div class="crm-filter-bar" data-bind="crm-filters">
      <label class="crm-filter crm-filter--wide">
        <span>Buscar</span>
        <input class="input" data-crm-quick-filter="search" type="search" placeholder="Negocio, decisor, notas..." />
      </label>
      <label class="crm-filter">
        <span>Teléfono</span>
        <select class="select" data-crm-quick-filter="phoneType">
          <option value="">Todos</option>
          ${renderPhoneTypeOptions()}
        </select>
      </label>
      <label class="crm-filter">
        <span>Ciudad</span>
        <select class="select" data-crm-quick-filter="city">
          <option value="">Todas</option>
          ${renderOptions(uniqueCrmValues(rows, "city"))}
        </select>
      </label>
      <label class="crm-filter">
        <span>Nicho</span>
        <select class="select" data-crm-quick-filter="niche">
          <option value="">Todos</option>
          ${renderOptions(uniqueCrmValues(rows, "niche"))}
        </select>
      </label>
      <label class="crm-filter">
        <span>Funnel</span>
        <select class="select" data-crm-quick-filter="adsFunnelType">
          <option value="">Todos</option>
          ${renderAdsFunnelFilterOptions()}
        </select>
      </label>
      <label class="crm-filter">
        <span>Meta Ads</span>
        <select class="select" data-crm-quick-filter="metaAds">
          <option value="">Todos</option>
          ${renderBooleanFilterOptions()}
        </select>
      </label>
      <label class="crm-filter">
        <span>Estim. Meta</span>
        <select class="select" data-crm-quick-filter="hasMetaEstimate">
          <option value="">Todos</option>
          <option value="true">Con estimación</option>
          <option value="false">Sin dato</option>
        </select>
      </label>
      <label class="crm-filter">
        <span>Google Ads</span>
        <select class="select" data-crm-quick-filter="googleAds">
          <option value="">Todos</option>
          ${renderBooleanFilterOptions()}
        </select>
      </label>
      <button class="btn btn--ghost" data-action="crm-reset-filters" type="button">Limpiar</button>
      <span class="crm-filter-count" data-bind="crm-filter-count">${fmtNumber(rows.length)} filas</span>
    </div>
  `;
}

function hydrateCrmBoard(scope, { rows, options, editable = true, showDiscarded = true, title = "Prospectos", emptyCopy = "Añade leads desde la ficha de cada lead o importa un CSV/Excel." }) {
  const board = $(".crm-board", scope);
  if (!board) return;
  const state = {
    quick: {},
    filters: {},
    sortKey: "",
    sortDir: "asc",
    limits: { active: CRM_PAGE_SIZE, discarded: CRM_PAGE_SIZE },
    columnOrder: loadCrmColumnOrder()
  };
  board.__crmRows = rows;
  board.__crmRender = render;
  board.__crmState = state;

  bindCrmQuickFilters(board, state, render);
  render();

  function render() {
    const columns = orderedCrmColumns(createCrmColumns(options, rows, { editable }), state.columnOrder);
    const activeRows = rows.filter((row) => row.crm_status !== "Descartado");
    const discardedRows = rows.filter((row) => row.crm_status === "Descartado");
    const activeSource = showDiscarded ? activeRows : rows;
    const active = applyCrmTableState(activeSource, columns, state);
    const discarded = showDiscarded ? applyCrmTableState(discardedRows, columns, state) : [];
    const activeVisible = active.slice(0, state.limits.active);
    const discardedVisible = discarded.slice(0, state.limits.discarded);

    $("[data-bind='crm-active-count']", board).textContent = showDiscarded
      ? `${fmtNumber(active.length)} de ${fmtNumber(activeRows.length)} contactos activos`
      : `${fmtNumber(active.length)} de ${fmtNumber(rows.length)} leads`;
    const discardedCount = $("[data-bind='crm-discarded-count']", board);
    if (discardedCount) discardedCount.textContent = `${fmtNumber(discarded.length)} de ${fmtNumber(discardedRows.length)} descartados`;
    $("[data-bind='crm-filter-count']", board).textContent = `${fmtNumber(active.length + discarded.length)} de ${fmtNumber(rows.length)} filas`;
    $("[data-bind='crm-active-table']", board).innerHTML = renderCrmTable({
      rows: activeVisible,
      total: active.length,
      rendered: activeVisible.length,
      columns,
      options,
      state,
      kind: "active",
      emptyTitle: `${title} vacíos`,
      emptyCopy
    });
    const discardedHost = $("[data-bind='crm-discarded-table']", board);
    if (discardedHost) {
      discardedHost.innerHTML = renderCrmTable({
        rows: discardedVisible,
        total: discarded.length,
        rendered: discardedVisible.length,
        columns,
        options,
        state,
        kind: "discarded",
        emptyTitle: "Sin descartados",
        emptyCopy: "Los leads marcados como Descartado aparecerán aquí."
      });
    }
    bindCrmTableControls(board, state, render);
    if (editable) bindCrmEditableControls(board);
  }
}

function createCrmColumns(options = {}, rows = [], { editable = true } = {}) {
  const rowOptions = (key) => uniqueCrmValues(rows, key);
  const statusOptions = uniqueStrings([...(options.statuses || []), ...rows.map((row) => row.crm_status)]);
  const checkpointOptions = uniqueStrings([...(options.checkpoints || []), ...rows.map((row) => row.checkpoint)]);
  const objectionOptions = uniqueStrings([...(options.objections || []), ...rows.map((row) => row.objection)]);
  return [
    {
      key: "first_contact_at",
      label: "Primer contacto",
      width: 132,
      filter: "date",
      value: (row) => row.first_contact_at,
      render: (row) => editable
        ? renderEditableCrmFirstContact(row)
        : renderCrmFirstContact(row)
    },
    {
      key: "business",
      label: "Negocio",
      width: 170,
      filter: "text",
      value: (row) => row.name,
      render: renderCrmBusinessCell
    },
    {
      key: "decision_maker_name",
      label: "Nombre Decisor",
      width: 136,
      filter: "text",
      value: (row) => row.decision_maker_name,
      render: (row) => editable ? crmInput("decisionMakerName", row.decision_maker_name, "text", "crm-input--name") : crmReadonly(row.decision_maker_name)
    },
    {
      key: "phone",
      label: "Teléfono",
      width: 130,
      filter: "phone_type",
      value: (row) => row.phone_e164 || row.phone,
      filterValue: (row) => crmPhoneType(row),
      render: renderCrmPhone
    },
    {
      key: "decision_maker_email",
      label: "Email Decisor",
      width: 190,
      filter: "text",
      value: (row) => row.decision_maker_email || row.fallback_email,
      render: (row) => editable ? crmInput("decisionMakerEmail", row.decision_maker_email, "email", "crm-input--email", row.fallback_email || "") : crmReadonly(row.decision_maker_email || row.fallback_email)
    },
    {
      key: "website",
      label: "URL Web",
      width: 190,
      filter: "text",
      value: (row) => row.website,
      render: renderCrmWebsite
    },
    {
      key: "answered_by",
      label: "¿Quién atendió?",
      width: 120,
      filter: "text",
      value: (row) => row.answered_by,
      render: (row) => editable ? crmInput("answeredBy", row.answered_by, "text", "crm-input--name") : crmReadonly(row.answered_by)
    },
    {
      key: "crm_status",
      label: "Estado",
      width: 112,
      filter: "select",
      options: statusOptions,
      value: (row) => row.crm_status,
      render: (row) => editable ? crmSelect("crmStatus", row.crm_status, options.statuses || []) : crmReadonly(row.crm_status)
    },
    {
      key: "checkpoint",
      label: "Checkpoint",
      width: 118,
      filter: "select",
      options: checkpointOptions,
      value: (row) => row.checkpoint,
      render: (row) => editable ? crmSelect("checkpoint", row.checkpoint, options.checkpoints || [], true) : crmReadonly(row.checkpoint)
    },
    {
      key: "objection",
      label: "Objeción inicial",
      width: 210,
      filter: "select",
      options: objectionOptions,
      value: (row) => row.objection,
      render: (row) => editable ? crmObjectionInput(row.objection) : crmReadonly(row.objection)
    },
    {
      key: "follow_up_date",
      label: "Día (Seguimiento)",
      width: 155,
      filter: "date",
      value: (row) => row.follow_up_date,
      render: (row) => editable ? crmInput("followUpDate", row.follow_up_date, "date", "crm-input--date") : crmReadonly(row.follow_up_date)
    },
    {
      key: "follow_up_time",
      label: "Hora (Seguimiento)",
      width: 135,
      filter: "text",
      value: (row) => row.follow_up_time,
      render: (row) => editable ? crmInput("followUpTime", row.follow_up_time, "time", "crm-input--time") : crmReadonly(row.follow_up_time)
    },
    {
      key: "next_action",
      label: "Próxima acción",
      width: 250,
      filter: "text",
      value: (row) => row.next_action,
      render: (row) => editable ? crmTextarea("nextAction", row.next_action, "crm-textarea--action") : crmReadonly(row.next_action)
    },
    {
      key: "observations",
      label: "Observaciones",
      width: 280,
      filter: "text",
      value: (row) => row.observations,
      render: (row) => editable ? crmTextarea("observations", row.observations, "crm-textarea--notes") : crmReadonly(row.observations)
    },
    {
      key: "city",
      label: "Ciudad",
      width: 150,
      filter: "select",
      options: rowOptions("city"),
      value: (row) => row.city,
      render: (row) => crmReadonly(row.city)
    },
    {
      key: "niche",
      label: "Nicho",
      width: 180,
      filter: "select",
      options: rowOptions("niche"),
      value: (row) => row.niche,
      render: (row) => crmReadonly(row.niche)
    },
    {
      key: "category",
      label: "Categoría",
      width: 112,
      filter: "select",
      options: rowOptions("category"),
      value: (row) => row.category,
      render: (row) => crmReadonly(row.category)
    },
    {
      key: "ads_funnel_type",
      label: "Tipo funnel",
      width: 122,
      filter: "select",
      options: ["lead_generation", "ecommerce", "not_ecommerce", "other", "unknown"],
      labels: { ...Object.fromEntries(Object.entries(ADS_FUNNEL_LABELS).map(([key, [, label]]) => [key, label])), not_ecommerce: "No Ecommerce" },
      value: (row) => row.ads_funnel_type || "unknown",
      filterValue: (row) => row.ads_funnel_type || "unknown",
      render: (row) => renderAdsFunnelBadge(row.ads_funnel_type || "unknown", row.ads_funnel_confidence)
    },
    {
      key: "ads_meta_active",
      label: "Meta Ads",
      width: 96,
      filter: "boolean",
      value: (row) => crmBoolValue(row.ads_meta_active),
      render: (row) => renderAdsBadge(row.ads_meta_active, "Meta")
    },
    {
      key: "meta_ads_estimate",
      label: "Estim. Meta",
      width: 118,
      filter: "estimate",
      value: (row) => hasMetaAdsEstimate(row) ? "true" : "false",
      sortValue: (row) => {
        const value = Number(row.meta_ads_estimated_spend_max);
        return Number.isFinite(value) ? value : null;
      },
      render: (row) => renderMetaAdsEstimateBadge(row, { compact: true })
    },
    {
      key: "ads_google_active",
      label: "Google Ads",
      width: 102,
      filter: "boolean",
      value: (row) => crmBoolValue(row.ads_google_active),
      render: (row) => renderAdsBadge(row.ads_google_active, "Google")
    }
  ];
}

function renderCrmTable({ rows, total, rendered, columns, options, state, kind, emptyTitle, emptyCopy }) {
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  return `
    <div class="table-wrap crm-table-wrap">
      <table class="table crm-table crm-table--${escape(kind)}" style="min-width:${tableWidth}px">
        <colgroup>
          ${columns.map((column) => `<col style="width:${Number(column.width) || 160}px" />`).join("")}
        </colgroup>
        <thead>
          <tr>${columns.map((column) => renderCrmHeaderCell(column, state)).join("")}</tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows.map((row) => renderCrmRow(row, columns, options)).join("")
              : `<tr><td colspan="${columns.length}">${emptyState(emptyTitle, emptyCopy)}</td></tr>`
          }
        </tbody>
      </table>
      <div class="crm-table-footer">
        <span>Mostrando ${fmtNumber(rendered)} de ${fmtNumber(total)}</span>
        ${
          rendered < total
            ? `<button class="btn btn--sm btn--ghost" data-action="crm-load-more" data-crm-kind="${escape(kind)}" type="button">Cargar ${fmtNumber(Math.min(CRM_PAGE_SIZE, total - rendered))} más</button>`
            : ""
        }
      </div>
    </div>
  `;
}

function renderCrmHeaderCell(column, state) {
  const sorted = state.sortKey === column.key;
  const sortMark = sorted ? (state.sortDir === "asc" ? "↑" : "↓") : "↕";
  return `
    <th draggable="true" data-crm-column="${escape(column.key)}">
      <div class="crm-th">
        <button class="crm-th__sort" data-action="crm-sort" data-column-key="${escape(column.key)}" type="button" title="Ordenar por ${escape(column.label)}">
          <span>${escape(column.label)}</span>
          <i aria-hidden="true">${sortMark}</i>
        </button>
        <span class="crm-th__drag" title="Arrastrar columna">⋮⋮</span>
      </div>
      ${renderCrmColumnFilter(column, state.filters[column.key] || "")}
    </th>
  `;
}

function renderCrmColumnFilter(column, selected) {
  if (column.filter === "phone_type") {
    return `
      <select class="crm-column-filter" data-crm-column-filter="${escape(column.key)}">
        <option value="">Todos</option>
        ${renderPhoneTypeOptions(selected)}
      </select>
    `;
  }
  if (column.filter === "select") {
    return `
      <select class="crm-column-filter" data-crm-column-filter="${escape(column.key)}">
        <option value="">Todos</option>
        ${renderOptions(column.options || [], selected, column.labels || {})}
      </select>
    `;
  }
  if (column.filter === "boolean") {
    return `
      <select class="crm-column-filter" data-crm-column-filter="${escape(column.key)}">
        <option value="">Todos</option>
        <option value="true" ${selected === "true" ? "selected" : ""}>Activo</option>
        <option value="false" ${selected === "false" ? "selected" : ""}>Sin señal</option>
        <option value="unknown" ${selected === "unknown" ? "selected" : ""}>Sin revisar</option>
      </select>
    `;
  }
  if (column.filter === "estimate") {
    return `
      <select class="crm-column-filter" data-crm-column-filter="${escape(column.key)}">
        <option value="">Todos</option>
        <option value="true" ${selected === "true" ? "selected" : ""}>Con estimación</option>
        <option value="false" ${selected === "false" ? "selected" : ""}>Sin dato</option>
      </select>
    `;
  }
  const type = column.filter === "date" ? "date" : "search";
  const placeholder = column.filter === "number" ? ">=100 / 100-500" : "Filtrar";
  return `<input class="crm-column-filter" data-crm-column-filter="${escape(column.key)}" type="${type}" value="${escape(selected)}" placeholder="${escape(placeholder)}" />`;
}

function renderCrmRow(row, columns, options) {
  return `
    <tr data-business-id="${escape(row.business_id)}" class="${row.first_contact_at ? "is-called" : ""}">
      ${columns.map((column) => `<td data-column-key="${escape(column.key)}">${column.render(row, options)}</td>`).join("")}
    </tr>
  `;
}

function bindCrmQuickFilters(board, state, render) {
  const update = (immediate = false) => {
    state.limits = { active: CRM_PAGE_SIZE, discarded: CRM_PAGE_SIZE };
    if (immediate) return render();
    window.clearTimeout(board.__crmFilterTimer);
    board.__crmFilterTimer = window.setTimeout(render, 120);
  };
  $$("[data-crm-quick-filter]", board).forEach((control) => {
    const key = control.dataset.crmQuickFilter;
    const eventName = control.tagName === "SELECT" ? "change" : "input";
    control.addEventListener(eventName, () => {
      state.quick[key] = control.value;
      update(control.tagName === "SELECT");
    });
  });
  $("[data-action='crm-reset-filters']", board)?.addEventListener("click", () => {
    state.quick = {};
    state.filters = {};
    state.sortKey = "";
    state.sortDir = "asc";
    state.limits = { active: CRM_PAGE_SIZE, discarded: CRM_PAGE_SIZE };
    $$("[data-crm-quick-filter]", board).forEach((control) => {
      control.value = "";
    });
    render();
  });
}

function bindCrmTableControls(board, state, render) {
  $$("[data-action='crm-sort']", board).forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.columnKey;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      render();
    });
  });

  $$("[data-crm-column-filter]", board).forEach((control) => {
    const apply = () => {
      const key = control.dataset.crmColumnFilter;
      if (control.value) state.filters[key] = control.value;
      else delete state.filters[key];
      state.limits = { active: CRM_PAGE_SIZE, discarded: CRM_PAGE_SIZE };
      render();
    };
    control.addEventListener("change", apply);
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter") control.blur();
    });
  });

  $$("[data-action='crm-load-more']", board).forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.crmKind === "discarded" ? "discarded" : "active";
      state.limits[kind] += CRM_PAGE_SIZE;
      render();
    });
  });

  $$("th[data-crm-column]", board).forEach((header) => {
    header.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", header.dataset.crmColumn);
      header.classList.add("is-dragging");
    });
    header.addEventListener("dragend", () => {
      header.classList.remove("is-dragging");
    });
    header.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    header.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = event.dataTransfer.getData("text/plain");
      const to = header.dataset.crmColumn;
      if (!from || !to || from === to) return;
      state.columnOrder = moveCrmColumn(state.columnOrder, from, to);
      saveCrmColumnOrder(state.columnOrder);
      render();
    });
  });
}

function applyCrmTableState(rows, columns, state) {
  const filtered = rows.filter((row) => crmMatchesQuickFilters(row, columns, state.quick) && crmMatchesColumnFilters(row, columns, state.filters));
  if (!state.sortKey) return filtered;
  const column = columns.find((item) => item.key === state.sortKey);
  if (!column) return filtered;
  const dir = state.sortDir === "desc" ? -1 : 1;
  return [...filtered].sort((a, b) => compareCrmValues(getCrmSortValue(column, a), getCrmSortValue(column, b)) * dir);
}

function crmMatchesQuickFilters(row, columns, quick = {}) {
  const search = normalizeCrmText(quick.search);
  if (search) {
    const haystack = normalizeCrmText(columns.map((column) => column.value(row)).join(" "));
    if (!haystack.includes(search)) return false;
  }
  if (quick.phoneType) {
    const type = crmPhoneType(row);
    if (quick.phoneType === "with_phone" && type === "none") return false;
    else if (quick.phoneType === "without_phone" && type !== "none") return false;
    else if (!["with_phone", "without_phone"].includes(quick.phoneType) && type !== quick.phoneType) return false;
  }
  if (quick.city && row.city !== quick.city) return false;
  if (quick.niche && row.niche !== quick.niche) return false;
  if (quick.adsFunnelType && !crmMatchesFunnelFilter(row.ads_funnel_type || "unknown", quick.adsFunnelType)) return false;
  if (quick.metaAds && crmBoolValue(row.ads_meta_active) !== quick.metaAds) return false;
  if (quick.hasMetaEstimate && String(hasMetaAdsEstimate(row)) !== quick.hasMetaEstimate) return false;
  if (quick.googleAds && crmBoolValue(row.ads_google_active) !== quick.googleAds) return false;
  return true;
}

function crmMatchesColumnFilters(row, columns, filters = {}) {
  return Object.entries(filters).every(([key, filter]) => {
    if (!filter) return true;
    const column = columns.find((item) => item.key === key);
    if (!column) return true;
    const value = column.filterValue ? column.filterValue(row) : column.value(row);
    if (column.filter === "phone_type") {
      if (filter === "with_phone") return value !== "none";
      if (filter === "without_phone") return value === "none";
      return value === filter;
    }
    if (column.filter === "estimate") return String(hasMetaAdsEstimate(row)) === String(filter);
    if (key === "ads_funnel_type") return crmMatchesFunnelFilter(value || "unknown", filter);
    if (column.filter === "select" || column.filter === "boolean") return String(value ?? "") === String(filter);
    if (column.filter === "date") return String(value || "") === String(filter);
    return normalizeCrmText(value).includes(normalizeCrmText(filter));
  });
}

function crmMatchesFunnelFilter(value, filter) {
  if (!filter) return true;
  const normalized = value || "unknown";
  if (filter === "not_ecommerce") return normalized !== "ecommerce";
  return normalized === filter;
}

function getCrmSortValue(column, row) {
  if (column.sortValue) return column.sortValue(row);
  return column.value(row);
}

function compareCrmValues(a, b) {
  const emptyA = a == null || a === "";
  const emptyB = b == null || b === "";
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;
  const numberA = typeof a === "number" ? a : Number.NaN;
  const numberB = typeof b === "number" ? b : Number.NaN;
  if (!Number.isNaN(numberA) && !Number.isNaN(numberB)) return numberA - numberB;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

function orderedCrmColumns(columns, order) {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const ordered = (order || []).map((key) => byKey.get(key)).filter(Boolean);
  const missing = columns.filter((column) => !ordered.some((item) => item.key === column.key));
  return [...ordered, ...missing];
}

function loadCrmColumnOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CRM_COLUMN_ORDER_KEY) || "[]");
    if (Array.isArray(parsed) && isValidCrmColumnOrder(parsed)) return parsed;
    localStorage.removeItem(CRM_COLUMN_ORDER_KEY);
  } catch {
    try {
      localStorage.removeItem(CRM_COLUMN_ORDER_KEY);
    } catch {}
  }
  return [...CRM_DEFAULT_COLUMNS];
}

function isValidCrmColumnOrder(order) {
  if (!Array.isArray(order) || !order.length) return false;
  const allowed = new Set(CRM_DEFAULT_COLUMNS);
  return order.every((key) => allowed.has(key));
}

function saveCrmColumnOrder(order) {
  try {
    localStorage.setItem(CRM_COLUMN_ORDER_KEY, JSON.stringify(order));
  } catch {}
}

function moveCrmColumn(order, from, to) {
  const current = [...new Set([...(order || CRM_DEFAULT_COLUMNS), ...CRM_DEFAULT_COLUMNS])];
  const fromIndex = current.indexOf(from);
  const toIndex = current.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return current;
  const [item] = current.splice(fromIndex, 1);
  current.splice(toIndex, 0, item);
  return current;
}

function renderOptions(values = [], selected = "", labels = {}) {
  return uniqueStrings(values)
    .map((value) => {
      const label = labels[value] || value;
      return `<option value="${escape(value)}" ${value === selected ? "selected" : ""}>${escape(label)}</option>`;
    })
    .join("");
}

function uniqueCrmValues(rows, key) {
  return uniqueStrings(rows.map((row) => row?.[key]));
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base", numeric: true })
  );
}

function normalizeCrmText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function crmPhoneType(row) {
  const raw = String(row.phone_e164 || row.phone || "").trim();
  if (!raw) return "none";
  const digits = raw.replace(/\D/g, "");
  let local = digits;
  if (local.startsWith("0034")) local = local.slice(4);
  else if (local.startsWith("34") && local.length === 11) local = local.slice(2);
  const first = local[0];
  if (first === "6" || first === "7") return "mobile";
  if (first === "8" || first === "9") return "fixed";
  return "unknown";
}

function crmPhoneLabel(type) {
  return { mobile: "Móvil", fixed: "Fijo", unknown: "Otro" }[type] || "";
}

function crmBoolValue(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unknown";
}

function crmReadonly(value) {
  return value ? `<span class="crm-readonly">${escape(value)}</span>` : `<span class="faint">—</span>`;
}

function renderEditableCrmFirstContact(row = {}) {
  return `
    <div class="crm-called-date ${row.first_contact_at ? "is-called" : ""}">
      ${crmInput("firstContactAt", row.first_contact_at, "date", `crm-input--date ${row.first_contact_at ? "crm-input--called" : ""}`)}
      ${row.first_contact_at ? `<span>Llamado</span>` : ""}
    </div>
  `;
}

function renderCrmFirstContact(row = {}) {
  return row.first_contact_at
    ? `<span class="crm-called-pill">${escape(row.first_contact_at)}<small>Llamado</small></span>`
    : `<span class="faint">—</span>`;
}

function renderCrmBusinessCell(row) {
  return `
    <a class="crm-business" href="#/leads/${escape(row.business_id)}">
      <span>${escape(row.name)}</span>
      <small>${escape([row.city, row.niche].filter(Boolean).join(" · ") || "Lead")}</small>
    </a>
  `;
}

function renderCrmPhone(row) {
  const phone = row.phone_e164 || row.phone;
  const type = crmPhoneType(row);
  return phone
    ? `<div class="crm-phone-cell"><a class="mono crm-phone" href="tel:${escape(phone)}">${escape(phone)}</a>${type !== "none" ? `<span class="crm-phone-type crm-phone-type--${escape(type)}">${escape(crmPhoneLabel(type))}</span>` : ""}</div>`
    : `<span class="faint">—</span>`;
}

function renderCrmWebsite(row) {
  return row.website
    ? `<a class="mono crm-url" href="${escape(row.website)}" target="_blank" rel="noopener">${escape(stripScheme(row.website))}</a>`
    : `<span class="faint">—</span>`;
}

function crmInput(field, value, type = "text", extraClass = "", placeholder = "") {
  return `<input class="crm-input ${escape(extraClass)}" data-crm-field="${escape(field)}" type="${escape(type)}" value="${escape(value || "")}" placeholder="${escape(placeholder)}" />`;
}

function crmTextarea(field, value, extraClass = "") {
  return `<textarea class="crm-textarea ${escape(extraClass)}" data-crm-field="${escape(field)}" rows="2">${escape(value || "")}</textarea>`;
}

function crmSelect(field, value, options, allowBlank = false) {
  const safeValue = value || "";
  const selectOptions = Array.from(new Set([...(allowBlank ? [""] : []), ...(options || []), safeValue].filter((option) => allowBlank || option)));
  return `
    <select class="crm-input crm-select" data-crm-field="${escape(field)}">
      ${selectOptions
        .map((option) => `<option value="${escape(option)}" ${option === safeValue ? "selected" : ""}>${escape(option || "—")}</option>`)
        .join("")}
    </select>
  `;
}

function crmObjectionInput(value) {
  return `<input class="crm-input crm-input--objection" data-crm-field="objection" list="crm-objection-options" value="${escape(value || "")}" />`;
}

function bindCrmEditableControls(board) {
  const saveState = $("[data-bind='crm-save-state']", board);
  $$("[data-crm-field]", board).forEach((control) => {
    control.dataset.lastValue = control.value;
    const eventName = control.tagName === "SELECT" || control.type === "date" || control.type === "time" ? "change" : "blur";
    control.addEventListener(eventName, () => saveCrmControl(control, board, saveState));
    if (control.tagName === "TEXTAREA") {
      control.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") control.blur();
      });
    }
  });
}

async function saveCrmControl(control, board, saveState) {
  if (control.value === control.dataset.lastValue) return;
  const row = control.closest("tr[data-business-id]");
  if (!row) return;
  const listId = board.dataset.listId;
  const businessId = row.dataset.businessId;
  const field = control.dataset.crmField;
  control.classList.add("is-saving");
  control.classList.remove("is-saved", "is-error");
  if (saveState) saveState.textContent = "Guardando...";
  try {
    await api(`/api/lead-lists/${encodeURIComponent(listId)}/businesses/${encodeURIComponent(businessId)}/crm`, {
      method: "PATCH",
      body: JSON.stringify({ [field]: control.value })
    });
    control.dataset.lastValue = control.value;
    control.classList.remove("is-saving");
    control.classList.add("is-saved");
    const changedKey = updateCrmLocalRow(board, businessId, field, control.value);
    if (field === "objection" && control.value) appendCrmObjectionOption(board, control.value);
    if (saveState) saveState.textContent = "Guardado";
    setTimeout(() => control.classList.remove("is-saved"), 900);
    if (shouldRerenderCrmAfterSave(board, field, changedKey)) window.setTimeout(() => board.__crmRender?.(), 120);
  } catch (err) {
    control.classList.remove("is-saving");
    control.classList.add("is-error");
    if (saveState) saveState.textContent = "Error al guardar";
    toast(`No se pudo guardar (${err.message})`, "error");
  }
}

function updateCrmLocalRow(board, businessId, field, value) {
  const row = board.__crmRows?.find((item) => item.business_id === businessId);
  if (!row) return "";
  const key = {
    firstContactAt: "first_contact_at",
    decisionMakerName: "decision_maker_name",
    decisionMakerEmail: "decision_maker_email",
    answeredBy: "answered_by",
    crmStatus: "crm_status",
    checkpoint: "checkpoint",
    objection: "objection",
    followUpDate: "follow_up_date",
    followUpTime: "follow_up_time",
    nextAction: "next_action",
    observations: "observations"
  }[field];
  if (!key) return "";
  row[key] = value || (key === "crm_status" ? "Nuevo" : null);
  return key;
}

function shouldRerenderCrmAfterSave(board, field, changedKey) {
  if (field === "crmStatus") return true;
  const state = board.__crmState;
  if (!state || !changedKey) return false;
  if (state.sortKey === changedKey) return true;
  if (state.filters?.[changedKey]) return true;
  return Boolean(state.quick?.search);
}

function appendCrmObjectionOption(board, value) {
  const list = $("#crm-objection-options", board);
  if (!list || Array.from(list.options).some((option) => option.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  list.appendChild(option);
}

function openListModal() {
  const form = document.createElement("form");
  form.innerHTML = `
    <div class="field"><label>Nombre</label><input class="input" name="name" required placeholder="Prioridad Madrid" /></div>
    <div class="field"><label>Descripción</label><textarea class="textarea" name="description" placeholder="Criterio interno, cliente, vertical o siguiente acción"></textarea></div>
    <div class="field">
      <label>Color</label>
      <select class="select" name="color">
        <option value="gold">Gold</option>
        <option value="green">Green</option>
        <option value="cyan">Cyan</option>
        <option value="burgundy">Burgundy</option>
        <option value="zinc">Zinc</option>
      </select>
    </div>
  `;
  const footer = document.createDocumentFragment();
  const cancel = btn("Cancelar", "ghost");
  const submit = btn("Crear lista", "primary");
  cancel.addEventListener("click", closeModal);
  submit.addEventListener("click", async () => {
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name) return toast("El nombre es obligatorio", "error");
    submit.disabled = true;
    try {
      const res = await api("/api/lead-lists", { method: "POST", body: JSON.stringify(data) });
      toast("Lista creada", "ok");
      closeModal();
      location.hash = `#/lists/${res.list.id}`;
    } catch (err) {
      toast(`No se pudo crear (${err.message})`, "error");
    } finally {
      submit.disabled = false;
    }
  });
  footer.append(cancel, submit);
  openModal({ title: "Nueva lista", body: form, footer });
}

// ── Analytics ────────────────────────────────────────────
async function renderAnalytics({ search }) {
  setCurrentCrumb("Cold Calling");
  const dates = defaultAnalyticsDates();
  const scopeType = search.get("scopeType") || "all";
  const scopeId = search.get("scopeId") || "";
  const from = search.get("from") || dates.from;
  const to = search.get("to") || dates.to;

  const [lists, campaigns, settingsData, analyticsData] = await Promise.all([
    api("/api/lead-lists"),
    api("/api/campaigns?limit=200"),
    api("/api/analytics/settings"),
    api(`/api/analytics/cold-calling?${analyticsQuery({ scopeType, scopeId, from, to })}`)
  ]);
  const analytics = analyticsData.analytics || {};
  const settings = settingsData.settings || {};
  const suggestedAppointmentRate = Math.round((analytics.rates?.scheduledRate || 0) * 1000) / 10;
  const appointmentRate = settings.appointmentRate ?? suggestedAppointmentRate;

  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Analítica</h1>
        <p class="subhead">Embudo de llamadas y previsión mensual.</p>
      </div>
    </div>

    <form class="analytics-filters" id="analytics-filters">
      <select class="select" name="scopeType" data-bind="analytics-scope-type">
        <option value="all" ${scopeType === "all" ? "selected" : ""}>Todo</option>
        <option value="list" ${scopeType === "list" ? "selected" : ""}>Lista</option>
        <option value="campaign" ${scopeType === "campaign" ? "selected" : ""}>Campaña</option>
      </select>
      <select class="select" name="scopeId" data-bind="analytics-scope-id"></select>
      <input class="input" type="date" name="from" value="${escape(from)}" />
      <input class="input" type="date" name="to" value="${escape(to)}" />
      <button class="btn" type="submit">Filtrar</button>
      <a class="btn btn--ghost" href="#/analytics">Reset</a>
    </form>

    <section class="analytics-hero">
      <article class="metric-hero metric-hero--calls">
        <span>Total llamadas</span>
        <strong>${fmtNumber(analytics.counts?.totalCalls || 0)}</strong>
      </article>
      <article class="metric-hero metric-hero--rate">
        <span>Tasa de agendamiento</span>
        <strong>${fmtPercentRatio(analytics.rates?.scheduledRate || 0, 1)}</strong>
      </article>
      <article class="metric-hero">
        <span>Agendadas</span>
        <strong>${fmtNumber(analytics.counts?.scheduledCalls || 0)}</strong>
      </article>
    </section>

    <section class="analytics-grid">
      <article class="analytics-panel funnel-panel">
        <div class="analytics-panel__head">
          <div>
            <h2>Embudo</h2>
            <p>${escape(formatAnalyticsPeriod(analytics.meta, from, to))}</p>
          </div>
          <div class="funnel-toggle" data-bind="funnel-mode">
            <button class="is-active" type="button" data-mode="total">Sobre total</button>
            <button type="button" data-mode="drop">Caída</button>
          </div>
        </div>
        <div data-bind="funnel-steps">${renderFunnelSteps(analytics, "total")}</div>
      </article>

      <article class="analytics-panel analytics-panel--compact">
        <h2>Señales</h2>
        <div class="analytics-signal-grid">
          ${analyticsSignal("No lo coge", analytics.counts?.noAnswerCalls || 0)}
          ${analyticsSignal("Secretaria", analytics.counts?.secretaryCalls || 0)}
          ${analyticsSignal("Objeción inicial", analytics.counts?.initialObjectionCalls || 0)}
          ${analyticsSignal("Decisor", analytics.counts?.decisionMakerCalls || 0)}
        </div>
      </article>
    </section>

    <section class="analytics-panel forecast-panel">
      <div class="analytics-panel__head">
        <div>
          <h2>Previsión</h2>
          <p>Proyección del próximo mes (30 días)</p>
        </div>
        <button class="btn btn--primary" type="button" data-action="save-forecast">Guardar previsión</button>
      </div>

      <form class="forecast-controls" data-bind="forecast-form">
        ${forecastInput("appointmentRate", "Tasa agendamiento", appointmentRate, "%")}
        ${forecastInput("qualificationRate", "Tasa cualificación", settings.qualificationRate ?? 70, "%")}
        ${forecastInput("closeRate", "Tasa cierre", settings.closeRate ?? 30, "%")}
        ${forecastInput("showUpRate", "Show-Up", settings.showUpRate ?? 80, "%")}
        ${forecastInput("offerPrice", "Precio oferta", settings.offerPrice ?? 3000, "€")}
        ${forecastInput("firstMonthPrice", "Precio oferta primer mes", settings.firstMonthPrice ?? 1000, "€")}
        ${forecastInput("revenueTarget", "Objetivo facturación", settings.revenueTarget ?? 10000, "€")}
        <button class="btn btn--ghost" type="button" data-action="use-period-appointment">Usar periodo</button>
      </form>

      <div data-bind="forecast-table"></div>
    </section>
  `;

  const scopeTypeSelect = $("[data-bind='analytics-scope-type']", view);
  const scopeIdSelect = $("[data-bind='analytics-scope-id']", view);
  const populateScopeId = () => {
    scopeIdSelect.innerHTML = renderAnalyticsScopeOptions(scopeTypeSelect.value, scopeIdSelect.value || scopeId, lists.rows || [], campaigns.rows || []);
    scopeIdSelect.disabled = scopeTypeSelect.value === "all";
  };
  populateScopeId();
  scopeTypeSelect.addEventListener("change", () => {
    scopeIdSelect.value = "";
    populateScopeId();
  });

  $("#analytics-filters", view).addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const params = new URLSearchParams();
    for (const [key, value] of data.entries()) {
      if (key === "scopeId" && form.elements.scopeType.value === "all") continue;
      if (value) params.set(key, value);
    }
    location.hash = `#/analytics${params.toString() ? "?" + params.toString() : ""}`;
  });

  bindFunnelToggle(analytics);
  bindForecastControls(settings, suggestedAppointmentRate);
}

function analyticsQuery({ scopeType, scopeId, from, to }) {
  const params = new URLSearchParams();
  if (scopeType) params.set("scopeType", scopeType);
  if (scopeId) params.set("scopeId", scopeId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params.toString();
}

function defaultAnalyticsDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 29);
  return { from: dateToInput(from), to: dateToInput(to) };
}

function dateToInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderAnalyticsScopeOptions(type, selected, lists, campaigns) {
  if (type === "list") {
    return `<option value="">Todas las listas</option>${lists
      .map((list) => `<option value="${escape(list.id)}" ${selected === list.id ? "selected" : ""}>${escape(list.name)}</option>`)
      .join("")}`;
  }
  if (type === "campaign") {
    return `<option value="">Todas las campañas</option>${campaigns
      .map(
        (campaign) =>
          `<option value="${escape(campaign.id)}" ${selected === campaign.id ? "selected" : ""}>${escape(campaign.niche)} · ${escape(campaign.city)}</option>`
      )
      .join("")}`;
  }
  return `<option value="">Todo el workspace</option>`;
}

function formatAnalyticsPeriod(meta = {}, from, to) {
  const actualFrom = meta.firstContactFrom ? String(meta.firstContactFrom).slice(0, 10) : from;
  const actualTo = meta.firstContactTo ? String(meta.firstContactTo).slice(0, 10) : to;
  return `${actualFrom || "—"} a ${actualTo || "—"}`;
}

function renderFunnelSteps(analytics, mode) {
  const steps = analytics.steps || [];
  const total = steps[0]?.count || 0;
  return `
    <div class="funnel-steps">
      ${steps
        .map((step, index) => {
          const previous = index === 0 ? total : steps[index - 1]?.count || 0;
          const ratio = mode === "drop"
            ? index === 0
              ? 0
              : safeRatio(Math.max(0, previous - step.count), previous)
            : safeRatio(step.count, total);
          const width = mode === "drop" && index === 0 ? 0 : Math.max(3, Math.round(ratio * 100));
          const suffix = mode === "drop" && index > 0 ? " caída" : "";
          return `
            <div class="funnel-step">
              <div class="funnel-step__top">
                <strong>${escape(step.label)}</strong>
                <span>${fmtNumber(step.count)} · ${fmtPercentRatio(ratio, 1)}${suffix}</span>
              </div>
              <div class="funnel-step__bar"><i style="width:${width}%"></i></div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function safeRatio(part, total) {
  return Number(total) > 0 ? (Number(part) || 0) / Number(total) : 0;
}

function analyticsSignal(label, value) {
  return `
    <div class="analytics-signal">
      <span>${escape(label)}</span>
      <strong>${fmtNumber(value)}</strong>
    </div>
  `;
}

function bindFunnelToggle(analytics) {
  const host = $("[data-bind='funnel-mode']", view);
  const steps = $("[data-bind='funnel-steps']", view);
  if (!host || !steps) return;
  host.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    $$("button[data-mode]", host).forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    steps.innerHTML = renderFunnelSteps(analytics, button.dataset.mode);
  });
}

function forecastInput(name, label, value, suffix) {
  return `
    <label class="forecast-control">
      <span>${escape(label)}</span>
      <b>${escape(suffix)}</b>
      <input class="input" name="${escape(name)}" type="number" min="0" step="0.01" value="${escape(value ?? "")}" />
    </label>
  `;
}

function bindForecastControls(settings, suggestedAppointmentRate) {
  const form = $("[data-bind='forecast-form']", view);
  const table = $("[data-bind='forecast-table']", view);
  if (!form || !table) return;
  const render = () => {
    table.innerHTML = renderForecastTable(readForecastForm(form));
  };
  render();
  form.addEventListener("input", render);
  $("[data-action='use-period-appointment']", form).addEventListener("click", () => {
    form.elements.appointmentRate.value = suggestedAppointmentRate;
    render();
  });
  $("[data-action='save-forecast']", view).addEventListener("click", async () => {
    const button = $("[data-action='save-forecast']", view);
    button.disabled = true;
    try {
      await api("/api/analytics/settings", {
        method: "PATCH",
        body: JSON.stringify({ settings: readForecastForm(form) })
      });
      toast("Previsión guardada", "ok");
    } catch (err) {
      toast(`No se pudo guardar (${err.message})`, "error");
    } finally {
      button.disabled = false;
    }
  });
}

function readForecastForm(form) {
  return {
    appointmentRate: readNumber(form.elements.appointmentRate.value, 0),
    qualificationRate: readNumber(form.elements.qualificationRate.value, 0),
    closeRate: readNumber(form.elements.closeRate.value, 0),
    showUpRate: readNumber(form.elements.showUpRate.value, 0),
    offerPrice: readNumber(form.elements.offerPrice.value, 0),
    firstMonthPrice: readNumber(form.elements.firstMonthPrice.value, 0),
    revenueTarget: readNumber(form.elements.revenueTarget.value, 0)
  };
}

function readNumber(value, fallback) {
  const number = Number(String(value || "").replace(",", "."));
  return Number.isFinite(number) ? number : fallback;
}

function renderForecastTable(input) {
  const projections = buildForecastProjections(input);
  const rows = [
    ["Clientes requeridos", "clientsRequired"],
    ["Llamadas calificadas agendadas", "qualifiedSalesCalls"],
    ["Llamadas atendidas", "attendedSalesCalls"],
    ["Llamadas agendadas (total)", "scheduledSalesCalls"],
    ["Llamadas requeridas por mes", "monthlyColdCalls"],
    ["Llamadas requeridas por día", "dailyColdCalls"]
  ];
  return `
    <div class="forecast-table-wrap">
      <table class="forecast-table">
        <thead>
          <tr>
            <th></th>
            ${projections.map((projection) => `<th>${escape(projection.label)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              ([label, key]) => `
              <tr>
                <td>${escape(label)}</td>
                ${projections.map((projection) => `<td>${fmtNumber(projection[key])}</td>`).join("")}
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function buildForecastProjections(input) {
  const totalClients = input.offerPrice > 0 ? input.revenueTarget / input.offerPrice : 0;
  const cashClients = input.firstMonthPrice > 0 ? input.revenueTarget / input.firstMonthPrice : 0;
  const realClients = (totalClients + cashClients) / 2;
  return [
    buildForecastProjection("Total ventas", totalClients, input),
    buildForecastProjection("Cash en cuenta", cashClients, input, true),
    buildForecastProjection("Pronóstico real", realClients, input)
  ];
}

function buildForecastProjection(label, rawClients, input, highlight = false) {
  const closeRate = percentToDecimal(input.closeRate);
  const qualificationRate = percentToDecimal(input.qualificationRate);
  const showUpRate = percentToDecimal(input.showUpRate);
  const appointmentRate = percentToDecimal(input.appointmentRate);
  const clientsRequired = Math.ceil(rawClients || 0);
  const qualifiedSalesCalls = ceilByRate(clientsRequired, closeRate);
  const attendedSalesCalls = ceilByRate(qualifiedSalesCalls, qualificationRate);
  const scheduledSalesCalls = ceilByRate(attendedSalesCalls, showUpRate);
  const monthlyColdCalls = ceilByRate(scheduledSalesCalls, appointmentRate);
  return {
    label,
    highlight,
    clientsRequired,
    qualifiedSalesCalls,
    attendedSalesCalls,
    scheduledSalesCalls,
    monthlyColdCalls,
    dailyColdCalls: Math.ceil(monthlyColdCalls / 30)
  };
}

function percentToDecimal(value) {
  const number = Number(value) || 0;
  return Math.min(Math.max(number / 100, 0.001), 1);
}

function ceilByRate(value, rate) {
  return Math.ceil((Number(value) || 0) / Math.max(rate, 0.001));
}

// ── Scoring ──────────────────────────────────────────────
async function renderScoring() {
  setCurrentCrumb("Reglas");
  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Scoring</h1>
        <p class="subhead">Edita cuánto pesa cada señal. Ads ya puede sumar al score; chatbot queda fuera del cálculo por defecto.</p>
      </div>
      <button class="btn" data-action="rescore-all" type="button">Re-scorear todos</button>
      <button class="btn btn--primary" data-action="save-scoring-rules" type="button">Guardar reglas</button>
    </div>
    <div class="scoring-layout">
      <form class="rules-panel" data-bind="rules">${rowSkeleton(6)}</form>
      <aside class="scoring-aside">
        <div class="card">
          <h3>Cómo se aplica</h3>
          <p class="muted" style="margin:0;line-height:1.6">Las reglas se evalúan en orden. Rating, reseñas y presencia web usan grupos excluyentes para no sumar dos veces el mismo concepto. El resultado se limita a 100.</p>
        </div>
        <div class="card">
          <h3>Canal automático</h3>
          <dl class="kv">
            <dt>70+</dt><dd>Llamada si hay teléfono</dd>
            <dt>50-69</dt><dd>Llamada y seguimiento</dd>
            <dt>Email</dt><dd>Si no hay teléfono y sí email</dd>
          </dl>
        </div>
      </aside>
    </div>
  `;
  const data = await api("/api/scoring/rules");
  renderScoringRules(data.rules || []);
  $("[data-action='save-scoring-rules']", view).addEventListener("click", saveScoringRules);
  $("[data-action='rescore-all']", view).addEventListener("click", rescoreAllLeads);
}

function renderScoringRules(rules) {
  const host = $("[data-bind='rules']", view);
  host.innerHTML = rules
    .map(
      (rule) => `
      <label class="rule-row" data-rule-id="${escape(rule.id)}">
        <input class="rule-row__toggle" type="checkbox" name="${escape(rule.id)}:enabled" ${rule.enabled ? "checked" : ""} />
        <span class="rule-row__main">
          <strong>${escape(rule.label)}</strong>
          <span>${escape(rule.description || rule.condition)}</span>
        </span>
        <span class="rule-row__points">
          <input class="input mono" type="number" name="${escape(rule.id)}:points" value="${escape(rule.points)}" min="-100" max="100" />
          <span>pts</span>
        </span>
        <input type="hidden" name="${escape(rule.id)}:payload" value="${escape(JSON.stringify(rule))}" />
      </label>`
    )
    .join("");
}

async function saveScoringRules() {
  const button = $("[data-action='save-scoring-rules']", view);
  const form = $("[data-bind='rules']", view);
  const rules = $$("[data-rule-id]", form).map((row) => {
    const id = row.dataset.ruleId;
    const payload = JSON.parse($(`input[name='${CSS.escape(id)}:payload']`, row).value);
    return {
      ...payload,
      enabled: $(`input[name='${CSS.escape(id)}:enabled']`, row).checked,
      points: Number($(`input[name='${CSS.escape(id)}:points']`, row).value)
    };
  });
  button.disabled = true;
  try {
    await api("/api/scoring/rules", { method: "PATCH", body: JSON.stringify({ rules }) });
    toast("Reglas guardadas", "ok");
  } catch (err) {
    toast(`No se pudo guardar scoring (${err.message})`, "error");
  } finally {
    button.disabled = false;
  }
}

async function rescoreAllLeads() {
  const button = $("[data-action='rescore-all']", view);
  button.disabled = true;
  try {
    const result = await api("/api/scoring/rescore", { method: "POST", body: "{}" });
    toast(`${fmtNumber(result.queued)} leads enviados a scoring`, "ok");
  } catch (err) {
    toast(`No se pudo re-scorear (${err.message})`, "error");
  } finally {
    button.disabled = false;
  }
}

// ── Calls list ────────────────────────────────────────────
async function renderCallsList({ search }) {
  setCurrentCrumb("Lista");
  const outcome = search.get("outcome") || "";
  const qualified = search.get("qualified") || "";

  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Llamadas</h1>
        <p class="subhead">Conversaciones de Nebrija AI con tus leads.</p>
      </div>
    </div>

    <form class="table-wrap" id="calls-filters" style="margin-bottom:14px">
      <div class="table-toolbar">
        <select class="select" name="outcome" style="max-width:200px">
          <option value="">Cualquier outcome</option>
          <option value="qualified" ${outcome === "qualified" ? "selected" : ""}>qualified</option>
          <option value="callback" ${outcome === "callback" ? "selected" : ""}>callback</option>
          <option value="no_qualified" ${outcome === "no_qualified" ? "selected" : ""}>no_qualified</option>
        </select>
        <select class="select" name="qualified" style="max-width:200px">
          <option value="">Cualquier cualificación</option>
          <option value="true" ${qualified === "true" ? "selected" : ""}>Cualificados</option>
          <option value="false" ${qualified === "false" ? "selected" : ""}>No cualificados</option>
        </select>
        <button class="btn" type="submit">Filtrar</button>
        <a class="btn btn--ghost" href="#/calls">Reset</a>
      </div>
    </form>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Lead</th>
            <th>Inicio</th>
            <th>Estado</th>
            <th>Outcome</th>
            <th class="col-num">Duración</th>
            <th class="col-num">Coste</th>
            <th>Resumen</th>
          </tr>
        </thead>
        <tbody data-bind="rows"><tr><td colspan="7" style="padding:40px;text-align:center"><span class="spinner"></span></td></tr></tbody>
      </table>
    </div>
  `;

  $("#calls-filters").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (v) params.set(k, v);
    location.hash = `#/calls${params.toString() ? "?" + params.toString() : ""}`;
  });

  const params = new URLSearchParams();
  if (outcome) params.set("outcome", outcome);
  if (qualified) params.set("qualified", qualified);
  params.set("limit", "100");
  const data = await api(`/api/calls?${params.toString()}`);

  const tbody = $("[data-bind='rows']");
  if (!data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyState(
      "Sin llamadas",
      "Lanza una llamada desde el detalle de un lead."
    )}</td></tr>`;
    return;
  }

  tbody.innerHTML = data.rows
    .map(
      (c) => `
      <tr data-href="#/calls/${escape(c.id)}">
        <td class="cell-primary">${escape(c.business_name || "—")}<div class="cell-secondary">${escape(c.business_city || "")} ${c.business_niche ? "· " + escape(c.business_niche) : ""}</div></td>
        <td>${fmtDate(c.started_at || c.created_at)}</td>
        <td>${renderStatus(c.status || "—")}</td>
        <td>${callBadge(c)}</td>
        <td class="col-num mono">${fmtDuration(c.duration_seconds)}</td>
        <td class="col-num mono">${fmtCurrency(c.cost)}</td>
        <td class="ellipsis" style="max-width:380px">${escape(c.summary || "—")}</td>
      </tr>`
    )
    .join("");
  bindRowNav(tbody);
}

// ── Call detail ───────────────────────────────────────────
async function renderCallDetail({ params }) {
  const id = params[0];
  const { call } = await api(`/api/calls/${id}`);
  setCurrentCrumb(call.business_name || id.slice(0, 8));

  view.innerHTML = `
    <a class="back-link" href="#/calls">← Volver a llamadas</a>
    <div class="row">
      <div class="grow">
        <h1 class="headline">${escape(call.business_name || "Llamada")}</h1>
        <p class="subhead">${escape(call.business_city || "")} ${call.business_niche ? "· " + escape(call.business_niche) : ""} · ${fmtDate(call.started_at || call.created_at)}</p>
      </div>
      <div class="row" style="gap:6px">
        ${callBadge(call)}
        ${renderStatus(call.status || "—")}
      </div>
    </div>

    <div class="kpi-grid" style="margin-top:8px">
      ${kpiCard("Duración", fmtDuration(call.duration_seconds), call.ended_at ? `Hasta ${fmtDate(call.ended_at)}` : "")}
      ${kpiCard("Coste", fmtCurrency(call.cost), "Provisión Nebrija")}
      ${kpiCard("Resultado", call.outcome || "—", call.qualified ? "Lead cualificado" : call.qualified === false ? "No cualificado" : "—", call.qualified ? "accent" : null)}
      ${kpiCard("Razón fin", call.ended_reason || "—", "")}
    </div>

    <div class="detail-grid" style="margin-top:18px">
      <div class="card">
        <h3>Resumen</h3>
        <p style="margin:0;line-height:1.65">${escape(call.summary || "Sin resumen del agente.")}</p>
        ${call.recording_url ? `<div style="margin-top:14px"><audio controls preload="none" src="${escape(call.recording_url)}" style="width:100%"></audio></div>` : ""}
      </div>
      <div class="card">
        <h3>Metadatos</h3>
        <dl class="kv">
          <dt>Provider call ID</dt><dd class="mono ellipsis">${escape(call.provider_call_id || "—")}</dd>
          <dt>Cliente</dt><dd class="mono">${escape(call.customer_number || "—")}</dd>
          <dt>Lead</dt><dd>${call.business_id ? `<a href="#/leads/${escape(call.business_id)}">Ver lead</a>` : "—"}</dd>
          <dt>Iniciada</dt><dd>${fmtDate(call.started_at)}</dd>
          <dt>Finalizada</dt><dd>${fmtDate(call.ended_at)}</dd>
          <dt>Provider</dt><dd class="mono">${escape(call.provider || "—")}</dd>
        </dl>
      </div>
    </div>

    <div class="section-title"><h2>Transcripción</h2></div>
    <div class="transcript">${escape(call.transcript || "Sin transcripción disponible.")}</div>

    <div class="section-title"><h2>Datos estructurados</h2></div>
    <pre class="transcript">${escape(JSON.stringify(call.structured_data || {}, null, 2))}</pre>
  `;
}

// ── Settings ──────────────────────────────────────────────
async function renderSettings() {
  setCurrentCrumb("NebrijaAI");
  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Settings</h1>
        <p class="subhead">Credenciales e integración de voz para este workspace.</p>
      </div>
    </div>

    <div class="detail-grid">
      <form class="card settings-card" id="nebrija-settings">
        <div class="card__head">
          <h3>NebrijaAI</h3>
          <span class="badge badge--zinc" data-bind="nebrija-status">Cargando</span>
        </div>
        <div class="field">
          <label>API base URL</label>
          <input class="input" name="apiBaseUrl" placeholder="https://nebrijaai.com/api/v1" />
        </div>
        <div class="field">
          <label>API Key</label>
          <input class="input" name="apiKey" type="password" autocomplete="new-password" placeholder="Mantener clave actual" />
          <div class="form-hint" data-bind="api-key-hint">Sin clave guardada.</div>
        </div>
        <div class="field">
          <label>Phone number ID por defecto</label>
          <input class="input" name="defaultPhoneNumberId" placeholder="ID del numero emisor" />
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" type="button" data-action="refresh-assistants">Probar asistentes</button>
          <button class="btn btn--primary" type="submit">Guardar</button>
        </div>
      </form>

      <div class="card settings-card">
        <div class="card__head">
          <h3>Asistentes disponibles</h3>
          <button class="btn btn--sm" type="button" data-action="refresh-assistants">Actualizar</button>
        </div>
        <div data-bind="assistants-list">${rowSkeleton(3)}</div>
      </div>
    </div>
  `;

  const settingsData = await api("/api/settings/nebrija");
  hydrateSettingsForm(settingsData);
  await loadAssistants();

  $("#nebrija-settings", view).addEventListener("submit", saveNebrijaSettings);
  $$("[data-action='refresh-assistants']", view).forEach((button) =>
    button.addEventListener("click", loadAssistants)
  );
}

function hydrateSettingsForm(data) {
  const form = $("#nebrija-settings", view);
  const settings = data.settings || {};
  form.elements.apiBaseUrl.value = settings.apiBaseUrl || "";
  form.elements.defaultPhoneNumberId.value = settings.defaultPhoneNumberId || "";
  const status = $("[data-bind='nebrija-status']", view);
  status.className = `badge ${settings.configured ? "badge--green" : "badge--burgundy"}`;
  status.textContent = settings.configured ? "Conectado" : "Sin configurar";
  $("[data-bind='api-key-hint']", view).textContent = settings.apiKeyLast4
    ? `Clave activa terminada en ${settings.apiKeyLast4}${settings.usingEnvFallback ? " (env)" : ""}.`
    : "Introduce una API Key para listar asistentes y lanzar llamadas.";
}

async function saveNebrijaSettings(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const submit = $("button[type='submit']", form);
  const body = {
    apiBaseUrl: form.elements.apiBaseUrl.value.trim(),
    defaultPhoneNumberId: form.elements.defaultPhoneNumberId.value.trim()
  };
  if (form.elements.apiKey.value.trim()) body.apiKey = form.elements.apiKey.value.trim();
  submit.disabled = true;
  try {
    const data = await api("/api/settings/nebrija", { method: "PATCH", body: JSON.stringify(body) });
    form.elements.apiKey.value = "";
    hydrateSettingsForm({ settings: data.settings });
    toast("Settings guardados", "ok");
    await loadAssistants();
  } catch (err) {
    toast(`No se pudo guardar (${err.message})`, "error");
  } finally {
    submit.disabled = false;
  }
}

async function loadAssistants() {
  const host = $("[data-bind='assistants-list']", view);
  if (!host) return;
  host.innerHTML = `<div class="row" style="padding:18px;justify-content:center"><span class="spinner"></span></div>`;
  try {
    const data = await api("/api/settings/nebrija/assistants");
    window.__nebrijaAssistants = data.assistants || [];
    host.innerHTML = window.__nebrijaAssistants.length
      ? `<div class="list">${window.__nebrijaAssistants.map(renderAssistantListItem).join("")}</div>`
      : emptyState("Sin asistentes", "La API Key funciona, pero NebrijaAI no devolvió asistentes.");
  } catch (err) {
    window.__nebrijaAssistants = [];
    host.innerHTML = emptyState("No se pudieron cargar", err.message === "nebrija_api_key_not_configured" ? "Guarda una API Key antes de listar asistentes." : err.message);
  }
}

function renderAssistantListItem(assistant) {
  const variables = assistant.variableNames || [];
  return `
    <div class="list__item" style="cursor:default">
      <div class="list__main">
        <div class="list__title">${escape(assistant.name)}</div>
        <div class="list__meta mono">${escape(assistant.id)}</div>
        ${
          variables.length
            ? `<div class="variable-row">${variables.map((name) => `<span class="badge badge--zinc">${escape(name)}</span>`).join("")}</div>`
            : `<div class="list__meta">Sin variables detectadas</div>`
        }
      </div>
    </div>
  `;
}

// ── Modals: new campaign / new lead ───────────────────────
async function openCampaignModal() {
  const form = document.createElement("form");
  form.innerHTML = `
    <div class="row">
      <div class="field"><label>Nicho</label><input class="input" name="niche" required placeholder="clínica dental" /></div>
      <div class="field"><label>Ciudad</label><input class="input" name="city" required placeholder="Madrid" /></div>
    </div>
    <div class="row">
      <div class="field"><label>Origen</label>
        <select class="select" name="sourceType">
          <option value="google_places_api">google_places_api</option>
        </select>
      </div>
      <div class="field"><label>Límite solicitado</label><input class="input" name="requestedLimit" type="number" min="1" placeholder="1000" /></div>
    </div>
    <label class="check-row">
      <input type="checkbox" name="enrichAds" checked />
      <span>Enriquecer Ads/Funnel automáticamente al descubrir leads</span>
    </label>
    <div class="divider"></div>
    <div class="field">
      <label>Asistente NebrijaAI</label>
      <select class="select" name="voiceAssistantId" data-bind="campaign-assistant">
        <option value="">Sin asistente vinculado</option>
      </select>
      <div class="form-hint" data-bind="campaign-assistant-hint">Puedes vincular un asistente ahora o lanzar llamadas manualmente despues.</div>
    </div>
  `;
  await hydrateCampaignAssistants(form);
  const footer = document.createDocumentFragment();
  const cancel = btn("Cancelar", "ghost");
  const submit = btn("Lanzar campaña", "primary");
  cancel.addEventListener("click", closeModal);
  submit.addEventListener("click", async () => {
    const data = Object.fromEntries(new FormData(form).entries());
    Object.assign(data, buildCampaignVoicePayload(form));
    if (!data.niche || !data.city) {
      toast("Faltan campos obligatorios", "error");
      return;
    }
    submit.disabled = true;
    try {
      await api("/campaigns", { method: "POST", body: JSON.stringify(data) });
      toast("Campaña creada", "ok");
      closeModal();
      if ((parseHash().pathname || "/").startsWith("/campaigns") || parseHash().pathname === "/") {
        router();
      } else {
        location.hash = "#/campaigns";
      }
    } catch (err) {
      toast(`Error: ${err.message}`, "error");
    } finally {
      submit.disabled = false;
    }
  });
  footer.append(cancel, submit);
  openModal({ title: "Nueva campaña", body: form, footer });
}

async function hydrateCampaignAssistants(form, options = {}) {
  const select = $("[data-bind='campaign-assistant']", form);
  const hint = $("[data-bind='campaign-assistant-hint']", form);
  form.dataset.fallbackAssistantId = options.selectedAssistantId || "";
  form.dataset.fallbackAssistantName = options.selectedAssistantName || "";
  form.dataset.fallbackAssistantVariables = JSON.stringify(options.selectedAssistantVariables || []);
  try {
    if (!window.__nebrijaAssistants?.length) {
      const data = await api("/api/settings/nebrija/assistants");
      window.__nebrijaAssistants = data.assistants || [];
    }
    const assistants = window.__nebrijaAssistants || [];
    const selectedMissing = options.selectedAssistantId && !assistants.some((assistant) => assistant.id === options.selectedAssistantId);
    select.innerHTML = `<option value="">Sin asistente vinculado</option>${(window.__nebrijaAssistants || [])
      .map((assistant) => `<option value="${escape(assistant.id)}">${escape(assistant.name)}</option>`)
      .join("")}${
      selectedMissing
        ? `<option value="${escape(options.selectedAssistantId)}">${escape(options.selectedAssistantName || options.selectedAssistantId)}</option>`
        : ""
    }`;
    select.value = options.selectedAssistantId || "";
    hint.textContent = window.__nebrijaAssistants?.length
      ? "Las variables se rellenan automaticamente con datos del lead."
      : "No hay asistentes disponibles en NebrijaAI.";
  } catch (err) {
    hint.innerHTML = `Configura NebrijaAI en <a href="#/settings">Settings</a> para listar asistentes.`;
    if (options.selectedAssistantId) {
      select.innerHTML = `<option value="${escape(options.selectedAssistantId)}">${escape(options.selectedAssistantName || options.selectedAssistantId)}</option>`;
    }
  }
}

function getSelectedCampaignAssistant(form) {
  const id = form.elements.voiceAssistantId?.value;
  if (!id) return null;
  return (
    (window.__nebrijaAssistants || []).find((assistant) => assistant.id === id) || {
      id,
      name: form.dataset.fallbackAssistantId === id
        ? form.dataset.fallbackAssistantName || id
        : form.elements.voiceAssistantId.selectedOptions?.[0]?.textContent || id,
      variableNames: form.dataset.fallbackAssistantId === id
        ? JSON.parse(form.dataset.fallbackAssistantVariables || "[]")
        : []
    }
  );
}

function buildCampaignVoicePayload(form) {
  const assistant = getSelectedCampaignAssistant(form);
  if (!assistant) {
    return {
      voiceAssistantId: "",
      voiceAssistantName: "",
      voiceAssistantVariables: [],
      voiceVariableMap: {}
    };
  }
  return {
    voiceAssistantId: assistant.id,
    voiceAssistantName: assistant.name,
    voiceAssistantVariables: assistant.variableNames || []
  };
}

async function saveCampaignVoiceSettings(event, campaignId) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $("button[type='submit']", form);
  submit.disabled = true;
  try {
    await api(`/api/campaigns/${campaignId}`, {
      method: "PATCH",
      body: JSON.stringify(buildCampaignVoicePayload(form))
    });
    toast("Asistente actualizado", "ok");
    await router();
  } catch (err) {
    toast(`No se pudo guardar el asistente (${err.message})`, "error");
  } finally {
    submit.disabled = false;
  }
}

async function openLeadModal() {
  let leadLists = { rows: [] };
  try {
    leadLists = await api("/api/lead-lists");
  } catch {}
  const form = document.createElement("form");
  form.innerHTML = `
    <div class="field"><label>Nombre</label><input class="input" name="name" required placeholder="Clínica Demo" /></div>
    <div class="row">
      <div class="field"><label>Web</label><input class="input" name="website" placeholder="https://example.com" /></div>
      <div class="field"><label>Teléfono</label><input class="input" name="phone" placeholder="+34 ..." /></div>
    </div>
    <div class="row">
      <div class="field"><label>Ciudad</label><input class="input" name="city" placeholder="Madrid" /></div>
      <div class="field"><label>Nicho</label><input class="input" name="niche" placeholder="clínica dental" /></div>
    </div>
    <div class="field"><label>Lista</label>
      <select class="select" name="listId">
        <option value="">Sin lista inicial</option>
        ${(leadLists.rows || []).map((list) => `<option value="${escape(list.id)}">${escape(list.name)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Dirección</label><input class="input" name="address" /></div>
  `;
  const footer = document.createDocumentFragment();
  const cancel = btn("Cancelar", "ghost");
  const submit = btn("Importar lead", "primary");
  cancel.addEventListener("click", closeModal);
  submit.addEventListener("click", async () => {
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name) {
      toast("El nombre es obligatorio", "error");
      return;
    }
    submit.disabled = true;
    try {
      const res = await api("/businesses", { method: "POST", body: JSON.stringify(data) });
      if (data.listId) {
        await api(`/api/lead-lists/${data.listId}/businesses`, {
          method: "POST",
          body: JSON.stringify({ businessId: res.business.id })
        });
      }
      toast("Lead importado", "ok");
      closeModal();
      location.hash = `#/leads/${res.business.id}`;
    } catch (err) {
      toast(`Error: ${err.message}`, "error");
    } finally {
      submit.disabled = false;
    }
  });
  footer.append(cancel, submit);
  openModal({ title: "Importar lead", body: form, footer });
}

function openLeadImportModal() {
  const state = { file: null, contentBase64: "", preview: null };
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="import-box">
      <label class="file-drop">
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-bind="lead-import-file" />
        <span class="file-drop__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 20h14v-2H5v2ZM12 2 6.5 7.5 8 9l3-3v9h2V6l3 3 1.5-1.5L12 2Z"/></svg>
        </span>
        <span class="file-drop__main">Selecciona CSV o Excel</span>
        <span class="file-drop__sub" data-bind="lead-import-filename">Hasta 5.000 filas por importación</span>
      </label>
      <label class="check-row">
        <input type="checkbox" data-bind="lead-import-enrich" checked />
        <span>Lanzar enriquecimiento de Ads al importar</span>
      </label>
      <label class="check-row">
        <input type="checkbox" data-bind="lead-import-crm" checked />
        <span>Crear/actualizar lista CRM con estos contactos</span>
      </label>
      <div class="field import-crm-list">
        <label>Nombre de la lista CRM</label>
        <input class="input" data-bind="lead-import-list-name" placeholder="Cold Calling - Junio" />
      </div>
    </div>
    <div data-bind="lead-import-preview"></div>
  `;

  const footer = document.createDocumentFragment();
  const cancel = btn("Cancelar", "ghost");
  const submit = btn("Importar lista", "primary");
  submit.disabled = true;
  cancel.addEventListener("click", closeModal);
  submit.addEventListener("click", async () => {
    if (!state.preview || !state.contentBase64) return;
    const mapping = {};
    $$("[data-import-header]", body).forEach((select) => {
      mapping[select.dataset.importHeader] = select.value;
    });
    submit.disabled = true;
    try {
      const result = await api("/api/imports/leads/commit", {
        method: "POST",
        body: JSON.stringify({
          filename: state.file.name,
          contentBase64: state.contentBase64,
          mapping,
          enrichAds: $("[data-bind='lead-import-enrich']", body).checked,
          crmListName: $("[data-bind='lead-import-crm']", body).checked
            ? $("[data-bind='lead-import-list-name']", body).value.trim()
            : ""
        })
      });
      const errors = result.errors?.length ? ` · ${result.errors.length} filas omitidas` : "";
      const crmCopy = result.crmRowsImported ? ` · ${fmtNumber(result.crmRowsImported)} en CRM` : "";
      toast(`${fmtNumber(result.imported)} leads importados${crmCopy}${errors}`, result.imported ? "ok" : "error");
      closeModal();
      if (result.crmList?.id) {
        location.hash = `#/lists/${result.crmList.id}`;
      } else if (result.leads?.length === 1) {
        location.hash = `#/leads/${result.leads[0].id}`;
      } else {
        location.hash = "#/leads";
        router();
      }
    } catch (err) {
      toast(`No se pudo importar (${err.message})`, "error");
    } finally {
      submit.disabled = false;
    }
  });
  footer.append(cancel, submit);
  openModal({ title: "Importar lista", body, footer });

  $("[data-bind='lead-import-file']", body).addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    state.file = file;
    $("[data-bind='lead-import-filename']", body).textContent = file.name;
    const listNameInput = $("[data-bind='lead-import-list-name']", body);
    if (listNameInput && !listNameInput.value.trim()) listNameInput.value = importListNameFromFilename(file.name);
    const previewHost = $("[data-bind='lead-import-preview']", body);
    previewHost.innerHTML = `<div class="row" style="padding:16px;justify-content:center"><span class="spinner"></span></div>`;
    submit.disabled = true;
    try {
      state.contentBase64 = await fileToBase64(file);
      state.preview = await api("/api/imports/leads/preview", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentBase64: state.contentBase64 })
      });
      previewHost.innerHTML = renderLeadImportPreview(state.preview);
      submit.disabled = false;
    } catch (err) {
      previewHost.innerHTML = `<div class="login-card__error">${escape(err.message)}</div>`;
    }
  });
}

function renderLeadImportPreview(preview) {
  const fields = preview.crmFields || [];
  const options = (selected, header) => `
    <option value="ignore" ${selected === "ignore" ? "selected" : ""}>Ignorar</option>
    ${renderImportFieldOptions(fields, selected)}
    <option value="custom:${escape(customKeyFromHeader(header))}" ${String(selected || "").startsWith("custom:") ? "selected" : ""}>Campo personalizado</option>
  `;
  return `
    <div class="import-preview">
      <div class="import-preview__head">
        <div><strong>${fmtNumber(preview.totalRows)}</strong> filas detectadas</div>
        <span class="badge badge--zinc">${escape(preview.format)}</span>
      </div>
      <div class="mapping-table">
        ${preview.headers
          .map((header) => {
            const selected = preview.suggestedMapping?.[header] || "ignore";
            const sample = preview.sampleRows?.map((row) => row[header]).filter(Boolean).slice(0, 2).join(" · ");
            return `
              <div class="mapping-row">
                <div class="mapping-row__source">
                  <strong>${escape(header)}</strong>
                  <span>${escape(sample || "Sin muestra")}</span>
                </div>
                <select class="select" data-import-header="${escape(header)}">
                  ${options(selected, header)}
                </select>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderImportFieldOptions(fields, selected) {
  const groups = ["Contacto", "CRM", "Empresa"];
  return groups
    .map((group) => {
      const groupFields = fields.filter((field) => (field.group || "Empresa") === group);
      if (!groupFields.length) return "";
      return `
        <optgroup label="${escape(group)}">
          ${groupFields
            .map((field) => `<option value="${escape(field.key)}" ${selected === field.key ? "selected" : ""}>${escape(field.label)}${field.required ? " *" : ""}</option>`)
            .join("")}
        </optgroup>
      `;
    })
    .join("");
}

function importListNameFromFilename(filename) {
  return String(filename || "Import CRM")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Import CRM";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.onload = () => {
      const text = String(reader.result || "");
      resolve(text.includes(",") ? text.split(",").pop() : text);
    };
    reader.readAsDataURL(file);
  });
}

function customKeyFromHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "custom";
}

function btn(label, variant) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cx(
    "btn",
    variant === "primary" && "btn--primary",
    variant === "ghost" && "btn--ghost",
    variant === "gold" && "btn--gold",
    variant === "danger" && "btn--danger"
  );
  b.textContent = label;
  return b;
}

// ── Helpers ───────────────────────────────────────────────
function bindRowNav(scope) {
  $$("tr[data-href]", scope).forEach((tr) => {
    tr.addEventListener("click", (event) => {
      if (event.target.closest("a,button,input,select,textarea,[data-action]")) return;
      location.hash = tr.dataset.href;
    });
  });
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (healthTimer) clearInterval(healthTimer);
  bootstrap();
});
