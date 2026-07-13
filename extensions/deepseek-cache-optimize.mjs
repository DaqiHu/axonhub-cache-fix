// deepseek-cache-optimize — strip cache_control from DeepSeek-bound requests.
// DeepSeek's Anthropic API ignores cache_control but the JSON field still
// produces different tokens between requests, breaking their prefix-cache
// matching. This extension detects DeepSeek model names and removes all
// cache_control fields so the raw token sequence is maximally stable.
//
// References:
//   https://api-docs.deepseek.com/guides/anthropic_api — cache_control: Ignored
//   https://api-docs.deepseek.com/guides/kv_cache       — full-match prefix units

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const LOG_DIR = process.env.AXONHUB_CACHE_FIX_LOG_DIR || join(homedir(), ".axonhub-cache-fix", "logs");
const LOG_PATH = join(LOG_DIR, "deepseek-cache-optimize.log");

function log(msg) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] dc-opt: ${msg}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
}

// DeepSeek model name patterns (case-insensitive substrings match)
const DEEPSEEK_PATTERNS = [
  "deepseek",
  // model aliases that AxonHub maps to DeepSeek channels
];

function isDeepSeekModel(model) {
  if (typeof model !== "string" || model.length === 0) return false;
  const lower = model.toLowerCase();
  return DEEPSEEK_PATTERNS.some((p) => lower.includes(p));
}

function stripCacheControl(obj) {
  if (!obj || typeof obj !== "object") return 0;
  let count = 0;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      count += stripCacheControl(item);
    }
  } else {
    if ("cache_control" in obj) {
      delete obj.cache_control;
      count++;
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === "object") {
        count += stripCacheControl(val);
      }
    }
  }
  return count;
}

export default {
  name: "deepseek-cache-optimize",
  description:
    "Strip all cache_control fields from DeepSeek-bound requests since " +
    "DeepSeek ignores them but the JSON token diff breaks prefix-cache matching",
  order: 48,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!body) return;

    const model = body.model;
    if (!isDeepSeekModel(model)) {
      log(`skip model="${model}" — not DeepSeek`);
      return;
    }

    let stripped = 0;

    if (Array.isArray(body.system)) {
      stripped += stripCacheControl(body.system);
    }
    if (Array.isArray(body.messages)) {
      stripped += stripCacheControl(body.messages);
    }
    if (Array.isArray(body.tools)) {
      stripped += stripCacheControl(body.tools);
    }
    // also handle tool_choice if present (rare)
    if (body.tool_choice && typeof body.tool_choice === "object") {
      stripped += stripCacheControl(body.tool_choice);
    }

    log(`model="${model}" stripped=${stripped} cc_fields`);
  },
};
