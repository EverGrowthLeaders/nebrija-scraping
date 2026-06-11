export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const safeUrl = redactUrlSecrets(url);
      throw new HttpError(`HTTP ${response.status} for ${safeUrl}`, {
        status: response.status,
        body,
        url: safeUrl
      });
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function redactUrlSecrets(value) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (/token|api[-_]?key|secret|password|authorization/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return String(value || "").replace(/([?&](?:token|api[-_]?key|secret|password|authorization)=)[^&]+/gi, "$1[redacted]");
  }
}
