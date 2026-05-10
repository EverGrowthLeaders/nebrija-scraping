import crypto from "node:crypto";
import { normalizeSpanishPhone } from "./phone.mjs";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const NOISE_EMAIL_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".css", ".js", ".svg"];
const PHONE_REGEX = /(?:\+34|0034)?[\s.-]?(?:[6789][\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d)/g;

export function sha256(value) {
  return crypto.createHash("sha256").update(value || "").digest("hex");
}

export function decodeCloudflareEmail(encoded) {
  if (!encoded || encoded.length < 4) return null;
  const key = Number.parseInt(encoded.slice(0, 2), 16);
  if (Number.isNaN(key)) return null;
  let decoded = "";
  for (let i = 2; i < encoded.length; i += 2) {
    decoded += String.fromCharCode(Number.parseInt(encoded.slice(i, i + 2), 16) ^ key);
  }
  return decoded;
}

export function extractEmails(text = "") {
  const found = new Set();
  for (const match of text.matchAll(EMAIL_REGEX)) {
    const email = match[0].trim().toLowerCase();
    if (!NOISE_EMAIL_SUFFIXES.some((suffix) => email.endsWith(suffix))) {
      found.add(email);
    }
  }

  for (const match of text.matchAll(/data-cfemail=["']([^"']+)["']/g)) {
    const decoded = decodeCloudflareEmail(match[1]);
    if (decoded) found.add(decoded.toLowerCase());
  }

  for (const match of text.matchAll(/mailto:([^"'\s?<>]+)/gi)) {
    found.add(decodeURIComponent(match[1]).trim().toLowerCase());
  }

  return [...found];
}

export function extractPhones(text = "") {
  const normalized = new Set();
  for (const match of text.matchAll(PHONE_REGEX)) {
    const phone = normalizeSpanishPhone(match[0]);
    if (phone) normalized.add(phone);
  }
  for (const match of text.matchAll(/tel:([^"'\s<>]+)/gi)) {
    const phone = normalizeSpanishPhone(decodeURIComponent(match[1]));
    if (phone) normalized.add(phone);
  }
  return [...normalized];
}

export function extractSocialLinks(links = []) {
  const socials = {};
  for (const link of links) {
    const url = typeof link === "string" ? link : link?.url;
    if (!url) continue;
    if (/instagram\.com/i.test(url) && !socials.instagram) socials.instagram = url;
    if (/facebook\.com/i.test(url) && !socials.facebook) socials.facebook = url;
    if (/linkedin\.com/i.test(url) && !socials.linkedin) socials.linkedin = url;
    if (/wa\.me|api\.whatsapp\.com|whatsapp/i.test(url) && !socials.whatsapp) socials.whatsapp = url;
  }
  return socials;
}

export function detectCommercialSignals({ markdown = "", html = "", links = [] } = {}) {
  const haystack = `${markdown}\n${html}\n${links.map((link) => link.url || link).join("\n")}`.toLowerCase();
  return {
    hasOnlineBooking: /reserv(a|ar|as)|booking|calendly|doctoralia|treatwell|booksy|cita online|agenda/.test(
      haystack
    ),
    hasChatbot: /chatbot|intercom|drift|tawk\.to|crisp|zendesk chat|livechat|hubspotutk/.test(haystack),
    hasWhatsapp: /wa\.me|api\.whatsapp\.com|whatsapp/.test(haystack),
    hasContactForm: /<form|formulario|contacto|contact form|enviar mensaje/.test(haystack)
  };
}

export function selectBusinessUrls(rootUrl, links = [], limit = 8) {
  const normalizedRoot = new URL(rootUrl);
  const candidates = new Map();
  const add = (url, score) => {
    try {
      const parsed = new URL(url, normalizedRoot);
      if (parsed.hostname.replace(/^www\./, "") !== normalizedRoot.hostname.replace(/^www\./, "")) return;
      parsed.hash = "";
      const clean = parsed.toString();
      candidates.set(clean, Math.max(candidates.get(clean) || 0, score));
    } catch {
      // ignore malformed URLs
    }
  };

  add(rootUrl, 100);
  for (const link of links) {
    const url = typeof link === "string" ? link : link?.url;
    if (!url) continue;
    const lower = url.toLowerCase();
    let score = 1;
    if (/contact|contacto|ubicacion|location/.test(lower)) score += 80;
    if (/about|quienes|sobre|equipo|team/.test(lower)) score += 40;
    if (/servicios|services|tratamientos|especialidades/.test(lower)) score += 35;
    if (/reserva|cita|booking|agenda/.test(lower)) score += 45;
    if (/privacy|legal|cookie|aviso-legal|terms/.test(lower)) score -= 60;
    add(url, score);
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url);
}

export function extractLeadSignals(page) {
  const markdown = page.markdown || "";
  const html = page.html || "";
  const links = page.links || [];
  const text = `${markdown}\n${html}`;
  return {
    emails: extractEmails(text),
    phones: extractPhones(text),
    socials: extractSocialLinks(links),
    signals: detectCommercialSignals({ markdown, html, links })
  };
}
