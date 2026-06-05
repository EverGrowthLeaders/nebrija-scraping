export const DEFAULT_SCORING_RULES = [
  {
    id: "rating_4_5",
    label: "Rating Google excelente",
    description: "Rating de Google igual o superior a 4.5.",
    enabled: true,
    points: 30,
    condition: "rating_at_least",
    threshold: 4.5,
    exclusiveGroup: "rating",
    order: 10
  },
  {
    id: "rating_4_0",
    label: "Rating Google bueno",
    description: "Rating de Google igual o superior a 4.0.",
    enabled: true,
    points: 20,
    condition: "rating_at_least",
    threshold: 4,
    exclusiveGroup: "rating",
    order: 20
  },
  {
    id: "reviews_200",
    label: "Alta prueba social",
    description: "200 o más reseñas.",
    enabled: true,
    points: 25,
    condition: "reviews_at_least",
    threshold: 200,
    exclusiveGroup: "reviews",
    order: 30
  },
  {
    id: "reviews_50",
    label: "Prueba social suficiente",
    description: "50 o más reseñas.",
    enabled: true,
    points: 10,
    condition: "reviews_at_least",
    threshold: 50,
    exclusiveGroup: "reviews",
    order: 40
  },
  {
    id: "missing_website",
    label: "Sin web detectada",
    description: "No tiene web visible; oportunidad alta de digitalización.",
    enabled: true,
    points: 40,
    condition: "missing_website",
    exclusiveGroup: "web_presence",
    order: 50
  },
  {
    id: "missing_online_booking",
    label: "Sin reserva online",
    description: "Tiene web, pero no se detectó reserva/cita online.",
    enabled: true,
    points: 20,
    condition: "missing_online_booking",
    exclusiveGroup: "web_presence",
    order: 60
  },
  {
    id: "has_phone",
    label: "Tiene teléfono",
    description: "Puede entrar en flujo de llamada.",
    enabled: true,
    points: 15,
    condition: "has_phone",
    order: 70
  },
  {
    id: "has_email",
    label: "Tiene email",
    description: "Puede recibir seguimiento por email.",
    enabled: true,
    points: 10,
    condition: "has_email",
    order: 80
  },
  {
    id: "meta_ads_active",
    label: "Meta Ads activo",
    description: "Señal activa en Meta Ads Library.",
    enabled: true,
    points: 15,
    condition: "meta_ads_active",
    order: 90
  },
  {
    id: "google_ads_active",
    label: "Google Ads activo",
    description: "Señal activa en Google Ads Transparency Center.",
    enabled: true,
    points: 15,
    condition: "google_ads_active",
    order: 100
  }
];

const DEFAULT_MAX_SCORE = 100;

export function calculateLeadScore(business, rules = DEFAULT_SCORING_RULES) {
  return explainLeadScore(business, rules).score;
}

export function explainLeadScore(business, rules = DEFAULT_SCORING_RULES) {
  let score = 0;
  const matchedGroups = new Set();
  const matchedRules = [];
  const orderedRules = normalizeScoringRules(rules);

  for (const rule of orderedRules) {
    if (!rule.enabled) continue;
    if (rule.exclusiveGroup && matchedGroups.has(rule.exclusiveGroup)) continue;
    if (!ruleMatchesBusiness(rule, business)) continue;
    const points = clampRulePoints(rule.points);
    if (points === 0) continue;
    score += points;
    matchedRules.push({
      id: rule.id,
      label: rule.label,
      points,
      condition: rule.condition
    });
    if (rule.exclusiveGroup) matchedGroups.add(rule.exclusiveGroup);
  }

  return {
    score: Math.min(score, DEFAULT_MAX_SCORE),
    rawScore: score,
    maxScore: DEFAULT_MAX_SCORE,
    matchedRules
  };
}

export function nextOutreachChannel({ score, phone_e164, email_count }) {
  if (score >= 70 && phone_e164) return "voice";
  if (score >= 50 && phone_e164) return "voice_then_email";
  if (email_count > 0) return "email";
  return "enrich_more";
}

export function normalizeScoringRules(rules = DEFAULT_SCORING_RULES) {
  const fallbackById = new Map(DEFAULT_SCORING_RULES.map((rule) => [rule.id, rule]));
  const incoming = Array.isArray(rules) ? rules : [];
  const merged = incoming
    .filter((rule) => rule && typeof rule === "object")
    .map((rule) => {
      const fallback = fallbackById.get(rule.id) || {};
      return {
        ...fallback,
        ...rule,
        id: String(rule.id || fallback.id || "").trim(),
        label: String(rule.label || fallback.label || rule.id || "Regla").trim(),
        description: String(rule.description || fallback.description || "").trim(),
        enabled: rule.enabled !== false,
        points: clampRulePoints(rule.points ?? fallback.points),
        order: Number(rule.order ?? fallback.order ?? 999)
      };
    })
    .filter((rule) => rule.id && rule.condition);

  const knownIds = new Set(merged.map((rule) => rule.id));
  for (const defaultRule of DEFAULT_SCORING_RULES) {
    if (!knownIds.has(defaultRule.id)) merged.push({ ...defaultRule });
  }

  return merged.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

function ruleMatchesBusiness(rule, business = {}) {
  const rating = Number(business.rating || 0);
  const reviews = Number(business.review_count || business.reviewCount || 0);
  const emailCount = Number(business.email_count || business.emailCount || 0);

  switch (rule.condition) {
    case "rating_at_least":
      return rating >= Number(rule.threshold || 0);
    case "reviews_at_least":
      return reviews >= Number(rule.threshold || 0);
    case "missing_website":
      return !business.website;
    case "missing_online_booking":
      return Boolean(business.website) && !business.has_online_booking && !business.hasOnlineBooking;
    case "has_phone":
      return Boolean(business.phone_e164 || business.phoneE164);
    case "has_email":
      return emailCount > 0 || Boolean(business.hasEmail) || Boolean(business.emails?.length);
    case "meta_ads_active":
      return business.ads_meta_active === true || business.adsMetaActive === true;
    case "google_ads_active":
      return business.ads_google_active === true || business.adsGoogleActive === true;
    case "any_ads_active":
      return business.ads_meta_active === true || business.adsMetaActive === true || business.ads_google_active === true || business.adsGoogleActive === true;
    default:
      return false;
  }
}

function clampRulePoints(points) {
  return Math.max(-100, Math.min(100, Math.round(Number(points) || 0)));
}
