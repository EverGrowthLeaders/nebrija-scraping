import crypto from "node:crypto";

export function parseApiKeys(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseApiKeyHashes(value) {
  return parseApiKeys(value)
    .map((item) => item.toLowerCase())
    .filter((item) => /^[a-f0-9]{64}$/.test(item));
}

export function getRequestApiKey(headers = {}) {
  const direct = headers["x-api-key"] || headers["x-test-api-key"];
  if (direct) return String(direct).trim();

  const authorization = headers.authorization || headers.Authorization;
  const match = String(authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function isAuthorizedApiKey(headers, expectedKeys, expectedHashes = []) {
  const candidate = getRequestApiKey(headers);
  if (!candidate || (!expectedKeys?.length && !expectedHashes?.length)) return false;
  if (expectedKeys?.some((expected) => safeEqual(candidate, expected))) return true;
  const digest = crypto.createHash("sha256").update(candidate).digest("hex");
  return expectedHashes?.some((expected) => safeEqual(digest, expected));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
