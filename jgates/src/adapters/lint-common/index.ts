// Shared body of the stack lint adapters (golangci-lint, clippy, .NET analyzers, shellcheck, hadolint). Each adapter
// gives a spec: where its tool lives in the tools image, the exact command for a component or a list of files, and a
// parser of the tool's own output. The plan shows the command; the run executes it in the step container of the tools
// image and turns what the tool reports into located findings. A tool that is missing, a crash, or an output that no
// exit code explains is a blocked or error stage, never a pass. Nothing is rewritten: the linters only read.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { AdapterManifest } from "../../core/catalog/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { findOnPath } from "../../core/bridge/index.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec, substituteTokens, type ExecutionResult } from "../../core/runner/index.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";

export type LintLevel = "error" | "warning" | "info" | "style";

export interface LintDiagnostic {
  /** As the tool printed it (relative to its working folder, or absolute). */
  file: string;
  line?: number | undefined;
  column?: number | undefined;
  ruleId: string;
  level: LintLevel;
  message: string;
}

export interface LintParse {
  ok: boolean;
  diagnostics: LintDiagnostic[];
  /** Why the output cannot be trusted (when not ok). */
  problem?: string;
}

export interface LintCommandPlan {
  /** The tool's own arguments (after the executable and the prefix). */
  args: string[];
  env: Record<string, string>;
  /** Project paths the tool writes next to the project and cannot be redirected (declared so a run does not read them as a change). */
  workspaceWrites?: string[];
  /** What the run needs besides the command (recorded in the plan). */
  contract?: Record<string, unknown>;
  /** The files that decide the behaviour of the tool (hashed into the plan). */
  configFiles?: string[];
}

export interface LintSpec {
  manifest: AdapterManifest;
  /** The name of the tool in findings and messages. */
  tool: string;
  /** The tool of image.json whose version is the tool's. */
  imageTool: string;
  /** The tool of image.json whose command runs it (cargo for clippy, dotnet for the analyzers). */
  commandTool: string;
  /** Arguments that come before the tool's own (`clippy` after cargo). */
  prefix?: string[];
  /** The variable that names another executable, inside the tools image only. */
  overrideEnv: string;
  /** component: the working folder is the component's; workspace: the workspace root, with the files found by the plan. */
  scope: "component" | "workspace";
  executesProjectCode: boolean;
  /** Plans the command for the folder, or says why there is nothing to check. */
  prepare(scanDir: string, componentRoot: string | null): LintCommandPlan | { skip: string };
  parse(stdout: string, stderr: string, exitCode: number | null): LintParse;
  /** Maps what the tool printed to the file path the result stores (default: the path relative to the working folder). */
  normalizePath?(printed: string): string;
}

const WORKSPACE = "{workspace}";
export const RUN_DIR = "{runDir}";

/** Variables a toolchain needs beyond the runner's default allowlist (only used when a step runs natively, inside the image). */
const TOOLCHAIN_ENV = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "WINDIR", "CARGO_HOME", "RUSTUP_HOME", "GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "DOTNET_ROOT", "NUGET_PACKAGES", "NUGET_HTTP_CACHE_PATH"] as const;
const ENV_ALLOWLIST: readonly string[] = [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV];

export const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number.parseInt(v, 10));
export const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Folders no lint pass enters: dependencies, build output, caches and tool state. */
const SKIPPED_FOLDERS = new Set(["node_modules", "vendor", "target", "bin", "obj", "dist", "build", "out", "venv", "__pycache__", "third_party"]);
/** Beyond this many files the command line gets too long to be a reviewable plan: the plan says so instead of cutting the list. */
export const MAX_FILES = 500;

/** The workspace-relative POSIX paths of the files whose name `accept` takes, sorted; the second value tells the list was cut. */
export function findFiles(dir: string, accept: (name: string) => boolean): { files: string[]; tooMany: boolean } {
  const files: string[] = [];
  let tooMany = false;
  const walk = (abs: string, rel: string, depth: number): void => {
    if (tooMany || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      const next = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIPPED_FOLDERS.has(e.name)) continue;
        walk(path.join(abs, e.name), next, depth + 1);
      } else if (e.isFile() && accept(e.name)) {
        if (files.length >= MAX_FILES) {
          tooMany = true;
          return;
        }
        files.push(next);
      }
    }
  };
  walk(dir, "", 0);
  return { files, tooMany };
}

interface ToolProbe {
  executable: string | null;
  /** Arguments before the tool's own: the script, when the override is a Node script that stands for the tool. */
  prefix: string[];
  version: string | null;
  problem: "not_found" | null;
  detail: string;
}

/** Whether the tool is in the tools image, and its version, from image.json (nothing starts). */
export function probeLintTool(spec: Pick<LintSpec, "imageTool" | "commandTool" | "overrideEnv">, env: NodeJS.ProcessEnv): ToolProbe {
  const named = inImageOverride(env, spec.overrideEnv);
  if (named !== null) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, problem: "not_found", detail: named };
    // The version is the image catalogue's: an override is asked nothing, so a stand-in script needs no version flag.
    const version = probeImageTool(spec.imageTool, env).version ?? "0.0.0";
    return /\.(?:mjs|cjs|js)$/i.test(abs) ? { executable: process.execPath, prefix: [abs], version, problem: null, detail: "" } : { executable: abs, prefix: [], version, problem: null, detail: "" };
  }
  const tool = probeImageTool(spec.imageTool, env);
  if (tool.problem !== null) return { executable: null, prefix: [], version: null, problem: "not_found", detail: tool.detail };
  const command = probeImageTool(spec.commandTool, env);
  if (command.problem !== null || command.executable === null) return { executable: null, prefix: [], version: null, problem: "not_found", detail: command.detail };
  return { executable: command.executable, prefix: [], version: tool.version, problem: null, detail: "" };
}

/** A path the tool printed as the workspace-relative POSIX path the result stores. `cwd` is the working folder as the tool sees it. */
export function workspaceRelative(printed: string, workspace: string, cwd: string): string {
  const file = printed.replace(/^(?:\\\\\?\\|\/\/\?\/)(?=[A-Za-z]:)/, "");
  const abs = path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? path.resolve(file) : path.resolve(cwd, file);
  const rel = path.relative(path.resolve(workspace), abs).split(path.sep).join("/");
  return rel.startsWith("..") ? abs.split(path.sep).join("/") : rel;
}

const SEVERITY: Record<LintLevel, "high" | "medium" | "low"> = { error: "high", warning: "medium", info: "low", style: "low" };

export function toFindings(spec: LintSpec, diagnostics: LintDiagnostic[], opts: { stageId: string; version: string | null; workspace: string; cwd: string }): ResultFinding[] {
  const seen = new Set<string>();
  const out: ResultFinding[] = [];
  for (const d of diagnostics) {
    const printed = spec.normalizePath ? spec.normalizePath(d.file) : d.file;
    const file = workspaceRelative(printed, opts.workspace, opts.cwd);
    const key = `${file}:${d.line ?? 0}:${d.column ?? 0}:${d.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      stageId: opts.stageId,
      tool: spec.tool,
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: d.ruleId,
      category: "lint",
      severity: d.level,
      normalizedSeverity: SEVERITY[d.level],
      message: d.message,
      location: { path: file, ...(d.line !== undefined ? { line: d.line } : {}), ...(d.column !== undefined ? { column: d.column } : {}) },
      fingerprint: contentHash({ tool: spec.tool, rule: d.ruleId, file, message: d.message }),
      origin: spec.manifest.id,
      blocking: true,
      blockingReason: "blocking-tool" as const,
      waived: false,
    });
  }
  return out;
}

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");

export function makeLintAdapter(spec: LintSpec): ExternalAdapter {
  const ADAPTER_ID = spec.manifest.id;

  function plan(input: ExternalPlanInput): ExternalPlan {
    const t = translator("lint-stacks");
    const root = spec.scope === "component" && input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
    const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
    const probe = probeLintTool(spec, input.env);
    const prepared = spec.prepare(scanDir, root);
    const command = "skip" in prepared ? { args: [], env: {} as Record<string, string> } : prepared;

    let availability: ExternalPlan["availability"];
    if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("lint_missing", { tool: spec.tool, detail: probe.detail }) };
    else if (probe.version !== null && satisfiesRange(probe.version, spec.manifest.toolVersionRange) !== true) {
      availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: spec.tool, version: probe.version, range: spec.manifest.toolVersionRange, what: ADAPTER_ID }) };
    } else if ("skip" in prepared) availability = { status: "unavailable", reason: prepared.skip };
    else availability = { status: "available", reason: null };

    const executable = probe.executable ?? spec.commandTool;
    return {
      label: t(`lint_label_${ADAPTER_ID}`),
      command: {
        executable,
        args: [...probe.prefix, ...(spec.prefix ?? []), ...command.args],
        cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
        env: command.env,
        stdin: null,
      },
      runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
      toolVersion: probe.version,
      configFiles: (command.configFiles ?? []).map((file) => ({ file: root ? `${root}/${file}` : file, sha256: sha256File(path.join(scanDir, file)) })),
      availability,
      blocksPlan: false,
      network: false,
      limitations: [t(`lint_limitation_${ADAPTER_ID}`)],
      conditions: [t("lint_condition_read_only")],
      // A tool the image lacks is the shared "tools image" cause, not an install offer.
      imageTool: spec.imageTool,
      contract: { tool: spec.tool, ...(command.contract ?? {}) },
      output: { format: "text", schema: null },
      effects: { executesProjectCode: spec.executesProjectCode, workspaceWrites: command.workspaceWrites ?? [] },
    };
  }

  async function run(context: AdapterContext, planDoc: Plan, tool: string): Promise<AdapterOutput> {
    const t = translator("lint-stacks");
    const invocation = planDoc.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
    const items = planDoc.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
    if (!invocation || items.length === 0) throw new Error(t("lint_no_invocation", { tool }));

    const tokens = { runDir: context.runDir, workspace: context.workspacePath };
    const command = invocation.command;
    const cwd = substituteTokens(command.cwd, tokens);
    const args = command.args.map((a) => substituteTokens(a, tokens));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
    // Caches the plan redirects into the run folder exist before the tool starts.
    for (const value of [...Object.values(env), ...args]) if (value.startsWith(context.runDir)) fs.mkdirSync(value, { recursive: true });
    const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
    const version = items[0]?.versions.toolVersion ?? null;

    const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
    const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

    const stageFor = (item: PlanItem, state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({
      id: item.id,
      label: item.label,
      kind: "step",
      adapter: ADAPTER_ID,
      state,
      ...(reason ? { reason } : {}),
      ...extra,
    });
    const base = {
      requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
      disabled: [],
      logs: [] as string[],
      outputs: [relToRun(context.runDir, outDir)],
    };
    const blockedAll = (reason: string): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, "blocked", reason)), findings: [] });

    const unavailable = items.find((i) => i.availability.status !== "available");
    if (unavailable) return blockedAll(unavailable.availability.reason ?? t("lint_blocked", { tool: spec.tool, detail: command.executable }));

    const result: ExecutionResult = await runSpec(
      { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
      { parentEnv: context.env, envAllowlist: ENV_ALLOWLIST },
    );
    base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

    if (result.spawnError) return { ...blockedAll(t("lint_blocked", { tool: spec.tool, detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
    if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("lint_cancelled", { tool: spec.tool }))), findings: [] };
    if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("lint_timeout", { tool: spec.tool, seconds: timeoutSeconds }))), findings: [] };

    fs.writeFileSync(path.join(outDir, `${spec.tool}.txt`), `${result.stdout}${result.stderr === "" ? "" : `\n--- stderr ---\n${result.stderr}`}`, { mode: 0o600 });
    const parsed = spec.parse(result.stdout, result.stderr, result.exitCode);
    if (!parsed.ok || result.truncated) {
      const detail = result.truncated ? "output truncated" : `${parsed.problem ?? ""} ${tail(result.stderr || result.stdout)}`.trim();
      return { ...base, stages: items.map((i) => stageFor(i, "error", t("lint_exit_error", { tool: spec.tool, code: result.exitCode ?? "-", detail: detail || String(result.signal ?? "") }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` })), findings: [] };
    }
    const view = (p: string): string => stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, p);
    const findings = toFindings(spec, parsed.diagnostics, { stageId: items[0]?.id as string, version, workspace: view(context.workspacePath), cwd: view(cwd) });
    const reason = t("lint_reason_completed", { tool: spec.tool, version: version ?? "?", count: findings.length });
    return {
      ...base,
      stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: findings.length, findings: findings.length, nativeStatus: `exit ${result.exitCode}` })),
      findings,
    };
  }

  return { manifest: spec.manifest, plan, run };
}

/** exit-code gate shared by the parsers: the exit code and the list must agree, or the output is not trusted. */
export function conclude(diagnostics: LintDiagnostic[], exitCode: number | null, clean: number[], dirty: number[]): LintParse {
  if (exitCode !== null && clean.includes(exitCode)) return diagnostics.length === 0 ? { ok: true, diagnostics } : { ok: false, diagnostics: [], problem: `exit ${exitCode} but ${diagnostics.length} finding(s) are listed` };
  if (exitCode !== null && dirty.includes(exitCode)) return diagnostics.length > 0 ? { ok: true, diagnostics } : { ok: false, diagnostics: [], problem: `exit ${exitCode} but no finding was listed` };
  return { ok: false, diagnostics: [], problem: `unexpected exit ${exitCode ?? "-"}` };
}
