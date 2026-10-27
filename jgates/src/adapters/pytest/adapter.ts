// pytest adapter, execution: one `python -m pytest` per tool instance in the component, with the JUnit XML and the
// coverage report (pytest-cov) written in the run folder, no cache provider and no bytecode in the workspace. pytest
// executes the project's tests and conftest.py, so the plan declares it and the cache never reuses the result.
// Coverage is measured with its numerator, denominator and component; a missing report is "not measured", never 0%
// or passed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { ratioMetric } from "../../core/results/metrics.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultMetric, ResultStage } from "../../core/run/types.js";
import { choosePytestConfig } from "./config.js";
import { findCoverageConfig, parseCoverageJson } from "./coverage.js";
import { caseFile, parseJunit } from "./junit.js";
import { pytestManifest } from "./manifest.js";
import { probePytest } from "./probe.js";

const ADAPTER_ID = pytestManifest.id;
const WORKSPACE = "{workspace}";
const RUN_DIR = "{runDir}";
const MIN_RULE = "coverage.minimum";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the plan records about an instance (the plan hash covers it) and the run reads back. */
interface PytestContract {
  component: string | null;
  root: string | null;
  /** The coverage capability is selected for this run. */
  coverageSelected: boolean;
  /** `--cov` is on the command (selected and the plugin answers). */
  coverageInCommand: boolean;
  /** What `--cov` measures: a path, "config" (the component's own coverage configuration) or null. */
  coverageSource: string | null;
  minimum: number | null;
  minimumSource: string | null;
  junit: string;
  report: string;
}

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** The capabilities of the instance that are on in this run (all of them when the selection is not available). */
function selectedCapabilities(input: ExternalPlanInput): Set<string> {
  const all = new Set<string>(pytestManifest.capabilities);
  const selection = (input as { selection?: { items?: Array<{ kind?: string; id?: string; capabilities?: Array<{ capability: string | null; enabled: boolean }> }> } }).selection;
  const item = selection?.items?.find((i) => i.kind === "tool" && i.id === input.tool);
  if (!item?.capabilities) return all;
  return new Set(item.capabilities.filter((p) => p.enabled && p.capability !== null).map((p) => p.capability as string));
}

/** The minimum line coverage of the policy: `coverage.minimum.<component>` over `coverage.minimum` (rules.<id>.threshold). */
function policyMinimum(config: Rec | undefined, component: string | null): { value: number | null; source: string | null } {
  const policy = config && isRec(config.policy) ? config.policy : {};
  const rules = isRec(policy.rules) ? policy.rules : {};
  for (const id of [...(component ? [`${MIN_RULE}.${component}`] : []), MIN_RULE]) {
    const rule = rules[id];
    if (isRec(rule) && rule.enabled !== false && typeof rule.threshold === "number" && Number.isFinite(rule.threshold)) {
      return { value: rule.threshold, source: `policy.rules.${id}` };
    }
  }
  return { value: null, source: null };
}

function planPytest(input: ExternalPlanInput): ExternalPlan {
  const t = translator("pytest");
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const cwdAbs = root ? path.join(input.dir, root) : input.dir;
  const config = choosePytestConfig(input.dir, input.tool, input.componentRoot);
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = tools[input.tool];
  const component = isRec(body) && typeof body.component === "string" ? body.component : null;
  const capabilities = selectedCapabilities(input);
  const coverageSelected = capabilities.has("coverage");
  const probe = probePytest(input.env, cwdAbs);
  const coverageConfig = findCoverageConfig(input.dir, input.componentRoot);
  const hasSrc = fs.existsSync(path.join(cwdAbs, "src"));
  const coverageSource = coverageConfig.file !== null ? "config" : hasSrc ? "src" : ".";
  const coverageInCommand = coverageSelected && probe.coverage;
  const minimum = policyMinimum(input.config, component);

  const out = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const junit = `${out}/junit.xml`;
  const report = `${out}/coverage.json`;
  const args = [
    "-m",
    "pytest",
    // Nothing is cached in the workspace (.pytest_cache); the manifest declares the flag.
    "-p",
    "no:cacheprovider",
    "-o",
    "junit_family=xunit2",
    `--junitxml=${junit}`,
    ...(config.source === "binding" && config.file ? ["-c", `${WORKSPACE}/${config.file}`] : []),
    ...(coverageInCommand ? [coverageSource === "config" ? "--cov" : `--cov=${coverageSource}`, `--cov-report=json:${report}`] : []),
  ];
  const env: Record<string, string> = {
    PYTHONDONTWRITEBYTECODE: "1",
    COVERAGE_FILE: `${out}/.coverage`,
    ...(hasSrc ? { PYTHONPATH: `${WORKSPACE}/${root ? `${root}/` : ""}src` } : {}),
  };

  const files = new Map<string, string | null>();
  if (config.file) files.set(config.file, sha256File(path.join(input.dir, config.file)));
  for (const f of coverageConfig.present) files.set(f, sha256File(path.join(input.dir, f)));

  let availability: ExternalPlan["availability"];
  if (probe.problem === "python_missing") availability = { status: "unavailable", reason: t("pytest_python_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_pytest") availability = { status: "unavailable", reason: t("pytest_missing", { python: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, pytestManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: pytestManifest.toolName, version: probe.version, range: pytestManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else availability = { status: "available", reason: null };

  const contract: PytestContract = {
    component,
    root,
    coverageSelected,
    coverageInCommand,
    coverageSource: coverageInCommand ? coverageSource : null,
    minimum: minimum.value,
    minimumSource: minimum.source,
    junit,
    report,
  };
  return {
    label: t("pytest_label"),
    command: { executable: probe.python ?? "python", args, cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE, env, stdin: null },
    runtime: { name: "native", interpreter: probe.python, available: probe.python !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: [...files].map(([file, sha256]) => ({ file, sha256 })),
    availability,
    blocksPlan: false,
    network: false,
    limitations: [t("pytest_limitation_executes"), ...(coverageSelected && !probe.coverage && probe.version !== null ? [t("pytest_limitation_cov_missing")] : [])],
    conditions: [
      t("pytest_condition_runs"),
      ...(coverageInCommand ? [t("pytest_condition_coverage", { source: coverageSource === "config" ? (config.file ?? "config") : coverageSource })] : []),
      ...(hasSrc ? [t("pytest_condition_pythonpath", { dir: `${root ? `${root}/` : ""}src` })] : []),
    ],
    output: { format: "junit-xml", schema: null },
    effects: { executesProjectCode: true },
    contract: contract as unknown as Record<string, unknown>,
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

function contractOf(invocation: Plan["invocations"][number]): PytestContract {
  const c = (invocation.contract ?? {}) as Partial<PytestContract>;
  return {
    component: c.component ?? null,
    root: c.root ?? null,
    coverageSelected: c.coverageSelected === true,
    coverageInCommand: c.coverageInCommand === true,
    coverageSource: c.coverageSource ?? null,
    minimum: typeof c.minimum === "number" ? c.minimum : null,
    minimumSource: c.minimumSource ?? null,
    junit: c.junit ?? "",
    report: c.report ?? "",
  };
}

async function runPytest(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("pytest");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("pytest_no_invocation", { tool }));
  const contract = contractOf(invocation);

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = { PATH: context.env.PATH ?? "" };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const junitFile = substituteTokens(contract.junit, tokens);
  const reportFile = substituteTokens(contract.report, tokens);
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

  const unitItem = items.find((i) => i.capabilities.includes("unit"));
  const coverageItem = items.find((i) => i.capabilities.includes("coverage"));
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
  const notMeasured = (reason: string): ResultMetric => ({
    id: "coverage.lines",
    label: t("pytest_metric_coverage"),
    unit: "percent",
    measured: false,
    reason,
    basis: "lines",
    ...withComponent,
    scope,
    origin: ADAPTER_ID,
  });
  const base = {
    requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
    disabled: [],
    logs: [] as string[],
    outputs: [relToRun(context.runDir, outDir)],
  };
  /** Every stage in one state; the coverage metric is reported as not measured with the same reason. */
  const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({
    ...base,
    stages: items.map((i) => stageFor(i, state, reason, extra)),
    findings: [],
    metrics: coverageItem ? [notMeasured(reason)] : [],
  });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("pytest_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];
  const withLogs = (o: AdapterOutput): AdapterOutput => ({ ...o, logs: base.logs });

  if (result.spawnError) return withLogs(all("blocked", t("pytest_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })));
  if (result.timedOut) return withLogs(all("timeout", t("pytest_timeout", { seconds: timeoutSeconds })));
  // 0: all passed; 1: some tests failed. Anything else (2 interrupted, 3 internal, 4 usage, 5 no tests, a signal) proves nothing.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    const reason = result.exitCode === 5 ? t("pytest_no_tests") : t("pytest_exit_error", { code: result.exitCode ?? "-", detail });
    return withLogs({
      ...base,
      stages: items.map((i) => stageFor(i, "error", i === coverageItem ? `${t("pytest_cov_blocked_by_exit")} ${reason}` : reason, { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` })),
      findings: [],
      metrics: coverageItem ? [notMeasured(t("pytest_cov_blocked_by_exit"))] : [],
    });
  }

  const stages: ResultStage[] = [];
  const findings: ResultFinding[] = [];
  const metrics: ResultMetric[] = [];

  if (unitItem) {
    const untrusted = (detail: string, native: string): void => {
      stages.push(stageFor(unitItem, "completed", t("pytest_invalid_junit", { detail }), { interpreted: false, nativeStatus: native }));
    };
    let xml: string | null = null;
    try {
      xml = fs.readFileSync(junitFile, "utf8");
    } catch (error) {
      untrusted((error as Error).message, `exit ${result.exitCode}`);
    }
    if (xml !== null) {
      const junit = parseJunit(xml);
      const bad = junit.failed + junit.errors;
      if (!junit.ok || junit.total === 0) {
        untrusted(junit.problem ?? "no test case", `exit ${result.exitCode}`);
      } else if (result.exitCode === 1 && bad === 0) {
        stages.push(stageFor(unitItem, "completed", t("pytest_exit_mismatch"), { interpreted: false, nativeStatus: "exit 1" }));
      } else {
        for (const c of junit.cases) {
          if (c.outcome !== "failed" && c.outcome !== "error") continue;
          const test = `${c.classname}::${c.name}`;
          const file = caseFile(c.classname, cwd, context.workspacePath);
          findings.push({
            stageId: unitItem.id,
            tool: ADAPTER_ID,
            ...(version ? { toolVersion: version } : {}),
            ruleId: c.outcome === "failed" ? "test-failed" : "test-error",
            category: "tests",
            severity: "error",
            normalizedSeverity: "high",
            message: t(c.outcome === "failed" ? "pytest_test_failed" : "pytest_test_error", { test, message: c.message || "-" }),
            ...(file ? { location: { path: file } } : {}),
            fingerprint: contentHash({ tool: ADAPTER_ID, rule: c.outcome, test }),
            origin: ADAPTER_ID,
            blocking: true,
            blockingReason: "blocking-tool",
            waived: false,
          });
        }
        stages.push(
          stageFor(unitItem, "completed", t("pytest_reason_tests", { version: version ?? "?", total: junit.total, failed: junit.failed, errors: junit.errors, skipped: junit.skipped }), {
            blockingViolations: bad,
            findings: bad,
            nativeStatus: `exit ${result.exitCode}`,
          }),
        );
        const count = (id: string, key: string, value: number): ResultMetric => ({ id, label: t(key), unit: "count", value, ...withComponent, scope, origin: ADAPTER_ID });
        metrics.push(count("tests.total", "pytest_metric_tests_total", junit.total), count("tests.failed", "pytest_metric_tests_failed", bad), count("tests.skipped", "pytest_metric_tests_skipped", junit.skipped));
      }
    }
  }

  if (coverageItem) {
    const unmeasured = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): void => {
      stages.push(stageFor(coverageItem, state, reason, extra));
      metrics.push(notMeasured(reason));
    };
    if (!contract.coverageInCommand) {
      unmeasured("blocked", t("pytest_cov_missing", { python: command.executable }));
    } else {
      let text: string | null = null;
      let problem = "";
      try {
        text = fs.readFileSync(reportFile, "utf8");
      } catch (error) {
        problem = (error as Error).message;
      }
      const reading = text === null ? null : parseCoverageJson(text);
      if (reading === null || !reading.ok) {
        unmeasured("completed", t("pytest_cov_unreadable", { detail: reading?.problem ?? problem }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` });
      } else if (reading.statements === 0) {
        unmeasured("completed", t("pytest_cov_empty"), { interpreted: false, nativeStatus: `exit ${result.exitCode}` });
      } else {
        const exclusions = [t("pytest_exclusion_source", { source: contract.coverageSource ?? "-" }), ...(reading.excluded > 0 ? [t("pytest_exclusion_pragma", { count: reading.excluded })] : [])];
        const metric = ratioMetric({
          id: "coverage.lines",
          label: t("pytest_metric_coverage"),
          numerator: reading.covered,
          denominator: reading.statements,
          ...withComponent,
          scope,
          origin: ADAPTER_ID,
          basis: reading.branch ? "lines+branches" : "lines",
          exclusions,
          format: "coverage.py json",
        });
        metrics.push(metric);
        const percent = metric.value as number;
        const below = contract.minimum !== null && percent < contract.minimum;
        if (below) {
          findings.push({
            stageId: coverageItem.id,
            tool: ADAPTER_ID,
            ...(version ? { toolVersion: version } : {}),
            ruleId: "coverage-below-minimum",
            category: "tests",
            severity: "error",
            normalizedSeverity: "high",
            message: t("pytest_cov_below", { component: contract.component ?? ".", percent, covered: reading.covered, statements: reading.statements, minimum: contract.minimum as number, source: contract.minimumSource ?? "-" }),
            fingerprint: contentHash({ tool: ADAPTER_ID, rule: "coverage-below-minimum", component: contract.component, minimum: contract.minimum }),
            origin: ADAPTER_ID,
            blocking: true,
            blockingReason: "blocking-tool",
            waived: false,
          });
        }
        const reason =
          contract.minimum !== null
            ? t("pytest_cov_reason", { percent, covered: reading.covered, statements: reading.statements, minimum: contract.minimum })
            : t("pytest_cov_reason_nomin", { percent, covered: reading.covered, statements: reading.statements });
        stages.push(stageFor(coverageItem, "completed", reason, { blockingViolations: below ? 1 : 0, findings: below ? 1 : 0, nativeStatus: `exit ${result.exitCode}` }));
      }
    }
  }

  return { ...base, stages, findings, metrics };
}

export const pytestAdapter: ExternalAdapter = {
  manifest: pytestManifest,
  plan: planPytest,
  run: runPytest,
};
