// Vitest adapter: plans one `vitest run` per tool instance (JSON reporter, and the v8 coverage provider when coverage
// is selected and the provider pinned to Vitest's version is installed), with every output in the run folder, and reads
// the tests and the line coverage back. It never installs anything: a missing provider blocks the coverage stage with
// the instruction. The tests execute the project's code, so the cache never reuses this step.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { ratioMetric } from "../../core/results/index.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";
import { vitestManifest } from "./manifest.js";
import { parseLineCoverage, parseVitestReport, thresholdMessage, type VitestReport } from "./normalize.js";
import { COVERAGE_PROVIDER, findCoverageProvider, findVitest } from "./probe.js";

export { vitestManifest } from "./manifest.js";
export { parseLineCoverage, parseVitestReport } from "./normalize.js";
export { findCoverageProvider, findVitest } from "./probe.js";

/** Vitest resolves vitest.config.* first, then vite.config.* (which may hold a `test` block). */
export const VITEST_CONFIG_FILES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
] as const;

/** The configuration file Vitest would pick in `dir` (relative name), by existence only: nothing is read or executed. */
export function findVitestConfig(dir: string): string | null {
  for (const name of VITEST_CONFIG_FILES) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return name;
    } catch {
      // not there
    }
  }
  return null;
}

/** The `config` binding of a tools.yml instance for the config found in `dir`, at the "editable file" level. */
export function vitestBinding(dir: string): { adapter: string; config: string } | null {
  const file = findVitestConfig(dir);
  return file ? { adapter: vitestManifest.id, config: file } : null;
}

const ADAPTER_ID = vitestManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";
const UNIT = "unit";
const COVERAGE = "coverage";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** Capabilities the instance asks for: the selection of the plan when it has one, else what tools.yml/the template list. */
function wantedCapabilities(input: ExternalPlanInput): Set<string> {
  const selection = (input as { selection?: { items?: Array<{ kind: string; id: string; capabilities?: Array<{ capability?: string; enabled: boolean }> }> } }).selection;
  const item = selection?.items?.find((i) => i.kind === "tool" && i.id === input.tool);
  if (item?.capabilities) return new Set(item.capabilities.filter((c) => c.enabled).map((c) => c.capability ?? ""));
  const body = isRec(input.config?.tools) ? (input.config?.tools as Record<string, unknown>)[input.tool] : undefined;
  const list = isRec(body) && Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [input.capability];
  return new Set(list);
}

/** The configuration file of the instance: the tools.yml binding, else the one Vitest resolves itself. */
function chooseConfig(input: ExternalPlanInput): { file: string | null; source: "binding" | "native" | "none"; shadowed: string | null } {
  try {
    const bound = resolveToolBindings(input.dir, { skipInventory: true, manifests: [vitestManifest] }).instances.find((i) => i.id === input.tool);
    const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.relPath !== null && b.exists);
    if (binding?.relPath) return { file: binding.relPath, source: "binding", shadowed: null };
  } catch {
    // an unreadable tools.yml is reported by config validate; the native resolution still applies
  }
  const base = input.componentRoot && input.componentRoot !== "." ? path.join(input.dir, input.componentRoot) : input.dir;
  const found = findVitestConfig(base);
  if (!found) return { file: null, source: "none", shadowed: null };
  const rel = (name: string): string => (input.componentRoot && input.componentRoot !== "." ? `${input.componentRoot}/${name}` : name);
  // vitest.config.* wins over vite.config.* in the same directory: the second one is then not read by Vitest.
  const shadowed = found.startsWith("vitest.config.") ? VITEST_CONFIG_FILES.find((n) => n.startsWith("vite.config.") && isFile(path.join(base, n))) : undefined;
  return { file: rel(found), source: "native", shadowed: shadowed ? rel(shadowed) : null };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const outDirToken = (tool: string): string => `${RUN_DIR}/outputs/${ADAPTER_ID}/${tool}`;

function planVitest(input: ExternalPlanInput): ExternalPlan {
  const t = translator("vitest");
  const probe = findVitest(input.dir, input.componentRoot, input.env);
  const config = chooseConfig(input);
  const wanted = wantedCapabilities(input);
  const wantsCoverage = wanted.has(COVERAGE);
  const provider = findCoverageProvider(input.dir, input.componentRoot, probe);
  const coverageReady = probe.version !== null && provider.installed && !provider.mismatch;
  const out = outDirToken(input.tool);
  const args = [
    ...probe.prefix,
    "run",
    ...(config.source === "binding" && config.file ? ["--config", `${WORKSPACE}/${config.file}`] : []),
    "--reporter=json",
    `--outputFile=${out}/vitest.json`,
    // Nothing of Vitest's own caches goes to the project: results and transformed modules stay off.
    "--no-cache",
    "--no-fsModuleCache",
    ...(wantsCoverage && coverageReady
      ? ["--coverage.enabled", "--coverage.provider=v8", "--coverage.reporter=json-summary", "--coverage.reportOnFailure", `--coverage.reportsDirectory=${out}/coverage`]
      : []),
  ];
  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("vitest_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_version") availability = { status: "unavailable", reason: t("vitest_no_version", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, vitestManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: vitestManifest.toolName, version: probe.version, range: vitestManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else availability = { status: "available", reason: null };

  const conditions: string[] = [t("vitest_condition_executes")];
  if (config.file) conditions.push(t(config.source === "binding" ? "vitest_condition_config_binding" : "vitest_condition_config_native", { file: config.file }));
  else conditions.push(t("vitest_condition_config_none"));
  if (config.shadowed) conditions.push(t("vitest_condition_shadowed", { config: config.file ?? "-", shadowed: config.shadowed }));
  if (wantsCoverage && !coverageReady && probe.version !== null) {
    conditions.push(provider.installed ? t("vitest_condition_provider_mismatch", { provider: COVERAGE_PROVIDER, found: provider.version ?? "?", version: probe.version }) : t("vitest_condition_provider_missing", { provider: COVERAGE_PROVIDER }));
  }
  return {
    label: t("vitest_label"),
    command: {
      executable: probe.executable ?? "vitest",
      args,
      cwd: input.componentRoot && input.componentRoot !== "." ? `${WORKSPACE}/${input.componentRoot}` : WORKSPACE,
      env: { CI: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: config.file ? [{ file: config.file, sha256: sha256File(path.join(input.dir, config.file)) }] : [],
    availability,
    blocksPlan: false,
    network: false,
    limitations: [],
    conditions,
    output: { format: "json", schema: null },
    // The tests, the configuration and the setup files are the project's code: the cache never reuses this step.
    effects: { executesProjectCode: true },
    contract: { coverage: { requested: wantsCoverage, collected: wantsCoverage && coverageReady, provider: COVERAGE_PROVIDER, providerVersion: provider.version } },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");

async function runVitest(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("vitest");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("vitest_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = { PATH: context.env.PATH ?? "" };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const collected = args.some((a) => a.startsWith("--coverage.enabled"));

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const reportFile = path.join(outDir, "vitest.json");
  const summaryFile = path.join(outDir, "coverage", "coverage-summary.json");
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

  const capOf = (i: PlanItem): string => i.capabilities[0] ?? "";
  const unitItem = items.find((i) => capOf(i) === UNIT);
  const coverageItem = items.find((i) => capOf(i) === COVERAGE);
  const testItem = unitItem ?? items[0];
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
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("vitest_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...all("blocked", t("vitest_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...all("timeout", t("vitest_timeout", { seconds: timeoutSeconds })), logs: base.logs };

  let report: VitestReport | null = null;
  let reportProblem = "";
  try {
    report = parseVitestReport(fs.readFileSync(reportFile, "utf8"), context.workspacePath);
    if (!report.ok) {
      reportProblem = report.problem ?? "";
      report = null;
    }
  } catch (error) {
    reportProblem = (error as Error).message;
  }
  if (result.truncated && report) {
    reportProblem = "output truncated";
    report = null;
  }
  if (!report) {
    // No report: nothing proves what the tests did, whatever the exit code says.
    const detail = result.exitCode === 0 ? reportProblem : `${t("vitest_exit_error", { code: result.exitCode ?? "-", detail: tail(result.stderr) || String(result.signal ?? "") })} (${reportProblem})`;
    return { ...all("error", result.exitCode === 0 ? t("vitest_invalid_output", { detail }) : detail, { interpreted: false }), logs: base.logs };
  }

  const stages: ResultStage[] = [];
  const findings: ResultFinding[] = [];
  const metrics: NonNullable<AdapterOutput["metrics"]> = [];
  const failedStage = testItem as PlanItem;
  const baseFinding = { tool: ADAPTER_ID, ...(version ? { toolVersion: version } : {}), category: "tests", severity: "error", normalizedSeverity: "high" as const, origin: ADAPTER_ID, blocking: true, blockingReason: "blocking-tool" as const, waived: false };
  for (const f of report.failures) {
    findings.push({
      ...baseFinding,
      stageId: failedStage.id,
      ruleId: f.suite ? "vitest.suite-failed" : "vitest.test-failed",
      message: t(f.suite ? "vitest_finding_suite" : "vitest_finding_test", { name: f.name, message: f.message || "-" }),
      ...(f.file ? { location: { path: f.file, ...(f.line !== null ? { line: f.line } : {}), ...(f.column !== null ? { column: f.column } : {}) } } : {}),
    });
  }
  const counts = report.counts;
  metrics.push(
    { id: "tests.executed", label: t("vitest_metric_executed"), unit: "count", value: counts.passed + counts.failed, scope: "workspace", origin: ADAPTER_ID },
    { id: "tests.passed", label: t("vitest_metric_passed"), unit: "count", value: counts.passed, scope: "workspace", origin: ADAPTER_ID },
    { id: "tests.failed", label: t("vitest_metric_failed"), unit: "count", value: counts.failed, scope: "workspace", origin: ADAPTER_ID },
    { id: "tests.skipped", label: t("vitest_metric_skipped"), unit: "count", value: counts.skipped, scope: "workspace", origin: ADAPTER_ID },
  );

  // The coverage threshold is checked by Vitest itself: the exit code says it failed although every test passed.
  const thresholdFailed = collected && report.success && result.exitCode !== 0;
  if (!report.success && report.failures.length === 0) {
    return { ...all("error", t("vitest_exit_error", { code: result.exitCode ?? "-", detail: tail(result.stderr) || "-" }), { interpreted: false }), logs: base.logs };
  }

  if (unitItem) {
    const failed = report.failures.length;
    stages.push(stageFor(unitItem, "completed", t("vitest_reason_tests", { version: version ?? "?", executed: counts.passed + counts.failed, failed, skipped: counts.skipped }), { blockingViolations: failed, findings: failed, nativeStatus: `exit ${result.exitCode ?? "-"}` }));
  }
  if (coverageItem) {
    if (!collected) {
      stages.push(stageFor(coverageItem, "blocked", coverageInstruction(context, version, t)));
    } else {
      let summary: ReturnType<typeof parseLineCoverage> | null = null;
      try {
        summary = parseLineCoverage(fs.readFileSync(summaryFile, "utf8"));
      } catch (error) {
        summary = { ok: false, problem: (error as Error).message };
      }
      if (!summary.ok) {
        stages.push(stageFor(coverageItem, "error", t("vitest_coverage_missing", { detail: summary.problem }), { interpreted: false }));
      } else {
        metrics.push(ratioMetric({ id: "coverage.lines", label: t("vitest_metric_coverage_lines"), numerator: summary.lines.covered, denominator: summary.lines.total, scope: "workspace", origin: ADAPTER_ID }));
        let blocking = 0;
        if (thresholdFailed) {
          blocking = 1;
          findings.push({
            ...baseFinding,
            stageId: coverageItem.id,
            ruleId: "vitest.coverage-threshold",
            category: "coverage",
            message: t("vitest_finding_threshold", { message: thresholdMessage(result.stderr) ?? t("vitest_threshold_generic") }),
          });
        }
        const pct = summary.lines.total === 0 ? 0 : Math.round((summary.lines.covered / summary.lines.total) * 10000) / 100;
        stages.push(stageFor(coverageItem, "completed", t("vitest_reason_coverage", { covered: summary.lines.covered, total: summary.lines.total, percent: pct }), { blockingViolations: blocking, findings: blocking, nativeStatus: `exit ${result.exitCode ?? "-"}` }));
      }
    }
  }
  // Findings of a stage that is not in the plan (only coverage selected) have the coverage stage as owner.
  return { ...base, stages, findings: findings.filter((f) => stages.some((s) => s.id === f.stageId)), metrics };
}

function coverageInstruction(context: AdapterContext, version: string | null, t: ReturnType<typeof translator>): string {
  const probe = findVitest(context.workspacePath, null, context.env);
  const provider = findCoverageProvider(context.workspacePath, null, probe);
  const pinned = version ?? probe.version ?? "<versão do vitest>";
  if (provider.installed && provider.mismatch) return t("vitest_coverage_provider_mismatch", { provider: COVERAGE_PROVIDER, found: provider.version ?? "?", version: pinned });
  return t("vitest_coverage_provider_missing", { provider: COVERAGE_PROVIDER, version: pinned });
}

export const vitestAdapter: ExternalAdapter = {
  manifest: vitestManifest,
  plan: planVitest,
  run: runVitest,
};
