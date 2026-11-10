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
import { lastSegment, parseLibtestOutput, parseLlvmCovSummary, type LibtestFailure } from "./normalize.js";

const readOrNull = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
import { probeCargo } from "./probe.js";
import { scanProperties } from "./properties.js";
import { findOnPath } from "../../core/runner/path-lookup.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { ratioMetric } from "../../core/results/metrics.js";
import { contentHash } from "../../core/ids/index.js";
import { describeSelection, detectIntegration, resolveIntegrationSelection, rustTestTargets, rustUnitTargets } from "../../core/selection/tests.js";
import { policyMinimum, runModeOf } from "../test-common/index.js";

export { cargoTestManifest } from "./manifest.js";
export { parseLibtestOutput, parseLlvmCovSummary } from "./normalize.js";
export { findCargo, probeCargo } from "./probe.js";
export { propertyFunctions, scanProperties } from "./properties.js";

const ADAPTER_ID = cargoTestManifest.id;
const WORKSPACE = "{workspace}";
const RUN_DIR = "{runDir}";
const TESTS = "tests";
const PROPERTIES = "properties";
const COVERAGE = "coverage";

/** Whether cargo-llvm-cov is there: image.json, or (inside the image, with JGATES_CARGO) beside that cargo. */
export function probeLlvmCov(env: NodeJS.ProcessEnv): { available: boolean; detail: string } {
  const named = inImageOverride(env, "JGATES_CARGO");
  if (named !== null) {
    // A Node stand-in for cargo answers every cargo subcommand; a real cargo needs the cargo-llvm-cov binary next to it.
    if (/\.(?:mjs|cjs|js)$/i.test(named)) return { available: true, detail: "" };
    return findOnPath("cargo-llvm-cov", env) ? { available: true, detail: "" } : { available: false, detail: `cargo-llvm-cov beside ${named}` };
  }
  const probe = probeImageTool("cargo-llvm-cov", env);
  return probe.problem === null ? { available: true, detail: "" } : { available: false, detail: probe.detail };
}
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
  const tt = translator("test-stacks");
  const toolsMap = isRec(input.config?.tools) ? (input.config?.tools as Record<string, unknown>) : {};
  const body = toolsMap[input.tool];
  const component = isRec(body) && typeof body.component === "string" ? body.component : null;
  const minimum = policyMinimum(input.config, component);
  const { mode, integrationElsewhere } = runModeOf(wanted);
  // The integration selection (the tests/ targets): the unit run leaves it out, an instance with only `integration` runs it alone.
  const selection = resolveIntegrationSelection({ stack: "rust", config: input.config, tool: input.tool, adapter: ADAPTER_ID, scanDir });
  const detection = detectIntegration(scanDir, selection);
  const described = describeSelection(selection);
  const testFlags = (names: string[]): string[] => names.flatMap((n) => ["--test", n]);
  let targets: string[] = [];
  if (mode === "integration") targets = testFlags(detection.names);
  else if (mode === "unit" && detection.present) {
    const own = rustUnitTargets(scanDir);
    const others = rustTestTargets(scanDir).filter((n) => !detection.names.includes(n));
    targets = [...(own.lib ? ["--lib"] : []), ...(own.bins ? ["--bins"] : []), ...testFlags(others)];
  }
  // Coverage: cargo-llvm-cov of the tools image runs the same tests instrumented and writes its JSON summary.
  const coverageWanted = mode !== "integration" && wanted.has(COVERAGE);
  const llvmCov = coverageWanted ? probeLlvmCov(input.env) : { available: false, detail: "" };
  const report = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}/llvm-cov.json`;
  const args =
    coverageWanted && llvmCov.available
      ? ["llvm-cov", "--ignore-run-fail", "--offline", "--color", "never", ...targets, "--json", "--summary-only", "--output-path", report]
      : ["test", "--no-fail-fast", "--offline", "--color", "never", ...targets];
  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("cargo-test_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("cargo-test_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, cargoTestManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: cargoTestManifest.toolName, version: probe.version, range: cargoTestManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (!fs.existsSync(path.join(scanDir, "Cargo.toml"))) availability = { status: "unavailable", reason: t("cargo-test_no_manifest") };
  else availability = { status: "available", reason: null };
  const coverageProblem = coverageWanted && !llvmCov.available ? tt("test_missing", { tool: "cargo-llvm-cov", detail: llvmCov.detail }) : null;

  const toml = [".cargo/config.toml", ".cargo/config", "Cargo.toml"].map((f) => (root ? `${root}/${f}` : f)).filter((f) => fs.existsSync(path.join(input.dir, ...f.split("/"))));
  return {
    label: t("cargo-test_label"),
    command: {
      executable: probe.executable ?? cargoTestManifest.toolName,
      args: [...(probe.prefix ?? []), ...args],
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
    conditions: [
      t("cargo-test_condition_executes"),
      ...(wanted.has(PROPERTIES) ? [t("cargo-test_condition_properties")] : []),
      ...(mode === "integration" ? [tt(detection.present ? "test_condition_integration" : "test_no_integration", { selection: described })] : mode === "unit" && detection.present ? [tt("test_condition_unit_excludes", { selection: described })] : []),
      ...(coverageProblem ? [coverageProblem] : []),
    ],
    contract: { mode, selection: described, integrationElsewhere, nothingToRun: mode === "integration" && !detection.present, coverage: { requested: coverageWanted, collected: coverageWanted && llvmCov.available, problem: coverageProblem }, report: coverageWanted && llvmCov.available ? report : null, minimum: minimum.value, minimumSource: minimum.source, component },
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
  const contract = (invocation.contract ?? {}) as { nothingToRun?: boolean; mode?: string; selection?: string; coverage?: { collected?: boolean; problem?: string | null }; report?: string | null; minimum?: number | null; minimumSource?: string | null; component?: string | null };
  const integrationRun = contract.mode === "integration";
  // The tests stage: tests (the whole suite), unit, or integration for an instance that runs only the integration selection.
  const testItems = items.filter((i) => (integrationRun ? capOf(i) === "integration" : capOf(i) === TESTS || capOf(i) === "unit"));
  const testsItem = testItems[0];
  const misplacedIntegration = integrationRun ? undefined : items.find((i) => capOf(i) === "integration");
  const coverageItem = items.find((i) => capOf(i) === COVERAGE);
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
  // No integration test in the component: the integration step does not apply and starts nothing.
  if (contract.nothingToRun) return { ...base, stages: items.map((i) => stageFor(i, "not_applicable", translator("test-stacks")("test_no_integration", { selection: contract.selection ?? "-" }))), findings: [] };

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
    const owner = (property ? propertiesItem : testsItem) ?? testsItem ?? propertiesItem ?? coverageItem ?? (items[0] as PlanItem);
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
  const prefix = integrationRun ? "tests.integration" : "tests";
  const metrics: NonNullable<AdapterOutput["metrics"]> = [
    { id: `${prefix}.executed`, label: t("cargo-test_metric_executed"), unit: "count", value: counts.passed + counts.failed, scope: "workspace", origin: ADAPTER_ID },
    { id: `${prefix}.passed`, label: t("cargo-test_metric_passed"), unit: "count", value: counts.passed, scope: "workspace", origin: ADAPTER_ID },
    { id: `${prefix}.failed`, label: t("cargo-test_metric_failed"), unit: "count", value: counts.failed, scope: "workspace", origin: ADAPTER_ID },
    { id: `${prefix}.skipped`, label: t("cargo-test_metric_skipped"), unit: "count", value: counts.ignored, scope: "workspace", origin: ADAPTER_ID },
  ];
  // No property metric for a crate that does not use proptest; one that does gets it even at zero.
  if (scan.usesProptest && !integrationRun) {
    metrics.push(
      { id: "tests.property.total", label: t("cargo-test_metric_property_total"), unit: "count", value: propertyTests.length, scope: "workspace", origin: ADAPTER_ID },
      { id: "tests.property.failed", label: t("cargo-test_metric_property_failed"), unit: "count", value: propertyFailed.length, scope: "workspace", origin: ADAPTER_ID },
    );
  }

  const stages: ResultStage[] = [];
  const countFor = (item: PlanItem): number => findings.filter((f) => f.stageId === item.id).length;
  const native = `exit ${result.exitCode ?? "-"}`;
  const tt = translator("test-stacks");
  if (misplacedIntegration) stages.push(stageFor(misplacedIntegration, "blocked", tt("test_integration_own_instance", { tool })));
  for (const item of testItems) {
    const failed = countFor(item);
    const reason = t("cargo-test_reason_tests", { version: version ?? "?", executed: counts.passed + counts.failed, failed: counts.failed, skipped: counts.ignored });
    stages.push(stageFor(item, "completed", integrationRun ? `${reason} (${contract.selection ?? "-"})` : reason, { blockingViolations: failed, findings: failed, nativeStatus: native }));
  }
  if (coverageItem) {
    const scope = contract.component ? "component" : "workspace";
    const withComponent = contract.component ? { component: contract.component } : {};
    const unmeasured = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): void => {
      stages.push(stageFor(coverageItem, state, reason, extra));
      metrics.push({ id: "coverage.lines", label: tt("test_metric_coverage"), unit: "percent", measured: false, reason, ...withComponent, scope, origin: ADAPTER_ID });
    };
    if (!contract.coverage?.collected || !contract.report) unmeasured("blocked", contract.coverage?.problem ?? tt("test_cov_not_collected", { tool: "cargo-llvm-cov" }));
    else {
      const reading = parseLlvmCovSummary(readOrNull(substituteTokens(contract.report, tokens)));
      if (!reading.ok) unmeasured("completed", tt("test_cov_unreadable", { detail: reading.problem }), { interpreted: false, nativeStatus: native });
      else if (reading.total === 0) unmeasured("completed", tt("test_cov_empty"), { interpreted: false, nativeStatus: native });
      else {
        const metric = ratioMetric({ id: "coverage.lines", label: tt("test_metric_coverage"), numerator: reading.covered, denominator: reading.total, ...withComponent, scope, origin: ADAPTER_ID, basis: "lines", format: "llvm-cov export (cargo-llvm-cov)" });
        metrics.push(metric);
        const percent = metric.value as number;
        const minimum = typeof contract.minimum === "number" ? contract.minimum : null;
        const below = minimum !== null && percent < minimum;
        if (below) {
          findings.push({
            ...baseFinding,
            stageId: coverageItem.id,
            ruleId: "cargo-test.coverage-below-minimum",
            category: "coverage",
            message: tt("test_cov_below", { component: contract.component ?? ".", percent, covered: reading.covered, total: reading.total, minimum, source: contract.minimumSource ?? "-" }),
            fingerprint: contentHash({ tool: ADAPTER_ID, rule: "coverage-below-minimum", component: contract.component ?? null, minimum }),
          });
        }
        const reason = minimum !== null ? tt("test_cov_reason", { percent, covered: reading.covered, total: reading.total, minimum }) : tt("test_cov_reason_nomin", { percent, covered: reading.covered, total: reading.total });
        stages.push(stageFor(coverageItem, "completed", reason, { blockingViolations: below ? 1 : 0, findings: below ? 1 : 0, nativeStatus: native }));
      }
    }
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
