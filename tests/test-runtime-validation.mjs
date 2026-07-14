import { strict as assert } from "node:assert";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, "..");
const setupPath = join(repo, "scripts", "setup.ps1");
const validatorPath = join(repo, "scripts", "validate-runtime.mjs");
const scratch = mkdtempSync(join(tmpdir(), "axonhub-cache-fix-runtime-test-"));
const runtime = join(scratch, "valid");

let passed = 0;
let failed = 0;

function run(command, args) {
  return spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, AXONHUB_CACHE_FIX_LOG_DIR: join(scratch, "logs") },
  });
}

function validate(dir) {
  return run("node", [validatorPath, "--dir", dir]);
}

function cloneRuntime(name) {
  const target = join(scratch, name);
  cpSync(runtime, target, { recursive: true });
  return target;
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  await test("setup creates a fully loadable runtime", () => {
    const result = run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", setupPath,
      "-Dir", runtime,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(join(runtime, "model-families.mjs")), true);
    assert.equal(existsSync(join(runtime, "extensions", "model-families.mjs")), false);
    assert.equal(existsSync(join(runtime, "session-mirror-writer.mjs")), true);
    const config = JSON.parse(
      readFileSync(join(runtime, "extensions", "extensions.json"), "utf8"),
    );
    assert.deepEqual(config["tool-order-hold"], { enabled: true, order: 210 });
  });

  await test("validator loads required extensions with zero failures", () => {
    const result = validate(runtime);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(summary.failed, []);
    for (const name of [
      "prefix-hold",
      "strip-empty-system",
      "deepseek-cache-optimize",
      "tool-order-hold",
      "strip-billing-header",
    ]) {
      assert.equal(summary.loaded.includes(name), true, `${name} loaded`);
    }
  });

  await test("validator rejects a missing runtime", () => {
    const result = validate(join(scratch, "missing"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /extension directory.*missing/i);
  });

  await test("validator rejects a missing config", () => {
    const target = cloneRuntime("missing-config");
    rmSync(join(target, "extensions", "extensions.json"));
    const result = validate(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config.*missing/i);
  });

  await test("validator rejects extension import failures", () => {
    const target = cloneRuntime("broken-extension");
    writeFileSync(
      join(target, "extensions", "broken-extension.mjs"),
      "throw new Error('intentional runtime validation failure');\n",
    );
    const result = validate(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /broken-extension\.mjs/);
  });

  await test("validator rejects a disabled required extension", () => {
    const target = cloneRuntime("disabled-required");
    const configPath = join(target, "extensions", "extensions.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config["tool-order-hold"].enabled = false;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const result = validate(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required extensions missing.*tool-order-hold/i);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nRuntime validation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
