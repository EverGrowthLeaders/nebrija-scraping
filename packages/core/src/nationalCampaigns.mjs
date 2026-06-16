const TOP_20_CITIES = [
  "Madrid",
  "Barcelona",
  "Valencia",
  "Sevilla",
  "Zaragoza",
  "Malaga",
  "Murcia",
  "Palma",
  "Las Palmas de Gran Canaria",
  "Bilbao",
  "Alicante",
  "Cordoba",
  "Valladolid",
  "Vigo",
  "Gijon",
  "Hospitalet de Llobregat",
  "Vitoria-Gasteiz",
  "A Coruna",
  "Granada",
  "Elche"
];

const TOP_50_CITIES = [
  ...TOP_20_CITIES,
  "Oviedo",
  "Badalona",
  "Cartagena",
  "Terrassa",
  "Jerez de la Frontera",
  "Sabadell",
  "Mostoles",
  "Santa Cruz de Tenerife",
  "Pamplona",
  "Almeria",
  "Alcala de Henares",
  "Fuenlabrada",
  "Leganes",
  "Donostia-San Sebastian",
  "Getafe",
  "Burgos",
  "Albacete",
  "Santander",
  "Castellon de la Plana",
  "Alcorcon",
  "Logrono",
  "Badajoz",
  "Salamanca",
  "Huelva",
  "Lleida",
  "Marbella",
  "Tarragona",
  "Leon",
  "Cadiz",
  "Dos Hermanas"
];

const PROVINCE_CAPITALS = [
  "A Coruna",
  "Albacete",
  "Alicante",
  "Almeria",
  "Avila",
  "Badajoz",
  "Barcelona",
  "Bilbao",
  "Burgos",
  "Caceres",
  "Cadiz",
  "Castellon de la Plana",
  "Ceuta",
  "Ciudad Real",
  "Cordoba",
  "Cuenca",
  "Donostia-San Sebastian",
  "Girona",
  "Granada",
  "Guadalajara",
  "Huelva",
  "Huesca",
  "Jaen",
  "Las Palmas de Gran Canaria",
  "Leon",
  "Lleida",
  "Logrono",
  "Lugo",
  "Madrid",
  "Malaga",
  "Melilla",
  "Murcia",
  "Ourense",
  "Oviedo",
  "Palencia",
  "Palma",
  "Pamplona",
  "Pontevedra",
  "Salamanca",
  "Santa Cruz de Tenerife",
  "Santander",
  "Segovia",
  "Sevilla",
  "Soria",
  "Tarragona",
  "Teruel",
  "Toledo",
  "Valencia",
  "Valladolid",
  "Vitoria-Gasteiz",
  "Zamora",
  "Zaragoza"
];

export const SPANISH_CITY_PRESETS = Object.freeze({
  top_20: TOP_20_CITIES,
  top_50: TOP_50_CITIES,
  province_capitals: PROVINCE_CAPITALS,
  all_supported: unique([...TOP_50_CITIES, ...PROVINCE_CAPITALS])
});

export const DEFAULT_NATIONAL_CITY_PRESET = "top_50";
export const DEFAULT_NATIONAL_LIMIT_PER_CITY = 50;
export const MAX_NATIONAL_CAMPAIGN_CITIES = 250;

export function buildNationalCampaignPlan(input = {}) {
  const niche = String(input.niche || "").trim();
  if (!niche) throwBadRequest("missing_niche", "niche is required");

  const sourceType = String(input.sourceType || input.source_type || "google_places_api").trim() || "google_places_api";
  const cityPreset = normalizePresetName(input.cityPreset || input.city_preset || input.preset || DEFAULT_NATIONAL_CITY_PRESET);
  const cities = resolveNationalCampaignCities(input, cityPreset);
  const requestedLimitTotal = positiveInt(input.requestedLimitTotal ?? input.requested_limit_total ?? input.totalLimit ?? input.total_limit, null);
  const limitPerCity = positiveInt(
    input.limitPerCity ?? input.limit_per_city ?? input.requestedLimitPerCity ?? input.requested_limit_per_city,
    requestedLimitTotal ? Math.max(1, Math.ceil(requestedLimitTotal / cities.length)) : DEFAULT_NATIONAL_LIMIT_PER_CITY
  );

  return {
    niche,
    sourceType,
    country: String(input.country || "ES").trim() || "ES",
    cityPreset,
    cities,
    limitPerCity,
    requestedLimitTotal,
    campaigns: cities.map((city) => ({
      niche,
      city,
      sourceType,
      requestedLimit: limitPerCity
    }))
  };
}

export function resolveNationalCampaignCities(input = {}, presetName = DEFAULT_NATIONAL_CITY_PRESET) {
  const explicitCities = parseStringArray(input.cities ?? input.cityList ?? input.city_list);
  const limitCities = positiveInt(input.limitCities ?? input.limit_cities ?? input.maxCities ?? input.max_cities, MAX_NATIONAL_CAMPAIGN_CITIES);
  const maxCities = Math.min(limitCities, MAX_NATIONAL_CAMPAIGN_CITIES);
  if (explicitCities.length) return unique(explicitCities).slice(0, maxCities);

  const preset = SPANISH_CITY_PRESETS[presetName];
  if (!preset) {
    throwBadRequest("unsupported_city_preset", `unsupported city preset: ${presetName}`);
  }
  return preset.slice(0, maxCities);
}

function normalizePresetName(value) {
  return String(value || DEFAULT_NATIONAL_CITY_PRESET).trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[\n,;|]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function throwBadRequest(code, message) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = 400;
  throw error;
}
