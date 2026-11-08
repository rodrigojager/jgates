// Schemathesis adapter: plans one `st run <spec> --url <target>` per tool instance against the running target the
// instance names, with a fixed seed, a bound on examples per operation, a request timeout and the stage timeout, and
// normalizes the JSON and JUnit reports into findings that carry their reproduction. Without a target, or with an
// authentication variable that is not set, the stage is blocked, never passed. The tool is prepared by
// `jgates doctor --fix` (pip into the JGates environment); the run never installs it.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, redirectionEnv } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { schemathesisManifest } from "./manifest.js";
import { parseSchemathesisReports } from "./normalize.js";
import { probeSchemathesis } from "./probe.js";
import { checkTarget, instanceBody, intSetting, readAuth, safeRelative, type AuthSetting } from "./target.js";

export { schemathesisManifest } from "./manifest.js";
export { parseSchemathesisReports, parseJUnit } from "./normalize.js";
export { findSchemathesis, probeSchemathesis } from "./probe.js";
export { checkTarget, isLoopbackHost, readAuth } from "./target.js";

const ADAPTER_ID = schemathesisManifest.id;
const WORKSPACE = "{workspace}";
/** Replaced at run time by the instance's output folder in the run (reports and the generated configuration file). */
export const OUT_TOKEN = "{schemathesisOut}";
/** The variable the run sets to the authentication header value; the configuration file refers to it, never to the secret. */
export const AUTH_ENV = "JGATES_RUNTIME_AUTH";

/** Checks that judge conformance to the specification; the default set, safe for any target that honours its contract. */
export const DEFAULT_CHECKS = ["not_a_server_error", "status_code_conformance", "content_type_conformance", "response_schema_conformance"] as const;
/** Every check the instance may choose (Schemathesis 4.x names). */
export const ALLOWED_CHECKS = [
  ...DEFAULT_CHECKS,
  "response_headers_conformance",
  "negative_data_rejection",
  "positive_data_acceptance",
  "missing_required_header",
  "unsupported_method",
  "allow_header_conformance",
  "use_after_free",
  "ensure_resource_availability",
  "ignored_auth",
] as const;

export const SPEC_CANDIDATES = ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json", "api/openapi.yaml", "api/openapi.yml", "api/openapi.json", "docs/openapi.yaml", "docs/openapi.yml", "docs/openapi.json"];

export interface SchemathesisSettings {
  target: string | null;
  spec: string | null;
  auth: AuthSetting | null;
  seed: number;
  maxExamples: number;
  requestTimeoutSeconds: number;
  checks: string[];
  /** What the instance wrote that is not valid; the plan refuses it instead of guessing. */
  problems: string[];
}

/** Reads and validates the instance settings (defaults: seed 1, 50 examples per operation, 10 s per request). */
export function schemathesisSettings(input: Pick<ExternalPlanInput, "config" | "tool">): SchemathesisSettings {
  const t = translator("schemathesis");
  const body = instanceBody(input.config, input.tool);
  const problems: string[] = [];
  const target = checkTarget(body.target);
  if (target.problem === "invalid") problems.push(t("schemathesis_setting_target", { tool: input.tool, value: String(body.target) }));
  let spec: string | null = null;
  if (body.spec !== undefined) {
    if (typeof body.spec === "string" && safeRelative(body.spec)) spec = body.spec.replace(/\\/g, "/");
    else problems.push(t("schemathesis_setting_spec", { tool: input.tool, value: String(body.spec) }));
  }
  const auth = readAuth(body.auth);
  if (auth.problem) problems.push(t("schemathesis_setting_auth", { tool: input.tool }));
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const v = intSetting(body[key], fallback, min, max);
    if (v === "invalid") {
      problems.push(t("schemathesis_setting_number", { tool: input.tool, key, value: String(body[key]), min, max }));
      return fallback;
    }
    return v ?? fallback;
  };
  const seed = number("seed", 1, 0, 2 ** 31 - 1);
  const maxExamples = number("maxExamples", 50, 1, 10_000);
  const requestTimeoutSeconds = number("requestTimeoutSeconds", 10, 1, 300);
  let checks: string[] = [...DEFAULT_CHECKS];
  if (body.checks !== undefined) {
    const list = Array.isArray(body.checks) ? body.checks : null;
    if (list && list.length > 0 && list.every((c) => typeof c === "string" && (ALLOWED_CHECKS as readonly string[]).includes(c))) checks = [...new Set(list as string[])];
    else problems.push(t("schemathesis_setting_checks", { tool: input.tool, allowed: ALLOWED_CHECKS.join(", ") }));
  }
  return { target: target.url, spec, auth: auth.auth, seed, maxExamples, requestTimeoutSeconds, checks, problems };
}

function findSpec(settings: SchemathesisSettings, scanDir: string): string | null {
  if (settings.spec) return settings.spec;
  return SPEC_CANDIDATES.find((c) => fs.existsSync(path.join(scanDir, ...c.split("/")))) ?? null;
}

function planSchemathesis(input: ExternalPlanInput): ExternalPlan {
  const t = translator("schemathesis");
  const settings = schemathesisSettings(input);
  const probe = probeSchemathesis(input.env);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
  const spec = findSpec(settings, scanDir);
  const specArg = `${WORKSPACE}/${root ? `${root}/` : ""}${spec ?? "<specification>"}`;
  const args = [
    "--config-file",
    `${OUT_TOKEN}/schemathesis.toml`,
    "--no-color",
    "run",
    specArg,
    "--url",
    settings.target ?? "<target>",
    "--checks",
    settings.checks.join(","),
    "--max-examples",
    String(settings.maxExamples),
    "--seed",
    String(settings.seed),
    "--request-timeout",
    String(settings.requestTimeoutSeconds),
    "--workers",
    "1",
    "--report",
    "json,junit",
    "--report-json-path",
    `${OUT_TOKEN}/schemathesis.json`,
    "--report-junit-path",
    `${OUT_TOKEN}/schemathesis.junit.xml`,
  ];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (settings.problems.length > 0) {
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (settings.target === null) availability = { status: "unavailable", reason: t("schemathesis_no_target") };
  else if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("schemathesis_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("schemathesis_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, schemathesisManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: schemathesisManifest.toolName, version: probe.version, range: schemathesisManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (spec === null) availability = { status: "unavailable", reason: t("schemathesis_no_spec") };
  else availability = { status: "available", reason: null };

  const auth = settings.auth ? t("schemathesis_condition_auth", { header: settings.auth.header, env: settings.auth.valueEnv }) : t("schemathesis_condition_no_auth");
  return {
    label: t("schemathesis_label"),
    command: {
      executable: probe.executable ?? "st",
      args,
      cwd: "{runDir}",
      env: { ...redirectionEnv(schemathesisManifest), NO_COLOR: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: [],
    availability,
    blocksPlan,
    network: true,
    limitations: [t("schemathesis_limitation_target")],
    conditions: [
      settings.target ? t("schemathesis_condition_target", { target: settings.target }) : t("schemathesis_condition_no_target"),
      t("schemathesis_condition_bounds", { seed: settings.seed, examples: settings.maxExamples, request: settings.requestTimeoutSeconds, timeout: input.timeoutSeconds }),
      t("schemathesis_condition_checks", { checks: settings.checks.join(", ") }),
      auth,
    ],
    contract: { target: settings.target, spec, specPath: spec ? `${root ? `${root}/` : ""}${spec}` : null, seed: settings.seed, maxExamples: settings.maxExamples, requestTimeoutSeconds: settings.requestTimeoutSeconds, checks: settings.checks, auth: settings.auth },
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

/** Replaces a secret in a file written by the tool (logs, reports), so it never stays in the run folder. */
function scrubFile(file: string, secret: string | null): void {
  if (!secret || !fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(secret)) fs.writeFileSync(file, text.split(secret).join("***"), { mode: 0o600 });
}

async function runSchemathesis(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("schemathesis");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("schemathesis_no_invocation", { tool }));

  const command = invocation.command;
  const contract = (invocation.contract ?? {}) as Record<string, unknown>;
  const target = typeof contract.target === "string" ? contract.target : null;
  const spec = typeof contract.spec === "string" ? contract.spec : null;
  const auth = readAuth(contract.auth ?? undefined).auth;
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  createOutputPaths(schemathesisManifest, context.runDir);
  const tokens = { runDir: context.runDir, workspace: context.workspacePath, schemathesisOut: outDir };
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);
  const jsonReport = path.join(outDir, "schemathesis.json");
  const junitReport = path.join(outDir, "schemathesis.junit.xml");

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

  // No target: there is nothing to test, so the stage is blocked with the reason, never passed.
  if (target === null) return blockedAll(t("schemathesis_no_target"), "no-target");
  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("schemathesis_blocked", { detail: command.executable }));
  if (!spec) return blockedAll(t("schemathesis_no_spec"), "no-spec");
  let secret: string | null = null;
  if (auth) {
    secret = context.env[auth.valueEnv] ?? null;
    // Never test unauthenticated in place of the declared authentication.
    if (!secret) return blockedAll(t("schemathesis_auth_missing", { env: auth.valueEnv }), "no-auth");
  }
  // The run's own configuration file: a project schemathesis.toml never changes what the plan says.
  const toml = auth ? `# Written by JGates for this run.\n[headers]\n"${auth.header}" = "\${${AUTH_ENV}}"\n` : "# Written by JGates for this run.\n";
  fs.writeFileSync(path.join(outDir, "schemathesis.toml"), toml, { mode: 0o600 });

  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  if (secret) env[AUTH_ENV] = secret;
  const result = await runSpec(
    { executable: command.executable, args, cwd: substituteTokens(command.cwd, tokens), env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  for (const file of [stdoutLog, stderrLog, jsonReport, junitReport]) scrubFile(file, secret);
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("schemathesis_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("schemathesis_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Only the run-owned process tree is stopped; what Schemathesis wrote stays in the logs and reports as partial evidence.
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("schemathesis_cancelled"))), findings: [] };
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("schemathesis_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const specPath = typeof contract.specPath === "string" ? contract.specPath : spec;
  const parsed = parseSchemathesisReports(read(jsonReport), read(junitReport), { stageId: items[0]?.id as string, version, specPath, target });
  if (!parsed.ok) {
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("schemathesis_invalid_output", { detail: parsed.problem ?? "" }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` })), findings: [] };
  }
  if (secret) for (const f of parsed.findings) {
    f.message = f.message.split(secret).join("***");
    if (f.evidence) f.evidence = f.evidence.split(secret).join("***");
  }
  const count = parsed.findings.length;
  // Network or schema errors, or nothing tested: the target was not exercised as planned, so the stage is not a pass.
  if (parsed.errors.length > 0 || parsed.tested === 0) {
    const detail = parsed.errors.length > 0 ? parsed.errors.slice(0, 3).join("; ") : t("schemathesis_nothing_tested");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("schemathesis_run_errors", { detail, target }), { findings: count, blockingViolations: count, nativeStatus: `exit ${result.exitCode}` })), findings: parsed.findings };
  }
  const reason = t("schemathesis_reason_completed", { version: version ?? "?", count, tested: parsed.tested, target });
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: count, findings: count, nativeStatus: `exit ${result.exitCode}` })),
    findings: parsed.findings,
  };
}

export const schemathesisAdapter: ExternalAdapter = {
  manifest: schemathesisManifest,
  plan: planSchemathesis,
  run: runSchemathesis,
};
