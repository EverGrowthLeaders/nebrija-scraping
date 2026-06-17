import crypto from "node:crypto";
import { getRedisConnection } from "./queues.mjs";

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function batchKey(batchId) {
  return `enrichment-batch:${batchId}`;
}

function normalizeBatch(raw = {}) {
  if (!raw || !raw.id) return null;
  const total = Number(raw.total) || 0;
  const completed = Number(raw.completed) || 0;
  const failed = Number(raw.failed) || 0;
  const processed = Math.min(total, completed + failed);
  const pending = Math.max(0, total - processed);
  const percentage = total > 0 ? Math.round((processed / total) * 100) : 100;
  return {
    id: raw.id,
    tenantId: raw.tenantId,
    type: raw.type || "enrichment",
    queue: raw.queue || "",
    label: raw.label || "",
    status: raw.status || (pending > 0 ? "running" : "completed"),
    total,
    completed,
    failed,
    processed,
    pending,
    percentage,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    finishedAt: raw.finishedAt || null,
    meta: parseJson(raw.meta, {})
  };
}

export async function createEnrichmentBatch({
  tenantId,
  type = "enrichment",
  queue,
  total,
  label = "",
  meta = {},
  redis = getRedisConnection()
} = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = safeTotal > 0 ? "running" : "completed";
  const payload = {
    id,
    tenantId: tenantId || "",
    type,
    queue: queue || "",
    label,
    status,
    total: String(safeTotal),
    completed: "0",
    failed: "0",
    createdAt: now,
    updatedAt: now,
    finishedAt: status === "completed" ? now : "",
    meta: JSON.stringify(meta || {})
  };
  await redis.hset(batchKey(id), payload);
  await redis.expire(batchKey(id), DEFAULT_TTL_SECONDS);
  return normalizeBatch(payload);
}

export async function getEnrichmentBatch({ tenantId, batchId, redis = getRedisConnection() } = {}) {
  if (!batchId) return null;
  const raw = await redis.hgetall(batchKey(batchId));
  const batch = normalizeBatch(raw);
  if (!batch) return null;
  if (tenantId && batch.tenantId && batch.tenantId !== tenantId) return null;
  return batch;
}

export async function markEnrichmentBatchJobDone({ tenantId, batchId, failed = false, redis = getRedisConnection() } = {}) {
  if (!batchId) return null;
  const key = batchKey(batchId);
  const exists = await redis.exists(key);
  if (!exists) return null;

  const field = failed ? "failed" : "completed";
  await redis.hincrby(key, field, 1);
  const now = new Date().toISOString();
  await redis.hset(key, "updatedAt", now);
  await redis.expire(key, DEFAULT_TTL_SECONDS);

  const raw = await redis.hgetall(key);
  if (tenantId && raw.tenantId && raw.tenantId !== tenantId) return null;
  const batch = normalizeBatch(raw);
  if (batch && batch.processed >= batch.total && batch.status !== "completed") {
    await redis.hset(key, {
      status: "completed",
      updatedAt: now,
      finishedAt: now
    });
    return { ...batch, status: "completed", updatedAt: now, finishedAt: now };
  }
  return batch;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
