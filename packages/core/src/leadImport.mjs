import zlib from "node:zlib";
import { normalizeSpanishPhone } from "./phone.mjs";

export const LEAD_IMPORT_FIELDS = [
  { key: "name", label: "Nombre", required: true, aliases: ["nombre", "empresa", "negocio", "lead", "company", "business", "razon social", "razón social"] },
  { key: "website", label: "Web", aliases: ["web", "website", "url", "sitio web", "pagina web", "página web", "dominio"] },
  { key: "phone", label: "Telefono", aliases: ["telefono", "teléfono", "phone", "movil", "móvil", "tel"] },
  { key: "phone_e164", label: "Telefono E.164", aliases: ["phone_e164", "telefono e164", "teléfono e164", "e164"] },
  { key: "email", label: "Email", aliases: ["email", "correo", "correo electronico", "correo electrónico", "mail", "e-mail"] },
  { key: "address", label: "Direccion", aliases: ["direccion", "dirección", "address", "calle"] },
  { key: "city", label: "Ciudad", aliases: ["ciudad", "city", "localidad", "municipio"] },
  { key: "postal_code", label: "Codigo postal", aliases: ["codigo postal", "código postal", "cp", "postal code", "zip"] },
  { key: "niche", label: "Nicho", aliases: ["nicho", "sector", "industria", "actividad"] },
  { key: "category", label: "Categoria", aliases: ["categoria", "categoría", "category", "tipo"] },
  { key: "instagram", label: "Instagram", aliases: ["instagram", "ig"] },
  { key: "facebook", label: "Facebook", aliases: ["facebook", "fb", "meta"] },
  { key: "source_url", label: "URL fuente", aliases: ["source", "fuente", "source_url", "url fuente"] },
  { key: "scoring_notes", label: "Notas scoring", aliases: ["notas", "notas scoring", "observaciones", "comentarios"] }
];

const FIELD_BY_KEY = Object.fromEntries(LEAD_IMPORT_FIELDS.map((field) => [field.key, field]));
const MAX_IMPORT_ROWS = 5000;

export function previewLeadImport({ filename, contentBase64, buffer, maxSampleRows = 5 }) {
  const parsed = parseLeadFile({ filename, contentBase64, buffer });
  const headers = parsed.headers;
  return {
    filename: parsed.filename,
    format: parsed.format,
    totalRows: parsed.rows.length,
    headers,
    sampleRows: parsed.rows.slice(0, maxSampleRows),
    suggestedMapping: suggestLeadMapping(headers),
    crmFields: LEAD_IMPORT_FIELDS
  };
}

export function parseLeadFile({ filename = "leads.csv", contentBase64, buffer }) {
  const fileBuffer = buffer || Buffer.from(String(contentBase64 || ""), "base64");
  if (!fileBuffer.length) throw badImport("empty_file");

  const lower = String(filename || "").toLowerCase();
  const matrix = lower.endsWith(".xlsx")
    ? parseXlsxRows(fileBuffer)
    : parseCsvRows(fileBuffer.toString("utf8"));
  const { headers, rows } = rowsFromMatrix(matrix);
  if (!headers.length) throw badImport("missing_headers");
  if (!rows.length) throw badImport("missing_rows");
  if (rows.length > MAX_IMPORT_ROWS) throw badImport(`too_many_rows_max_${MAX_IMPORT_ROWS}`);

  return {
    filename,
    format: lower.endsWith(".xlsx") ? "xlsx" : "csv",
    headers,
    rows
  };
}

export function suggestLeadMapping(headers) {
  const used = new Set();
  const suggestions = {};
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const field = LEAD_IMPORT_FIELDS.find((candidate) =>
      [candidate.key, candidate.label, ...(candidate.aliases || [])].some((alias) => normalizeHeader(alias) === normalized)
    );
    if (field && !used.has(field.key)) {
      suggestions[header] = field.key;
      used.add(field.key);
    } else if (field?.key === "email") {
      suggestions[header] = field.key;
    } else {
      suggestions[header] = `custom:${customKeyFromHeader(header)}`;
    }
  }
  return suggestions;
}

export function buildImportedLeadRows(rows, mapping) {
  const normalizedMapping = normalizeMapping(mapping);
  const importRows = [];
  const errors = [];

  rows.forEach((row, index) => {
    const business = {};
    const customFields = {};
    const contacts = [];

    for (const [header, rawMapping] of Object.entries(normalizedMapping)) {
      const value = cleanCell(row[header]);
      if (!value) continue;
      if (!rawMapping || rawMapping === "ignore") continue;
      if (rawMapping.startsWith("custom:")) {
        const customKey = customKeyFromHeader(rawMapping.slice("custom:".length) || header);
        customFields[customKey] = value;
        continue;
      }
      if (rawMapping === "email") {
        contacts.push({ kind: "email", value, confidence: 0.75 });
        continue;
      }
      if (!FIELD_BY_KEY[rawMapping]) continue;
      business[toBusinessInputKey(rawMapping)] = value;
    }

    if (business.phone && !business.phoneE164) business.phoneE164 = normalizeSpanishPhone(business.phone);
    if (!business.name) {
      errors.push({ row: index + 2, error: "missing_name" });
      return;
    }
    importRows.push({
      business,
      contacts,
      customFields,
      originalRow: row,
      rowNumber: index + 2
    });
  });

  return { rows: importRows, errors };
}

export function normalizeMapping(mapping = {}) {
  const source = mapping.columns || mapping.fieldMapping || mapping;
  const normalized = {};
  for (const [header, value] of Object.entries(source || {})) {
    if (typeof value === "string") {
      normalized[header] = value.trim() || "ignore";
    } else if (value?.type === "custom") {
      normalized[header] = `custom:${value.key || header}`;
    } else if (value?.field) {
      normalized[header] = value.field;
    }
  }
  return normalized;
}

function parseCsvRows(text) {
  const src = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < src.length; index += 1) {
    const char = src[index];
    const next = src[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return trimEmptyRows(rows);
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const candidates = [",", ";", "\t"];
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter || ",";
}

function parseXlsxRows(buffer) {
  const files = unzipXlsx(buffer);
  const sheetPath = firstWorksheetPath(files);
  const sheetXml = files.get(sheetPath);
  if (!sheetXml) throw badImport("xlsx_missing_sheet");
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml") || "");
  const rows = [];

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    const rowXml = rowMatch[1].replace(/<c\b([^>]*)\/>/g, "<c$1></c>");
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = parseXmlAttrs(cellMatch[1]);
      const colIndex = columnIndexFromCellRef(attrs.r || "");
      if (!colIndex) continue;
      cells[colIndex - 1] = parseXlsxCellValue(attrs, cellMatch[2], sharedStrings);
    }
    rows.push(cells.map((value) => cleanCell(value)));
  }
  return trimEmptyRows(rows);
}

function unzipXlsx(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const files = new Map();
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw badImport("xlsx_invalid_central_directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw badImport("xlsx_invalid_local_file");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const data = method === 0
      ? compressed
      : method === 8
        ? zlib.inflateRawSync(compressed)
        : null;
    if (data) files.set(name, data.toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw badImport("xlsx_invalid_zip");
}

function firstWorksheetPath(files) {
  const workbook = files.get("xl/workbook.xml") || "";
  const rels = files.get("xl/_rels/workbook.xml.rels") || "";
  const firstSheet = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (firstSheet) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${escapeRegExp(firstSheet[1])}"[^>]*Target="([^"]+)"`).exec(rels);
    if (rel?.[1]) {
      const target = rel[1].replace(/^\/?xl\//, "");
      return `xl/${target}`;
    }
  }
  return "xl/worksheets/sheet1.xml";
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)).map((match) =>
    Array.from(match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((textMatch) => decodeXml(textMatch[1]))
      .join("")
  );
}

function parseXlsxCellValue(attrs, inner, sharedStrings) {
  const valueMatch = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
  if (attrs.t === "s") return sharedStrings[Number(valueMatch?.[1] || 0)] || "";
  if (attrs.t === "inlineStr") {
    return Array.from(inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((match) => decodeXml(match[1]))
      .join("");
  }
  return decodeXml(valueMatch?.[1] || "");
}

function parseXmlAttrs(text) {
  return Object.fromEntries(Array.from(text.matchAll(/([:\w-]+)="([^"]*)"/g)).map((match) => [match[1], decodeXml(match[2])]));
}

function rowsFromMatrix(matrix) {
  const first = matrix.findIndex((row) => row.some((cell) => cleanCell(cell)));
  if (first === -1) return { headers: [], rows: [] };
  const rawHeaders = matrix[first].map((header, index) => cleanCell(header) || `Columna ${index + 1}`);
  const headers = uniqueHeaders(rawHeaders);
  const rows = trimEmptyRows(matrix.slice(first + 1))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, cleanCell(row[index])])))
    .filter((row) => Object.values(row).some(Boolean));
  return { headers, rows };
}

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header) => {
    const base = header || "Columna";
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base} ${count + 1}` : base;
  });
}

function trimEmptyRows(rows) {
  let end = rows.length;
  while (end > 0 && !rows[end - 1].some((cell) => cleanCell(cell))) end -= 1;
  return rows.slice(0, end);
}

function cleanCell(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function customKeyFromHeader(value) {
  return normalizeHeader(value).replace(/\s+/g, "_").slice(0, 48) || "custom";
}

function toBusinessInputKey(field) {
  const map = {
    phone_e164: "phoneE164",
    source_url: "sourceUrl",
    scoring_notes: "scoringNotes",
    postal_code: "postalCode"
  };
  return map[field] || field;
}

function columnIndexFromCellRef(ref) {
  const letters = String(ref || "").match(/^[A-Z]+/i)?.[0] || "";
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64;
  return index;
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function badImport(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
