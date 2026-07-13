// Extension template for axonhub-cache-fix
//
// Replace $NAME, $DESC, $ORDER with actual values.
// Add your onRequest logic. Leave logging as-is.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = process.env.AXONHUB_CACHE_FIX_LOG_DIR
  || join(homedir(), ".axonhub-cache-fix", "logs");
const LOG_FILE = "$NAME.log";

function log(msg) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] $NAME: ${msg}\n`;
  try { appendFileSync(join(LOG_DIR, LOG_FILE), line); } catch {}
}

export default {
  name: "$NAME",
  description: "$DESC",
  order: $ORDER,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!body) return;

    // TODO: your logic here

    log("processed request");
  },
};
