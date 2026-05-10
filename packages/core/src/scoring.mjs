export function calculateLeadScore(business) {
  let score = 0;
  const rating = Number(business.rating || 0);
  const reviews = Number(business.review_count || business.reviewCount || 0);

  if (rating >= 4.5) score += 30;
  else if (rating >= 4.0) score += 20;

  if (reviews >= 200) score += 25;
  else if (reviews >= 50) score += 10;

  if (!business.website) score += 40;
  else if (!business.has_online_booking && !business.hasOnlineBooking) score += 20;

  if (business.phone_e164 || business.phoneE164) score += 15;
  if (business.email_count > 0 || business.hasEmail || business.emails?.length) score += 10;

  return Math.min(score, 100);
}

export function nextOutreachChannel({ score, phone_e164, email_count }) {
  if (score >= 70 && phone_e164) return "voice";
  if (score >= 50 && phone_e164) return "voice_then_email";
  if (email_count > 0) return "email";
  return "enrich_more";
}
