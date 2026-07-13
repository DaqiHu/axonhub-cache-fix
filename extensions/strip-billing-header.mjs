import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const LOG_DIR = process.env.AXONHUB_CACHE_FIX_LOG_DIR || join(homedir(), ".axonhub-cache-fix", "logs");
const LOG_PATH = join(LOG_DIR, "strip-billing-header.log");

function debug(msg) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] strip-billing-header: ${msg}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
}

export default {
  name: "strip-billing-header",
  description: "Remove the x-anthropic-billing-header block from system prompt to fix prefix caching on third-party providers",
  order: 85,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!Array.isArray(body?.system)) {
      debug("skipped — body.system is not an array");
      return;
    }

    let removed = 0;
    for (let i = body.system.length - 1; i >= 0; i--) {
      const block = body.system[i];
      if (block?.type === "text" && typeof block.text === "string" && block.text.includes("x-anthropic-billing-header:")) {
        const snippet = block.text.length > 120
          ? block.text.substring(0, 120) + "..."
          : block.text;
        debug(`REMOVED system[${i}]: ${snippet}`);
        body.system.splice(i, 1);
        removed++;
      }
    }

    if (removed === 0) {
      debug("NOT FOUND — no billing-header block in system array");
    } else {
      debug(`DONE — removed ${removed} billing-header block(s), system array now has ${body.system.length} items`);
    }
  },
};
