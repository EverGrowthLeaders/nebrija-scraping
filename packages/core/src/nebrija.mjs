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

  async listAssistants() {
    const response = await fetchJson(`${this.baseUrl}/assistants`, {
      method: "GET",
      headers: this.headers(),
      timeoutMs: 30_000
    });
    return normalizeAssistantsResponse(response);
  }

  async createOutboundCall({ customerNumber, assistantId, phoneNumberId, variableValues = {}, variables = {}, testId } = {}) {
    const values = Object.keys(variableValues || {}).length ? variableValues : variables;
    const body = {
      customer: {
        number: customerNumber
      }
    };
    if (values && Object.keys(values).length) {
      body.assistantOverrides = {
        variableValues: values
      };
    }
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

export function normalizeAssistantsResponse(response) {
  const rows = Array.isArray(response)
    ? response
    : response?.assistants || response?.data || response?.items || response?.results || [];
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeAssistant)
    .filter((assistant) => assistant.id);
}

export function normalizeAssistant(assistant) {
  const variableNames = extractAssistantVariableNames(assistant);
  return {
    id: assistant.id || assistant.assistantId || assistant._id,
    name: assistant.name || assistant.displayName || assistant.label || assistant.id || "Asistente sin nombre",
    description: assistant.description || assistant.summary || null,
    variableNames,
    raw: assistant
  };
}

export function extractAssistantVariableNames(assistant) {
  const found = new Set();
  collectVariableContainers(assistant, found);

  const serialized = JSON.stringify(assistant || {});
  for (const match of serialized.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*(?:[|}]|}})/g)) {
    const name = match[1]?.trim();
    if (name && !DEFAULT_VAPI_VARIABLE_ROOTS.has(name.split(".")[0])) found.add(name);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

function collectVariableContainers(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectVariableContainers(item, found);
    return;
  }

  for (const key of ["variables", "dynamicVariables", "variableValues", "templateVariables"]) {
    const item = value[key];
    if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === "string") found.add(entry);
        else if (entry?.name) found.add(entry.name);
        else if (entry?.key) found.add(entry.key);
      }
    } else if (item && typeof item === "object") {
      for (const name of Object.keys(item)) found.add(name);
    }
  }
  for (const child of Object.values(value)) collectVariableContainers(child, found);
}

const DEFAULT_VAPI_VARIABLE_ROOTS = new Set([
  "now",
  "date",
  "time",
  "month",
  "day",
  "year",
  "customer",
  "transport",
  "call",
  "assistant"
]);
