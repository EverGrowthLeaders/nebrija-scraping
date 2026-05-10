export function normalizeSpanishPhone(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");

  if (digits.startsWith("0034") && digits.length === 13) {
    return `+${digits.slice(2)}`;
  }

  if (digits.startsWith("34") && digits.length === 11) {
    return `+${digits}`;
  }

  if (digits.length === 9 && /^[6789]/.test(digits)) {
    return `+34${digits}`;
  }

  return null;
}

export function isProbablyMobile(e164) {
  return /^\+34[67]/.test(e164 || "");
}
