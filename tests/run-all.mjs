// Run all tests for axonhub-cache-fix extensions
// Usage: node tests/run-all.mjs

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tests = [
  "test-strip-system.mjs",
  "test-deepseek-cache.mjs",
  "test-prefix-hold.mjs",
  "test-runtime-validation.mjs",
  "test-pipeline.mjs",
];

let totalPassed = 0;
let totalFailed = 0;

for (const test of tests) {
  const result = spawnSync("node", [join(__dirname, test)], {
    stdio: "inherit",
  });

  if (result.status === 0) {
    // Extract pass/fail from last line of output is harder this way.
    // We just check exit code.
  } else {
    console.error(`\n${test} exited with code ${result.status}`);
    totalFailed++;
  }
}

console.log(`\n=== All test suites completed ===`);
if (totalFailed > 0) {
  console.error(`${totalFailed} suite(s) failed`);
  process.exit(1);
}
