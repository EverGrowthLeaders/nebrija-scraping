export function parseEndOfCallReport(payload) {
  const message = payload?.message || payload;
  const type = message?.type || payload?.type;
  if (type && type !== "end-of-call-report" && type !== "call.finished") {
    return { isEndOfCallReport: false, type };
  }

  const call = message?.call || payload?.call || {};
  const artifact = message?.artifact || {};
  const analysis = message?.analysis || {};
  const structuredData =
    analysis.structuredData ||
    analysis.structured_data ||
    message?.structuredData ||
    message?.structured_data ||
    {};

  const transcript =
    artifact.transcript ||
    message.transcript ||
    payload.transcript ||
    normalizeTranscriptFromMessages(artifact.messages || message.messages || []);

  const startedAt = call.startedAt || call.startTime || message.startedAt || payload.startTime || null;
  const endedAt = call.endedAt || call.endTime || message.endedAt || payload.endTime || null;
  const durationSeconds =
    numberOrNull(message.durationSeconds) ||
    numberOrNull(call.durationSeconds) ||
    durationFromDates(startedAt, endedAt) ||
    minutesToSeconds(call.durationMinutes || payload.durationMinutes);

  return {
    isEndOfCallReport: true,
    type: type || "end-of-call-report",
    providerCallId: call.id || message.callId || payload.id || payload.callId || null,
    status: call.status || payload.status || "ended",
    customerNumber: call.customer?.number || message.customer?.number || payload.customer?.number || null,
    startedAt,
    endedAt,
    durationSeconds,
    cost: numberOrNull(call.cost) || numberOrNull(payload.cost),
    endedReason: message.endedReason || call.endedReason || payload.endedReason || null,
    transcript,
    summary: analysis.summary || message.summary || payload.summary || null,
    outcome: structuredData.outcome || null,
    qualified: booleanOrNull(structuredData.qualified ?? structuredData.interested),
    recordingUrl:
      artifact.recording?.url ||
      artifact.recordingUrl ||
      message.recordingUrl ||
      payload.recordingUrl ||
      null,
    structuredData,
    rawReport: payload
  };
}

function normalizeTranscriptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((item) => {
      const role = item.role || item.speaker || "unknown";
      const content = item.message || item.content || item.text || "";
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return null;
}

function durationFromDates(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function minutesToSeconds(minutes) {
  const parsed = numberOrNull(minutes);
  return parsed == null ? null : Math.round(parsed * 60);
}
