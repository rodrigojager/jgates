// oasdiff adapter: plans one `oasdiff breaking <base> <spec> --format json` per tool instance (the OpenAPI specification
// of the scan root against a reference revision or file; the level of a change is kept out of the exit code) and
// normalizes its changes. The reference is resolved when the run starts: `git show <ref>:<spec>` into the run folder, or
// the reference file. A reference that cannot be resolved blocks the stage; it is never "nothing changed". The tool is
// supplied by the customer (see the manifest); the run never installs it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, redirectionEnv } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { oasdiffManifest } from "./manifest.js";
import { FAIL_ON_LEVELS, parseOasdiffOutput, type FailOn } from "./normalize.js";
import { probeOasdiff } from "./probe.js";

export { oasdiffManifest } from "./manifest.js";
export { parseOasdiffOutput } from "./normalize.js";
export { findOasdiff, probeOasdiff } from "./probe.js";

const ADAPTER_ID = oasdiffManifest.id;
const WORKSPACE = "{workspace}";
/** Replaced at run time by the base specification file (resolved from the reference). */
export const BASE_TOKEN = "{oasdiffBase}";

/** Where the specification is looked for when the instance does not name it, in this order. */
export const SPEC_CANDIDATES = ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json", "api/openapi.yaml", "api/openapi.yml", "api/openapi.json", "docs/openapi.yaml", "docs/openapi.yml", "docs/openapi.json", "spec/openapi.yaml", "spec/openapi.yml", "spec/openapi.json"];
/** A git ref the plan accepts: no option-looking value, no whitespace, no shell or revision-range syntax. */
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/~^@-]*$/;

/** The settings of an instance (tools.<id> in .jgates/tools.yml or in a template). */
export interface OasdiffSettings {
  /** Workspace-relative (or component-relative) path of the specification, or null to look for the usual names. */
  spec: string | null;
  baseRef: string | null;
  baseSpec: string | null;
  failOn: FailOn;
  /** What the instance wrote that is not valid; the plan refuses it instead of guessing. */
  problems: string[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A relative path that stays inside its root. */
function safeRelative(value: string): boolean {
  if (value === "" || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.replace(/\\/g, "/").split("/");
  return !parts.includes("..") && !parts.some((p) => p === "");
}

/** Reads and validates spec, baseRef, baseSpec and failOn of the instance (default failOn: ERR). */
export function oasdiffSettings(input: Pick<ExternalPlanInput, "config" | "tool">): OasdiffSettings {
  const t = translator("oasdiff");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  const problems: string[] = [];
  const pathSetting = (key: "spec" | "baseSpec"): string | null => {
    const value = body[key];
    if (value === undefined) return null;
    if (typeof value === "string" && safeRelative(value)) return value.replace(/\\/g, "/");
    problems.push(t("oasdiff_setting_path", { tool: input.tool, key, value: String(value) }));
    return null;
  };
  const spec = pathSetting("spec");
  const baseSpec = pathSetting("baseSpec");
  let baseRef: string | null = null;
  if (body.baseRef !== undefined) {
    if (typeof body.baseRef === "string" && REF_PATTERN.test(body.baseRef)) baseRef = body.baseRef;
    else problems.push(t("oasdiff_setting_base_ref", { tool: input.tool, value: String(body.baseRef) }));
  }
  if (baseRef !== null && baseSpec !== null) problems.push(t("oasdiff_setting_both", { tool: input.tool }));
  let failOn: FailOn = "ERR";
  if (body.failOn !== undefined) {
    if (typeof body.failOn === "string" && (FAIL_ON_LEVELS as readonly string[]).includes(body.failOn)) failOn = body.failOn as FailOn;
    else problems.push(t("oasdiff_setting_fail_on", { tool: input.tool, value: String(body.failOn), allowed: FAIL_ON_LEVELS.join(", ") }));
  }
  return { spec, baseRef, baseSpec, failOn, problems };
}

/** The specification of the instance relative to the scan root, or null when none is named and none is found. */
function findSpec(settings: OasdiffSettings, scanDir: string): string | null {
  if (settings.spec) return settings.spec;
  return SPEC_CANDIDATES.find((c) => fs.existsSync(path.join(scanDir, ...c.split("/")))) ?? null;
}

/** The command the plan shows: executable and args (no shell); the base file token is filled in when the run starts. */
function planOasdiff(input: ExternalPlanInput): ExternalPlan {
  const t = translator("oasdiff");
  const settings = oasdiffSettings(input);
  const probe = probeOasdiff(input.env);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
  const spec = findSpec(settings, scanDir);
  const args = ["breaking", BASE_TOKEN, spec ?? "<specification>", "--format", "json"];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (settings.problems.length > 0) {
    // A setting that is not valid never falls back to a default silently.
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("oasdiff_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("oasdiff_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, oasdiffManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: oasdiffManifest.toolName, version: probe.version, range: oasdiffManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (spec === null) availability = { status: "unavailable", reason: t("oasdiff_no_spec") };
  else availability = { status: "available", reason: null };

  const reference = settings.baseSpec ? t("oasdiff_reference_file", { file: settings.baseSpec }) : settings.baseRef ? t("oasdiff_reference_ref", { ref: settings.baseRef }) : t("oasdiff_reference_none");
  return {
    label: t("oasdiff_label"),
    command: {
      executable: probe.executable ?? oasdiffManifest.toolName,
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: { ...redirectionEnv(oasdiffManifest), NO_COLOR: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: [],
    availability,
    blocksPlan,
    network: false,
    limitations: [t("oasdiff_limitation_reference")],
    conditions: [t("oasdiff_condition_reference", { reference }), t("oasdiff_condition_fail_on", { level: settings.failOn })],
    // The reference and the level decide what a change counts as; they are part of the reviewed plan.
    contract: { spec, baseRef: settings.baseRef, baseSpec: settings.baseSpec, failOn: settings.failOn },
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

interface Reference {
  file: string | null;
  problem: string | null;
}

/** Puts the reference specification in the run folder (git show) or points at the reference file; never guesses one. */
function resolveReference(settings: OasdiffSettings, spec: string, cwd: string, outDir: string, env: NodeJS.ProcessEnv): Reference {
  const t = translator("oasdiff");
  if (settings.baseSpec) {
    const file = path.join(cwd, ...settings.baseSpec.split("/"));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { file: null, problem: t("oasdiff_reference_file_missing", { file: settings.baseSpec }) };
    return { file, problem: null };
  }
  if (!settings.baseRef) return { file: null, problem: t("oasdiff_reference_unset") };
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  const git = (args: string[]) => spawnSync("git", args, { cwd, env: gitEnv, timeout: 60_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const ref = git(["rev-parse", "--verify", "--quiet", `${settings.baseRef}^{commit}`]);
  if (ref.error || ref.status !== 0) return { file: null, problem: t("oasdiff_reference_ref_missing", { ref: settings.baseRef }) };
  // "./<path>" is relative to the scan root, so a component works like the workspace.
  const shown = git(["show", `${settings.baseRef}:./${spec}`]);
  if (shown.error || shown.status !== 0) return { file: null, problem: t("oasdiff_reference_spec_missing", { ref: settings.baseRef, spec }) };
  const file = path.join(outDir, `base-spec${path.extname(spec)}`);
  fs.writeFileSync(file, shown.stdout, { mode: 0o600 });
  return { file, problem: null };
}

async function runOasdiff(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("oasdiff");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("oasdiff_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const contract = (invocation.contract ?? {}) as Record<string, unknown>;
  const spec = typeof contract.spec === "string" ? contract.spec : null;
  const settings: OasdiffSettings = {
    spec,
    baseRef: typeof contract.baseRef === "string" ? contract.baseRef : null,
    baseSpec: typeof contract.baseSpec === "string" ? contract.baseSpec : null,
    failOn: contract.failOn === "WARN" ? "WARN" : "ERR",
    problems: [],
  };
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const specPath = path.relative(context.workspacePath, path.join(cwd, ...(spec ?? "").split("/"))).split(path.sep).join("/");

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  createOutputPaths(oasdiffManifest, context.runDir);
  const outFile = path.join(outDir, "oasdiff.json");
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
  const blockedAll = (reason: string, nativeStatus?: string): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, "blocked", reason, nativeStatus ? { nativeStatus } : {})), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("oasdiff_blocked", { detail: command.executable }));
  if (!spec) return blockedAll(t("oasdiff_no_spec"), "no-spec");

  // Without a reference there is nothing to compare with: blocked, never passed.
  const reference = resolveReference(settings, spec, cwd, outDir, context.env);
  if (reference.file === null) return blockedAll(reference.problem ?? t("oasdiff_reference_unset"), "no-reference");

  const args = command.args.map((a) => (a === BASE_TOKEN ? reference.file as string : substituteTokens(a, tokens)));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("oasdiff_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("oasdiff_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Only the run-owned process is stopped; whatever oasdiff wrote before stays in the logs as partial evidence.
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("oasdiff_cancelled"))), findings: [] };
  // Without --fail-on a finished comparison is exit 0; anything else (a spec that does not parse, a crash) proves nothing.
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("oasdiff_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  fs.writeFileSync(outFile, result.stdout, { mode: 0o600 });
  const parsed = parseOasdiffOutput(result.stdout, { stageId: items[0]?.id as string, version, specPath, failOn: settings.failOn });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("oasdiff_invalid_output", { detail }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  const reason = t("oasdiff_reason_completed", { version: version ?? "?", count, spec: specPath });
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: count, nativeStatus: "exit 0" })),
    findings: parsed.findings,
  };
}

export const oasdiffAdapter: ExternalAdapter = {
  manifest: oasdiffManifest,
  plan: planOasdiff,
  run: runOasdiff,
};
