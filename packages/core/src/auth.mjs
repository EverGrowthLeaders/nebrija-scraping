import crypto from "node:crypto";

export function parseApiKeys(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getRequestApiKey(headers = {}) {
  const direct = headers["x-api-key"] || headers["x-test-api-key"];
  if (direct) return String(direct).trim();

  const authorization = headers.authorization || headers.Authorization;
  const match = String(authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function isAuthorizedApiKey(headers, expectedKeys) {
  const candidate = getRequestApiKey(headers);
  if (!candidate || !expectedKeys?.length) return false;
  return expectedKeys.some((expected) => safeEqual(candidate, expected));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
