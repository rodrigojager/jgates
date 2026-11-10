// Shared body of the test runner adapters that came with the container-first image (go-test, dotnet-test, jest). Each
// adapter gives a spec: where its runner lives (the tools image, or the project's own dependencies for Jest), the exact
// command for the unit run (with coverage) or for the integration run, and readers of what the runner wrote (its test
// report and its coverage report). The plan shows the command; the run executes it in the step container of the tools
// image and turns the report into stages, findings and metrics:
//   - unit / tests / integration: the tests that ran, a finding per failing test;
//   - coverage: the measured ratio with its numerator and denominator, a finding below the policy minimum
//     (`coverage.minimum[.<component>]`); a report that is missing or empty is "not measured", never 0% or passed;
//   - properties: the property tests among those that ran (found by reading the test files, never executing them);
//     a component that uses no property framework reports the capability as not applicable.
// The integration selection (core/selection/tests.ts) splits the suite: the unit run leaves it out and an instance with
// only the integration capability runs it alone, so no test counts twice. A tool that is missing, a crash, or an exit
// code the report does not explain is a blocked or error stage, never a pass.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { translator } from "../../i18n/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { AdapterManifest } from "../../core/catalog/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { findOnPath } from "../../core/bridge/index.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { ratioMetric } from "../../core/results/metrics.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec, substituteTokens, type ExecutionResult } from "../../core/runner/index.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultMetric, ResultStage } from "../../core/run/types.js";
import { describeSelection, detectIntegration, resolveIntegrationSelection, type IntegrationDetection, type ResolvedSelection, type TestStack } from "../../core/selection/tests.js";

export const WORKSPACE = "{workspace}";
export const RUN_DIR = "{runDir}";

/** Capabilities a test runner instance can carry. `tests` is the whole suite, `unit` leaves the integration selection out. */
export const UNIT_LIKE = ["unit", "tests", "coverage", "properties"] as const;

export type RunMode = "unit" | "tests" | "integration";

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestCase {
  /** Full name as the runner reports it. */
  name: string;
  /** Workspace-relative POSIX path of the test file, or null when the report does not say. */
  file: string | null;
  line: number | null;
  status: TestStatus;
  /** First line of the failure message (empty when it passed). */
  message: string;
  /** A file or package that failed without any failing test (it did not load or build). */
  suite?: boolean;
  /** The test's own title, when the runner reports one apart from the full name (Jest). */
  title?: string;
}

export interface TestReading {
  ok: boolean;
  /** Why the report cannot be trusted (when not ok). */
  problem?: string;
  cases: TestCase[];
}

export type CoverageReading = { ok: true; covered: number; total: number; basis: string; format: string } | { ok: false; problem: string };

export interface RunnerProbe {
  executable: string | null;
  /** Arguments before the runner's own (the script, when a Node script stands for the runner). */
  prefix: string[];
  version: string | null;
  problem: "not_found" | null;
  detail: string;
}

export interface PrepareInput {
  input: ExternalPlanInput;
  scanDir: string;
  root: string | null;
  mode: RunMode;
  selection: ResolvedSelection;
  detection: IntegrationDetection;
  /** Coverage is selected for this run (unit mode only). */
  coverage: boolean;
  /** The output folder of the instance in the run folder, as a plan token path. */
  out: string;
  probe: RunnerProbe;
}

export interface PreparedCommand {
  args: string[];
  env: Record<string, string>;
  /** Files that decide the runner's behaviour (relative to the component, hashed into the plan). */
  configFiles?: string[];
  /** Project paths the runner writes and cannot be told otherwise (declared so a run does not read them as a change). */
  workspaceWrites?: string[];
  /** Whether the command measures coverage; when coverage is selected but not measured, the reason. */
  coverage: { collected: boolean; problem: string | null };
  /** What the run needs to read the outputs back (recorded in the plan). */
  contract?: Record<string, unknown>;
  conditions?: string[];
}

export interface ReadInput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** The instance's output folder in the run folder (host path). */
  outDir: string;
  contract: Record<string, unknown>;
  /** The workspace and the working folder as the runner saw them (container paths in a step container). */
  workspaceView: string;
  cwdView: string;
  /** The same on the host, to read the test files. */
  workspace: string;
  cwd: string;
}

export interface PropertyScan {
  /** Some test file of the component uses the property framework. */
  uses: boolean;
  isProperty(c: TestCase): boolean;
}

export interface TestRunnerSpec {
  manifest: AdapterManifest;
  /** The runner's name in messages ("go test", "dotnet test", "Jest"). */
  tool: string;
  stack: TestStack;
  /** The tool of image.json whose command runs the tests; null when the project supplies it (Jest). */
  imageTool: string | null;
  /** The variable that names another executable, inside the tools image only. */
  overrideEnv: string;
  /** The property framework, in messages ("rapid / testing/quick"). */
  framework: string;
  /** A custom probe (Jest: the project's own copy); the default asks image.json. */
  probe?(input: ExternalPlanInput, scanDir: string): RunnerProbe;
  prepare(p: PrepareInput): PreparedCommand | { skip: string };
  read(r: ReadInput): { tests: TestReading; coverage: CoverageReading | null };
  properties(cases: TestCase[], r: ReadInput): PropertyScan;
  /** Exit codes that mean "the tests ran and some failed" (default [1]). */
  failureExitCodes?: number[];
}

/** Variables a toolchain needs beyond the runner's default allowlist (only used when a step runs natively, inside the image). */
const TOOLCHAIN_ENV = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "WINDIR", "CARGO_HOME", "RUSTUP_HOME", "GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "GOFLAGS", "DOTNET_ROOT", "NUGET_PACKAGES", "NUGET_HTTP_CACHE_PATH", "NODE_PATH"] as const;
const ENV_ALLOWLIST: readonly string[] = [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV];

type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const posix = (p: string): string => p.split(path.sep).join("/").replace(/\\/g, "/");

/** Capabilities the instance asks for: the plan's selection when it has one, else what tools.yml / the template list. */
export function wantedCapabilities(input: ExternalPlanInput): Set<string> {
  const selection = (input as { selection?: { items?: Array<{ kind: string; id: string; capabilities?: Array<{ capability?: string | null; enabled: boolean }> }> } }).selection;
  const item = selection?.items?.find((i) => i.kind === "tool" && i.id === input.tool);
  if (item?.capabilities) return new Set(item.capabilities.filter((c) => c.enabled).map((c) => c.capability ?? ""));
  const body = isRec(input.config?.tools) ? (input.config?.tools as Rec)[input.tool] : undefined;
  const list = isRec(body) && Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [input.capability];
  return new Set(list);
}

/**
 * The run an instance makes: integration when it asks only for integration, the whole suite for `tests` (cargo), the
 * unit run (without the integration selection) otherwise. `integrationElsewhere`: the instance also asks for integration
 * next to a unit capability, which its single command cannot run; that stage says so.
 */
export function runModeOf(wanted: Set<string>): { mode: RunMode; integrationElsewhere: boolean } {
  const unitLike = UNIT_LIKE.some((c) => wanted.has(c));
  if (!unitLike) return { mode: "integration", integrationElsewhere: false };
  return { mode: wanted.has("unit") || !wanted.has("tests") ? "unit" : "tests", integrationElsewhere: wanted.has("integration") };
}

/** The minimum line coverage of the policy: `coverage.minimum.<component>` over `coverage.minimum` (rules.<id>.threshold). */
export function policyMinimum(config: Rec | undefined, component: string | null): { value: number | null; source: string | null } {
  const policy = config && isRec(config.policy) ? config.policy : {};
  const rules = isRec(policy.rules) ? policy.rules : {};
  for (const id of [...(component ? [`coverage.minimum.${component}`] : []), "coverage.minimum"]) {
    const rule = rules[id];
    if (isRec(rule) && rule.enabled !== false && typeof rule.threshold === "number" && Number.isFinite(rule.threshold)) return { value: rule.threshold, source: `policy.rules.${id}` };
  }
  return { value: null, source: null };
}

/** Whether the runner is in the tools image, and its version, from image.json (nothing starts); an override inside the image wins. */
export function probeRunner(spec: Pick<TestRunnerSpec, "imageTool" | "overrideEnv">, env: NodeJS.ProcessEnv): RunnerProbe {
  const named = inImageOverride(env, spec.overrideEnv);
  if (named !== null) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, problem: "not_found", detail: named };
    // The version is the image catalogue's: an override is asked nothing, so a stand-in script needs no version flag.
    const version = spec.imageTool ? (probeImageTool(spec.imageTool, env).version ?? "0.0.0") : "0.0.0";
    return /\.(?:mjs|cjs|js)$/i.test(abs) ? { executable: process.execPath, prefix: [abs], version, problem: null, detail: "" } : { executable: abs, prefix: [], version, problem: null, detail: "" };
  }
  if (!spec.imageTool) return { executable: null, prefix: [], version: null, problem: "not_found", detail: spec.overrideEnv };
  const tool = probeImageTool(spec.imageTool, env);
  if (tool.problem !== null || tool.executable === null) return { executable: null, prefix: [], version: null, problem: "not_found", detail: tool.detail };
  return { executable: tool.executable, prefix: [], version: tool.version, problem: null, detail: "" };
}

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** What the plan records about an instance and the run reads back. */
interface TestContract {
  mode: RunMode;
  component: string | null;
  selection: string;
  selectionSource: string;
  integrationElsewhere: boolean;
  nothingToRun: boolean;
  coverage: { requested: boolean; collected: boolean; problem: string | null };
  minimum: number | null;
  minimumSource: string | null;
  [key: string]: unknown;
}

function contractOf(invocation: Plan["invocations"][number]): TestContract {
  const c = (invocation.contract ?? {}) as Partial<TestContract>;
  return {
    ...c,
    mode: c.mode === "integration" || c.mode === "tests" ? c.mode : "unit",
    component: typeof c.component === "string" ? c.component : null,
    selection: typeof c.selection === "string" ? c.selection : "-",
    selectionSource: typeof c.selectionSource === "string" ? c.selectionSource : "default",
    integrationElsewhere: c.integrationElsewhere === true,
    nothingToRun: c.nothingToRun === true,
    coverage: { requested: c.coverage?.requested === true, collected: c.coverage?.collected === true, problem: c.coverage?.problem ?? null },
    minimum: typeof c.minimum === "number" ? c.minimum : null,
    minimumSource: typeof c.minimumSource === "string" ? c.minimumSource : null,
  };
}

const relToRun = (runDir: string, p: string): string => posix(path.relative(runDir, p));
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");

export function makeTestAdapter(spec: TestRunnerSpec): ExternalAdapter {
  const ADAPTER_ID = spec.manifest.id;

  function plan(input: ExternalPlanInput): ExternalPlan {
    const t = translator("test-stacks");
    const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
    const scanDir = root ? path.join(input.dir, ...root.split("/")) : input.dir;
    const wanted = wantedCapabilities(input);
    const { mode, integrationElsewhere } = runModeOf(wanted);
    const selection = resolveIntegrationSelection({ stack: spec.stack, config: input.config, tool: input.tool, adapter: ADAPTER_ID, scanDir });
    const detection = detectIntegration(scanDir, selection);
    const probe = spec.probe ? spec.probe(input, scanDir) : probeRunner(spec, input.env);
    const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
    const body = tools[input.tool];
    const component = isRec(body) && typeof body.component === "string" ? body.component : null;
    const minimum = policyMinimum(input.config, component);
    const coverageRequested = mode !== "integration" && wanted.has("coverage");
    const out = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
    const prepared = spec.prepare({ input, scanDir, root, mode, selection, detection, coverage: coverageRequested, out, probe });
    const command: PreparedCommand = "skip" in prepared ? { args: [], env: {}, coverage: { collected: false, problem: null } } : prepared;
    const described = describeSelection(selection);

    let availability: ExternalPlan["availability"];
    if (probe.problem === "not_found") availability = { status: "unavailable", reason: spec.imageTool ? t("test_missing", { tool: spec.tool, detail: probe.detail }) : t("test_missing_project", { tool: spec.tool, detail: probe.detail }) };
    else if (probe.version !== null && probe.version !== "0.0.0" && satisfiesRange(probe.version, spec.manifest.toolVersionRange) !== true) {
      availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: spec.tool, version: probe.version, range: spec.manifest.toolVersionRange, what: ADAPTER_ID }) };
    } else if ("skip" in prepared) availability = { status: "unavailable", reason: prepared.skip };
    else availability = { status: "available", reason: null };

    const conditions = [t("test_condition_executes")];
    if (mode === "unit" && detection.present) conditions.push(t("test_condition_unit_excludes", { selection: described }));
    if (mode === "integration") conditions.push(t(detection.present ? "test_condition_integration" : "test_no_integration", { selection: described }));
    if (coverageRequested && !command.coverage.collected && command.coverage.problem) conditions.push(command.coverage.problem);
    conditions.push(...(command.conditions ?? []));
    const contract: TestContract = {
      ...(command.contract ?? {}),
      mode,
      component,
      selection: described,
      selectionSource: selection.source === "default" ? "default" : `tools.${selection.sourceTool}.selection`,
      integrationElsewhere,
      // No integration test in the component: the step does not apply and starts nothing (never a blocker).
      nothingToRun: mode === "integration" && !detection.present,
      coverage: { requested: coverageRequested, collected: coverage(command, coverageRequested), problem: command.coverage.problem },
      minimum: minimum.value,
      minimumSource: minimum.source,
    };
    return {
      label: t(mode === "integration" ? "test_label_integration" : "test_label_unit", { tool: spec.tool }),
      command: {
        executable: probe.executable ?? spec.imageTool ?? spec.tool,
        args: [...probe.prefix, ...command.args],
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
      limitations: [t(`test_limitation_${ADAPTER_ID}`)],
      conditions,
      ...(spec.imageTool ? { imageTool: spec.imageTool } : {}),
      contract: contract as unknown as Record<string, unknown>,
      output: { format: "json", schema: null },
      // The tests are the project's code: the cache never reuses this step.
      effects: { executesProjectCode: true, workspaceWrites: command.workspaceWrites ?? [] },
    };
  }

  const coverage = (command: PreparedCommand, requested: boolean): boolean => requested && command.coverage.collected;

  async function run(context: AdapterContext, planDoc: Plan, tool: string): Promise<AdapterOutput> {
    const t = translator("test-stacks");
    const invocation = planDoc.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
    const items = planDoc.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
    if (!invocation || items.length === 0) throw new Error(t("test_no_invocation", { tool }));
    const contract = contractOf(invocation);

    const tokens = { runDir: context.runDir, workspace: context.workspacePath };
    const command = invocation.command;
    const cwd = substituteTokens(command.cwd, tokens);
    const args = command.args.map((a) => substituteTokens(a, tokens));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
    // Caches the plan redirects into the run folder exist before the runner starts.
    for (const value of Object.values(env)) if (value.startsWith(context.runDir)) fs.mkdirSync(value, { recursive: true });
    const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
    const version = items[0]?.versions.toolVersion ?? null;

    const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
    const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

    const capOf = (i: PlanItem): string => i.capabilities[0] ?? "";
    const testItems = items.filter((i) => ["unit", "tests", "integration"].includes(capOf(i)));
    const coverageItem = items.find((i) => capOf(i) === "coverage");
    const propertiesItem = items.find((i) => capOf(i) === "properties");
    const stageFor = (item: PlanItem, state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({
      id: item.id,
      label: item.label,
      kind: "step",
      adapter: ADAPTER_ID,
      state,
      ...(reason ? { reason } : {}),
      ...extra,
    });
    const scope = contract.component ? "component" : "workspace";
    const withComponent = contract.component ? { component: contract.component } : {};
    const notMeasured = (reason: string): ResultMetric => ({ id: "coverage.lines", label: t("test_metric_coverage"), unit: "percent", measured: false, reason, ...withComponent, scope, origin: ADAPTER_ID });
    const base = {
      requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
      disabled: [],
      logs: [] as string[],
      outputs: [relToRun(context.runDir, outDir)],
    };
    const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({
      ...base,
      stages: items.map((i) => stageFor(i, state, reason, extra)),
      findings: [],
      metrics: coverageItem ? [notMeasured(reason)] : [],
    });

    const unavailable = items.find((i) => i.availability.status !== "available");
    if (unavailable) return all("blocked", unavailable.availability.reason ?? t("test_blocked", { tool: spec.tool, detail: command.executable }));
    if (contract.nothingToRun) return { ...base, stages: items.map((i) => stageFor(i, "not_applicable", t("test_no_integration", { selection: contract.selection }))), findings: [] };

    const result: ExecutionResult = await runSpec(
      { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
      { parentEnv: context.env, envAllowlist: ENV_ALLOWLIST },
    );
    base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];
    const withLogs = (o: AdapterOutput): AdapterOutput => ({ ...o, logs: base.logs });

    if (result.spawnError) return withLogs(all("blocked", t("test_blocked", { tool: spec.tool, detail: `${result.spawnError.code}: ${result.spawnError.message}` })));
    if (result.cancelled) return withLogs(all("cancelled", t("test_cancelled", { tool: spec.tool })));
    if (result.timedOut) return withLogs(all("timeout", t("test_timeout", { tool: spec.tool, seconds: timeoutSeconds })));

    const view = (p: string): string => stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, p);
    const readInput: ReadInput = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, outDir, contract, workspaceView: view(context.workspacePath), cwdView: view(cwd), workspace: context.workspacePath, cwd };
    const reading = spec.read(readInput);
    const native = `exit ${result.exitCode ?? "-"}`;
    const failureCodes = spec.failureExitCodes ?? [1];
    const failed = reading.tests.cases.filter((c) => c.status === "failed");
    const untrusted = (detail: string): AdapterOutput =>
      withLogs({
        ...base,
        stages: items.map((i) => stageFor(i, "error", detail, { interpreted: false, nativeStatus: native })),
        findings: [],
        metrics: coverageItem ? [notMeasured(t("test_cov_blocked_by_exit"))] : [],
      });
    if (!reading.tests.ok || result.truncated) {
      // No report: nothing proves what the tests did, whatever the exit code says.
      const why = result.truncated ? "output truncated" : (reading.tests.problem ?? "");
      return untrusted(t("test_exit_error", { tool: spec.tool, code: result.exitCode ?? "-", detail: `${why} ${tail(result.stderr || result.stdout)}`.trim() || "-" }));
    }
    if (result.exitCode !== 0 && !(result.exitCode !== null && failureCodes.includes(result.exitCode) && failed.length > 0)) {
      return untrusted(t("test_exit_mismatch", { tool: spec.tool, code: result.exitCode ?? "-", failed: failed.length, detail: tail(result.stderr) || "-" }));
    }
    if (result.exitCode === 0 && failed.length > 0) return untrusted(t("test_exit_mismatch", { tool: spec.tool, code: 0, failed: failed.length, detail: "-" }));

    const cases = reading.tests.cases.filter((c) => !c.suite);
    const props = spec.properties(cases, readInput);
    const propertyCases = cases.filter((c) => c.status !== "skipped" && props.isProperty(c));
    const propertyFailed = propertyCases.filter((c) => c.status === "failed");
    const executed = cases.filter((c) => c.status !== "skipped").length;
    const skipped = cases.filter((c) => c.status === "skipped").length;

    const findings: ResultFinding[] = [];
    const metrics: ResultMetric[] = [];
    const stages: ResultStage[] = [];
    const testOwner = testItems.find((i) => capOf(i) !== "integration" || contract.mode === "integration") ?? coverageItem ?? propertiesItem ?? (items[0] as PlanItem);
    const baseFinding = { tool: ADAPTER_ID, ...(version ? { toolVersion: version } : {}), category: "tests", severity: "error", normalizedSeverity: "high" as const, origin: ADAPTER_ID, blocking: true, blockingReason: "blocking-tool" as const, waived: false };
    for (const c of reading.tests.cases.filter((x) => x.status === "failed")) {
      const property = !c.suite && props.isProperty(c);
      const owner = property && propertiesItem ? propertiesItem : testOwner;
      findings.push({
        ...baseFinding,
        stageId: owner.id,
        ruleId: `${ADAPTER_ID}.${c.suite ? "suite-failed" : property ? "property-failed" : "test-failed"}`,
        message: t(c.suite ? "test_finding_suite" : property ? "test_finding_property" : "test_finding_test", { name: c.name, message: c.message || "-" }),
        ...(c.file ? { location: { path: c.file, ...(c.line !== null ? { line: c.line } : {}) } } : {}),
        fingerprint: contentHash({ tool: ADAPTER_ID, rule: property ? "property" : c.suite ? "suite" : "test", test: c.name, file: c.file }),
      });
    }
    const count = (id: string, key: string, value: number): ResultMetric => ({ id, label: t(key), unit: "count", value, ...withComponent, scope, origin: ADAPTER_ID });
    const prefix = contract.mode === "integration" ? "tests.integration" : "tests";
    metrics.push(count(`${prefix}.executed`, "test_metric_executed", executed), count(`${prefix}.passed`, "test_metric_passed", executed - failed.filter((c) => !c.suite).length), count(`${prefix}.failed`, "test_metric_failed", failed.length), count(`${prefix}.skipped`, "test_metric_skipped", skipped));
    // A component without the property framework gets no property metric; one that uses it gets them even at zero.
    if (props.uses && contract.mode !== "integration") metrics.push(count("tests.property.total", "test_metric_property_total", propertyCases.length), count("tests.property.failed", "test_metric_property_failed", propertyFailed.length));

    const findingsOf = (item: PlanItem): number => findings.filter((f) => f.stageId === item.id).length;
    for (const item of testItems) {
      if (capOf(item) === "integration" && contract.mode !== "integration") {
        stages.push(stageFor(item, "blocked", t("test_integration_own_instance", { tool }), {}));
        continue;
      }
      if (executed === 0 && failed.length === 0) {
        stages.push(stageFor(item, "completed", t("test_no_tests", { tool: spec.tool, selection: contract.selection }), { interpreted: false, nativeStatus: native }));
        continue;
      }
      const n = findingsOf(item);
      const reason =
        contract.mode === "integration"
          ? t("test_reason_integration", { tool: spec.tool, version: version ?? "?", selection: contract.selection, executed, failed: failed.length, skipped })
          : t("test_reason_tests", { tool: spec.tool, version: version ?? "?", executed, failed: failed.length, skipped });
      stages.push(stageFor(item, "completed", reason, { blockingViolations: n, findings: n, nativeStatus: native }));
    }

    if (coverageItem) {
      const unmeasured = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): void => {
        stages.push(stageFor(coverageItem, state, reason, extra));
        metrics.push(notMeasured(reason));
      };
      const cov = reading.coverage;
      if (!contract.coverage.collected) unmeasured("blocked", contract.coverage.problem ?? t("test_cov_not_collected", { tool: spec.tool }));
      else if (!cov || !cov.ok) unmeasured("completed", t("test_cov_unreadable", { detail: cov && !cov.ok ? cov.problem : "-" }), { interpreted: false, nativeStatus: native });
      else if (cov.total === 0) unmeasured("completed", t("test_cov_empty"), { interpreted: false, nativeStatus: native });
      else {
        const metric = ratioMetric({ id: "coverage.lines", label: t("test_metric_coverage"), numerator: cov.covered, denominator: cov.total, ...withComponent, scope, origin: ADAPTER_ID, basis: cov.basis, format: cov.format });
        metrics.push(metric);
        const percent = metric.value as number;
        const below = contract.minimum !== null && percent < contract.minimum;
        if (below) {
          findings.push({
            ...baseFinding,
            stageId: coverageItem.id,
            ruleId: `${ADAPTER_ID}.coverage-below-minimum`,
            category: "coverage",
            message: t("test_cov_below", { component: contract.component ?? ".", percent, covered: cov.covered, total: cov.total, minimum: contract.minimum as number, source: contract.minimumSource ?? "-" }),
            fingerprint: contentHash({ tool: ADAPTER_ID, rule: "coverage-below-minimum", component: contract.component, minimum: contract.minimum }),
          });
        }
        const reason = contract.minimum !== null ? t("test_cov_reason", { percent, covered: cov.covered, total: cov.total, minimum: contract.minimum }) : t("test_cov_reason_nomin", { percent, covered: cov.covered, total: cov.total });
        stages.push(stageFor(coverageItem, "completed", reason, { blockingViolations: below ? 1 : 0, findings: below ? 1 : 0, nativeStatus: native }));
      }
    }

    if (propertiesItem) {
      if (!props.uses || propertyCases.length === 0) stages.push(stageFor(propertiesItem, "not_applicable", t("test_reason_no_properties", { framework: spec.framework })));
      else {
        const n = findingsOf(propertiesItem);
        stages.push(stageFor(propertiesItem, "completed", t("test_reason_properties", { framework: spec.framework, total: propertyCases.length, failed: propertyFailed.length }), { blockingViolations: n, findings: n, nativeStatus: native }));
      }
    }
    return { ...base, stages, findings, metrics };
  }

  return { manifest: spec.manifest, plan, run };
}

/** A path the runner printed as the workspace-relative POSIX path the result stores (null outside the workspace). */
export function workspaceRelative(printed: string, workspaceView: string, cwdView: string): string | null {
  if (!printed) return null;
  const file = printed.replace(/\\/g, "/");
  const ws = workspaceView.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = file.startsWith("/") || /^[A-Za-z]:\//.test(file) ? file : `${cwdView.replace(/\\/g, "/").replace(/\/+$/, "")}/${file}`;
  const norm = path.posix.normalize(abs);
  const lower = (s: string): string => (/^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s);
  if (lower(norm).startsWith(`${lower(ws)}/`)) return norm.slice(ws.length + 1);
  return null;
}

/** The text of a file in the run folder, or null. */
export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** First meaningful line of a message, bounded. */
export function firstLine(message: string, max = 300): string {
  // eslint-disable-next-line no-control-regex
  const plain = message.replace(/\u001b\[[0-9;]*m/g, "");
  const line = (plain.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
