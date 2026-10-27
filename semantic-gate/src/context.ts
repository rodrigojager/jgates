import fs from "node:fs";
import path from "node:path";
import { SemanticGateError } from "./errors.js";
import { commandLine, runCommand } from "./shell.js";
import type { CommandRecord, FileContext, GitReviewContext, SemanticGateConfig } from "./types.js";

const generatedOrVendoredPatterns = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /(^|\/)\.quality\//,
  /(^|\/)vendor\//,
  /(^|\/)__pycache__\//,
  /(^|\/).*\.egg-info\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
];

interface IgnoreRule {
  pattern: string;
  include: boolean;
  source: string;
}

interface IgnorePlan {
  files: string[];
  rules: IgnoreRule[];
}

export async function collectGitReviewContext(
  cwd: string,
  config: SemanticGateConfig,
): Promise<GitReviewContext> {
  const repoRootResult = await git(cwd, ["rev-parse", "--show-toplevel"], "find git repository root");
  if (repoRootResult.code !== 0) {
    throw new SemanticGateError("semantic-gate must run inside a git repository.", "context", repoRootResult.stderr);
  }
  const repoRoot = repoRootResult.stdout.trim();

  const commands: CommandRecord[] = [record(repoRootResult)];
  const warnings: string[] = [];
  const ignorePlan = loadIgnorePlan(repoRoot, config);

  const statusArgs = config.paths.length > 0
    ? ["status", "--short", "--", ...config.paths.map(normalizePath)]
    : ["status", "--short"];
  const status = await git(repoRoot, statusArgs, "identify changed files");
  commands.push(record(status));

  let diffStat = "";
  let stagedDiffStat = "";
  let rangeDiffStat: string | undefined;
  let fileNames: string[] = [];
  let range: string | undefined;

  if (config.scope === "changed") {
    const changed = await collectChangedFileNames(repoRoot, config, commands);
    fileNames = changed.files;
    diffStat = changed.diffStat;
    stagedDiffStat = changed.stagedDiffStat;
    rangeDiffStat = changed.rangeDiffStat;
    range = changed.range;
  } else {
    const scoped = await collectSnapshotFileNames(repoRoot, config, commands);
    fileNames = scoped.files;
    diffStat = config.scope === "full" ? "(full project scan; diff not applicable)" : "(path scan; diff not applicable)";
    stagedDiffStat = "";
  }

  const files: FileContext[] = [];
  for (const relativeFile of uniqueStrings(fileNames).sort()) {
    const normalized = normalizePath(relativeFile);
    if (!normalized) {
      continue;
    }
    const skipReason = skipReasonForPath(normalized, ignorePlan);
    if (skipReason) {
      warnings.push(`Skipped path: ${normalized} (${skipReason})`);
      continue;
    }
    if (config.scope === "changed") {
      files.push(await collectChangedFile(repoRoot, normalized, config, range, warnings, commands));
    } else {
      files.push(await collectSnapshotFile(repoRoot, normalized, config, warnings));
    }
  }

  const context: GitReviewContext = {
    repoRoot,
    scope: config.scope,
    paths: config.paths,
    excludes: config.excludes,
    includes: config.includes,
    ignoreFiles: ignorePlan.files,
    statusShort: status.stdout.trim(),
    diffStat,
    stagedDiffStat,
    commandsExecuted: commands,
    changedFiles: files,
    warnings,
  };
  if (rangeDiffStat !== undefined) {
    context.rangeDiffStat = rangeDiffStat;
  }
  return context;
}

async function collectChangedFileNames(
  repoRoot: string,
  config: SemanticGateConfig,
  commands: CommandRecord[],
): Promise<{
  files: string[];
  diffStat: string;
  stagedDiffStat: string;
  rangeDiffStat?: string;
  range?: string;
}> {
  const range = config.base
    ? config.head
      ? `${config.base}...${config.head}`
      : `${config.base}...HEAD`
    : undefined;

  if (range) {
    const rangeStat = await git(repoRoot, ["diff", "--stat", range], "summarize comparison range");
    const rangeNames = await git(repoRoot, ["diff", "--name-only", range], "list changed files in comparison range");
    commands.push(record(rangeStat), record(rangeNames));
    return {
      files: filterToConfiguredPaths(splitLines(rangeNames.stdout), config.paths),
      diffStat: "",
      stagedDiffStat: "",
      rangeDiffStat: rangeStat.stdout.trim(),
      range,
    };
  }

  const unstagedStat = await git(repoRoot, ["diff", "--stat"], "summarize unstaged changes");
  const stagedStat = await git(repoRoot, ["diff", "--cached", "--stat"], "summarize staged changes");
  const unstagedNames = await git(repoRoot, ["diff", "--name-only"], "list unstaged changed files");
  const stagedNames = await git(repoRoot, ["diff", "--cached", "--name-only"], "list staged changed files");
  commands.push(record(unstagedStat), record(stagedStat), record(unstagedNames), record(stagedNames));

  const files = [...splitLines(unstagedNames.stdout), ...splitLines(stagedNames.stdout)];
  if (config.includeUntracked) {
    const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
    if (config.paths.length > 0) {
      untrackedArgs.push("--", ...config.paths.map(normalizePath));
    }
    const untracked = await git(repoRoot, untrackedArgs, "list untracked files");
    commands.push(record(untracked));
    files.push(...splitLines(untracked.stdout));
  }

  return {
    files: filterToConfiguredPaths(files, config.paths),
    diffStat: unstagedStat.stdout.trim(),
    stagedDiffStat: stagedStat.stdout.trim(),
  };
}

async function collectSnapshotFileNames(
  repoRoot: string,
  config: SemanticGateConfig,
  commands: CommandRecord[],
): Promise<{ files: string[] }> {
  const args = ["ls-files", "-co", "--exclude-standard"];
  if (config.scope === "paths") {
    args.push("--", ...config.paths.map(normalizePath));
  }
  const result = await git(repoRoot, args, config.scope === "full" ? "list project files" : "list selected path files");
  commands.push(record(result));
  if (result.code !== 0) {
    throw new SemanticGateError("Failed to list files for semantic-gate scope.", "context", result.stderr);
  }
  return { files: splitLines(result.stdout) };
}

async function collectChangedFile(
  repoRoot: string,
  relativeFile: string,
  config: SemanticGateConfig,
  range: string | undefined,
  warnings: string[],
  commands: CommandRecord[],
): Promise<FileContext> {
  const file: FileContext = {
    path: relativeFile,
    changeKinds: [],
  };

  if (range) {
    const diff = await git(repoRoot, ["diff", range, "--", relativeFile], `read diff for ${relativeFile}`);
    commands.push(record(diff));
    file.diff = limitText(diff.stdout, config.maxDiffChars, `diff for ${relativeFile}`, warnings, file);
    file.changeKinds.push("range");
  } else {
    const unstaged = await git(repoRoot, ["diff", "--", relativeFile], `read unstaged diff for ${relativeFile}`);
    const staged = await git(repoRoot, ["diff", "--cached", "--", relativeFile], `read staged diff for ${relativeFile}`);
    commands.push(record(unstaged), record(staged));
    if (unstaged.stdout.trim()) {
      file.diff = limitText(unstaged.stdout, config.maxDiffChars, `unstaged diff for ${relativeFile}`, warnings, file);
      file.changeKinds.push("unstaged");
    }
    if (staged.stdout.trim()) {
      file.stagedDiff = limitText(staged.stdout, config.maxDiffChars, `staged diff for ${relativeFile}`, warnings, file);
      file.changeKinds.push("staged");
    }
  }

  await attachFileContent(repoRoot, relativeFile, config, warnings, file);
  if (file.changeKinds.length === 0) {
    file.changeKinds.push("untracked");
  }
  return file;
}

async function collectSnapshotFile(
  repoRoot: string,
  relativeFile: string,
  config: SemanticGateConfig,
  warnings: string[],
): Promise<FileContext> {
  const file: FileContext = {
    path: relativeFile,
    changeKinds: [config.scope === "full" ? "full-scan" : "path-scan"],
  };
  await attachFileContent(repoRoot, relativeFile, config, warnings, file);
  return file;
}

async function attachFileContent(
  repoRoot: string,
  relativeFile: string,
  config: SemanticGateConfig,
  warnings: string[],
  file: FileContext,
): Promise<void> {
  const absoluteFile = path.join(repoRoot, relativeFile);
  if (!fs.existsSync(absoluteFile)) {
    file.skippedReason = "file deleted or unavailable in working tree";
    if (!file.changeKinds.includes("deleted")) {
      file.changeKinds.push("deleted");
    }
    return;
  }

  const stat = fs.statSync(absoluteFile);
  if (!stat.isFile()) {
    file.skippedReason = "not a regular file";
    return;
  }
  if (stat.size > config.maxFileChars) {
    file.skippedReason = `file exceeds maxFileChars (${stat.size} > ${config.maxFileChars})`;
    file.truncated = true;
    warnings.push(`Skipped full content for ${relativeFile}: ${file.skippedReason}`);
    return;
  }

  const buffer = fs.readFileSync(absoluteFile);
  if (buffer.includes(0)) {
    file.skippedReason = "binary file";
    warnings.push(`Skipped binary file content: ${relativeFile}`);
    return;
  }
  file.content = buffer.toString("utf8");
}

function limitText(
  text: string,
  limit: number,
  label: string,
  warnings: string[],
  file: FileContext,
): string {
  if (text.length <= limit) {
    return text;
  }
  file.truncated = true;
  warnings.push(`Truncated ${label}: ${text.length} chars > ${limit}.`);
  return `${text.slice(0, limit)}\n[semantic-gate truncated ${label}; original chars=${text.length}]`;
}

function loadIgnorePlan(repoRoot: string, config: SemanticGateConfig): IgnorePlan {
  const rules: IgnoreRule[] = [];
  const files: string[] = [];
  const candidates = [...new Set([
    ".gitignore",
    ".jgates.ignore",
    ".semantic-gate.ignore",
    ...config.ignoreFiles,
  ])];

  for (const candidate of candidates) {
    const relative = normalizePath(candidate);
    const absolute = path.resolve(repoRoot, relative);
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

  for (const pattern of config.excludes) {
    rules.push({ pattern, include: false, source: "--exclude" });
  }
  for (const pattern of config.includes) {
    rules.push({ pattern, include: true, source: "--include" });
  }
  return { files, rules };
}

function skipReasonForPath(filePath: string, ignorePlan: IgnorePlan): string | undefined {
  if (generatedOrVendoredPatterns.some((pattern) => pattern.test(filePath))) {
    return "generated, vendored, cache, lockfile, or report path";
  }
  let ignoredBy: string | undefined;
  for (const rule of ignorePlan.rules) {
    if (matchesPattern(filePath, rule.pattern)) {
      ignoredBy = rule.include ? undefined : rule.source;
    }
  }
  return ignoredBy ? `ignored by ${ignoredBy}` : undefined;
}

function filterToConfiguredPaths(files: string[], configuredPaths: string[]): string[] {
  if (configuredPaths.length === 0) {
    return files;
  }
  const prefixes = configuredPaths.map(normalizePath).filter(Boolean);
  return files.filter((file) => {
    const normalized = normalizePath(file);
    return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

async function git(cwd: string, args: string[], purpose: string) {
  const result = await runCommand("git", args, { cwd, timeoutMs: 30_000 });
  return { ...result, command: commandLine("git", args), purpose };
}

function record(result: Awaited<ReturnType<typeof git>>): CommandRecord {
  const outcome = result.code === 0 ? "ok" : `exit ${result.code}: ${trimForRecord(result.stderr)}`;
  return {
    command: result.command,
    result: outcome,
    purpose: result.purpose,
  };
}

function trimForRecord(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function matchesPattern(file: string, pattern: string): boolean {
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
    return normalizedFile.split("/").some((part) => globRegex(normalizedPattern).test(part));
  }
  return globRegex(normalizedPattern).test(normalizedFile);
}

function globRegex(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      index += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }
  return new RegExp(`${out}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
