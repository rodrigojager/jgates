// cargo-test adapter: plans one `cargo test --no-fail-fast --offline` per tool instance (the component's Cargo.toml,
// build artifacts in the run folder) and reads the stable libtest text output back: failed tests become findings, the
// counts become metrics, and the proptest property tests (found statically in the .rs files) get their own rule,
// stage and metrics. The toolchain is supplied by the customer (see the manifest); the run never installs it. The tests
// execute the project's code, so the cache never reuses this step.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec, substituteTokens } from "../../core/runner/index.js";
import { createOutputPaths, redirectionEnv } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";
import { cargoTestManifest } from "./manifest.js";
import { lastSegment, parseLibtestOutput, type LibtestFailure } from "./normalize.js";
import { probeCargo } from "./probe.js";
import { scanProperties } from "./properties.js";

export { cargoTestManifest } from "./manifest.js";
export { parseLibtestOutput } from "./normalize.js";
export { findCargo, probeCargo } from "./probe.js";
export { propertyFunctions, scanProperties } from "./properties.js";

const ADAPTER_ID = cargoTestManifest.id;
const WORKSPACE = "{workspace}";
const TESTS = "tests";
const PROPERTIES = "properties";
/** Variables cargo needs beyond the runner's default allowlist (toolchain homes, proxies, program folders). */
const TOOLCHAIN_ENV = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "WINDIR", "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "CARGO_HTTP_CAINFO"] as const;
const ENV_ALLOWLIST: readonly string[] = [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV];

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Capabilities the instance asks for: the selection of the plan when it has one, else what tools.yml/the template list. */
function wantedCapabilities(input: ExternalPlanInput): Set<string> {
  const selection = (input as { selection?: { items?: Array<{ kind: string; id: string; capabilities?: Array<{ capability?: string; enabled: boolean }> }> } }).selection;
  const item = selection?.items?.find((i) => i.kind === "tool" && i.id === input.tool);
  if (item?.capabilities) return new Set(item.capabilities.filter((c) => c.enabled).map((c) => c.capability ?? ""));
  const body = isRec(input.config?.tools) ? (input.config?.tools as Record<string, unknown>)[input.tool] : undefined;
  const list = isRec(body) && Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [input.capability];
  return new Set(list);
}

function planCargoTest(input: ExternalPlanInput): ExternalPlan {
  const t = translator("cargo-test");
  const probe = probeCargo(input.env);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
  const wanted = wantedCapabilities(input);
  const args = ["test", "--no-fail-fast", "--offline", "--color", "never"];
  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("cargo-test_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("cargo-test_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, cargoTestManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: cargoTestManifest.toolName, version: probe.version, range: cargoTestManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (!fs.existsSync(path.join(scanDir, "Cargo.toml"))) availability = { status: "unavailable", reason: t("cargo-test_no_manifest") };
  else availability = { status: "available", reason: null };

  const toml = [".cargo/config.toml", ".cargo/config", "Cargo.toml"].map((f) => (root ? `${root}/${f}` : f)).filter((f) => fs.existsSync(path.join(input.dir, ...f.split("/"))));
  return {
    label: t("cargo-test_label"),
    command: {
      executable: probe.executable ?? cargoTestManifest.toolName,
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: {
        ...redirectionEnv(cargoTestManifest),
        CARGO_TERM_COLOR: "never",
        NO_COLOR: "1",
        RUST_BACKTRACE: "0",
        // proptest would write proptest-regressions/ files into the source tree; the run keeps the project untouched.
        PROPTEST_DISABLE_FAILURE_PERSISTENCE: "true",
      },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: toml.map((file) => ({ file, sha256: null })),
    availability,
    blocksPlan: false,
    network: false,
    limitations: [t("cargo-test_limitation_static"), t("cargo-test_limitation_offline")],
    conditions: [t("cargo-test_condition_executes"), ...(wanted.has(PROPERTIES) ? [t("cargo-test_condition_properties")] : [])],
    output: { format: "text", schema: null },
    // The tests, build scripts and procedural macros are the project's code: the cache never reuses this step.
    effects: { executesProjectCode: true },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");
const posix = (p: string): string => p.split(path.sep).join("/").replace(/\\/g, "/");

async function runCargoTest(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("cargo-test");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("cargo-test_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const scanRoot = posix(path.relative(context.workspacePath, cwd)) || ".";

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  createOutputPaths(cargoTestManifest, context.runDir);
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

  const capOf = (i: PlanItem): string => i.capabilities[0] ?? "";
  const testsItem = items.find((i) => capOf(i) === TESTS);
  const propertiesItem = items.find((i) => capOf(i) === PROPERTIES);
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
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("cargo-test_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env, envAllowlist: ENV_ALLOWLIST },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...all("blocked", t("cargo-test_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...all("timeout", t("cargo-test_timeout", { seconds: timeoutSeconds })), logs: base.logs };
  // Only the run-owned process is stopped; whatever cargo wrote before stays in the logs as partial evidence.
  if (result.cancelled) return { ...all("cancelled", t("cargo-test_cancelled")), logs: base.logs };

  const report = parseLibtestOutput(result.stdout);
  if (!report.ok || result.truncated) {
    // No summary line (a compilation error, a crash): nothing proves what the tests did, whatever the exit code says.
    const why = result.truncated ? "output truncated" : (report.problem ?? "");
    const detail = result.exitCode === 0 ? t("cargo-test_invalid_output", { detail: why }) : `${t("cargo-test_exit_error", { code: result.exitCode ?? "-", detail: tail(result.stderr) || String(result.signal ?? "") })} (${why})`;
    return { ...all("error", detail, { interpreted: false }), logs: base.logs };
  }
  if (result.exitCode !== 0 && report.counts.failed === 0 && report.failures.length === 0) {
    return { ...all("error", t("cargo-test_exit_error", { code: result.exitCode ?? "-", detail: tail(result.stderr) || "-" }), { interpreted: false }), logs: base.logs };
  }

  // Property tests (proptest) are told apart by reading the .rs files that the crate has; libtest does not say.
  const scan = scanProperties(cwd, (abs) => posix(path.relative(context.workspacePath, abs)));
  const isProperty = (name: string): boolean => scan.functions.has(lastSegment(name));
  const propertyTests = report.tests.filter((r) => r.status !== "ignored" && isProperty(r.name));
  const propertyFailed = propertyTests.filter((r) => r.status === "failed");

  const baseFinding = { tool: ADAPTER_ID, ...(version ? { toolVersion: version } : {}), category: "tests", severity: "error", normalizedSeverity: "high" as const, origin: ADAPTER_ID, blocking: true, blockingReason: "blocking-tool" as const, waived: false };
  const locate = (f: LibtestFailure, property: boolean): ResultFinding["location"] | undefined => {
    if (f.file) {
      const abs = path.isAbsolute(f.file) ? f.file : path.join(cwd, f.file);
      if (fs.existsSync(abs) && !posix(path.relative(context.workspacePath, abs)).startsWith("..")) {
        return { path: posix(path.relative(context.workspacePath, abs)), ...(f.line !== null ? { line: f.line } : {}), ...(f.column !== null ? { column: f.column } : {}) };
      }
    }
    const declared = property ? scan.functions.get(lastSegment(f.name)) : undefined;
    return declared ? { path: declared } : undefined;
  };
  const findings: ResultFinding[] = [];
  const stripInput = (m: string): string => m.replace(/;?\s*minimal failing input:.*$/, "").trim() || "-";
  for (const f of report.failures) {
    const property = isProperty(f.name);
    const owner = (property ? propertiesItem : testsItem) ?? testsItem ?? propertiesItem ?? (items[0] as PlanItem);
    const location = locate(f, property);
    findings.push({
      ...baseFinding,
      stageId: owner.id,
      ruleId: property ? "cargo-test.property-failed" : "cargo-test.test-failed",
      message: property ? t("cargo-test_finding_property", { name: f.name, message: stripInput(f.message), input: f.minimalInput ?? t("cargo-test_no_minimal_input") }) : t("cargo-test_finding_test", { name: f.name, message: f.message || "-" }),
      ...(location ? { location } : {}),
    });
  }

  const counts = report.counts;
  const metrics: NonNullable<AdapterOutput["metrics"]> = [
    { id: "tests.executed", label: t("cargo-test_metric_executed"), unit: "count", value: counts.passed + counts.failed, scope: "workspace", origin: ADAPTER_ID },
    { id: "tests.passed", label: t("cargo-test_metric_passed"), unit: "count", value: counts.passed, scope: "workspace", origin: ADAPTER_ID },
    { id: "tests.failed", label: t("cargo-test_metric_failed"), unit: "count", value: counts.failed, scope: "workspace", origin: ADAPTER_ID },
    { id: "tests.skipped", label: t("cargo-test_metric_skipped"), unit: "count", value: counts.ignored, scope: "workspace", origin: ADAPTER_ID },
  ];
  // No property metric for a crate that does not use proptest; one that does gets it even at zero.
  if (scan.usesProptest) {
    metrics.push(
      { id: "tests.property.total", label: t("cargo-test_metric_property_total"), unit: "count", value: propertyTests.length, scope: "workspace", origin: ADAPTER_ID },
      { id: "tests.property.failed", label: t("cargo-test_metric_property_failed"), unit: "count", value: propertyFailed.length, scope: "workspace", origin: ADAPTER_ID },
    );
  }

  const stages: ResultStage[] = [];
  const countFor = (item: PlanItem): number => findings.filter((f) => f.stageId === item.id).length;
  const native = `exit ${result.exitCode ?? "-"}`;
  if (testsItem) {
    const failed = countFor(testsItem);
    stages.push(stageFor(testsItem, "completed", t("cargo-test_reason_tests", { version: version ?? "?", executed: counts.passed + counts.failed, failed: counts.failed, skipped: counts.ignored }), { blockingViolations: failed, findings: failed, nativeStatus: native }));
  }
  if (propertiesItem) {
    if (!scan.usesProptest) {
      stages.push(stageFor(propertiesItem, "not_applicable", t("cargo-test_reason_no_proptest")));
    } else {
      const failed = countFor(propertiesItem);
      stages.push(stageFor(propertiesItem, "completed", t("cargo-test_reason_properties", { total: propertyTests.length, failed: propertyFailed.length }), { blockingViolations: failed, findings: failed, nativeStatus: native }));
    }
  }
  return { ...base, stages, findings, metrics };
}

export const cargoTestAdapter: ExternalAdapter = {
  manifest: cargoTestManifest,
  plan: planCargoTest,
  run: runCargoTest,
};
