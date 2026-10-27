#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_IMAGE = "jgates/quality-sidecar:latest";
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_IGNORES = [
  ".git/",
  ".quality/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".turbo/",
  ".vite/",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  "*.log",
  "*.sqlite",
  "*.sqlite3",
  "*.db"
];
const SUPPORT_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".gitignore",
  ".quality-gate-policy.json",
  "README.md"
];
const INPUT_FILE_FLAGS = new Set([
  "--coverage-report",
  "--dependency-graph",
  "--evidence-report",
  "--policy-file",
  "--test-report"
]);
const LARGE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const OPERATIONAL_EXIT_CODE = 3;

function takeValue(raw, index, flag, options = {}) {
  const value = raw[index + 1];
  if (value === undefined || (!options.allowFlagValue && value.startsWith("--"))) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function normalizeFormatValue(value) {
  return String(value).trim().split(/[\s,]+/).filter(Boolean).join(",");
}

function parseArgs(rawArgs, env = process.env) {
  const raw = [...rawArgs];
  const parsed = {
    target: ".",
    image: env.QUALITY_SIDECAR_IMAGE || DEFAULT_IMAGE,
    pull: false,
    noPull: false,
    startDocker: env.QUALITY_GATE_START_DOCKER !== "0" && env.QUALITY_GATE_NO_START_DOCKER !== "1",
    dockerStartTimeoutMs: Number(env.QUALITY_GATE_DOCKER_START_TIMEOUT_MS || 120000),
    build: env.QUALITY_GATE_AUTO_BUILD !== "0" && env.QUALITY_GATE_NO_BUILD !== "1",
    debugDocker: false,
    help: false,
    version: false,
    scope: env.QUALITY_GATE_SCOPE || "changed",
    base: env.QUALITY_GATE_BASE || undefined,
    head: env.QUALITY_GATE_HEAD || undefined,
    paths: [],
    excludes: [],
    includes: [],
    ignoreFiles: [],
    json: false,
    ci: false,
    noInteractive: false,
    output: env.QUALITY_GATE_OUTPUT || ".quality/reports",
    dockerArgs: [],
    containerArgs: []
  };

  if (raw[0] && !raw[0].startsWith("-")) {
    parsed.target = raw.shift();
  }

  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--version") {
      parsed.version = true;
      continue;
    }

    if (arg === "--scope") {
      parsed.scope = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--scope=")) {
      parsed.scope = arg.slice("--scope=".length);
      continue;
    }

    if (arg === "--base" || arg === "--head") {
      parsed[arg.slice(2)] = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--base=") || arg.startsWith("--head=")) {
      const key = arg.startsWith("--base=") ? "base" : "head";
      parsed[key] = arg.slice(key.length + 3);
      continue;
    }

    if (arg === "--path") {
      parsed.paths.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--path=")) {
      parsed.paths.push(arg.slice("--path=".length));
      continue;
    }

    if (arg === "--exclude") {
      parsed.excludes.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--exclude=")) {
      parsed.excludes.push(arg.slice("--exclude=".length));
      continue;
    }

    if (arg === "--include") {
      parsed.includes.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--include=")) {
      parsed.includes.push(arg.slice("--include=".length));
      continue;
    }

    if (arg === "--ignore-file") {
      parsed.ignoreFiles.push(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--ignore-file=")) {
      parsed.ignoreFiles.push(arg.slice("--ignore-file=".length));
      continue;
    }

    if (arg === "--ci") {
      parsed.ci = true;
      parsed.noInteractive = true;
      continue;
    }

    if (arg === "--no-interactive") {
      parsed.noInteractive = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--image" || arg === "-Image" || arg === "-image") {
      parsed.image = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--image=")) {
      parsed.image = arg.slice("--image=".length);
      continue;
    }

    if (arg === "--pull" || arg === "-Pull" || arg === "-pull") {
      parsed.pull = true;
      continue;
    }

    if (arg === "--no-pull" || arg === "-NoPull" || arg === "-noPull") {
      parsed.noPull = true;
      continue;
    }

    if (arg === "--start-docker") {
      parsed.startDocker = true;
      continue;
    }

    if (arg === "--no-start-docker") {
      parsed.startDocker = false;
      continue;
    }

    if (arg === "--docker-start-timeout-ms") {
      parsed.dockerStartTimeoutMs = Number(takeValue(raw, i, arg));
      i += 1;
      continue;
    }

    if (arg.startsWith("--docker-start-timeout-ms=")) {
      parsed.dockerStartTimeoutMs = Number(arg.slice("--docker-start-timeout-ms=".length));
      continue;
    }

    if (arg === "--build" || arg === "-Build" || arg === "-build") {
      parsed.build = true;
      continue;
    }

    if (arg === "--no-build" || arg === "-NoBuild" || arg === "-noBuild") {
      parsed.build = false;
      continue;
    }

    if (arg === "--debug-docker" || arg === "-DebugDocker" || arg === "-debugDocker") {
      parsed.debugDocker = true;
      continue;
    }

    if (arg === "--docker-arg" || arg === "-DockerArg" || arg === "-dockerArg") {
      parsed.dockerArgs.push(takeValue(raw, i, arg, { allowFlagValue: true }));
      i += 1;
      continue;
    }

    if (arg.startsWith("--docker-arg=")) {
      parsed.dockerArgs.push(arg.slice("--docker-arg=".length));
      continue;
    }

    if (arg === "--format") {
      parsed.containerArgs.push(arg, normalizeFormatValue(takeValue(raw, i, arg)));
      i += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      parsed.containerArgs.push(`--format=${normalizeFormatValue(arg.slice("--format=".length))}`);
      continue;
    }

    if (arg === "--output") {
      parsed.output = takeValue(raw, i, arg);
      i += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      parsed.output = arg.slice("--output=".length);
      continue;
    }

    parsed.containerArgs.push(arg);
  }

  if (parsed.pull && parsed.noPull) {
    parsed.pull = false;
  }
  if (!["changed", "full", "paths"].includes(parsed.scope)) {
    throw new Error("--scope must be changed, full, or paths");
  }
  if (parsed.scope !== "paths" && parsed.paths.length > 0) {
    throw new Error("--path can only be used with --scope paths");
  }
  if (parsed.scope === "paths" && parsed.paths.length === 0) {
    throw new Error("--scope paths requires at least one --path");
  }
  if (!Number.isFinite(parsed.dockerStartTimeoutMs) || parsed.dockerStartTimeoutMs < 0) {
    throw new Error("--docker-start-timeout-ms must be a non-negative number");
  }
  if (parsed.json && !hasContainerFormat(parsed.containerArgs)) {
    parsed.containerArgs.push("--format", "json");
  }

  Object.defineProperty(parsed, "gitEnv", { value: env, enumerable: false });

  return parsed;
}

function hasContainerFormat(args) {
  return args.some((arg) => arg === "--format" || String(arg).startsWith("--format="));
}

function ensureTarget(target) {
  const targetPath = path.resolve(target);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target path does not exist: ${targetPath}`);
  }
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`Target path must be a directory: ${targetPath}`);
  }
  return targetPath;
}

function buildDockerArgs(parsed, targetPath, reportsPath = path.join(targetPath, ".quality", "reports")) {
  const containerArgs = withoutOutputArgs(parsed.containerArgs);
  return [
    "run",
    "--rm",
    "--user",
    "0",
    "-e",
    `QUALITY_GATE_SCOPE=${parsed.scope}`,
    ...parsed.dockerArgs,
    "-v",
    `${targetPath}:/workspace`,
    "-v",
    `${reportsPath}:/workspace/.quality/reports`,
    "-w",
    "/workspace",
    parsed.image,
    "check",
    "/workspace",
    "--output",
    ".quality/reports",
    "--scope-manifest",
    ".quality/reports/quality-scope.json",
    ...containerArgs
  ];
}

function hasSidecarMode(args) {
  return args.some((arg) => arg === "--mode" || String(arg).startsWith("--mode="));
}

function sidecarMode(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "--mode") return args[index + 1] ? String(args[index + 1]) : null;
    if (arg.startsWith("--mode=")) return arg.slice("--mode=".length);
  }
  return null;
}

function buildLocalSidecarArgs(parsed, targetPath, reportsPath) {
  const containerArgs = withoutOutputArgs(parsed.containerArgs);
  const args = [
    "-m",
    "quality_sidecar",
    "check",
    targetPath,
    "--output",
    reportsPath,
    "--scope-manifest",
    path.join(reportsPath, "quality-scope.json"),
    ...containerArgs
  ];
  // Keep the sidecar's normal contract explicit. Reduced modes remain available,
  // but only when the caller consciously requests --mode quick|offline.
  if (!hasSidecarMode(containerArgs)) args.push("--mode", "full");
  return args;
}

function withoutOutputArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      index += 1;
      continue;
    }
    if (String(arg).startsWith("--output=")) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function normalizeInputFileArgs(args = [], targetPath) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (INPUT_FILE_FLAGS.has(arg)) {
      normalized.push(arg);
      if (index + 1 < args.length) {
        normalized.push(normalizeInputPath(args[++index], targetPath));
      }
      continue;
    }
    const matched = [...INPUT_FILE_FLAGS].find((flag) => arg.startsWith(`${flag}=`));
    if (matched) {
      normalized.push(`${matched}=${normalizeInputPath(arg.slice(matched.length + 1), targetPath)}`);
      continue;
    }
    normalized.push(args[index]);
  }
  return normalized;
}

function normalizeInputPath(value, targetPath) {
  const absolute = path.resolve(targetPath, String(value));
  const relative = normalizePath(path.relative(targetPath, absolute));
  return relative && relative !== ".." && !relative.startsWith("../") ? relative : String(value);
}

function inputSupportFiles(args = [], targetPath) {
  const values = [];
  const policyFiles = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (INPUT_FILE_FLAGS.has(arg) && index + 1 < args.length) {
      const value = String(args[++index]);
      values.push(value);
      if (arg === "--policy-file") policyFiles.push(value);
      continue;
    }
    const matched = [...INPUT_FILE_FLAGS].find((flag) => arg.startsWith(`${flag}=`));
    if (matched) {
      const value = arg.slice(matched.length + 1);
      values.push(value);
      if (matched === "--policy-file") policyFiles.push(value);
    }
  }
  if (!policyFiles.length && fs.existsSync(path.join(targetPath, ".quality-gate-policy.json"))) {
    policyFiles.push(".quality-gate-policy.json");
  }
  for (const policyFile of policyFiles) {
    const policyPath = path.join(targetPath, normalizeInputPath(policyFile, targetPath));
    try {
      const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
      for (const sectionName of ["dependencyGraph", "evidence", "testQuality"]) {
        const reports = policy?.[sectionName]?.reports;
        if (Array.isArray(reports)) values.push(...reports.filter((item) => typeof item === "string"));
      }
    } catch {
      // The sidecar reports malformed policy as an operational configuration error.
    }
  }
  return [...new Set(values.map((value) => normalizeInputPath(value, targetPath)).filter((value) => {
    const absolute = path.join(targetPath, value);
    return !value.startsWith("../") && fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  }))];
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function commandLine(command, args) {
  return [command, ...args].map(quoteForDisplay).join(" ");
}

function resolveScopedTarget(targetPath, parsed) {
  const reportsPath = path.isAbsolute(parsed.output)
    ? parsed.output
    : path.resolve(targetPath, parsed.output);
  const selected = resolveScopeFiles(targetPath, parsed);
  if (parsed.scope === "full" && selected.ignoredCount === 0 && parsed.excludes.length === 0 && parsed.includes.length === 0 && parsed.ignoreFiles.length === 0) {
    return { effectiveTarget: targetPath, reportsPath, scope: selected };
  }
  const projectionRoot = path.join(targetPath, ".quality", "scopes", `quality-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const effectiveTarget = path.join(projectionRoot, "workspace");
  fs.mkdirSync(effectiveTarget, { recursive: true });
  for (const file of selected.files) {
    const source = path.join(targetPath, file);
    const destination = path.join(effectiveTarget, file);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return { effectiveTarget, reportsPath, scope: selected };
}

function resolveScopeFiles(targetPath, parsed) {
  const ignorePlan = loadIgnorePlan(targetPath, parsed);
  let files = [];
  const commands = [];

  if (parsed.scope === "changed") {
    const range = resolveGitRange(parsed);
    if (range.base || range.head) {
      const args = ["diff", "--name-only", `${range.base || "HEAD"}...${range.head || "HEAD"}`];
      const result = runCaptured("git", args, targetPath);
      commands.push(recordCommand("git", args, result));
      assertGitCommandSucceeded(result, args, "resolve the changed-file scope", {
        scope: parsed.scope,
        base: range.base || null,
        head: range.head || null,
        commands
      });
      files.push(...splitLines(result.stdout));
    } else {
      for (const args of [["diff", "--name-only"], ["diff", "--cached", "--name-only"], ["ls-files", "--others", "--exclude-standard"]]) {
        const result = runCaptured("git", args, targetPath);
        commands.push(recordCommand("git", args, result));
        assertGitCommandSucceeded(result, args, "resolve local changed files", {
          scope: parsed.scope,
          base: null,
          head: null,
          commands
        });
        files.push(...splitLines(result.stdout));
      }
    }
    files = filterToConfiguredPaths(files, parsed.paths);
  } else if (parsed.scope === "full") {
    const args = ["ls-files", "-co", "--exclude-standard"];
    const result = runCaptured("git", args, targetPath);
    commands.push(recordCommand("git", args, result));
    files = result.status === 0 ? splitLines(result.stdout) : walkFiles(targetPath).map((file) => normalizePath(path.relative(targetPath, file)));
  } else {
    for (const selectedPath of parsed.paths) {
      const normalized = normalizePath(selectedPath);
      const args = ["ls-files", "-co", "--exclude-standard", "--", normalized];
      const result = runCaptured("git", args, targetPath);
      commands.push(recordCommand("git", args, result));
      files.push(...(result.status === 0 ? splitLines(result.stdout) : walkFiles(path.join(targetPath, normalized)).map((file) => normalizePath(path.relative(targetPath, file)))));
    }
  }

  if (parsed.scope === "full") {
    files.push(...collectIncludedFiles(targetPath, ignorePlan, [""]));
  } else if (parsed.scope === "paths") {
    files.push(...collectIncludedFiles(targetPath, ignorePlan, parsed.paths));
  }

  const primaryUnique = [...new Set(files.map(normalizePath).filter(Boolean))];
  const selectedPaths = primaryUnique.filter((file) => !isIgnored(file, ignorePlan));
  const selectedFiles = selectedPaths
    .filter((file) => fs.existsSync(path.join(targetPath, file)) && fs.statSync(path.join(targetPath, file)).isFile());
  const standardSupport = [];
  if (parsed.scope === "full" || (parsed.scope === "changed" && selectedFiles.length > 0)) {
    for (const support of SUPPORT_FILES) {
      if (fs.existsSync(path.join(targetPath, support))) {
        standardSupport.push(support);
      }
    }
  } else if (parsed.scope === "paths" && fs.existsSync(path.join(targetPath, ".quality-gate-policy.json"))) {
    standardSupport.push(".quality-gate-policy.json");
  }
  const explicitSupport = inputSupportFiles(parsed.containerArgs || [], targetPath);
  const supportFiles = [...new Set([...standardSupport, ...explicitSupport].map(normalizePath))]
    .filter((file) => fs.existsSync(path.join(targetPath, file)) && fs.statSync(path.join(targetPath, file)).isFile())
    .filter((file) => explicitSupport.includes(file) || !isIgnored(file, ignorePlan))
    .filter((file) => !selectedFiles.includes(file));
  const filtered = [...new Set([...selectedFiles, ...supportFiles])].sort();
  const diff = collectDiffMetrics(targetPath, parsed, selectedPaths);
  const history = collectHistoryMetrics(targetPath, parsed, selectedPaths);
  const range = resolveGitRange(parsed);
  return {
    schemaVersion: 1,
    scope: parsed.scope,
    base: range.base || null,
    head: range.head || null,
    files: filtered,
    fileCount: filtered.length,
    selectedFiles: selectedPaths.sort(),
    selectedFileCount: selectedPaths.length,
    analyzedFileCount: selectedFiles.length,
    supportFiles: supportFiles.sort(),
    ignoredCount: primaryUnique.length - selectedPaths.length,
    ignoreFiles: ignorePlan.files,
    diff,
    history,
    resolution: { status: "available" },
    commands
  };
}

function collectIncludedFiles(targetPath, ignorePlan, roots) {
  const includePatterns = [...new Set(ignorePlan.rules
    .filter((rule) => rule.include)
    .map((rule) => normalizePath(rule.pattern))
    .filter(Boolean))];

  if (!includePatterns.length) {
    return [];
  }

  const selectedRoots = roots.length ? roots : [""];
  const files = [];
  for (const root of selectedRoots) {
    const normalizedRoot = normalizePath(root);
    const absoluteRoot = path.join(targetPath, normalizedRoot);
    for (const filePath of walkFiles(absoluteRoot)) {
      const relative = normalizePath(path.relative(targetPath, filePath));
      if (includePatterns.some((pattern) => matchesPattern(relative, pattern))) {
        files.push(relative);
      }
    }
  }
  return files;
}

function validateGitRef(value, flag, scope = "changed") {
  if (value === undefined || value === null) return undefined;
  const validType = typeof value === "string" || typeof value === "number";
  const ref = validType ? String(value) : "";
  if (!validType || !ref || ref !== ref.trim() || ref.startsWith("-") || /[\x00-\x1f\x7f]/.test(ref)) {
    const error = new Error(`${flag} must be a non-empty Git revision without control characters and must not start with '-'.`);
    error.name = "ScopeResolutionError";
    error.code = "INVALID_GIT_REF";
    error.exitCode = OPERATIONAL_EXIT_CODE;
    error.details = { scope, base: null, head: null, commands: [] };
    throw error;
  }
  return ref;
}

function resolveGitRange(parsed = {}) {
  const env = parsed.gitEnv || process.env;
  if (parsed.base !== undefined || parsed.head !== undefined) {
    return {
      base: validateGitRef(parsed.base, "--base", parsed.scope),
      head: validateGitRef(parsed.head === undefined ? "HEAD" : parsed.head, "--head", parsed.scope)
    };
  }
  if (env.GITLAB_CI && env.CI_MERGE_REQUEST_DIFF_BASE_SHA) {
    return {
      base: validateGitRef(env.CI_MERGE_REQUEST_DIFF_BASE_SHA, "CI_MERGE_REQUEST_DIFF_BASE_SHA", parsed.scope),
      head: validateGitRef(env.CI_COMMIT_SHA || "HEAD", "CI_COMMIT_SHA", parsed.scope)
    };
  }
  if (env.GITLAB_CI && env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) {
    return {
      base: validateGitRef(`origin/${env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`, "CI_MERGE_REQUEST_TARGET_BRANCH_NAME", parsed.scope),
      head: validateGitRef(env.CI_COMMIT_SHA || "HEAD", "CI_COMMIT_SHA", parsed.scope)
    };
  }
  if (env.GITHUB_BASE_REF) {
    return {
      base: validateGitRef(`origin/${env.GITHUB_BASE_REF}`, "GITHUB_BASE_REF", parsed.scope),
      head: validateGitRef(env.GITHUB_SHA || "HEAD", "GITHUB_SHA", parsed.scope)
    };
  }
  return {};
}

function runCapturedLarge(command, args, cwd, encoding = "utf8") {
  return spawnSync(command, args, {
    cwd,
    encoding,
    errors: "replace",
    timeout: 60000,
    maxBuffer: LARGE_OUTPUT_LIMIT
  });
}

function numstatPath(rawPath, selectedFiles) {
  const normalized = normalizePath(String(rawPath || "").replace(/^"|"$/g, ""));
  if (selectedFiles.includes(normalized)) return normalized;
  return selectedFiles.find((file) => normalized.endsWith(file)) || normalized;
}

function mergeNumstat(result, selectedFiles, entries) {
  if (result.status !== 0) return false;
  for (const line of splitLines(result.stdout)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const file = numstatPath(parts.slice(2).join("\t"), selectedFiles);
    if (!selectedFiles.includes(file)) continue;
    const previous = entries.get(file) || { additions: 0, deletions: 0, binary: false };
    if (parts[0] === "-" || parts[1] === "-") {
      previous.binary = true;
    } else {
      previous.additions += Number(parts[0]) || 0;
      previous.deletions += Number(parts[1]) || 0;
    }
    entries.set(file, previous);
  }
  return true;
}

function fileLineCount(filePath) {
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let lines = 0;
    let total = 0;
    let lastByte = null;
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (total < 2048 && chunk.subarray(0, Math.min(bytesRead, 2048 - total)).includes(0)) return null;
      for (const byte of chunk) if (byte === 10) lines += 1;
      total += bytesRead;
      lastByte = chunk[bytesRead - 1];
    }
    return total ? lines + (lastByte === 10 ? 0 : 1) : 0;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function patchSize(result) {
  if (result.status === 0 && Buffer.isBuffer(result.stdout)) return result.stdout.length;
  if (result.error?.code === "ENOBUFS") return LARGE_OUTPUT_LIMIT + 1;
  return 0;
}

function collectDiffMetrics(targetPath, parsed, selectedFiles) {
  const empty = { status: "not-applicable", fileCount: 0, additions: 0, deletions: 0, changedLines: 0, patchBytes: 0, binaryFiles: 0, files: {} };
  if (parsed.scope !== "changed") return empty;
  const entries = new Map();
  const commands = [];
  const range = resolveGitRange(parsed);
  let successful = 0;
  let attempted = 0;
  let patchBytes = 0;

  if (range.base || range.head) {
    const spec = `${range.base || "HEAD"}...${range.head || "HEAD"}`;
    const args = ["diff", "--numstat", spec, "--", ...selectedFiles];
    const result = runCapturedLarge("git", args, targetPath);
    attempted += 1;
    assertGitCommandSucceeded(result, args, "collect changed-file metrics", {
      scope: parsed.scope,
      base: range.base || null,
      head: range.head || null,
      commands: [...commands, recordCommand("git", args, result)]
    });
    if (mergeNumstat(result, selectedFiles, entries)) successful += 1;
    commands.push(recordCommand("git", args, result));
    if (selectedFiles.length > 0) {
      const patchArgs = ["diff", "--binary", "--no-ext-diff", spec, "--", ...selectedFiles];
      const patch = runCapturedLarge("git", patchArgs, targetPath, null);
      assertGitCommandSucceeded(patch, patchArgs, "collect changed-file patch bytes", {
        scope: parsed.scope,
        base: range.base || null,
        head: range.head || null,
        commands: [...commands, recordCommand("git", patchArgs, patch)]
      }, { allowBufferLimit: true });
      commands.push(recordCommand("git", patchArgs, patch));
      patchBytes += patchSize(patch);
    }
  } else {
    const head = runCaptured("git", ["rev-parse", "--verify", "HEAD"], targetPath);
    const specs = head.status === 0
      ? [["diff", "--numstat", "HEAD", "--"]]
      : [["diff", "--numstat", "--cached", "--"], ["diff", "--numstat", "--"]];
    const patchSpecs = head.status === 0
      ? [["diff", "--binary", "--no-ext-diff", "HEAD", "--"]]
      : [["diff", "--binary", "--no-ext-diff", "--cached", "--"], ["diff", "--binary", "--no-ext-diff", "--"]];
    for (const args of specs) {
      const result = runCapturedLarge("git", args, targetPath);
      attempted += 1;
      assertGitCommandSucceeded(result, args, "collect local changed-file metrics", {
        scope: parsed.scope,
        base: null,
        head: null,
        commands: [...commands, recordCommand("git", args, result)]
      });
      if (mergeNumstat(result, selectedFiles, entries)) successful += 1;
      commands.push(recordCommand("git", args, result));
    }
    if (selectedFiles.length > 0) {
      for (const baseArgs of patchSpecs) {
        const args = [...baseArgs, ...selectedFiles];
        const patch = runCapturedLarge("git", args, targetPath, null);
        assertGitCommandSucceeded(patch, args, "collect local changed-file patch bytes", {
          scope: parsed.scope,
          base: null,
          head: null,
          commands: [...commands, recordCommand("git", args, patch)]
        }, { allowBufferLimit: true });
        commands.push(recordCommand("git", args, patch));
        patchBytes += patchSize(patch);
      }
    }
  }

  const untracked = runCaptured("git", ["ls-files", "--others", "--exclude-standard"], targetPath);
  assertGitCommandSucceeded(untracked, ["ls-files", "--others", "--exclude-standard"], "collect untracked changed files", {
    scope: parsed.scope,
    base: range.base || null,
    head: range.head || null,
    commands: [...commands, recordCommand("git", ["ls-files", "--others", "--exclude-standard"], untracked)]
  });
  commands.push(recordCommand("git", ["ls-files", "--others", "--exclude-standard"], untracked));
  if (untracked.status === 0) {
    for (const file of splitLines(untracked.stdout).map(normalizePath).filter((item) => selectedFiles.includes(item))) {
      if (entries.has(file)) continue;
      const absolute = path.join(targetPath, file);
      const lines = fileLineCount(absolute);
      const size = fs.existsSync(absolute) ? fs.statSync(absolute).size : 0;
      entries.set(file, { additions: lines || 0, deletions: 0, binary: lines === null });
      patchBytes += size;
    }
  }

  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  const files = {};
  for (const [file, entry] of entries) {
    additions += entry.additions;
    deletions += entry.deletions;
    if (entry.binary) binaryFiles += 1;
    files[file] = entry;
  }
  return {
    status: successful === attempted ? "available" : successful ? "partial" : "unavailable",
    base: range.base || null,
    head: range.head || null,
    fileCount: selectedFiles.length,
    additions,
    deletions,
    changedLines: additions + deletions,
    patchBytes,
    binaryFiles,
    files,
    commands
  };
}

function collectHistoryMetrics(targetPath, parsed, selectedFiles) {
  if (parsed.scope !== "changed") return { status: "not-applicable", commitLimit: 500, files: {} };
  const fileLimit = 500;
  const historyFiles = [...selectedFiles].sort().slice(0, fileLimit);
  const truncated = selectedFiles.length > historyFiles.length;
  const selected = new Set(historyFiles);
  const collected = new Map(historyFiles.map((file) => [file, { commits: new Set(), additions: 0, deletions: 0 }]));
  let successful = 0;
  let attempted = 0;
  for (let offset = 0; offset < historyFiles.length; offset += 50) {
    const batch = historyFiles.slice(offset, offset + 50);
    const args = ["log", "--max-count=500", "--format=commit:%H", "--numstat", "--no-renames", "--", ...batch];
    const result = runCapturedLarge("git", args, targetPath);
    attempted += 1;
    if (result.status !== 0) continue;
    successful += 1;
    let commit = null;
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      if (line.startsWith("commit:")) {
        commit = line.slice("commit:".length).trim();
        continue;
      }
      const parts = line.split("\t");
      if (parts.length < 3 || parts[0] === "-" || parts[1] === "-") continue;
      const file = numstatPath(parts.slice(2).join("\t"), historyFiles);
      if (!selected.has(file)) continue;
      const item = collected.get(file);
      if (commit) item.commits.add(commit);
      item.additions += Number(parts[0]) || 0;
      item.deletions += Number(parts[1]) || 0;
    }
  }
  const files = {};
  for (const [file, item] of collected) {
    files[file] = { commits: item.commits.size, additions: item.additions, deletions: item.deletions, churn: item.additions + item.deletions };
  }
  const status = !attempted ? "unavailable" : successful === attempted && !truncated ? "available" : successful ? "partial" : "unavailable";
  return { status, commitLimit: 500, fileLimit, truncatedFiles: selectedFiles.length - historyFiles.length, files };
}

function loadIgnorePlan(targetPath, parsed) {
  const rules = DEFAULT_IGNORES.map((pattern) => ({ pattern, include: false, source: "defaults" }));
  const files = [];
  const candidates = [...new Set([".gitignore", ".jgates.ignore", ".quality-gate.ignore", ...parsed.ignoreFiles])];
  for (const candidate of candidates) {
    const relative = normalizePath(candidate);
    const absolute = path.resolve(targetPath, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      continue;
    }
    files.push(relative);
    for (const rawLine of fs.readFileSync(absolute, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const include = line.startsWith("!");
      rules.push({ pattern: include ? line.slice(1) : line, include, source: relative });
    }
  }
  for (const pattern of parsed.excludes) {
    rules.push({ pattern, include: false, source: "--exclude" });
  }
  for (const pattern of parsed.includes) {
    rules.push({ pattern, include: true, source: "--include" });
  }
  return { files, rules };
}

function isIgnored(file, ignorePlan) {
  let ignored = false;
  for (const rule of ignorePlan.rules) {
    if (matchesPattern(file, rule.pattern)) {
      ignored = !rule.include;
    }
  }
  return ignored;
}

function filterToConfiguredPaths(files, configuredPaths) {
  if (!configuredPaths.length) {
    return files;
  }
  const prefixes = configuredPaths.map(normalizePath).filter(Boolean);
  return files.filter((file) => {
    const normalized = normalizePath(file);
    return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

function runCaptured(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", errors: "replace", timeout: 30000 });
}

function recordCommand(command, args, result) {
  return {
    command: commandLine(command, args),
    exitCode: result.status ?? null,
    stderr: String(result.stderr || result.error?.message || "").trim().slice(0, 4000)
  };
}

function assertGitCommandSucceeded(result, args, purpose, context = {}, options = {}) {
  if (!result.error && result.status === 0) return;
  if (options.allowBufferLimit && result.error?.code === "ENOBUFS") return;
  const command = commandLine("git", args);
  const exitCode = result.status ?? null;
  const stderr = String(result.stderr || result.error?.message || "Git command failed").trim().slice(0, 4000);
  const error = new Error(`Unable to ${purpose}: ${command} exited with ${exitCode ?? "no status"}. ${stderr}`.trim());
  error.name = "ScopeResolutionError";
  error.code = "GIT_SCOPE_RESOLUTION_FAILED";
  error.exitCode = OPERATIONAL_EXIT_CODE;
  error.details = {
    ...context,
    command,
    commandExitCode: exitCode,
    stderr
  };
  throw error;
}

function splitLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function walkFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  if (fs.statSync(root).isFile()) {
    return [root];
  }
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "node_modules", ".quality"].includes(entry.name)) {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function matchesPattern(file, pattern) {
  const normalizedFile = normalizePath(file);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.endsWith("/")) {
    const prefix = normalizedPattern.replace(/\/+$/, "");
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`) || normalizedFile.includes(`/${prefix}/`);
  }
  if (!normalizedPattern.includes("/")) {
    return normalizedFile.split("/").some((part) => globMatches(part, normalizedPattern));
  }
  return globMatches(normalizedFile, normalizedPattern);
}

function globMatches(value, pattern) {
  const memo = new Map();
  const match = (valueIndex, patternIndex) => {
    const key = `${valueIndex}:${patternIndex}`;
    if (memo.has(key)) {
      return memo.get(key);
    }
    let matched;
    if (patternIndex === pattern.length) {
      matched = valueIndex === value.length;
    } else if (pattern[patternIndex] === "*" && pattern[patternIndex + 1] === "*") {
      matched = match(valueIndex, patternIndex + 2) ||
        (valueIndex < value.length && match(valueIndex + 1, patternIndex));
    } else if (pattern[patternIndex] === "*") {
      matched = match(valueIndex, patternIndex + 1) ||
        (valueIndex < value.length && value[valueIndex] !== "/" && match(valueIndex + 1, patternIndex));
    } else if (pattern[patternIndex] === "?") {
      matched = valueIndex < value.length && value[valueIndex] !== "/" && match(valueIndex + 1, patternIndex + 1);
    } else {
      matched = valueIndex < value.length && value[valueIndex] === pattern[patternIndex] &&
        match(valueIndex + 1, patternIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return match(0, 0);
}

function isDockerAvailable(env = process.env, runner = spawnSync) {
  const result = runner("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    errors: "replace",
    env,
    timeout: 15000
  });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  return !result.error && result.status === 0 && stdout.length > 0 && !/internal server error/i.test(stderr);
}

function sleepSync(ms) {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function dockerDesktopCandidates(env = process.env) {
  const candidates = [];
  if (env.DOCKER_DESKTOP_PATH) {
    candidates.push({ command: env.DOCKER_DESKTOP_PATH, args: [] });
  }
  if (process.platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const localAppData = env.LOCALAPPDATA;
    const windowsCandidates = [
      path.join(programFiles, "Docker", "Docker", "Docker Desktop.exe"),
      localAppData ? path.join(localAppData, "Docker", "Docker Desktop.exe") : null
    ].filter(Boolean);
    for (const command of windowsCandidates) {
      if (fs.existsSync(command)) {
        candidates.push({ command, args: [] });
      }
    }
  } else if (process.platform === "darwin") {
    candidates.push({ command: "open", args: ["-a", "Docker"] });
  }
  candidates.push({ command: "docker", args: ["desktop", "start"] });
  return candidates;
}

function startDetachedProcess(command, args, env = process.env) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env
    });
    child.unref();
    return { status: 0 };
  } catch (error) {
    return { error };
  }
}

function startDockerDaemon(env = process.env, starter = startDetachedProcess) {
  const failures = [];
  for (const candidate of dockerDesktopCandidates(env)) {
    const result = starter(candidate.command, candidate.args, env);
    if (!result.error && (result.status === undefined || result.status === 0)) {
      return {
        started: true,
        command: commandLine(candidate.command, candidate.args),
        failures
      };
    }
    failures.push({
      command: commandLine(candidate.command, candidate.args),
      message: result.error ? result.error.message : `exit ${result.status}`
    });
  }
  return { started: false, command: null, failures };
}

function waitForDocker(env = process.env, runner = spawnSync, timeoutMs = 120000, pollMs = 2000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    if (isDockerAvailable(env, runner)) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return isDockerAvailable(env, runner);
}

function ensureDockerAvailable(parsed, env = process.env, runner = spawnSync, starter = startDetachedProcess) {
  if (isDockerAvailable(env, runner)) {
    return true;
  }
  if (!parsed.startDocker) {
    return false;
  }
  const started = startDockerDaemon(env, starter);
  if (!started.started) {
    console.error("Docker is not available and could not be started automatically.");
    for (const failure of started.failures) {
      console.error(`- ${failure.command}: ${failure.message}`);
    }
    return false;
  }
  console.error(`Docker is not available; started ${started.command} and waiting for the daemon...`);
  if (waitForDocker(env, runner, parsed.dockerStartTimeoutMs)) {
    console.error("Docker daemon is ready.");
    return true;
  }
  console.error(`Docker did not become ready within ${parsed.dockerStartTimeoutMs}ms.`);
  return false;
}

function imageExists(image, env = process.env, runner = spawnSync) {
  const result = runner("docker", ["image", "inspect", image], {
    encoding: "utf8",
    errors: "replace",
    env,
    timeout: 15000
  });
  return !result.error && result.status === 0;
}

function canBuildBundledImage(packageRoot = PACKAGE_ROOT) {
  return fs.existsSync(path.join(packageRoot, "Dockerfile")) &&
    fs.existsSync(path.join(packageRoot, "sidecar")) &&
    fs.existsSync(path.join(packageRoot, "docker", "entrypoint.sh"));
}

function buildBundledImage(image, env = process.env, runner = spawnSync, packageRoot = PACKAGE_ROOT) {
  if (!canBuildBundledImage(packageRoot)) {
    console.error(
      `Docker image ${image} was not found locally and this installation does not include the bundled sidecar build context. ` +
      "Run with --pull, pass --image <existing-image>, or install from the full repository/package."
    );
    return 3;
  }

  console.error(`Docker image ${image} was not found locally. Building the bundled quality-sidecar image...`);
  const result = runner("docker", ["build", "-t", image, packageRoot], {
    stdio: "inherit",
    env
  });
  if (result.error) {
    console.error(`Failed to execute docker build: ${result.error.message}`);
    return 3;
  }
  return result.status ?? 3;
}

// The data folder of JGates, resolved as jgates does (JGATES_HOME, then the folder of the platform).
function jgatesHome(env = process.env) {
  if (env.JGATES_HOME) return path.resolve(env.JGATES_HOME);
  const homedir = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homedir, "AppData", "Local"), "jgates");
  if (process.platform === "darwin") return path.join(homedir, "Library", "Application Support", "jgates");
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homedir, ".local", "state");
  return path.join(state, "jgates");
}

// The interpreter of the Python environment `jgates doctor --fix` creates, or null when it is not there.
function jgatesPythonEnv(env = process.env) {
  const bin = path.join(jgatesHome(env), "tools", "python", process.platform === "win32" ? "Scripts" : "bin");
  for (const name of process.platform === "win32" ? ["python.exe", "python"] : ["python"]) {
    const candidate = path.join(bin, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}

// Same order as jgates: JGATES_PYTHON, then PYTHON (the wrapper's own variable), then the JGates environment, then the PATH.
function pythonCommand(env = process.env) {
  if (env.JGATES_PYTHON) {
    return env.JGATES_PYTHON;
  }
  if (env.PYTHON) {
    return env.PYTHON;
  }
  const own = jgatesPythonEnv(env);
  if (own) {
    return own;
  }
  return process.platform === "win32" ? "python" : "python3";
}

// The tools the local sidecar did not find (status "missing" in quality-report.json), by name.
function missingLocalTools(reportsPath) {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(reportsPath, "quality-report.json"), "utf8"));
    return (report.tools || []).filter((tool) => tool && tool.status === "missing").map((tool) => String(tool.name));
  } catch {
    return [];
  }
}

function findOnPath(command, env = process.env) {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// One answer line from the terminal, read synchronously ("" at the end of the input).
function readLineSync(fd = 0) {
  const bytes = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, one, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0 || one[0] === 10) break;
    bytes.push(one[0]);
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
}

// A person can answer: a terminal on stdin, and neither --ci, --no-interactive, CI nor QUALITY_GATE_NO_INTERACTIVE.
function canAsk(parsed, env = process.env) {
  return !parsed.ci && !parsed.noInteractive && !parsed.json && !env.CI && env.QUALITY_GATE_NO_INTERACTIVE !== "1" && process.stdin.isTTY === true;
}

const JGATES_HINT = "Install what is missing with: jgates doctor --fix (or run with Docker available).";

function localSidecarEnv(env = process.env, packageRoot = PACKAGE_ROOT) {
  const sidecarPath = path.join(packageRoot, "sidecar");
  return {
    ...env,
    PYTHONPATH: env.PYTHONPATH ? `${sidecarPath}${path.delimiter}${env.PYTHONPATH}` : sidecarPath
  };
}

function runLocalSidecar(parsed, scopedTarget, reportsPath, env = process.env, runner = spawnSync) {
  const args = buildLocalSidecarArgs(parsed, scopedTarget.effectiveTarget, reportsPath);
  const command = pythonCommand(env);
  const mode = sidecarMode(args) || "full";
  if (parsed.debugDocker) {
    console.log(commandLine(command, args));
  }
  console.error(
    `Docker is not available; running the bundled Quality Gate sidecar locally in ${mode} mode. ` +
    (mode === "full"
      ? "Unavailable required tools will fail the gate."
      : "This reduced mode was explicitly requested by the caller.")
  );
  const result = runner(command, args, {
    stdio: "inherit",
    env: {
      ...localSidecarEnv(env),
      QUALITY_GATE_SCOPE: parsed.scope
    }
  });
  if (result.error) {
    console.error(`Failed to run local quality sidecar: ${result.error.message}`);
    return 3;
  }
  return result.status ?? 3;
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

function helpText() {
  return `quality-gate

Usage:
  quality-gate
  quality-gate --scope changed
  quality-gate --scope full
  quality-gate --scope paths --path apps/web --path packages/core
  quality-gate . --threshold 90 --format=json,md --output .quality/reports
  quality-gate --version
  quality-gate --help

Information commands (--help, --version) never touch Docker.

Scope flags:
  --scope changed|full|paths     changed is the default.
  --base <ref> / --head <ref>    Explicit Git range; GitLab merge request variables are auto-detected.
  --path <path>                  Add a path for scope=paths; repeatable.
  --exclude <glob>               Exclude files using gitignore-style globs; repeatable.
  --include <glob>               Re-include a previously excluded file; repeatable.
  --ignore-file <path>           Add a custom gitignore-style ignore file; repeatable; supports !path re-inclusion.

Automation:
  --ci                           Headless CI mode.
  --json                         Request JSON report format.
  --no-interactive               Never prompt.

Docker wrapper flags:
  --image <image>
  --pull / --no-pull
  --start-docker / --no-start-docker
  --docker-start-timeout-ms <ms>
  --build / --no-build
  --docker-arg <arg>
  --debug-docker

Local fallback:
  When Docker is not available, the bundled Python sidecar keeps full mode by default.
  Pass --mode quick|offline explicitly to opt into a reduced-evidence scan.

Language-agnostic policy:
  --policy-file <path>           Budgets, change requirements, and evidence thresholds.
  --max-file-bytes <n>           Override a profile budget; 0 disables that budget.
  --max-file-lines <n>
  --max-changed-files <n>
  --max-changed-lines <n>
  --max-diff-bytes <n>
  --dependency-graph <path>      Normalized dependency graph JSON; repeatable.
  --evidence-report <path>       Normalized quality evidence JSON; repeatable.
  --test-report <path>           JUnit XML evidence; repeatable.

All remaining flags are passed to the sidecar check command.
`;
}

function writeEmptyQualityReport(reportsPath, scope, parsed) {
  fs.mkdirSync(reportsPath, { recursive: true });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: parsed.target,
    status: "APPROVED",
    exitCode: 0,
    profile: "standard",
    mode: "scoped",
    score: { value: 100, threshold: 0, max: 100 },
    scope,
    scoreAppliesTo: scoreAppliesToForScope(scope.scope),
    summary: {
      counts: { active: 0, allowed: 0, total: 0 },
      reasons: ["No files matched the requested scope after ignore rules."],
      toolErrors: []
    },
    stack: {},
    metrics: {
      scope: scope.scope,
      totals: { files: 0, bytes: 0, textFiles: 0, binaryFiles: 0, lines: 0 },
      change: scope.diff || { status: "unavailable", files: 0, additions: 0, deletions: 0, changedLines: 0, patchBytes: 0, binaryFiles: 0 },
      notEvaluated: "No files matched the requested scope after ignore rules."
    },
    tools: [],
    findings: []
  };
  fs.writeFileSync(path.join(reportsPath, "quality-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(reportsPath, "quality-report.md"),
    `# Quality Gate Report\n\nStatus: APPROVED\nScope: ${scope.scope}\nFiles analyzed: 0\n\nNo files matched the requested scope after ignore rules.\n`,
    "utf8"
  );
}

function failedScopeManifest(parsed, error) {
  const range = resolveGitRange(parsed);
  const details = error.details || {};
  return {
    schemaVersion: 1,
    scope: parsed.scope,
    base: details.base ?? range.base ?? null,
    head: details.head ?? range.head ?? null,
    files: [],
    fileCount: 0,
    selectedFiles: [],
    selectedFileCount: 0,
    analyzedFileCount: 0,
    supportFiles: [],
    ignoredCount: 0,
    ignoreFiles: [],
    diff: {
      status: "error",
      base: details.base ?? range.base ?? null,
      head: details.head ?? range.head ?? null,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      changedLines: 0,
      patchBytes: 0,
      binaryFiles: 0,
      files: {}
    },
    history: { status: "not-evaluated", files: {} },
    resolution: {
      status: "error",
      code: error.code || "SCOPE_RESOLUTION_FAILED",
      message: error.message,
      exitCode: error.exitCode || OPERATIONAL_EXIT_CODE
    },
    commands: Array.isArray(details.commands) ? details.commands : []
  };
}

function writeOperationalQualityReport(reportsPath, scope, parsed, error) {
  fs.mkdirSync(reportsPath, { recursive: true });
  const code = error.code || "SCOPE_RESOLUTION_FAILED";
  const exitCode = error.exitCode || OPERATIONAL_EXIT_CODE;
  const message = error.message || "The requested scope could not be resolved.";
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: parsed.target,
    status: "ERROR",
    exitCode,
    profile: "standard",
    mode: "scoped",
    score: { value: null, threshold: null, max: 100 },
    scope,
    scoreAppliesTo: scoreAppliesToForScope(scope.scope),
    summary: {
      counts: { active: 0, allowed: 0, total: 0 },
      reasons: [message],
      toolErrors: ["git"]
    },
    error: { code, message, exitCode },
    stack: {},
    metrics: {
      scope: scope.scope,
      totals: { files: 0, bytes: 0, textFiles: 0, binaryFiles: 0, lines: 0 },
      change: scope.diff,
      notEvaluated: "Scope resolution failed; no quality decision was made."
    },
    tools: [],
    findings: []
  };
  fs.writeFileSync(path.join(reportsPath, "quality-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(reportsPath, "quality-report.md"),
    `# Quality Gate Report\n\nStatus: ERROR\nExit code: ${exitCode}\nScope: ${scope.scope}\nError: ${code}\n\n${message}\n`,
    "utf8"
  );
}

function scoreAppliesToForScope(scope) {
  return scope === "full" ? "entire-project" : scope === "paths" ? "selected-paths" : "changed-files";
}

// The container may write the reports as another user (root on Linux), which leaves
// them read-only for the caller. Try an in-place write first, then replace the file
// (allowed by the directory ownership). Returns null on success or the error.
function rewriteReportFile(filePath, text) {
  try {
    fs.writeFileSync(filePath, text, "utf8");
    return null;
  } catch (firstError) {
    const temp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, text, "utf8");
      fs.renameSync(temp, filePath);
      return null;
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing else to clean up.
      }
      return firstError;
    }
  }
}

// Never throws: a report that cannot be augmented becomes a warning on stderr, so the
// exit code of the container stays the exit code of the wrapper.
function augmentQualityReports(reportsPath, scope) {
  const jsonPath = path.join(reportsPath, "quality-report.json");
  const markdownPath = path.join(reportsPath, "quality-report.md");
  const warnings = [];
  if (fs.existsSync(jsonPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      report.scope = scope;
      report.scoreAppliesTo = scoreAppliesToForScope(scope.scope);
      const failure = rewriteReportFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
      if (failure) warnings.push(`${jsonPath}: ${failure.message}`);
    } catch (error) {
      warnings.push(`${jsonPath}: ${error.message}`);
    }
  }
  if (fs.existsSync(markdownPath)) {
    try {
      const addition = [
        "",
        "## Scope",
        "",
        `Scope: ${scope.scope}`,
        `Files analyzed: ${scope.fileCount}`,
        `Ignored files: ${scope.ignoredCount}`,
        `Ignore files: ${scope.ignoreFiles.length ? scope.ignoreFiles.join(", ") : "(none)"}`,
        "",
      ].join("\n");
      const failure = rewriteReportFile(markdownPath, fs.readFileSync(markdownPath, "utf8") + addition);
      if (failure) warnings.push(`${markdownPath}: ${failure.message}`);
    } catch (error) {
      warnings.push(`${markdownPath}: ${error.message}`);
    }
  }
  for (const warning of warnings) {
    console.error(`Aviso: o escopo não foi anexado ao relatório (${warning}). O código de saída do container foi mantido.`);
  }
  return warnings;
}

// hooks (tests): { interactive: boolean, ask(question) => string }.
function runDockerWrapper(rawArgs, env = process.env, runner = spawnSync, starter = startDetachedProcess, hooks = {}) {
  let parsed;
  let targetPath;

  try {
    parsed = parseArgs(rawArgs, env);
    // Information commands answer here, before anything that could reach the container runtime.
    if (parsed.help) {
      console.log(helpText());
      return 0;
    }
    if (parsed.version) {
      console.log(packageVersion());
      return 0;
    }
    targetPath = ensureTarget(parsed.target);
    parsed.containerArgs = normalizeInputFileArgs(parsed.containerArgs, targetPath);
  } catch (error) {
    console.error(error.message);
    return 3;
  }

  let scopedTarget;
  try {
    scopedTarget = resolveScopedTarget(targetPath, parsed);
  } catch (error) {
    if (!error.code) error.code = "SCOPE_RESOLUTION_FAILED";
    if (!error.exitCode) error.exitCode = OPERATIONAL_EXIT_CODE;
    const reportsPath = path.isAbsolute(parsed.output)
      ? parsed.output
      : path.resolve(targetPath, parsed.output);
    const scope = failedScopeManifest(parsed, error);
    fs.mkdirSync(reportsPath, { recursive: true });
    fs.writeFileSync(path.join(reportsPath, "quality-scope.json"), `${JSON.stringify(scope, null, 2)}\n`, "utf8");
    writeOperationalQualityReport(reportsPath, scope, parsed, error);
    console.error(`${error.code}: ${error.message}`);
    return error.exitCode;
  }
  const reportsPath = scopedTarget.reportsPath;
  fs.mkdirSync(reportsPath, { recursive: true });
  fs.writeFileSync(
    path.join(reportsPath, "quality-scope.json"),
    `${JSON.stringify(scopedTarget.scope, null, 2)}\n`,
    "utf8"
  );

  if (scopedTarget.scope.files.length === 0 && scopedTarget.scope.selectedFileCount === 0) {
    writeEmptyQualityReport(reportsPath, scopedTarget.scope, parsed);
    console.error("No files matched the requested quality-gate scope after ignore rules.");
    return 0;
  }

  if (!ensureDockerAvailable(parsed, env, runner, starter)) {
    let exitCode = runLocalSidecar(parsed, scopedTarget, reportsPath, env, runner);
    augmentQualityReports(reportsPath, scopedTarget.scope);
    const missing = exitCode === 0 ? [] : missingLocalTools(reportsPath);
    if (missing.length === 0) {
      return exitCode;
    }
    // The local sidecar ended without some tools: a person is offered to install them or to try Docker; anywhere
    // else the error stays as it was and only the hint is added. The exit code never changes because of the offer.
    const interactive = hooks.interactive === undefined ? canAsk(parsed, env) : hooks.interactive;
    console.error(`Tools not found by the local sidecar: ${missing.join(", ")}.`);
    if (!interactive) {
      console.error(JGATES_HINT);
      return exitCode;
    }
    const ask = hooks.ask || ((question) => {
      process.stderr.write(question);
      return readLineSync(0);
    });
    const jgates = findOnPath("jgates", env);
    const options = [jgates ? "i = install what is missing with jgates doctor --fix" : "(jgates is not on the PATH: install it to get the recipes)", "d = try Docker", "n = no"];
    const answer = String(ask(`${options.join("; ")}\nChoice [i/d/N]: `)).trim().toLowerCase();
    if (answer === "i" && jgates) {
      const doctor = runner(jgates, ["doctor", "--fix", "--cwd", targetPath], { stdio: "inherit", env });
      if (doctor.error || doctor.status !== 0) {
        console.error("The installation did not finish; the result stays as it was.");
        return exitCode;
      }
      exitCode = runLocalSidecar(parsed, scopedTarget, reportsPath, env, runner);
      augmentQualityReports(reportsPath, scopedTarget.scope);
      return exitCode;
    }
    if (answer === "d") {
      if (!ensureDockerAvailable({ ...parsed, startDocker: true }, env, runner, starter)) {
        console.error("Docker is still not available; the result stays as it was.");
        return exitCode;
      }
      // Docker answers now: go on to the container run below.
    } else {
      return exitCode;
    }
  }

  if (parsed.pull) {
    const pullResult = runner("docker", ["pull", parsed.image], { stdio: "inherit", env });
    if (pullResult.error) {
      console.error(`Falha ao executar docker pull: ${pullResult.error.message}`);
      return 3;
    }
    if (pullResult.status !== 0) {
      return pullResult.status ?? 3;
    }
  }

  if (parsed.build && !imageExists(parsed.image, env, runner)) {
    const buildExitCode = buildBundledImage(parsed.image, env, runner);
    if (buildExitCode !== 0) {
      return buildExitCode;
    }
  }

  const dockerArgs = buildDockerArgs(parsed, scopedTarget.effectiveTarget, reportsPath);
  if (parsed.debugDocker) {
    console.log(commandLine("docker", dockerArgs));
  }

  const result = runner("docker", dockerArgs, { stdio: "inherit", env });
  if (result.error) {
    console.error(`Falha ao executar docker run: ${result.error.message}`);
    return 3;
  }

  augmentQualityReports(reportsPath, scopedTarget.scope);
  return result.status ?? 3;
}

if (require.main === module) {
  process.exit(runDockerWrapper(process.argv.slice(2)));
}

module.exports = {
  DEFAULT_IMAGE,
  PACKAGE_ROOT,
  parseArgs,
  ensureTarget,
  buildDockerArgs,
  quoteForDisplay,
  commandLine,
  isDockerAvailable,
  dockerDesktopCandidates,
  startDockerDaemon,
  waitForDocker,
  ensureDockerAvailable,
  imageExists,
  canBuildBundledImage,
  buildBundledImage,
  buildLocalSidecarArgs,
  sidecarMode,
  runLocalSidecar,
  pythonCommand,
  missingLocalTools,
  helpText,
  packageVersion,
  resolveScopeFiles,
  resolveScopedTarget,
  resolveGitRange,
  collectDiffMetrics,
  collectHistoryMetrics,
  normalizeInputFileArgs,
  inputSupportFiles,
  matchesPattern,
  augmentQualityReports,
  writeEmptyQualityReport,
  writeOperationalQualityReport,
  normalizeFormatValue,
  runDockerWrapper
};
