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

const renderAdsState = (business) => `
  <div class="ads-badges">
    ${renderAdsBadge(business.ads_meta_active, "Meta")}
    ${renderAdsBadge(business.ads_google_active, "Google")}
  </div>
`;

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
  const { job } = await api(`/api/campaigns/${id}`);
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
      ${kpiCard("Solicitados", fmtNumber(job.requested_limit) || "—", "Límite de la campaña")}
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
}

// ── Leads list ────────────────────────────────────────────
async function renderLeadsList({ search }) {
  setCurrentCrumb("Lista");
  const status = search.get("status") || "";
  const niche = search.get("niche") || "";
  const city = search.get("city") || "";
  const campaignId = search.get("campaignId") || "";
  const term = search.get("search") || "";

  view.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="grow">
        <h1 class="headline">Leads</h1>
        <p class="subhead">Negocios capturados, enriquecidos y cualificados.</p>
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
        <button class="btn" type="submit">Filtrar</button>
        <a class="btn btn--ghost" href="#/leads">Reset</a>
      </div>
    </form>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Lead</th>
            <th>Ciudad / Nicho</th>
            <th>Web</th>
            <th>Teléfono</th>
            <th class="col-num">Score</th>
            <th>Ads</th>
            <th>Estado</th>
            <th>Actualizado</th>
          </tr>
        </thead>
        <tbody data-bind="rows"><tr><td colspan="8" style="padding:40px;text-align:center"><span class="spinner"></span></td></tr></tbody>
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
  if (term) params.set("search", term);
  params.set("limit", "100");

  const data = await api(`/api/businesses?${params.toString()}`);
  const tbody = $("[data-bind='rows']");
  if (!data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="8">${emptyState(
      "Sin resultados",
      "Ajusta los filtros o lanza una campaña."
    )}</td></tr>`;
    return;
  }
  tbody.innerHTML = data.rows
    .map(
      (b) => `
      <tr data-href="#/leads/${escape(b.id)}">
        <td class="cell-primary">${escape(b.name)}</td>
        <td>${escape(b.city || "—")} <span class="muted">·</span> ${escape(b.niche || "—")}</td>
        <td>${b.website ? `<span class="mono ellipsis" style="display:inline-block;max-width:220px">${escape(stripScheme(b.website))}</span>` : "<span class='faint'>—</span>"}</td>
        <td class="mono">${escape(b.phone_e164 || "—")}</td>
        <td class="col-num">${renderScore(b.score)}</td>
        <td>${renderAdsState(b)}</td>
        <td>${renderStatus(b.status)}</td>
        <td>${fmtRel(b.updated_at)}</td>
      </tr>`
    )
    .join("");
  bindRowNav(tbody);
}

function stripScheme(url) {
  return String(url || "").replace(/^https?:\/\//, "");
}

// ── Lead detail ───────────────────────────────────────────
async function renderLeadDetail({ params }) {
  const id = params[0];
  const data = await api(`/api/businesses/${id}`);
  const b = data.business;
  setCurrentCrumb(b.name);

  view.innerHTML = `
    <a class="back-link" href="#/leads">← Volver a leads</a>
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
      </div>
    </div>

    <div class="detail-grid">
      <div class="card">
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
          </div>
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
  $("[data-action='save-scoring-notes']", view).addEventListener("click", () => saveScoringNotes(b.id));
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

function renderAdsDetail(label, value, evidence = {}) {
  return `
    <div class="ads-row">
      <div>
        <div class="ads-row__title">${escape(label)}</div>
        <div class="ads-row__meta">${escape(evidence.reason || evidence.status || "pendiente")}${evidence.confidence != null ? ` · conf ${Math.round(Number(evidence.confidence) * 100)}%` : ""}</div>
      </div>
      <div class="ads-row__side">
        ${renderAdsBadge(value, label)}
        ${evidence.sourceUrl ? `<a class="mini-link" href="${escape(evidence.sourceUrl)}" target="_blank" rel="noopener">fuente</a>` : ""}
      </div>
    </div>
  `;
}

function renderCustomFields(fields = {}) {
  const entries = Object.entries(fields || {}).filter(([, value]) => value != null && value !== "");
  if (!entries.length) return "";
  return `
    <div class="custom-fields">
      <div class="custom-fields__title">Campos personalizados</div>
      <dl class="kv">
        ${entries.map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join("")}
      </dl>
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

function openLeadModal() {
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
          enrichAds: $("[data-bind='lead-import-enrich']", body).checked
        })
      });
      const errors = result.errors?.length ? ` · ${result.errors.length} filas omitidas` : "";
      toast(`${fmtNumber(result.imported)} leads importados${errors}`, result.imported ? "ok" : "error");
      closeModal();
      if (result.leads?.length === 1) {
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
    ${fields.map((field) => `<option value="${escape(field.key)}" ${selected === field.key ? "selected" : ""}>${escape(field.label)}${field.required ? " *" : ""}</option>`).join("")}
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
  b.className = cx("btn", variant === "primary" && "btn--primary", variant === "ghost" && "btn--ghost", variant === "gold" && "btn--gold");
  b.textContent = label;
  return b;
}

// ── Helpers ───────────────────────────────────────────────
function bindRowNav(scope) {
  $$("tr[data-href]", scope).forEach((tr) => {
    tr.addEventListener("click", () => {
      location.hash = tr.dataset.href;
    });
  });
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (healthTimer) clearInterval(healthTimer);
  bootstrap();
});
