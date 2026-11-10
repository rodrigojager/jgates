// Build and type-check adapter: one tool instance per checker (tsc, mypy, pyright, go, cargo, dotnet). The plan lists
// every unit (discovered component) the instance checks, with the exact command of each, and the units it skips with
// the reason; the run executes those commands with the project's own configuration and normalizes the diagnostics into
// located findings. A checker that is missing, a crash, or an exit code that no located error explains is a blocked or
// error stage, never a pass. The toolchains are the customer's; the run never installs or downloads one.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec, substituteTokens } from "../../core/runner/index.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";
import { buildCheckManifest } from "./manifest.js";
import { parseCargo, parseDotnet, parseGo, parseMypy, parsePyright, parseTsc, toFindings, type DiagnosticParse } from "./normalize.js";
import { CHECKERS, probeChecker, type Checker } from "./probe.js";
import { planUnits, type BuildUnit, type SkippedUnit, type UnitSettings } from "./units.js";

export { buildCheckManifest } from "./manifest.js";
export { parseCargo, parseDotnet, parseGo, parseMypy, parsePyright, parseTsc } from "./normalize.js";
export { CHECKERS, probeChecker } from "./probe.js";
export { planUnits, pythonConfig } from "./units.js";

const ADAPTER_ID = buildCheckManifest.id;
const WORKSPACE = "{workspace}";

/** Variables a toolchain needs beyond the runner's default allowlist (program folders, caches, toolchain homes). */
const TOOLCHAIN_ENV = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "WINDIR", "CARGO_HOME", "RUSTUP_HOME", "GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "DOTNET_ROOT", "NUGET_PACKAGES", "NUGET_HTTP_CACHE_PATH", "VIRTUAL_ENV"] as const;
const ENV_ALLOWLIST: readonly string[] = [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV];

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface BuildCheckSettings {
  checker: Checker | null;
  tsconfig: string | null;
  /**
   * mypy only. "skip" (default): a Python component without a mypy configuration is not checked. "defaults": it is
   * checked with mypy's defaults (missing third-party stubs ignored), unless it configures pyright instead.
   */
  withoutConfig: "skip" | "defaults";
  /** What the instance wrote that is not valid; the plan refuses it instead of guessing. */
  problems: string[];
}

const WITHOUT_CONFIG = ["skip", "defaults"] as const;

/** A relative path that stays inside its root. */
function safeRelative(value: string): boolean {
  if (value === "" || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.replace(/\\/g, "/").split("/");
  return !parts.includes("..") && !parts.some((p) => p === "");
}

/** Reads and validates checker and tsconfig of the instance (tools.<id> in .jgates/tools.yml or in a template). */
export function buildCheckSettings(input: Pick<ExternalPlanInput, "config" | "tool">): BuildCheckSettings {
  const t = translator("build-check");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const raw = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  // A template carries the settings under `config` (its schema allows nothing else); tools.yml writes them next to the adapter.
  const body: Record<string, unknown> = { ...(isRec(raw.config) ? raw.config : {}), ...Object.fromEntries(Object.entries(raw).filter(([k]) => k === "checker" || k === "tsconfig" || k === "withoutConfig")) };
  const problems: string[] = [];
  let checker: Checker | null = null;
  if (typeof body.checker === "string" && (CHECKERS as readonly string[]).includes(body.checker)) checker = body.checker as Checker;
  else problems.push(t("build_check_setting_checker", { tool: input.tool, value: String(body.checker ?? "-"), allowed: CHECKERS.join(", ") }));
  let tsconfig: string | null = null;
  if (body.tsconfig !== undefined) {
    if (typeof body.tsconfig === "string" && safeRelative(body.tsconfig)) tsconfig = body.tsconfig.replace(/\\/g, "/");
    else problems.push(t("build_check_setting_tsconfig", { tool: input.tool, value: String(body.tsconfig) }));
  }
  let withoutConfig: BuildCheckSettings["withoutConfig"] = "skip";
  if (body.withoutConfig !== undefined) {
    if (typeof body.withoutConfig === "string" && (WITHOUT_CONFIG as readonly string[]).includes(body.withoutConfig)) withoutConfig = body.withoutConfig as BuildCheckSettings["withoutConfig"];
    else problems.push(t("build_check_setting_without_config", { tool: input.tool, value: String(body.withoutConfig), allowed: WITHOUT_CONFIG.join(", ") }));
  }
  return { checker, tsconfig, withoutConfig, problems };
}

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** dotnet build writes bin/ and obj/ next to the project file; cargo check may write Cargo.lock; the others write nothing. */
function workspaceWritesOf(checker: Checker, units: BuildUnit[]): string[] {
  const at = (root: string, name: string) => (root === "." ? name : `${root}/${name}`);
  if (checker === "dotnet") return units.flatMap((u) => [at(u.root, "bin"), at(u.root, "obj")]);
  if (checker === "cargo") return units.map((u) => at(u.root, "Cargo.lock"));
  return [];
}

const commandLine =(executable: string, args: string[]): string => [path.basename(executable), ...args].join(" ");

function planBuildCheck(input: ExternalPlanInput): ExternalPlan {
  const t = translator("build-check");
  const settings = buildCheckSettings(input);
  const governed = input.policyDir !== undefined;
  const checker = settings.checker ?? "tsc";
  const unitSettings: UnitSettings = { checker: settings.checker, tsconfig: settings.tsconfig, withoutConfig: settings.withoutConfig };
  const plan = settings.problems.length > 0 ? { units: [] as BuildUnit[], skipped: [] as SkippedUnit[] } : planUnits({ dir: input.dir, env: input.env, checker, componentRoot: input.componentRoot, settings: unitSettings, skipWorkspace: governed });

  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  const missing = plan.units.filter((u) => !u.available);
  if (settings.problems.length > 0) {
    // A setting that is not valid never falls back to a default silently.
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (plan.units.length === 0) {
    availability = { status: "unavailable", reason: t("build_check_no_units", { checker, skipped: plan.skipped.map((s) => `${s.root} (${s.reason})`).join("; ") || "-" }) };
  } else if (missing.length > 0) {
    availability = { status: "unavailable", reason: [...new Set(missing.map((u) => u.reason))].join(" ") };
  } else availability = { status: "available", reason: null };

  const first = plan.units[0];
  const firstStep = first?.steps[0];
  const conditions = [
    ...plan.units.map((u) => t("build_check_condition_unit", { unit: u.component, root: u.root, language: u.language, commands: u.steps.length > 0 ? u.steps.map((s) => commandLine(s.executable, s.args)).join(" && ") : u.checker })),
    ...plan.skipped.map((s) => t("build_check_condition_skipped", { unit: s.component, root: s.root, language: s.language, reason: s.reason })),
  ];
  const projectCode = checker === "cargo" || checker === "dotnet" || checker === "mypy";
  const cwdRoot = first && first.root !== "." ? first.root : null;
  return {
    label: t(`build_check_label_${checker}`),
    command: {
      executable: firstStep?.executable ?? checker,
      args: firstStep ? [...firstStep.args] : [],
      cwd: cwdRoot ? `${WORKSPACE}/${cwdRoot}` : WORKSPACE,
      env: firstStep ? { ...firstStep.env } : {},
      stdin: null,
    },
    runtime: { name: "native", interpreter: firstStep?.executable ?? null, available: plan.units.length > 0 && missing.length === 0 },
    toolVersion: first?.version ?? null,
    configFiles: plan.units.filter((u) => u.config !== "").map((u) => ({ file: u.config, sha256: sha256File(path.resolve(input.dir, u.config)) })),
    availability,
    blocksPlan,
    network: false,
    limitations: [t(`build_check_limitation_${checker}`)],
    conditions,
    // The units and their commands decide what is checked; they are part of the reviewed plan.
    contract: { checker, tsconfig: settings.tsconfig, units: plan.units, skipped: plan.skipped },
    output: { format: "text", schema: null },
    // What the toolchain writes next to the project and cannot be redirected (declared so the run does not read it as a change).
    effects: { executesProjectCode: projectCode, workspaceWrites: workspaceWritesOf(checker, plan.units) },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const slug = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");

function parseStep(checker: Checker, step: string, stdout: string, stderr: string, exitCode: number | null): DiagnosticParse {
  switch (checker) {
    case "tsc":
      return parseTsc(stdout, exitCode);
    case "mypy":
      return parseMypy(stdout, exitCode);
    case "pyright":
      return parsePyright(stdout, exitCode);
    case "go":
      return parseGo(`${stderr}\n${stdout}`, exitCode, step === "vet" ? "go-vet" : "go-build");
    case "cargo":
      return parseCargo(stdout, exitCode);
    case "dotnet":
      return parseDotnet(stdout, exitCode);
  }
}

async function runBuildCheck(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("build-check");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("build_check_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const contract = (invocation.contract ?? {}) as { checker?: Checker; units?: BuildUnit[]; skipped?: SkippedUnit[] };
  const checker = contract.checker ?? "tsc";
  const units = contract.units ?? [];
  const skipped = contract.skipped ?? [];
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

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
  const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, state, reason, extra)), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("build_check_blocked", { detail: checker }));
  if (units.length === 0) return all("blocked", t("build_check_no_units", { checker, skipped: skipped.map((s) => `${s.root} (${s.reason})`).join("; ") || "-" }));

  const findings: ResultFinding[] = [];
  let version: string | null = items[0]?.versions.toolVersion ?? null;
  let problem: { state: ResultStage["state"]; reason: string; extra: Partial<ResultStage> } | null = null;
  const note = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}) => {
    if (problem === null) problem = { state, reason, extra };
  };

  for (const unit of units) {
    version = unit.version ?? version;
    const cwd = unit.root === "." ? context.workspacePath : path.join(context.workspacePath, ...unit.root.split("/"));
    let previousClean = true;
    for (const step of unit.steps) {
      if (step.onlyAfterClean && !previousClean) continue;
      const args = step.args.map((a) => substituteTokens(a, tokens));
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(step.env)) env[name] = substituteTokens(value, tokens);
      // Caches and target folders live in the run folder; they must exist before the checker starts.
      for (const value of [...Object.values(env), ...args]) if (value.startsWith(context.runDir)) fs.mkdirSync(value, { recursive: true });
      const stem = `${tool}.${slug(unit.component)}.${step.id}`;
      const stdoutLog = path.join(context.logsDir, `${stem}.stdout.log`);
      const stderrLog = path.join(context.logsDir, `${stem}.stderr.log`);
      const result = await runSpec({ executable: step.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog }, { parentEnv: context.env, envAllowlist: ENV_ALLOWLIST });
      base.logs.push(relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog));

      if (result.spawnError) {
        note("blocked", t("build_check_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` }));
        break;
      }
      // Only the run-owned process is stopped; what the checker wrote before stays in the logs as partial evidence.
      if (result.cancelled) return { ...all("cancelled", t("build_check_cancelled")), logs: base.logs };
      if (result.timedOut) {
        note("timeout", t("build_check_timeout", { seconds: timeoutSeconds, unit: unit.component }));
        break;
      }
      const parsed = parseStep(checker, step.id, result.stdout, result.stderr, result.exitCode);
      if (!parsed.ok || result.truncated) {
        const detail = result.truncated ? "output truncated" : `${parsed.problem ?? ""} ${tail(result.stderr)}`.trim();
        note("error", t("build_check_exit_error", { unit: unit.component, tool: step.label, code: result.exitCode ?? "-", detail: detail || String(result.signal ?? "") }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` });
        break;
      }
      findings.push(...toFindings(parsed.diagnostics, { stageId: items[0]?.id as string, checker, version: unit.version, workspace: stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, context.workspacePath), unitRoot: unit.root, step: step.id }));
      previousClean = result.exitCode === 0;
    }
  }

  const failed = problem as { state: ResultStage["state"]; reason: string; extra: Partial<ResultStage> } | null;
  if (failed !== null) return { ...all(failed.state, failed.reason, failed.extra), findings: [], logs: base.logs };
  // Distinct fingerprints only: go vet and go build can report the same diagnostic.
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = f.fingerprint ?? "";
    if (key !== "" && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const blocking = unique.filter((f) => f.blocking).length;
  const reason = t("build_check_reason_completed", { tool: checker, version: version ?? "?", units: units.length, count: unique.length, blocking, skipped: skipped.length });
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: unique.length, nativeStatus: blocking > 0 ? "diagnostics" : "clean" })),
    findings: unique,
  };
}

export const buildCheckAdapter: ExternalAdapter = {
  manifest: buildCheckManifest,
  plan: planBuildCheck,
  run: runBuildCheck,
};
