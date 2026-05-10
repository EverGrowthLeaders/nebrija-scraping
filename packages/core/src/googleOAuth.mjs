import crypto from "node:crypto";
import { config } from "./config.mjs";

let jwksCache = { expiresAt: 0, keys: [] };

export function getGoogleAuthUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id: config.auth.googleClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account"
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode({ code, redirectUri }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.auth.googleClientId,
      client_secret: config.auth.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    }),
    signal: AbortSignal.timeout(20_000)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error_description || body.error || "google_token_exchange_failed");
    error.statusCode = 401;
    throw error;
  }
  return body;
}

export async function verifyGoogleIdToken(idToken) {
  const [encodedHeader, encodedPayload, encodedSignature] = String(idToken || "").split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    const error = new Error("invalid_google_id_token");
    error.statusCode = 401;
    throw error;
  }

  const header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"));
  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  if (header.alg !== "RS256") {
    const error = new Error("unsupported_google_token_alg");
    error.statusCode = 401;
    throw error;
  }

  const key = (await getGoogleJwks()).find((item) => item.kid === header.kid);
  if (!key) {
    const error = new Error("google_jwk_not_found");
    error.statusCode = 401;
    throw error;
  }

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const valid = verifier.verify(crypto.createPublicKey({ key, format: "jwk" }), base64UrlDecode(encodedSignature));
  if (!valid) {
    const error = new Error("invalid_google_token_signature");
    error.statusCode = 401;
    throw error;
  }

  validateGoogleClaims(payload);
  return {
    sub: payload.sub,
    email: String(payload.email || "").toLowerCase(),
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: payload.name || payload.email,
    picture: payload.picture || null,
    hostedDomain: payload.hd || null
  };
}

function validateGoogleClaims(payload) {
  const now = Math.floor(Date.now() / 1000);
  const issuerOk = payload.iss === "accounts.google.com" || payload.iss === "https://accounts.google.com";
  if (!issuerOk || payload.aud !== config.auth.googleClientId || Number(payload.exp) <= now) {
    const error = new Error("invalid_google_token_claims");
    error.statusCode = 401;
    throw error;
  }
  if (!(payload.email_verified === true || payload.email_verified === "true") || !payload.email) {
    const error = new Error("google_email_not_verified");
    error.statusCode = 403;
    throw error;
  }

  const emailDomain = String(payload.email).split("@").pop()?.toLowerCase();
  const hostedDomain = String(payload.hd || "").toLowerCase();
  if (
    config.auth.allowedGoogleDomains.length &&
    !config.auth.allowedGoogleDomains.includes(emailDomain) &&
    !config.auth.allowedGoogleDomains.includes(hostedDomain)
  ) {
    const error = new Error("google_domain_not_allowed");
    error.statusCode = 403;
    throw error;
  }
}

async function getGoogleJwks() {
  if (jwksCache.expiresAt > Date.now() && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body.keys)) {
    throw new Error("google_jwks_fetch_failed");
  }
  const maxAge = /max-age=(\d+)/i.exec(response.headers.get("cache-control") || "")?.[1];
  jwksCache = {
    keys: body.keys,
    expiresAt: Date.now() + (Number(maxAge) || 300) * 1000
  };
  return jwksCache.keys;
}

function base64UrlDecode(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
