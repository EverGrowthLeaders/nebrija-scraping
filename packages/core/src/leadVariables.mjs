export const LEAD_VARIABLES = [
  { key: "business_id", label: "ID del lead" },
  { key: "business_name", label: "Nombre del negocio" },
  { key: "lead_name", label: "Nombre del lead" },
  { key: "name", label: "Nombre" },
  { key: "city", label: "Ciudad" },
  { key: "category", label: "Categoria" },
  { key: "niche", label: "Nicho" },
  { key: "website", label: "Web" },
  { key: "phone", label: "Telefono original" },
  { key: "phone_e164", label: "Telefono E.164" },
  { key: "decision_maker_name", label: "Nombre decisor" },
  { key: "decision_maker_phone", label: "Movil decisor" },
  { key: "decision_maker_linkedin", label: "LinkedIn decisor" },
  { key: "address", label: "Direccion" },
  { key: "rating", label: "Rating Google" },
  { key: "review_count", label: "Numero de reviews" },
  { key: "score", label: "Score" },
  { key: "source_url", label: "URL fuente" },
  { key: "has_online_booking", label: "Tiene reserva online" },
  { key: "has_chatbot", label: "Tiene chatbot" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" }
];

export function leadVariablePayload(business) {
  const name = business.name || "";
  const decisionMaker = business.custom_fields?.decision_maker?.decisionMaker ||
    business.custom_fields?.decision_maker?.decision_maker ||
    {};
  return {
    business_id: business.id || "",
    business_name: name,
    lead_name: name,
    name,
    city: business.city || "",
    category: business.category || business.niche || "",
    niche: business.niche || "",
    website: business.website || "",
    phone: business.phone || business.phone_e164 || "",
    phone_e164: business.phone_e164 || "",
    decision_maker_name: business.decision_maker_name || decisionMaker.fullName || "",
    decision_maker_phone: business.decision_maker_phone || decisionMaker.phone || "",
    decision_maker_linkedin: business.decision_maker_linkedin || decisionMaker.linkedinUrl || "",
    address: business.address || "",
    rating: business.rating == null ? "" : String(business.rating),
    review_count: business.review_count == null ? "" : String(business.review_count),
    score: business.score == null ? "" : String(business.score),
    source_url: business.source_url || "",
    has_online_booking: business.has_online_booking ? "si" : "no",
    has_chatbot: business.has_chatbot ? "si" : "no",
    instagram: business.instagram || "",
    facebook: business.facebook || ""
  };
}

export function defaultVariableMap(variableNames = []) {
  const available = new Set(LEAD_VARIABLES.map((item) => item.key));
  const aliases = {
    company: "business_name",
    company_name: "business_name",
    business: "business_name",
    negocio: "business_name",
    nombre_negocio: "business_name",
    lead: "business_name",
    phone_number: "phone_e164",
    telefono: "phone_e164",
    decisor: "decision_maker_name",
    nombre_decisor: "decision_maker_name",
    movil_decisor: "decision_maker_phone",
    telefono_decisor: "decision_maker_phone",
    linkedin_decisor: "decision_maker_linkedin",
    reviews: "review_count",
    rating_google: "rating",
    ciudad: "city",
    categoria: "category",
    web: "website"
  };

  return Object.fromEntries(
    variableNames.map((name) => {
      const normalized = String(name).trim();
      const lower = normalized.toLowerCase();
      if (available.has(lower)) return [normalized, lower];
      return [normalized, aliases[lower] || "business_name"];
    })
  );
}

export function buildVariableValues(business, variableMap = {}, variableNames = []) {
  const payload = leadVariablePayload(business);
  const names = variableNames.length ? variableNames : Object.keys(variableMap);
  if (!names.length) return payload;

  const values = {};
  for (const name of names) {
    const source = variableMap[name] || defaultVariableMap([name])[name];
    values[name] = payload[source] ?? "";
  }
  return values;
}
