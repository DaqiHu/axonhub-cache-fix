import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const ENV_VAR = "CACHE_FIX_UPSTREAM_ERROR_BODY_LOG";
const MAX_PREVIEW_CHARS = 4096;
const MAX_MESSAGE_CHARS = 2048;
const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|credential|password/i;

function logPath() {
  return process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH
    || join(
      process.env.AXONHUB_CACHE_FIX_LOG_DIR || join(homedir(), ".claude", "usage-log"),
      "upstream-error-bodies.jsonl",
    );
}

function headerLookup(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function sanitize(value, depth = 0) {
  if (depth > 12) return "[DEPTH_TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
  }
  return result;
}

function truncate(value, maximum) {
  if (typeof value !== "string") return value;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 15)}...[TRUNCATED]`;
}

function errorEnvelope(body) {
  if (!body || typeof body !== "object") return {};
  const error = body.error && typeof body.error === "object" ? body.error : body;
  return {
    code: error.code ?? error.type ?? null,
    message: typeof error.message === "string" ? error.message : null,
  };
}

export function buildRecord({ ctx, now = new Date() }) {
  const sanitized = sanitize(ctx?.body);
  const envelope = errorEnvelope(sanitized);
  const serialized = JSON.stringify(sanitized);
  return {
    schema_version: 1,
    ts: now.toISOString(),
    type: "upstream_error_body",
    status: ctx?.status ?? null,
    request_id: headerLookup(ctx?.headers, "ah-request-id")
      || headerLookup(ctx?.headers, "request-id")
      || null,
    model: ctx?.meta?._requestedModel ?? null,
    error_code: envelope.code,
    error_message: truncate(envelope.message, MAX_MESSAGE_CHARS),
    body_preview: truncate(serialized, MAX_PREVIEW_CHARS),
  };
}

async function appendRecord(record) {
  const path = logPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

export default {
  name: "upstream-error-body-log",
  description: "Record bounded, redacted JSON bodies for non-2xx upstream responses without mutating them.",
  order: 675,

  async onRequest(ctx) {
    if (process.env[ENV_VAR] !== "on") return;
    try {
      if (typeof ctx?.body?.model === "string") {
        ctx.meta = ctx.meta || {};
        ctx.meta._requestedModel = ctx.meta._requestedModel || ctx.body.model;
      }
    } catch {}
  },

  async onResponse(ctx) {
    if (process.env[ENV_VAR] !== "on") return;
    if (typeof ctx?.status !== "number" || ctx.status < 400) return;
    if (!ctx?.body || typeof ctx.body !== "object") return;
    try {
      await appendRecord(buildRecord({ ctx }));
    } catch {}
  },
};
