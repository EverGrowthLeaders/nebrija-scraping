import crypto from "node:crypto";
import { normalizeSpanishPhone } from "./phone.mjs";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const NOISE_EMAIL_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".css", ".js", ".svg"];
const PHONE_REGEX = /(?:\+34|0034)?[\s.-]?(?:[6789][\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d[\s.-]?\d)/g;
const PHONE_CONTEXT_REGEX = /tel[eé]fono|tel\.|llama|llamar|ll[aá]manos|contacto|contacta|whatsapp|m[oó]vil|phone/i;
const MAX_PHONES_PER_PAGE = 5;

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

export function extractPhones(text = "", { html = "", links = [], strict = false, maxPhones = MAX_PHONES_PER_PAGE } = {}) {
  const normalized = new Set();
  const add = (value) => {
    const phone = normalizeSpanishPhone(value);
    if (phone && normalized.size < maxPhones) normalized.add(phone);
  };

  extractPhonesFromTelLinks(`${html}\n${linksToText(links)}`).forEach(add);
  extractPhonesFromWhatsappLinks(`${html}\n${linksToText(links)}`).forEach(add);

  if (strict) {
    extractContextualPhones(text).forEach(add);
  } else {
    for (const match of text.matchAll(PHONE_REGEX)) add(match[0]);
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
  const text = markdown;
  return {
    emails: extractEmails(text),
    phones: extractPhones(text, { html, links, strict: true }),
    socials: extractSocialLinks(links),
    signals: detectCommercialSignals({ markdown, html, links })
  };
}

function extractPhonesFromTelLinks(text) {
  return Array.from(String(text || "").matchAll(/(?:href=["']?)?tel:([^"'\s<>]+)/gi))
    .map((match) => safeDecode(match[1]));
}

function extractPhonesFromWhatsappLinks(text) {
  const found = [];
  for (const match of String(text || "").matchAll(/(?:wa\.me\/|phone=|whatsapp(?:%3A|:)?\/\/send\?phone=)(\+?\d{9,15})/gi)) {
    found.push(match[1]);
  }
  return found;
}

function extractContextualPhones(text) {
  const found = [];
  const value = String(text || "");
  for (const match of value.matchAll(PHONE_REGEX)) {
    const context = sentenceAround(value, match.index, match[0].length);
    if (PHONE_CONTEXT_REGEX.test(context) || isStandalonePhoneText(context)) found.push(match[0]);
  }
  return found;
}

function isStandalonePhoneText(context) {
  const trimmed = String(context || "").trim();
  return trimmed.length <= 36 && !/[<>{}=;]/.test(trimmed);
}

function sentenceAround(value, index, length) {
  const startCandidates = [
    value.lastIndexOf("\n", index - 1),
    value.lastIndexOf(".", index - 1),
    value.lastIndexOf(";", index - 1),
    value.lastIndexOf("!", index - 1),
    value.lastIndexOf("?", index - 1)
  ];
  const start = Math.max(...startCandidates, -1) + 1;
  const tail = value.slice(index + length);
  const endOffset = tail.search(/[.\n;!?]/);
  const end = endOffset === -1 ? value.length : index + length + endOffset;
  return value.slice(start, end);
}

function linksToText(links = []) {
  return links
    .map((link) => typeof link === "string" ? link : `${link.url || ""} ${link.href || ""}`)
    .join("\n");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
