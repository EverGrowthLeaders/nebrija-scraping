const CITY_AREA_MODIFIERS = [
  "centro",
  "norte",
  "sur",
  "este",
  "oeste",
  "cerca de mi",
  "mejores",
  "profesionales"
];

const MADRID_AREA_MODIFIERS = [
  "Centro",
  "Salamanca",
  "Chamberi",
  "Chamartin",
  "Retiro",
  "Arganzuela",
  "Moncloa",
  "Carabanchel",
  "Hortaleza",
  "Fuencarral",
  "Ciudad Lineal",
  "Vallecas"
];

export function buildGoogleDiscoveryQueries(extractionJob = {}, options = {}) {
  const base = String(extractionJob.niche || "").trim();
  const city = String(extractionJob.city || "").trim();
  if (!base || !city) return [];

  const requestedLimit = positiveInt(options.requestedLimit, positiveInt(extractionJob.requested_limit, 20));
  const maxResultCount = positiveInt(options.maxResultCount, 20);
  const minQueries = Math.max(1, Math.ceil(requestedLimit / maxResultCount));
  const targetQueries = Math.min(Math.max(minQueries + 3, 1), positiveInt(options.maxQueries, 16));
  const variants = unique([
    base,
    ...base.split(/[,/|]/).map((item) => item.trim()),
    base.replace(/^empresas?\s+de\s+/i, "").trim(),
    base.replace(/^servicios?\s+de\s+/i, "").trim()
  ].filter(Boolean));

  const modifiers = city.toLowerCase() === "madrid"
    ? [...MADRID_AREA_MODIFIERS, ...CITY_AREA_MODIFIERS]
    : CITY_AREA_MODIFIERS;

  const queries = [];
  for (const variant of variants) {
    queries.push(`${variant} en ${city}`);
  }
  for (const modifier of modifiers) {
    for (const variant of variants) {
      if (queries.length >= targetQueries) return unique(queries);
      queries.push(`${variant} ${city} ${modifier}`);
    }
  }

  return unique(queries).slice(0, targetQueries);
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
