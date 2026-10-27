// External PII tools: defined once in .jgates/pii.yml (`tools`) and used by name by the masking of the semantic-gate
// context (mode `context`) and by the check and the correction of project files (modes `check` and `fix`).
// The protocol is the same in every use: JGates writes a copy of the files in a temporary folder (never the project),
// with the same tree of relative paths, runs the tool without a shell with that folder as working directory and in
// JGATES_MASK_DIR, lists the files in JGATES_MASK_FILES (one relative path per line, outside the folder) and says the use
// in JGATES_MASK_MODE. The tool edits the files in place and prints one JSON status line
// (schemas/pii/mask-tool-status.schema.json). JGates then checks the folder against the status: only listed files may
// change, nothing is created, removed or turned into a link, `changed` matches what changed, and in check mode nothing
// changes at all. Anything else fails closed: the caller gets a code and a reason, never a partial result.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { resolveExecutable } from "../runner/preflight.js";
import { emptyCounts, maskText, strictMaskRules } from "../../adapters/semantic-gate/mask.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec } from "../runner/process.js";
import { resolveSecret, SecretsError } from "../secrets/index.js";

export type MaskMode = "context" | "check" | "fix";
export const MASK_MODES: readonly MaskMode[] = ["context", "check", "fix"];

/** Where the tools are defined, relative to the configuration folder (the project, or the policy in governed mode). */
export const PII_CONFIG_FILE = ".jgates/pii.yml";
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 60;
/** The status line and anything the tool prints before it; more than this is not a status line. */
const MAX_STDOUT_BYTES = 1024 * 1024;

export const TOOL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const COUNT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface MaskToolDefinition {
  id: string;
  command: string;
  args: string[];
  timeoutSeconds: number;
  /** Environment variables (names) passed from the parent on top of the basic allowlist; a name missing there comes from the user key store (core/secrets). */
  passEnv: string[];
}

export interface MaskToolStatus {
  jgatesMask: 1;
  status: "ok" | "error";
  detected: boolean;
  changed: boolean;
  counts?: Record<string, number>;
  files?: string[];
  message?: string;
}

/** MASKING_COMMAND_FAILED: the tool or its status cannot be trusted. MASKING_UNRESOLVED: it found data it did not treat. */
export type MaskFailureCode = "MASKING_COMMAND_FAILED" | "MASKING_UNRESOLVED";

export type MaskToolOutcome =
  | { ok: true; tool: string; status: MaskToolStatus; changedFiles: string[]; durationMs: number }
  | { ok: false; tool: string; code: MaskFailureCode; reason: string; status?: MaskToolStatus; durationMs: number };

// ---- the definitions (.jgates/pii.yml > tools) -------------------------------------------------------------------------

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface MaskToolsFile {
  /** Whether the file exists. */
  present: boolean;
  tools: Map<string, MaskToolDefinition>;
  /** Problems with the field path (`.jgates/pii.yml: tools.<id>.<field> ...`). */
  problems: string[];
}

/** Reads the tool definitions of a configuration folder. Never throws: problems carry the file and the field path. */
export function readMaskTools(configDir: string): MaskToolsFile {
  const out: MaskToolsFile = { present: false, tools: new Map(), problems: [] };
  let doc: unknown;
  try {
    const text = fs.readFileSync(path.join(configDir, PII_CONFIG_FILE), "utf8");
    out.present = true;
    doc = parseYaml(text) as unknown;
  } catch (error) {
    if (out.present) out.problems.push(`${PII_CONFIG_FILE}: cannot be read (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    return out;
  }
  if (doc === null || doc === undefined) return out;
  if (!isRec(doc)) {
    out.problems.push(`${PII_CONFIG_FILE}: must be a mapping`);
    return out;
  }
  const tools = doc.tools;
  if (tools === undefined || tools === null) return out;
  const where = (...segments: string[]): string => `${PII_CONFIG_FILE}: ${["tools", ...segments].join(".")}`;
  if (!isRec(tools)) {
    out.problems.push(`${where()} must be a mapping of tool ids`);
    return out;
  }
  for (const [id, raw] of Object.entries(tools)) {
    if (!TOOL_ID.test(id)) {
      out.problems.push(`${where(id)} is not a valid tool id (lowercase letters, digits, ".", "_" and "-")`);
      continue;
    }
    if (!isRec(raw)) {
      out.problems.push(`${where(id)} must be a mapping`);
      continue;
    }
    const before = out.problems.length;
    for (const key of Object.keys(raw)) {
      if (!["command", "args", "timeoutSeconds", "passEnv", "description"].includes(key)) out.problems.push(`${where(id, key)} is not a known option`);
    }
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (command === "") out.problems.push(`${where(id, "command")} must be a non-empty string`);
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) out.problems.push(`${where(id, "args")} must be a list of strings`);
    const timeout = raw.timeoutSeconds === undefined ? DEFAULT_TOOL_TIMEOUT_SECONDS : raw.timeoutSeconds;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 3600) out.problems.push(`${where(id, "timeoutSeconds")} must be an integer from 1 to 3600`);
    const passEnv = raw.passEnv === undefined ? [] : raw.passEnv;
    if (!Array.isArray(passEnv) || passEnv.some((n) => typeof n !== "string" || !ENV_NAME.test(n))) out.problems.push(`${where(id, "passEnv")} must be a list of environment variable names`);
    if (out.problems.length > before) continue;
    // The tool runs in the copy, so a relative path would not point at the project: {configDir} names the folder of the
    // configuration (the project, or the policy in governed mode).
    const base = path.resolve(configDir);
    const expand = (text: string): string => text.split("{configDir}").join(base);
    out.tools.set(id, { id, command: expand(command), args: (args as string[]).map(expand), timeoutSeconds: timeout as number, passEnv: [...new Set(passEnv as string[])] });
  }
  return out;
}

// ---- the temporary copy ------------------------------------------------------------------------------------------------

/** A relative path safe to write under the copy: "/" separators, no absolute path, no "." or ".." segment. */
export function safeRelativePath(file: string): string | null {
  const normalized = file.replaceAll("\\", "/");
  if (normalized === "" || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.join("/");
}

export interface MaskWorkspace {
  /** The folder the tool works in (JGATES_MASK_DIR). */
  dir: string;
  /** The file list (JGATES_MASK_FILES), outside `dir`. */
  listFile: string;
  /** Every file written, relative with "/", sorted. */
  files: string[];
  read(file: string): Buffer;
  readText(file: string): string;
  /** Removes the copy; safe to call more than once. */
  cleanup(): void;
}

/** Writes the copy (0700 folders, 0600 files) in a new temporary folder. Throws on an unsafe or repeated path. */
export function createMaskWorkspace(entries: ReadonlyArray<{ path: string; content: string | Buffer }>, options: { tmpDir?: string } = {}): MaskWorkspace {
  const root = fs.mkdtempSync(path.join(options.tmpDir ?? os.tmpdir(), "jgates-mask-"));
  fs.chmodSync(root, 0o700);
  const dir = path.join(root, "files");
  const listFile = path.join(root, "files.txt");
  const cleanup = (): void => fs.rmSync(root, { recursive: true, force: true });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    const files: string[] = [];
    for (const entry of entries) {
      const rel = safeRelativePath(entry.path);
      if (rel === null) throw new Error(`unsafe path for the copy: ${JSON.stringify(entry.path)}`);
      if (files.includes(rel)) throw new Error(`repeated path for the copy: ${rel}`);
      const target = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, entry.content, { mode: 0o600, flag: "wx" });
      files.push(rel);
    }
    files.sort();
    writeList(listFile, files);
    return {
      dir,
      listFile,
      files,
      read: (file) => fs.readFileSync(path.join(dir, ...file.split("/"))),
      readText: (file) => fs.readFileSync(path.join(dir, ...file.split("/")), "utf8"),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function writeList(listFile: string, files: readonly string[]): void {
  fs.writeFileSync(listFile, files.length > 0 ? `${files.join("\n")}\n` : "", { mode: 0o600 });
}

// ---- the check of what the tool did ------------------------------------------------------------------------------------

export interface TreeEntry {
  kind: "file" | "link" | "other";
  sha256: string | null;
}

/** Every entry under `dir` (folders are walked, not listed), without following links. */
export function snapshotTree(dir: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) out.set(childRel, { kind: "link", sha256: null });
      else if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.set(childRel, { kind: "file", sha256: crypto.createHash("sha256").update(fs.readFileSync(childAbs)).digest("hex") });
      else out.set(childRel, { kind: "other", sha256: null });
    }
  };
  walk(dir, "");
  return out;
}

export interface TreeDiff {
  modified: string[];
  added: string[];
  removed: string[];
  /** Entries that are not regular files (links, sockets...). */
  notFiles: string[];
}

export function diffTrees(before: Map<string, TreeEntry>, after: Map<string, TreeEntry>): TreeDiff {
  const diff: TreeDiff = { modified: [], added: [], removed: [], notFiles: [] };
  for (const [rel, entry] of after) {
    if (entry.kind !== "file") diff.notFiles.push(rel);
    const old = before.get(rel);
    if (!old) diff.added.push(rel);
    else if (old.kind === "file" && entry.kind === "file" && old.sha256 !== entry.sha256) diff.modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) diff.removed.push(rel);
  for (const list of Object.values(diff)) (list as string[]).sort();
  return diff;
}

type AjvValidate = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
type AjvCtor = new (opts: object) => { compile(schema: object): AjvValidate };
const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;
let statusValidator: AjvValidate | null = null;

/** jgates/schemas/pii/mask-tool-status.schema.json, found from dist/core/mask-tools (and src/core/mask-tools). */
export function maskStatusSchemaPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas", "pii", "mask-tool-status.schema.json");
}

function validateStatus(value: unknown): string | null {
  if (!statusValidator) {
    const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    statusValidator = ajv.compile(JSON.parse(fs.readFileSync(maskStatusSchemaPath(), "utf8")) as object);
  }
  if (statusValidator(value)) return null;
  const first = statusValidator.errors?.[0];
  return first ? `${first.instancePath || "(root)"} ${first.message ?? "is invalid"}` : "does not match the schema";
}

/** The status line: the last stdout line that is a JSON object with `jgatesMask`, validated against the schema. */
export function parseMaskStatus(stdout: string): { status: MaskToolStatus } | { error: string } {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRec(value) || !("jgatesMask" in value)) continue;
    const problem = validateStatus(value);
    if (problem) return { error: `the status line is invalid: ${problem}` };
    return { status: value as unknown as MaskToolStatus };
  }
  return { error: "the tool printed no status line (a JSON object with jgatesMask)" };
}

/**
 * Whether a status agrees with what the folder shows. Returns the first inconsistency, or null.
 * `listed` is what JGATES_MASK_FILES named: only those may change.
 */
export function checkConsistency(mode: MaskMode, status: MaskToolStatus, diff: TreeDiff, listed: readonly string[]): string | null {
  const allowed = new Set(listed);
  if (diff.notFiles.length > 0) return `the folder holds a link or a special file (${diff.notFiles.length})`;
  if (diff.added.length > 0) return `the tool created ${diff.added.length} file(s)`;
  if (diff.removed.length > 0) return `the tool removed ${diff.removed.length} file(s)`;
  const outside = diff.modified.filter((f) => !allowed.has(f));
  if (outside.length > 0) return `the tool changed ${outside.length} file(s) outside the list`;
  if (status.files?.some((f) => !allowed.has(f))) return "the status names a file outside the list";
  const changed = diff.modified.length > 0;
  if (mode === "check" && (changed || status.changed)) return "check mode allows no change";
  if (status.changed !== changed) return status.changed ? "the status says changed but no file changed" : `the status says not changed but ${diff.modified.length} file(s) changed`;
  if (status.changed && !status.detected) return "the status says changed but nothing detected";
  const total = Object.values(status.counts ?? {}).reduce((a, b) => a + b, 0);
  if (!status.detected && total > 0) return "the status counts findings but says nothing detected";
  if (status.files && changed && diff.modified.some((f) => !status.files?.includes(f))) return "a changed file is missing from the status files";
  return null;
}

/** Tool text can echo what it found: mask the built-in shapes and secrets before it is shown, then shorten. */
const shortText = (text: string): string => {
  const rules = strictMaskRules();
  return maskText(text, emptyCounts(rules), rules).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
};

export interface RunMaskToolOptions {
  mode: MaskMode;
  /** The files the tool may change (default: every file of the copy). */
  files?: readonly string[];
  parentEnv?: NodeJS.ProcessEnv;
  /**
   * A name of passEnv missing from parentEnv comes from the user's key store (default true). The value goes to this
   * tool only; a name the tool does not declare never reaches it. The store is never read once blockVault() ran.
   */
  vault?: boolean;
  signal?: AbortSignal;
  /** Between SIGTERM and SIGKILL when the tool is stopped (tests shorten it). */
  killGraceMs?: number;
}

/** Runs one tool on the copy and checks it. Never throws. */
export async function runMaskTool(tool: MaskToolDefinition, workspace: MaskWorkspace, options: RunMaskToolOptions): Promise<MaskToolOutcome> {
  const started = Date.now();
  const fail = (code: MaskFailureCode, reason: string, status?: MaskToolStatus): MaskToolOutcome => ({
    ok: false,
    tool: tool.id,
    code,
    reason: `${tool.id}: ${reason}`,
    ...(status ? { status } : {}),
    durationMs: Date.now() - started,
  });
  try {
    const listed = [...(options.files ?? workspace.files)].sort();
    writeList(workspace.listFile, listed);
    const parentEnv = options.parentEnv ?? process.env;
    const executable = resolveExecutable(tool.command, parentEnv);
    if (!executable) return fail("MASKING_COMMAND_FAILED", `the command ${JSON.stringify(tool.command)} was not found`);
    const passed: Record<string, string> = {};
    for (const name of tool.passEnv) {
      const value = parentEnv[name];
      if (value !== undefined) {
        passed[name] = value;
        continue;
      }
      let stored: ReturnType<typeof resolveSecret>;
      try {
        stored = resolveSecret(name, { env: parentEnv, vault: options.vault !== false });
      } catch (error) {
        return fail("MASKING_COMMAND_FAILED", error instanceof SecretsError ? error.message : "the user key store cannot be read");
      }
      if (stored) passed[name] = stored.value;
    }
    const before = snapshotTree(workspace.dir);
    const result = await runSpec(
      {
        executable,
        args: [...tool.args],
        cwd: workspace.dir,
        env: { ...passed, JGATES_MASK_DIR: workspace.dir, JGATES_MASK_FILES: workspace.listFile, JGATES_MASK_MODE: options.mode },
        stdin: null,
        timeoutMs: tool.timeoutSeconds * 1000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      { parentEnv, envAllowlist: DEFAULT_ENV_ALLOWLIST, maxOutputBytes: MAX_STDOUT_BYTES, ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}) },
    );
    if (result.spawnError) return fail("MASKING_COMMAND_FAILED", `the command could not start (${result.spawnError.code})`);
    if (result.cancelled) return fail("MASKING_COMMAND_FAILED", "cancelled");
    if (result.timedOut) return fail("MASKING_COMMAND_FAILED", `no answer within ${tool.timeoutSeconds} s`);
    if (result.exitCode !== 0) return fail("MASKING_COMMAND_FAILED", `exited with ${result.exitCode === null ? `signal ${result.signal ?? "?"}` : `code ${result.exitCode}`}`);
    if (result.truncated) return fail("MASKING_COMMAND_FAILED", "the output is larger than the limit");
    const parsed = parseMaskStatus(result.stdout);
    if ("error" in parsed) return fail("MASKING_COMMAND_FAILED", parsed.error);
    const status = parsed.status;
    if (status.status === "error") return fail("MASKING_COMMAND_FAILED", `the tool reported an error${status.message ? `: ${shortText(status.message)}` : ""}`, status);
    const diff = diffTrees(before, snapshotTree(workspace.dir));
    const inconsistent = checkConsistency(options.mode, status, diff, listed);
    if (inconsistent) return fail("MASKING_COMMAND_FAILED", `inconsistent status: ${inconsistent}`, status);
    if (options.mode !== "check" && status.detected && !status.changed) return fail("MASKING_UNRESOLVED", "the tool detected sensitive data and changed nothing", status);
    return { ok: true, tool: tool.id, status, changedFiles: diff.modified, durationMs: Date.now() - started };
  } catch (error) {
    return fail("MASKING_COMMAND_FAILED", shortText(error instanceof Error ? error.message : String(error)));
  }
}

/** Runs the tools in order, each one on the result of the previous; stops at the first failure. */
export async function runMaskTools(tools: readonly MaskToolDefinition[], workspace: MaskWorkspace, options: RunMaskToolOptions): Promise<{ ok: boolean; outcomes: MaskToolOutcome[] }> {
  const outcomes: MaskToolOutcome[] = [];
  for (const tool of tools) {
    const outcome = await runMaskTool(tool, workspace, options);
    outcomes.push(outcome);
    if (!outcome.ok) return { ok: false, outcomes };
  }
  return { ok: true, outcomes };
}

/** The counts of the tools, summed per label. */
export function sumToolCounts(outcomes: readonly MaskToolOutcome[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of outcomes) for (const [label, n] of Object.entries(o.status?.counts ?? {})) out[label] = (out[label] ?? 0) + n;
  return out;
}
