// low-cache-trace — archive low-cache-hit requests to daily JSONL files.
//
// This extension captures the request body and usage statistics for requests
// whose cache hit rate falls strictly below a configurable threshold, writing
// records to a UTC-daily JSONL archive. Intended for offline analysis of
// low-cache-efficiency patterns.
//
// Activation: CACHE_FIX_LOW_CACHE_TRACE=on
// Threshold:  CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD (default 80, integer)
// Retention:  CACHE_FIX_LOW_CACHE_TRACE_RETENTION_DAYS (default 7)
// Directory:  CACHE_FIX_LOW_CACHE_TRACE_DIR (default ~/axonhub/logs/low-cache-requests)

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const ENV_GATE = "CACHE_FIX_LOW_CACHE_TRACE";
const ENV_THRESHOLD = "CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD";
const ENV_RETENTION_DAYS = "CACHE_FIX_LOW_CACHE_TRACE_RETENTION_DAYS";
const ENV_DIR = "CACHE_FIX_LOW_CACHE_TRACE_DIR";
const SWEEP_THROTTLE_MS = 60_000;
const DEFAULT_THRESHOLD = 80;
const DEFAULT_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

let _writeQueue = Promise.resolve();
let _lastSweepMs = 0;
let _sweepInFlight = false;

// ---------------------------------------------------------------------------
// Header lookup helper (lowercased key match)
// ---------------------------------------------------------------------------

function headerLookup(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Env-var helpers (read per call)
// ---------------------------------------------------------------------------

function logDir() {
  return process.env[ENV_DIR] || join(homedir(), "axonhub", "logs", "low-cache-requests");
}

function archivePath(now) {
  const ymd = now.toISOString().slice(0, 10);
  return join(logDir(), `${ymd}.jsonl`);
}

function getThreshold() {
  const raw = process.env[ENV_THRESHOLD];
  if (raw === undefined || raw === "") return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : DEFAULT_THRESHOLD;
}

function getRetentionDays() {
  const raw = process.env[ENV_RETENTION_DAYS];
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

// ---------------------------------------------------------------------------
// classifyUsage — pure helper
//
// Returns { hitPct: number|null, shouldRecord: boolean }
// shouldRecord is true only when:
//   (a) usage is an object with at least one cache field present
//   (b) denominator (input + creation + read) > 0
//   (c) hitPct < threshold (strictly below)
// ---------------------------------------------------------------------------

export function classifyUsage(usage, threshold) {
  if (!usage || typeof usage !== "object") {
    return { hitPct: null, shouldRecord: false };
  }

  const cr = usage.cache_read_input_tokens;
  const cc = usage.cache_creation_input_tokens;
  const it = usage.input_tokens;

  // Both cache fields absent → skip (treat as "unknown usage")
  if (cr === undefined && cc === undefined) {
    return { hitPct: null, shouldRecord: false };
  }

  const read = typeof cr === "number" && Number.isFinite(cr) ? cr : 0;
  const creation = typeof cc === "number" && Number.isFinite(cc) ? cc : 0;
  const input = typeof it === "number" && Number.isFinite(it) ? it : 0;

  const denominator = input + creation + read;
  if (denominator <= 0) {
    return { hitPct: null, shouldRecord: false };
  }

  const hitPct = (read / denominator) * 100;
  const effectiveThreshold =
    threshold !== undefined ? threshold : getThreshold();
  const shouldRecord = hitPct < effectiveThreshold;

  return { hitPct, shouldRecord };
}

// ---------------------------------------------------------------------------
// buildRecord — pure helper
//
// Produces the record object that will be serialized as JSONL. Field order
// follows the spec: schema_version, ts, status, request_id, session_id,
// agent_id, model, usage, hit_pct, body.
// ---------------------------------------------------------------------------

export function buildRecord({
  status,
  requestId,
  sessionId,
  agentId,
  model,
  usage,
  body,
  now,
  threshold,
} = {}) {
  const { hitPct } = classifyUsage(usage, threshold);

  return {
    schema_version: 1,
    ts: (now || new Date()).toISOString(),
    status: status != null ? status : null,
    request_id: requestId || null,
    session_id: sessionId || null,
    agent_id: agentId || null,
    model: model || null,
    usage: {
      input_tokens: (usage && typeof usage.input_tokens === "number" ? usage.input_tokens : 0),
      cache_creation_input_tokens: (usage && typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0),
      cache_read_input_tokens: (usage && typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0),
    },
    hit_pct: hitPct !== null ? hitPct : null,
    body: body || null,
  };
}

// ---------------------------------------------------------------------------
// retentionSweep — delete files older than retentionDays
//
// Pure-adjacent: reads and deletes files on disk. Throttling is:
//   - when `throttleMs` is not provided: uses internal SWEEP_THROTTLE_MS
//   - when `throttleMs` is explicitly 0: no throttling (used by tests)
//   - when `throttleMs > 0`: uses the provided value
//
// Internal throttling uses module-level _lastSweepMs; test throttling uses
// the same state but with a user-supplied interval.
// ---------------------------------------------------------------------------

export async function retentionSweep({
  dir,
  retentionDays,
  now,
  throttleMs,
} = {}) {
  if (!dir) dir = logDir();
  if (retentionDays === undefined) retentionDays = getRetentionDays();
  if (!now) now = new Date();

  // Determine throttle interval
  const throttle = throttleMs !== undefined ? throttleMs : SWEEP_THROTTLE_MS;
  if (throttle > 0) {
    const elapsed = now.getTime() - _lastSweepMs;
    if (elapsed < throttle) return;
  }
  _lastSweepMs = now.getTime();

  if (_sweepInFlight) return;
  _sweepInFlight = true;
  try {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    cutoff.setUTCHours(0, 0, 0, 0);

    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const fileDate = new Date(match[1] + "T00:00:00Z");
      if (fileDate < cutoff) {
        try {
          await unlink(join(dir, name));
        } catch {
          // fail-open: ignore deletion errors
        }
      }
    }
  } catch {
    // fail-open
  } finally {
    _sweepInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// I/O — serialized append
// ---------------------------------------------------------------------------

function serialize(fn) {
  _writeQueue = _writeQueue.then(fn).catch(() => {});
  return _writeQueue;
}

async function appendRecord(record) {
  const path = archivePath(new Date());
  await serialize(async () => {
    const dir = logDir();
    await mkdir(dir, { recursive: true }).catch(() => {});
    await appendFile(path, JSON.stringify(record) + "\n");
  });
  // Fire-and-forget retention sweep (not awaited, throttled internally)
  retentionSweep({ dir: logDir(), retentionDays: getRetentionDays() }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Extension hooks
// ---------------------------------------------------------------------------

export default {
  name: "low-cache-trace",
  description:
    "Archive requests with low cache-hit rate to daily JSONL files for offline trace analysis.",
  order: 900,

  async onRequest(ctx) {
    if (process.env[ENV_GATE] !== "on") return;
    try {
      if (!ctx || !ctx.body || typeof ctx.body !== "object") return;
      if (!ctx.meta) ctx.meta = {};

      const requestId =
        headerLookup(ctx.headers, "ah-request-id") ||
        headerLookup(ctx.headers, "request-id") ||
        null;
      const sessionId =
        headerLookup(ctx.headers, "x-claude-code-session-id") || null;
      const agentId =
        headerLookup(ctx.headers, "x-claude-code-agent-id") || null;
      const model =
        typeof ctx.body.model === "string" ? ctx.body.model : null;

      ctx.meta._lowCacheTrace = {
        body: structuredClone(ctx.body),
        requestId,
        sessionId,
        agentId,
        model,
        status: null,
        done: false,
      };
    } catch {
      // fail-open
    }
  },

  async onResponseStart(ctx) {
    if (process.env[ENV_GATE] !== "on") return;
    try {
      if (!ctx?.meta?._lowCacheTrace) return;
      ctx.meta._lowCacheTrace.status =
        typeof ctx.status === "number" ? ctx.status : null;
    } catch {
      // fail-open
    }
  },

  async onStreamEvent(ctx) {
    if (process.env[ENV_GATE] !== "on") return;
    try {
      if (!ctx?.event || !ctx?.meta?._lowCacheTrace) return;

      const trace = ctx.meta._lowCacheTrace;
      if (trace.done) return;

      if (ctx.event.type !== "message_start") return;
      const usage = ctx.event.message?.usage;
      if (!usage) return;

      // Only write for 2xx responses
      const status = trace.status;
      if (typeof status !== "number" || status < 200 || status >= 300) return;

      const { shouldRecord } = classifyUsage(usage);
      if (!shouldRecord) return;

      trace.done = true;
      const record = buildRecord({
        status,
        requestId: trace.requestId,
        sessionId: trace.sessionId,
        agentId: trace.agentId,
        model: trace.model,
        usage,
        body: trace.body,
        now: new Date(),
      });
      await appendRecord(record);
    } catch {
      // fail-open
    }
  },

  async onResponse(ctx) {
    if (process.env[ENV_GATE] !== "on") return;
    try {
      if (!ctx?.meta?._lowCacheTrace) return;

      const trace = ctx.meta._lowCacheTrace;
      if (trace.done) return;

      const status = ctx.status;
      if (typeof status !== "number" || status < 200 || status >= 300) return;

      const usage = ctx.body?.usage;
      if (!usage) return;

      const { shouldRecord } = classifyUsage(usage);
      if (!shouldRecord) return;

      trace.done = true;
      const record = buildRecord({
        status,
        requestId: trace.requestId,
        sessionId: trace.sessionId,
        agentId: trace.agentId,
        model: trace.model,
        usage,
        body: trace.body,
        now: new Date(),
      });
      await appendRecord(record);
    } catch {
      // fail-open
    }
  },

  // Test-only: reset module-level state between test runs.
  __resetForTests() {
    __resetForTests();
  },
};

// Standalone named export so tests can call module.__resetForTests() directly.
export function __resetForTests() {
  _writeQueue = Promise.resolve();
  _lastSweepMs = 0;
  _sweepInFlight = false;
}
