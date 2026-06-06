import { config, requireEnv } from "./config.mjs";
import { fetchJson } from "./http.mjs";

export class ApifyClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? config.apify.apiKey;
    this.baseUrl = options.baseUrl || config.apify.baseUrl;
    this.facebookAdsActorId = options.facebookAdsActorId || config.apify.facebookAdsActorId;
    this.googleAdsActorId = options.googleAdsActorId || config.apify.googleAdsActorId;
    this.timeoutMs = options.timeoutMs || config.apify.requestTimeoutMs;
    this.runTimeoutSecs = options.runTimeoutSecs || config.apify.runTimeoutSecs;
    this.maxChargedResults = options.maxChargedResults || config.apify.maxChargedResults;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async runFacebookAdsLibrary(input = {}, options = {}) {
    requireEnv(this.apiKey, "APIFY_API_KEY");
    const actorId = encodeURIComponent(this.facebookAdsActorId).replace("%7E", "~");
    const url = new URL(`${this.baseUrl}/acts/${actorId}/run-sync-get-dataset-items`);
    url.searchParams.set("token", this.apiKey);
    url.searchParams.set("timeout", String(options.timeoutSecs || this.runTimeoutSecs));
    url.searchParams.set("memory", String(options.memoryMbytes || 512));
    const items = await fetchJson(url.toString(), {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: options.timeoutMs || this.timeoutMs
    });
    return Array.isArray(items) ? items : [];
  }

  async runGoogleAdsTransparency(input = {}, options = {}) {
    requireEnv(this.apiKey, "APIFY_API_KEY");
    const actorId = encodeURIComponent(this.googleAdsActorId).replace("%7E", "~");
    const url = new URL(`${this.baseUrl}/acts/${actorId}/run-sync-get-dataset-items`);
    url.searchParams.set("token", this.apiKey);
    url.searchParams.set("timeout", String(options.timeoutSecs || this.runTimeoutSecs));
    url.searchParams.set("memory", String(options.memoryMbytes || 512));
    const items = await fetchJson(url.toString(), {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: options.timeoutMs || this.timeoutMs
    });
    return Array.isArray(items) ? items : [];
  }
}
