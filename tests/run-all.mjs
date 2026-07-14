// Run all tests for axonhub-cache-fix extensions
// Usage: node tests/run-all.mjs

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tests = [
  ["node", "test-strip-system.mjs"],
  ["node", "test-deepseek-cache.mjs"],
  ["node", "test-prefix-hold.mjs"],
  ["node", "test-tool-order-hold.mjs"],
  ["node", "test-upstream-error-body-log.mjs"],
  ["node", "test-low-cache-trace.mjs"],
  ["node", "test-proxy-resilience.mjs"],
  ["node", "test-runtime-validation.mjs"],
  ["node", "test-pipeline.mjs"],
  ["python", "test-cache-report.py"],
  ["python", "test-analyze.py"],
  ["python", "test-provider-report.py"],
  ["python", "test-sqlite-maintenance.py"],
  ["python", "test-probe-docs.py"],
  ["powershell.exe", "test-runtime-common.ps1"],
  ["powershell.exe", "test-service-scripts.ps1"],
  ["powershell.exe", "test-configure-sqlite.ps1"],
];

let totalFailed = 0;

for (const [command, test] of tests) {
  const result = spawnSync(command, [join(__dirname, test)], {
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
