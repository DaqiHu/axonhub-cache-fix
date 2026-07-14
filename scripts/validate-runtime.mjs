import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_EXTENSIONS = [
  "prefix-hold",
  "strip-empty-system",
  "deepseek-cache-optimize",
  "tool-order-hold",
  "strip-billing-header",
];

async function requirePath(path, label, expectedType) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`${label} missing: ${path}`);
  }

  if (expectedType === "directory" && !info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  if (expectedType === "file" && !info.isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

function defaultPipelinePath() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is not set; cannot locate cache-fix");
  return join(
    appData,
    "npm",
    "node_modules",
    "claude-code-cache-fix",
    "proxy",
    "pipeline.mjs",
  );
}

export async function validateRuntime({ runtimeDir, pipelinePath } = {}) {
  if (!runtimeDir) throw new Error("runtime directory is required");

  const root = resolve(runtimeDir);
  const extensionsDir = join(root, "extensions");
  const configPath = join(extensionsDir, "extensions.json");
  const loaderPath = pipelinePath || defaultPipelinePath();

  await requirePath(extensionsDir, "extension directory", "directory");
  await requirePath(configPath, "extension config", "file");
  await requirePath(loaderPath, "cache-fix pipeline", "file");

  const pipeline = await import(pathToFileURL(loaderPath).href);
  const registry = await pipeline.loadExtensions(extensionsDir, configPath);
  const failed = pipeline.getFailedExtensions();

  if (failed.length > 0) {
    const details = failed.map((item) => `${item.file}: ${item.error}`).join("; ");
    throw new Error(`extension load failures: ${details}`);
  }
  if (registry.length === 0) {
    throw new Error("extension registry is empty");
  }

  const loaded = registry.map((extension) => extension.name);
  const missing = REQUIRED_EXTENSIONS.filter((name) => !loaded.includes(name));
  if (missing.length > 0) {
    throw new Error(`required extensions missing: ${missing.join(", ")}`);
  }

  return {
    runtimeDir: root,
    extensionsDir,
    configPath,
    loaded,
    failed: [],
  };
}

function parseRuntimeDir(argv) {
  const index = argv.indexOf("--dir");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("usage: node scripts/validate-runtime.mjs --dir <runtime-root>");
  }
  return argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await validateRuntime({ runtimeDir: parseRuntimeDir(process.argv.slice(2)) });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Runtime validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
