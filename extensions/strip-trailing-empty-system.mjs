// strip-trailing-empty-system — remove empty system messages injected
// at the tail of the conversation by Claude Code. These empty [] system
// blocks shift the "end of user input" position and break DeepSeek's
// cache prefix matching without adding any semantic value.
//
// order 47 — runs after prefix-hold but before cc/cache handling

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = process.env.AXONHUB_CACHE_FIX_LOG_DIR || join(homedir(), ".axonhub-cache-fix", "logs");
const LOG_PATH = join(LOG_DIR, "strip-trailing-empty-system.log");

function log(msg) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] ses: ${msg}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
}

function isEmptySystem(msg) {
  if (!msg || msg.role !== "system") return false;
  const c = msg.content;
  // Array: [] or [{type:"text", text:""}]
  if (Array.isArray(c)) return c.length === 0 || (c.length === 1 && (!c[0].text || c[0].text.trim().length === 0));
  // String: "" or whitespace-only
  if (typeof c === "string") return c.trim().length === 0;
  return false;
}

function getSystemContentPreview(msg) {
  const c = msg.content;
  if (Array.isArray(c) && c.length > 0) return c[0].text?.slice(0, 60) || c[0].content?.slice(0, 60) || "?";
  if (typeof c === "string") return c.slice(0, 60);
  return "?";
}

const TRAILING_NOISE = [
  ["deferred-tools", "The following deferred tools are now available via ToolSearch."],
  ["task-tools", "The task tools haven't been used recently."],
];

function systemText(msg) {
  const content = msg?.content;
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }

  text = text.trim();
  const wrapped = text.match(/^<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\s*$/);
  return (wrapped ? wrapped[1] : text).trim();
}

function bookkeepingRule(msg) {
  const text = systemText(msg);
  for (const [rule, prefix] of TRAILING_NOISE) {
    if (text.startsWith(prefix)) return rule;
  }
  return null;
}

export default {
  name: "strip-empty-system",
  description:
    "Remove empty system messages and known trailing Claude Code bookkeeping " +
    "reminders while preserving meaningful system context",
  order: 47,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!Array.isArray(body?.messages)) return;

    const msgs = body.messages;
    let removed = 0;
    let removedWithContent = 0;

    // Remove all empty system messages. Known bookkeeping reminders must also
    // stay removed when Claude Code replays them as historical messages.
    const lastUser = (() => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") return i;
      }
      return -1;
    })();

    // No user messages = conversation hasn't started. Keep system messages
    // (they're likely setup/hooks output, not injections)
    if (lastUser < 0) return;

    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role !== "system") continue;

      const isEmpty = isEmptySystem(msg);
      const noiseRule = !isEmpty ? bookkeepingRule(msg) : null;

      if (isEmpty) {
        msgs.splice(i, 1);
        removed++;
      } else if (noiseRule) {
        const preview = getSystemContentPreview(msg);
        log(`removed ${noiseRule} system at [${i}]: "${preview}..."`);
        msgs.splice(i, 1);
        removedWithContent++;
      }
    }

    if (removed > 0 && removedWithContent > 0) {
      log(`removed ${removed} empty + ${removedWithContent} contentful system msgs`);
    } else if (removed > 0) {
      log(`removed ${removed} empty system msgs`);
    } else if (removedWithContent > 0) {
      log(`removed ${removedWithContent} trailing contentful system msgs`);
    }
  },
};
