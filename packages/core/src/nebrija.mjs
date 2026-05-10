import { config, requireEnv } from "./config.mjs";
import { fetchJson } from "./http.mjs";

export class NebrijaClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.nebrija.apiBaseUrl;
    this.apiKey = options.apiKey ?? config.nebrija.apiKey;
    this.assistantId = options.assistantId ?? config.nebrija.assistantId;
    this.phoneNumberId = options.phoneNumberId ?? config.nebrija.phoneNumberId;
  }

  headers() {
    return {
      Authorization: `Bearer ${requireEnv(this.apiKey, "NEBRIJA_API_KEY")}`
    };
  }

  async createOutboundCall({ customerNumber, assistantId, phoneNumberId, variables = {}, testId } = {}) {
    const body = {
      customer: {
        number: customerNumber
      },
      variables
    };
    if (testId) body.testId = testId;
    else body.assistantId = assistantId || requireEnv(this.assistantId, "NEBRIJA_ASSISTANT_ID");
    body.phoneNumberId = phoneNumberId || requireEnv(this.phoneNumberId, "NEBRIJA_PHONE_NUMBER_ID");

    return fetchJson(`${this.baseUrl}/calls`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: 30_000
    });
  }
}
