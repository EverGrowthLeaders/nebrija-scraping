const DEEPSEEK_V4_FLASH_PRICING = {
  inputPerMillionUsd: 0.10,
  outputPerMillionUsd: 0.20,
  cachedInputPerMillionUsd: 0.02
};

export function estimateDeepseekUsageCost(usage, pricing = DEEPSEEK_V4_FLASH_PRICING) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numberOrZero(usage.total_tokens ?? inputTokens + outputTokens);
  const cachedInputTokens = numberOrZero(
    usage.cached_tokens ??
    usage.cached_input_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens
  );
  const billableInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const inputUsd = (billableInputTokens / 1_000_000) * pricing.inputPerMillionUsd;
  const cachedInputUsd = (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillionUsd;
  const outputUsd = (outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  const estimatedUsd = inputUsd + cachedInputUsd + outputUsd;

  return {
    modelFamily: "deepseek-v4-flash",
    currency: "USD",
    inputTokens,
    cachedInputTokens,
    billableInputTokens,
    outputTokens,
    totalTokens,
    pricing,
    estimatedUsd: roundCost(estimatedUsd)
  };
}

export function summarizeDeepseekEnrichmentCosts({ ads = {}, decisionMaker = {} } = {}) {
  const items = [];
  addAiCostItem(items, "ads.discovery", ads.discoveryPlan?.ai);
  addAiCostItem(items, "ads.meta", ads.meta?.ai);
  addAiCostItem(items, "ads.meta.verification", ads.meta?.ai?.verification);
  addAiCostItem(items, "ads.google", ads.google?.ai);
  addAiCostItem(items, "ads.google.verification", ads.google?.ai?.verification);
  addAiCostItem(items, "ads.funnel", ads.classification?.ai);
  addAiCostItem(items, "decision_maker.search", decisionMaker.searchPlan?.ai);
  addAiCostItem(items, "decision_maker.resolve", decisionMaker.ai);
  addAiCostItem(items, "decision_maker.verify", decisionMaker.ai?.verification);

  return summarizeDeepseekCostItems(items);
}

export function summarizeDeepseekCostItems(items = []) {
  const normalized = items
    .map((item) => normalizeCostItem(item))
    .filter(Boolean);
  return {
    modelFamily: "deepseek-v4-flash",
    currency: "USD",
    totalEstimatedUsd: roundCost(normalized.reduce((total, item) => total + item.estimatedUsd, 0)),
    inputTokens: normalized.reduce((total, item) => total + item.inputTokens, 0),
    cachedInputTokens: normalized.reduce((total, item) => total + item.cachedInputTokens, 0),
    billableInputTokens: normalized.reduce((total, item) => total + item.billableInputTokens, 0),
    outputTokens: normalized.reduce((total, item) => total + item.outputTokens, 0),
    totalTokens: normalized.reduce((total, item) => total + item.totalTokens, 0),
    items: normalized
  };
}

export function validateDeepseekCostBudget({ summary = {}, maxUsd, label = "business", area = "deepseek" } = {}) {
  const limit = numberOrNull(maxUsd);
  if (limit == null) return [];
  const actual = Number(summary.totalEstimatedUsd) || 0;
  if (actual <= limit) return [];
  return [{
    case: label,
    area,
    reason: "deepseek_cost_exceeded",
    expectedMaxUsd: limit,
    actualUsd: roundCost(actual),
    items: Array.isArray(summary.items) ? summary.items : []
  }];
}

function addAiCostItem(items, area, ai) {
  const cost = ai?.cost;
  if (!cost) return;
  items.push({
    area,
    status: ai.status || null,
    model: ai.model || null,
    cost
  });
}

function normalizeCostItem(item = {}) {
  const cost = item.cost || item;
  if (!cost || typeof cost !== "object") return null;
  const estimatedUsd = Number(cost.estimatedUsd);
  if (!Number.isFinite(estimatedUsd)) return null;
  return {
    area: item.area || cost.area || "unknown",
    status: item.status || null,
    model: item.model || cost.model || null,
    currency: cost.currency || "USD",
    estimatedUsd: roundCost(estimatedUsd),
    inputTokens: numberOrZero(cost.inputTokens),
    cachedInputTokens: numberOrZero(cost.cachedInputTokens),
    billableInputTokens: numberOrZero(cost.billableInputTokens),
    outputTokens: numberOrZero(cost.outputTokens),
    totalTokens: numberOrZero(cost.totalTokens)
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function roundCost(value) {
  return Math.round(Number(value || 0) * 1_000_000_000) / 1_000_000_000;
}
