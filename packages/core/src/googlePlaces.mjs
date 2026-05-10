import { config, requireEnv } from "./config.mjs";
import { fetchJson } from "./http.mjs";
import { normalizeSpanishPhone } from "./phone.mjs";

export const LEAD_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.googleMapsUri",
  "places.websiteUri",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount"
];

export function mergePlacesFieldMask(fieldMask, requiredFields = LEAD_FIELD_MASK) {
  if (String(fieldMask || "").trim() === "*") return "*";
  const fields = new Set(
    String(fieldMask || "")
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean)
  );
  for (const field of requiredFields) fields.add(field);
  return [...fields].join(",");
}

export class GooglePlacesClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.google.placesBaseUrl;
    this.apiKey = options.apiKey ?? config.google.apiKey;
    this.fieldMask = mergePlacesFieldMask(options.fieldMask || config.google.defaultFieldMask);
  }

  headers(fieldMask = this.fieldMask) {
    return {
      "X-Goog-Api-Key": requireEnv(this.apiKey, "GOOGLE_MAPS_API_KEY"),
      "X-Goog-FieldMask": mergePlacesFieldMask(fieldMask)
    };
  }

  async searchText({ query, languageCode = "es", regionCode = "ES", maxResultCount = 20, fieldMask } = {}) {
    const body = {
      textQuery: query,
      languageCode,
      regionCode,
      maxResultCount
    };
    const response = await fetchJson(`${this.baseUrl}/places:searchText`, {
      method: "POST",
      headers: this.headers(fieldMask),
      body: JSON.stringify(body),
      timeoutMs: 30_000
    });
    return normalizePlaces(response?.places || []);
  }

  async searchNearby({ latitude, longitude, radiusMeters = 1500, includedTypes = [], fieldMask } = {}) {
    const body = {
      locationRestriction: {
        circle: {
          center: { latitude, longitude },
          radius: radiusMeters
        }
      },
      languageCode: "es",
      regionCode: "ES",
      maxResultCount: 20
    };
    if (includedTypes.length) body.includedTypes = includedTypes;

    const response = await fetchJson(`${this.baseUrl}/places:searchNearby`, {
      method: "POST",
      headers: this.headers(fieldMask),
      body: JSON.stringify(body),
      timeoutMs: 30_000
    });
    return normalizePlaces(response?.places || []);
  }
}

export function normalizePlaces(places) {
  return places.map((place) => ({
    placeId: place.id || place.name?.replace(/^places\//, ""),
    name: place.displayName?.text || place.displayName || null,
    address: place.formattedAddress || null,
    website: place.websiteUri || null,
    phone: place.internationalPhoneNumber || place.nationalPhoneNumber || null,
    phoneE164: normalizeSpanishPhone(place.internationalPhoneNumber || place.nationalPhoneNumber),
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? null,
    sourceUrl: place.googleMapsUri || place.searchUri || null,
    raw: place
  }));
}
