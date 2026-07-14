// Preserve tool-definition order across requests so dynamically visible tools
// do not shift the existing DeepSeek prompt-cache prefix.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = process.env.AXONHUB_CACHE_FIX_LOG_DIR
  || join(homedir(), ".axonhub-cache-fix", "logs");
const LOG_FILE = "tool-order-hold.log";

function log(msg) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] tool-order-hold: ${msg}\n`;
  try { appendFileSync(join(LOG_DIR, LOG_FILE), line); } catch {}
}

const state = new Map();

function requestFamily(tools) {
  return tools.length === 1 && tools[0]?.name === "web_search"
    ? "web-search"
    : "conversation";
}

function stateKey(ctx, tools) {
  const sid = ctx?.headers?.["x-claude-code-session-id"] || ctx?.meta?._sessionId;
  if (!sid) return null;
  const agent = ctx?.headers?.["x-claude-code-agent-id"] || ctx?.meta?._agentId || "main";
  const model = typeof ctx?.body?.model === "string" ? ctx.body.model : "unknown";
  return `${sid}:${agent}:${model}:${requestFamily(tools)}`;
}

function stableToolOrder(tools, previousNames) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const known = previousNames.filter((name) => byName.has(name));
  const added = tools.map((tool) => tool.name).filter((name) => !previousNames.includes(name));
  return [...known, ...added].map((name) => byName.get(name));
}

function hasUniqueNonEmptyNames(tools) {
  const names = tools.map((tool) => tool?.name);
  return names.every((name) => typeof name === "string" && name.length > 0)
    && new Set(names).size === names.length;
}

export default {
  name: "tool-order-hold",
  description: "Preserve prior tool order and append newly visible tools for stable prompt caching",
  order: 210,

  async onRequest(ctx) {
    const tools = ctx?.body?.tools;
    if (!Array.isArray(tools)) {
      log("skip: body.tools is not an array");
      return;
    }
    if (!hasUniqueNonEmptyNames(tools)) {
      log("skip: tool names must be unique non-empty strings");
      return;
    }

    const key = stateKey(ctx, tools);
    if (!key) {
      log("skip: no session id");
      return;
    }

    const previousNames = state.get(key);
    if (!previousNames) {
      const currentNames = tools.map((tool) => tool.name);
      state.set(key, currentNames);
      log(`baseline: key=${key} tools=${currentNames.join(",")}`);
      return;
    }

    const ordered = stableToolOrder(tools, previousNames);
    const currentNames = tools.map((tool) => tool.name);
    const orderedNames = ordered.map((tool) => tool.name);
    state.set(key, orderedNames);

    if (currentNames.some((name, index) => name !== orderedNames[index])) {
      ctx.body.tools = ordered;
      log(`reorder: key=${key} from=${currentNames.join(",")} to=${orderedNames.join(",")}`);
    }
  },
};
