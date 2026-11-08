// cargo-audit adapter: plans one `cargo-audit audit --json` per tool instance (the Cargo.lock of the scan root, the
// RustSec advisory database cloned into the run folder) and normalizes its advisories. The tool is supplied by the
// customer (see the manifest); the run never installs it. cargo-audit exits 1 both for vulnerabilities found and for an
// error, so the JSON document decides: a valid report is an audit, anything else is an error.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, outputPathFor, outputPathUnder, redirectionEnv, RUN_DIR_TOKEN } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { cargoAuditManifest } from "./manifest.js";
import { parseCargoAuditOutput } from "./normalize.js";
import { probeCargoAudit } from "./probe.js";

export { cargoAuditManifest } from "./manifest.js";
export { parseCargoAuditOutput } from "./normalize.js";
export { findCargoAudit, probeCargoAudit } from "./probe.js";

const ADAPTER_ID = cargoAuditManifest.id;
const WORKSPACE = "{workspace}";
/** Variables that tell cargo where its home, toolchain and proxy are; the allowlist of the runner drops them. */
export const CARGO_ENV_FORWARD = ["CARGO_HOME", "RUSTUP_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "CARGO_HTTP_CAINFO"] as const;

const cacheEntry = (): NonNullable<ReturnType<typeof outputPathFor>> => {
  const entry = outputPathFor(cargoAuditManifest, "cache");
  if (!entry) throw new Error("the cargo-audit manifest declares no cache output path");
  return entry;
};

/** The command the plan shows: executable and args (no shell), the advisory database in the run folder. */
function planCargoAudit(input: ExternalPlanInput): ExternalPlan {
  const t = translator("cargo-audit");
  const probe = probeCargoAudit(input.env);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
  const args = ["audit", "--json", "--color", "never", "--file", "Cargo.lock", "--db", `${outputPathUnder(RUN_DIR_TOKEN, cacheEntry())}/advisory-db`];
  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("cargo-audit_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("cargo-audit_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, cargoAuditManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: cargoAuditManifest.toolName, version: probe.version, range: cargoAuditManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (!fs.existsSync(path.join(scanDir, "Cargo.lock"))) availability = { status: "unavailable", reason: t("cargo-audit_no_lockfile") };
  else availability = { status: "available", reason: null };

  const configFile = [".cargo/audit.toml"].map((f) => (root ? `${root}/${f}` : f)).find((f) => fs.existsSync(path.join(input.dir, ...f.split("/"))));
  return {
    label: t("cargo-audit_label"),
    command: {
      executable: probe.executable ?? cargoAuditManifest.toolName,
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: { ...redirectionEnv(cargoAuditManifest), NO_COLOR: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: configFile && input.policyDir === undefined ? [{ file: configFile, sha256: null }] : [],
    availability,
    blocksPlan: false,
    network: true,
    limitations: [t("cargo-audit_limitation_matching")],
    conditions: [t("cargo-audit_condition_network")],
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runCargoAudit(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("cargo-audit");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("cargo-audit_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const name of CARGO_ENV_FORWARD) {
    const value = context.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const scanRoot = path.relative(context.workspacePath, cwd).split(path.sep).join("/") || ".";

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  createOutputPaths(cargoAuditManifest, context.runDir);
  const outFile = path.join(outDir, "cargo-audit.json");
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
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("cargo-audit_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("cargo-audit_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("cargo-audit_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Only the run-owned process is stopped; whatever cargo-audit wrote before stays in the logs as partial evidence.
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("cargo-audit_cancelled"))), findings: [] };
  const exitDetail = (): string => (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
  // 0 (clean) and 1 (vulnerabilities, or an error) are the only finished audits; the JSON tells which.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("cargo-audit_exit_error", { code: result.exitCode ?? "-", detail: exitDetail() }), { interpreted: false })), findings: [] };
  }
  fs.writeFileSync(outFile, result.stdout, { mode: 0o600 });
  const parsed = parseCargoAuditOutput(result.stdout, { stageId: items[0]?.id as string, version, root: scanRoot });
  if (!parsed.ok || result.truncated) {
    if (result.exitCode === 1 && !result.truncated) {
      return { ...base, stages: items.map((i) => stageFor(i, "error", t("cargo-audit_exit_error", { code: 1, detail: exitDetail() }), { interpreted: false })), findings: [] };
    }
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("cargo-audit_invalid_output", { detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` })), findings: [] };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  const reason = t("cargo-audit_reason_completed", { version: version ?? "?", count, packages: parsed.dependencyCount ?? "?" }) + (parsed.warnings > 0 ? `; ${t("cargo-audit_warnings", { count: parsed.warnings })}` : "");
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: count, nativeStatus: `exit ${result.exitCode}` })),
    findings: parsed.findings,
  };
}

export const cargoAuditAdapter: ExternalAdapter = {
  manifest: cargoAuditManifest,
  plan: planCargoAudit,
  run: runCargoAudit,
};
