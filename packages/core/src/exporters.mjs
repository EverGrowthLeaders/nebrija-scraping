export const CAMPAIGN_LEAD_EXPORT_COLUMNS = [
  { key: "id", label: "Lead ID" },
  { key: "name", label: "Nombre" },
  { key: "city", label: "Ciudad" },
  { key: "niche", label: "Nicho" },
  { key: "category", label: "Categoria" },
  { key: "status", label: "Estado" },
  { key: "score", label: "Score", type: "number" },
  { key: "phone_e164", label: "Telefono E.164" },
  { key: "phone", label: "Telefono original" },
  { key: "emails", label: "Emails" },
  { key: "website", label: "Web" },
  { key: "address", label: "Direccion" },
  { key: "rating", label: "Rating Google", type: "number" },
  { key: "review_count", label: "Reviews Google", type: "number" },
  { key: "has_online_booking", label: "Reserva online", type: "boolean" },
  { key: "has_chatbot", label: "Chatbot", type: "boolean" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "source_url", label: "URL fuente" },
  { key: "place_id", label: "Google Place ID" },
  { key: "scoring_notes", label: "Notas scoring" },
  { key: "created_at", label: "Creado" },
  { key: "updated_at", label: "Actualizado" }
];

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function campaignExportFilename(job = {}, ext = "xlsx") {
  const parts = ["leads", job.niche, job.city].filter(Boolean).map(slugify);
  const date = new Date().toISOString().slice(0, 10);
  return `${parts.join("-") || "leads-campana"}-${date}.${String(ext).replace(/^\./, "")}`;
}

export function buildCampaignCsv(leads, { columns = CAMPAIGN_LEAD_EXPORT_COLUMNS } = {}) {
  const lines = [
    columns.map((column) => csvEscape(column.label, { safeText: false })).join(","),
    ...leads.map((lead) =>
      columns.map((column) => csvEscape(exportValue(lead, column), { safeText: column.type !== "number" })).join(",")
    )
  ];
  return Buffer.concat([Buffer.from("\uFEFF", "utf8"), Buffer.from(lines.join("\r\n"), "utf8")]);
}

export function buildCampaignXlsx(leads, { columns = CAMPAIGN_LEAD_EXPORT_COLUMNS, sheetName = "Leads" } = {}) {
  const rows = [
    columns.map((column) => ({ value: column.label, type: "text", header: true })),
    ...leads.map((lead) => columns.map((column) => ({ value: exportValue(lead, column), type: column.type || "text" })))
  ];

  const files = [
    { path: "[Content_Types].xml", data: contentTypesXml() },
    { path: "_rels/.rels", data: rootRelsXml() },
    { path: "docProps/app.xml", data: appXml() },
    { path: "docProps/core.xml", data: coreXml() },
    { path: "xl/workbook.xml", data: workbookXml(sheetName) },
    { path: "xl/_rels/workbook.xml.rels", data: workbookRelsXml() },
    { path: "xl/styles.xml", data: stylesXml() },
    { path: "xl/worksheets/sheet1.xml", data: worksheetXml(rows, columns) }
  ];

  return zipFiles(files.map((file) => ({ path: file.path, data: Buffer.from(file.data, "utf8") })));
}

export { XLSX_CONTENT_TYPE };

function exportValue(lead, column) {
  const value = lead?.[column.key];
  if (column.key === "emails") return Array.isArray(value) ? value.join("; ") : value || "";
  if (column.type === "boolean") return value ? "si" : "no";
  if (value instanceof Date) return value.toISOString();
  if (value == null) return "";
  return value;
}

function csvEscape(value, { safeText = true } = {}) {
  let text = formatText(value);
  if (safeText && /^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function worksheetXml(rows, columns) {
  const lastCell = `${columnName(columns.length)}${Math.max(rows.length, 1)}`;
  const rowXml = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cellXml = row
        .map((cell, colIndex) => cellXmlValue(cell, `${columnName(colIndex + 1)}${rowNumber}`))
        .join("");
      return `<row r="${rowNumber}">${cellXml}</row>`;
    })
    .join("");
  const colXml = columns
    .map((column, index) => {
      const width = columnWidth(column.key);
      const number = index + 1;
      return `<col min="${number}" max="${number}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>${colXml}</cols>
  <sheetData>${rowXml}</sheetData>
  <autoFilter ref="A1:${lastCell}"/>
</worksheet>`;
}

function cellXmlValue(cell, ref) {
  if (cell.value == null || cell.value === "") return `<c r="${ref}"/>`;
  if (cell.type === "number") {
    const number = Number(cell.value);
    if (Number.isFinite(number)) return `<c r="${ref}"><v>${number}</v></c>`;
  }
  const style = cell.header ? ' s="1"' : "";
  return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlEscape(formatText(cell.value))}</t></is></c>`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="${XLSX_CONTENT_TYPE}"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function workbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Nebrija Scraping</Application>
</Properties>`;
}

function coreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Nebrija Scraping</dc:creator>
  <cp:lastModifiedBy>Nebrija Scraping</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function dosDateTime(value) {
  const year = Math.max(value.getFullYear(), 1980);
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()
  };
}

function columnName(index) {
  let name = "";
  let number = index;
  while (number > 0) {
    const mod = (number - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    number = Math.floor((number - mod) / 26);
  }
  return name;
}

function columnWidth(key) {
  const widths = {
    id: 38,
    name: 32,
    emails: 34,
    website: 34,
    address: 42,
    source_url: 34,
    scoring_notes: 42,
    created_at: 22,
    updated_at: 22
  };
  return widths[key] || 18;
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function safeSheetName(value) {
  return String(value || "Leads")
    .replace(/[\][:*?/\\]/g, " ")
    .slice(0, 31)
    .trim() || "Leads";
}

function formatText(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function xmlEscape(value) {
  return formatText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
