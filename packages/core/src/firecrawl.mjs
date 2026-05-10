import { config, requireEnv } from "./config.mjs";
import { fetchJson } from "./http.mjs";

export class FirecrawlClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.firecrawl.baseUrl;
    this.apiKey = options.apiKey ?? config.firecrawl.apiKey;
    this.timeoutMs = options.timeoutMs || config.crawler.requestTimeoutMs;
  }

  headers() {
    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (config.firecrawl.originHeader) headers.Origin = config.firecrawl.originHeader;
    return headers;
  }

  async request(path, body = {}) {
    requireEnv(this.baseUrl, "FIRECRAWL_BASE_URL");
    return fetchJson(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs
    });
  }

  async map(url, options = {}) {
    const response = await this.request("/map", {
      url,
      limit: options.limit || 100,
      sitemap: options.sitemap || "include",
      search: options.search,
      location: options.location
    });
    return normalizeMapResponse(response);
  }

  async scrape(url, options = {}) {
    const response = await this.request("/scrape", {
      url,
      formats: options.formats || ["markdown", "html", "links"],
      onlyMainContent: options.onlyMainContent ?? false,
      waitFor: options.waitFor
    });
    return normalizeScrapeResponse(response);
  }

  async search(query, options = {}) {
    const response = await this.request("/search", {
      query,
      limit: options.limit || 5,
      scrapeOptions: options.scrapeOptions
    });
    return normalizeSearchResponse(response);
  }
}

export function normalizeMapResponse(response) {
  const links = response?.links || response?.data?.links || [];
  return links
    .map((item) => {
      if (typeof item === "string") return { url: item };
      return {
        url: item.url,
        title: item.title,
        description: item.description
      };
    })
    .filter((item) => item.url);
}

export function normalizeScrapeResponse(response) {
  const data = response?.data || response || {};
  return {
    markdown: data.markdown || "",
    html: data.html || "",
    links: normalizeLinks(data.links || []),
    metadata: data.metadata || {},
    raw: response
  };
}

export function normalizeSearchResponse(response) {
  const data = response?.data || response?.results || response || [];
  const results = Array.isArray(data) ? data : data.results || data.web || [];
  return results
    .map((item) => ({
      url: item.url || item.link,
      title: item.title,
      description: item.description || item.snippet,
      markdown: item.markdown
    }))
    .filter((item) => item.url);
}

function normalizeLinks(links) {
  return links
    .map((link) => {
      if (typeof link === "string") return { url: link };
      return {
        url: link.url || link.href,
        title: link.title,
        text: link.text
      };
    })
    .filter((link) => link.url);
}
