const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;

export async function postDeepInfraJson({
  baseUrl,
  apiKey,
  body,
  timeoutMs = 45000,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  fetchImpl = globalThis.fetch,
  sleep = delay
} = {}) {
  if (!apiKey) throw new Error("deepinfra_api_key_missing");
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`deepinfra_http_${response.status}:${text.slice(0, 300)}`);
        if (attempt < attempts && isRetryableDeepInfraFailure(response.status, text)) {
          lastError = error;
          await sleep(retryDelayMs(attempt, retryBaseDelayMs));
          continue;
        }
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`deepinfra_invalid_json:${String(error.message || error).slice(0, 200)}`);
      }
    } catch (error) {
      if (attempt < attempts && isRetryableDeepInfraError(error)) {
        lastError = error;
        await sleep(retryDelayMs(attempt, retryBaseDelayMs));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("deepinfra_retry_exhausted");
}

function isRetryableDeepInfraFailure(status, text) {
  return status === 429 ||
    status >= 500 ||
    /engine_overloaded|model busy|retry later|temporarily unavailable|rate limit|timeout/i.test(String(text || ""));
}

function isRetryableDeepInfraError(error) {
  const message = String(error?.message || error || "");
  return error?.name === "AbortError" ||
    /fetch failed|network|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|engine_overloaded|model busy|retry later|deepinfra_http_429|deepinfra_http_5\d\d/i.test(message);
}

function retryDelayMs(attempt, baseDelayMs) {
  const base = Math.max(0, Number(baseDelayMs) || 0);
  return base * 2 ** Math.max(0, attempt - 1);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
