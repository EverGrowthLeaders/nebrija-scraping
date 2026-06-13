import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.mjs";

const DEFAULT_CHROME_CANDIDATES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AdsBrowserClient {
  constructor(options = {}) {
    this.mode = options.mode ?? config.adsBrowser?.fallbackMode ?? "off";
    this.chromePath = options.chromePath || config.adsBrowser?.chromePath || firstExistingChromePath();
    this.timeoutMs = options.timeoutMs || config.adsBrowser?.requestTimeoutMs || 45000;
    this.waitMs = options.waitMs || config.adsBrowser?.waitMs || 7000;
  }

  get enabled() {
    return !["off", "never", "false", "0"].includes(String(this.mode || "off").toLowerCase()) && Boolean(this.chromePath);
  }

  async inspectMetaAdsLibrary({ domain, country = "ES" } = {}) {
    if (!domain) return null;
    return await withBrowserSession({ chromePath: this.chromePath, timeoutMs: this.timeoutMs }, async (cdp) => {
      const url = buildMetaBrowserUrl({ domain, country });
      await navigateAndWait(cdp, url, this.waitMs);
      return await evaluatePage(cdp, metaExtractionScript(domain));
    });
  }

  async inspectGoogleAdsTransparency({ domain, country = "ES" } = {}) {
    if (!domain) return null;
    return await withBrowserSession({ chromePath: this.chromePath, timeoutMs: this.timeoutMs }, async (cdp) => {
      const url = buildGoogleBrowserUrl({ domain, country });
      await navigateAndWait(cdp, url, this.waitMs);
      return await evaluatePage(cdp, googleExtractionScript(domain));
    });
  }
}

function firstExistingChromePath() {
  return DEFAULT_CHROME_CANDIDATES.find((path) => existsSync(path)) || "";
}

function buildMetaBrowserUrl({ domain, country }) {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.searchParams.set("active_status", "active");
  url.searchParams.set("ad_type", "all");
  url.searchParams.set("country", country || "ES");
  url.searchParams.set("is_targeted_country", "false");
  url.searchParams.set("media_type", "all");
  url.searchParams.set("q", domain);
  url.searchParams.set("search_type", "keyword_unordered");
  url.searchParams.set("sort_data[mode]", "total_impressions");
  url.searchParams.set("sort_data[direction]", "desc");
  return url.toString();
}

function buildGoogleBrowserUrl({ domain, country }) {
  const url = new URL("https://adstransparency.google.com/");
  url.searchParams.set("region", country || "ES");
  url.searchParams.set("domain", domain);
  return url.toString();
}

async function withBrowserSession({ chromePath, timeoutMs }, fn) {
  if (!chromePath) throw new Error("ads_browser_chrome_missing");
  const profileDir = await mkdtemp(join(tmpdir(), "ads-browser-"));
  const port = 9600 + Math.floor(Math.random() * 500);
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const timer = setTimeout(() => chrome.kill("SIGTERM"), Math.max(10000, timeoutMs || 45000));
  try {
    await waitForJson(port, "/json/version");
    const target = await openTarget(port, "about:blank");
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const result = await fn(cdp);
    cdp.ws.close();
    return result;
  } finally {
    clearTimeout(timer);
    chrome.kill("SIGTERM");
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function waitForJson(port, path) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error("ads_browser_cdp_not_ready");
}

async function openTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!res.ok) throw new Error(`ads_browser_new_tab_failed:${res.status}`);
  return await res.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else {
      events.push(msg);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("ads_browser_websocket_error"));
  });
  async function send(method, params = {}) {
    await ready;
    id += 1;
    ws.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  return { ws, send, events };
}

async function navigateAndWait(cdp, url, waitMs) {
  cdp.events.length = 0;
  await cdp.send("Page.navigate", { url });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12000) {
    if (cdp.events.some((event) => event.method === "Page.loadEventFired")) break;
    await sleep(250);
  }
  await sleep(waitMs || 7000);
}

async function evaluatePage(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true
  });
  return result.result?.value || null;
}

function metaExtractionScript(domain) {
  return `(() => {
    const domain = ${JSON.stringify(domain)};
    const bodyText = document.body ? document.body.innerText : "";
    const anchors = Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
      text: (anchor.innerText || anchor.textContent || '').trim().slice(0, 260),
      href: anchor.href
    })).filter((anchor) => anchor.href && !anchor.href.startsWith('javascript:')).slice(0, 300);
    const ids = Array.from(bodyText.matchAll(/(?:Identificador de la biblioteca|Library ID|ID de la bibliothèque)\\s*:?\\s*(\\d+)/gi)).map((match) => match[1]);
    const cards = ids.map((id) => {
      const idx = bodyText.indexOf(id);
      return { id, text: bodyText.slice(Math.max(0, idx - 500), idx + 1800) };
    });
    const hasNoResults = /No hay ningún anuncio que coincida|No ads match|No ads found/i.test(bodyText);
    return {
      provider: "meta",
      sourceUrl: location.href,
      domain,
      bodyText: bodyText.slice(0, 6000),
      anchors,
      ids,
      cards,
      hasNoResults,
      checkedAt: new Date().toISOString()
    };
  })()`;
}

function googleExtractionScript(domain) {
  return `(() => {
    const domain = ${JSON.stringify(domain)};
    const bodyText = document.body ? document.body.innerText : "";
    return {
      provider: "google",
      sourceUrl: location.href,
      domain,
      bodyText: bodyText.slice(0, 8000),
      checkedAt: new Date().toISOString()
    };
  })()`;
}
