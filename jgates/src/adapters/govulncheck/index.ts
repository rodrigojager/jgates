// govulncheck adapter: plans one `govulncheck -format json ./...` per tool instance (the Go module of the scan root,
// source mode, the findings kept out of the exit code) and normalizes the vulnerabilities the code reaches. The tool is
// supplied by the customer (see the manifest); the run never installs it. The Go build cache is a folder of the run
// folder; the module cache stays where Go keeps it (outside the workspace) and go.sum is never rewritten.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, redirectionEnv } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { govulncheckManifest } from "./manifest.js";
import { parseGovulncheckOutput } from "./normalize.js";
import { probeGovulncheck } from "./probe.js";

export { govulncheckManifest } from "./manifest.js";
export { parseGovulncheckOutput } from "./normalize.js";
export { findGovulncheck, probeGovulncheck } from "./probe.js";

const ADAPTER_ID = govulncheckManifest.id;
const WORKSPACE = "{workspace}";
/** Variables that tell Go where its toolchain, module cache and proxy are; the allowlist of the runner drops them. */
export const GO_ENV_FORWARD = ["GOPATH", "GOMODCACHE", "GOROOT", "GOPROXY", "GONOSUMDB", "GONOSUMCHECK", "GOSUMDB", "GOPRIVATE", "GOTOOLCHAIN", "GOVULNDB", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE"] as const;

/** The command the plan shows: executable and args (no shell), the Go build cache in the run folder. */
function planGovulncheck(input: ExternalPlanInput): ExternalPlan {
  const t = translator("govulncheck");
  const probe = probeGovulncheck(input.env);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
  const args = ["-format", "json", "./..."];
  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("govulncheck_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("govulncheck_probe_failed", { path: probe.detail }) };
  else if (probe.problem === "no_go") availability = { status: "unavailable", reason: t("govulncheck_no_go", { detail: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, govulncheckManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: govulncheckManifest.toolName, version: probe.version, range: govulncheckManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (!fs.existsSync(path.join(scanDir, "go.mod"))) availability = { status: "unavailable", reason: t("govulncheck_no_module") };
  else availability = { status: "available", reason: null };

  return {
    label: t("govulncheck_label"),
    command: {
      executable: probe.executable ?? govulncheckManifest.toolName,
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: { ...redirectionEnv(govulncheckManifest), GOTELEMETRY: "off", NO_COLOR: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null && probe.go !== null },
    toolVersion: probe.version,
    configFiles: [],
    availability,
    blocksPlan: false,
    network: true,
    limitations: [t("govulncheck_limitation_reachable")],
    conditions: [t("govulncheck_condition_network")],
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runGovulncheck(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("govulncheck");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("govulncheck_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const name of GO_ENV_FORWARD) {
    const value = context.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const scanRoot = path.relative(context.workspacePath, cwd).split(path.sep).join("/") || ".";

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  createOutputPaths(govulncheckManifest, context.runDir);
  const outFile = path.join(outDir, "govulncheck.json");
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
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("govulncheck_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("govulncheck_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("govulncheck_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Only the run-owned process is stopped; whatever govulncheck wrote before stays in the logs as partial evidence.
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("govulncheck_cancelled"))), findings: [] };
  // With -format json a finished analysis is exit 0; anything else (a module that does not load, the database unreachable) proves nothing.
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("govulncheck_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  fs.writeFileSync(outFile, result.stdout, { mode: 0o600 });
  const parsed = parseGovulncheckOutput(result.stdout, { stageId: items[0]?.id as string, version, root: scanRoot });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("govulncheck_invalid_output", { detail }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  const reason = t("govulncheck_reason_completed", { version: version ?? "?", count }) + (parsed.notCalled > 0 ? `; ${t("govulncheck_not_called", { count: parsed.notCalled })}` : "");
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: count, nativeStatus: "exit 0" })),
    findings: parsed.findings,
  };
}

export const govulncheckAdapter: ExternalAdapter = {
  manifest: govulncheckManifest,
  plan: planGovulncheck,
  run: runGovulncheck,
};
