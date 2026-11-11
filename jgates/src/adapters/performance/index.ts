// performance adapter: runs the component's language-native benchmarks in the step container of the tools image and
// compares their mean times with the instance's budgets and with a stored baseline:
//   - Python: python -m pytest --benchmark-only --benchmark-json (pytest-benchmark, the project's own);
//   - TypeScript/JavaScript: vitest bench --run --outputJson (the project's vitest, else the tools image's);
//   - Go: go test -run ^$ -bench . ./... (the text report);
//   - Rust: cargo bench --offline -- --output-format bencher (criterion);
//   - .NET: dotnet run -c Release (BenchmarkDotNet, in process, short job, JSON exporter into the run folder).
// A benchmark over its budget, a regression over the baseline by more than the allowed percent, and a budget whose
// benchmark did not run are blocking findings; every mean is a metric, and the run writes a baseline candidate with them.
// A harness that fails or a report that is missing is an error stage, never a pass.
import fs from "node:fs";
import path from "node:path";
import { getLocale, translator } from "../../i18n/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan } from "../../core/plan/types.js";
import { findOnPath } from "../../core/runner/path-lookup.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultMetric } from "../../core/run/types.js";
import { declaredNodePackage, declaredPythonPackage } from "../playwright/index.js";
import { AREA, RUN_DIR, WORKSPACE, componentDirOf, instanceBody, isRec, readJsonFile, readText, runInstance, sha256File, tail, type KitContract } from "../playwright/kit.js";
import { performanceManifest } from "./manifest.js";
import { compareBenchmarks, parseBencher, parseBenchmarkDotNet, parseGoBench, parsePytestBenchmark, parseVitestBench, type BenchReading } from "./normalize.js";

export { performanceManifest } from "./manifest.js";
export { compareBenchmarks, matchesName, parseBencher, parseBenchmarkDotNet, parseGoBench, parsePytestBenchmark, parseVitestBench } from "./normalize.js";

const ADAPTER_ID = performanceManifest.id;
export const HARNESSES = ["pytest-benchmark", "vitest-bench", "go-bench", "criterion", "benchmarkdotnet"] as const;
export type Harness = (typeof HARNESSES)[number];
const DEFAULT_REGRESSION_PERCENT = 20;
const MAX_METRICS = 200;
const MAX_FINDINGS = 100;
const TOOL_OF: Record<Harness, string> = { "pytest-benchmark": "pytest-benchmark", "vitest-bench": "vitest bench", "go-bench": "go test -bench", criterion: "criterion", benchmarkdotnet: "BenchmarkDotNet" };

interface PerfContract extends KitContract {
  harness: Harness | null;
  budgets: Record<string, number>;
  baseline: Record<string, number> | null;
  baselineFile: string | null;
  maxRegressionPercent: number;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The .csproj of the component that references BenchmarkDotNet, or null. */
export function benchmarkProject(dir: string): string | null {
  return listDir(dir).find((n) => n.endsWith(".csproj") && /Include\s*=\s*"BenchmarkDotNet"/i.test(readText(path.join(dir, n)) ?? "")) ?? null;
}

/** Which harness the component uses when the instance does not say. */
export function detectHarness(dir: string, workspace: string): Harness | null {
  const names = listDir(dir);
  if (declaredPythonPackage(dir, "pytest-benchmark")) return "pytest-benchmark";
  if (names.includes("package.json")) return "vitest-bench";
  if (names.includes("go.mod")) return "go-bench";
  if (names.includes("Cargo.toml") && /^\s*criterion\b/m.test(readText(path.join(dir, "Cargo.toml")) ?? "")) return "criterion";
  if (benchmarkProject(dir)) return "benchmarkdotnet";
  void workspace;
  return null;
}

export interface PerfSettings {
  harness: Harness | null;
  budgets: Record<string, number>;
  baseline: string | null;
  maxRegressionPercent: number;
  problems: string[];
}

export function performanceSettings(input: Pick<ExternalPlanInput, "config" | "tool">): PerfSettings {
  const t = translator(AREA);
  const body = instanceBody(input);
  const problems: string[] = [];
  let harness: Harness | null = null;
  if (body.harness !== undefined) {
    if (typeof body.harness === "string" && (HARNESSES as readonly string[]).includes(body.harness)) harness = body.harness as Harness;
    else problems.push(t("perf_setting_harness", { tool: input.tool, value: String(body.harness), allowed: HARNESSES.join(", ") }));
  }
  const budgets: Record<string, number> = {};
  if (body.budgets !== undefined) {
    if (isRec(body.budgets) && Object.entries(body.budgets).every(([k, v]) => k.trim() !== "" && typeof v === "number" && Number.isFinite(v) && v > 0)) Object.assign(budgets, body.budgets);
    else problems.push(t("perf_setting_budgets", { tool: input.tool }));
  }
  let baseline: string | null = null;
  if (body.baseline !== undefined) {
    if (typeof body.baseline === "string" && body.baseline.trim() !== "" && !path.isAbsolute(body.baseline) && !body.baseline.split(/[\\/]/).includes("..")) baseline = body.baseline.replace(/\\/g, "/");
    else problems.push(t("perf_setting_baseline", { tool: input.tool }));
  }
  let maxRegressionPercent = DEFAULT_REGRESSION_PERCENT;
  if (body.maxRegressionPercent !== undefined) {
    if (typeof body.maxRegressionPercent === "number" && Number.isFinite(body.maxRegressionPercent) && body.maxRegressionPercent >= 0) maxRegressionPercent = body.maxRegressionPercent;
    else problems.push(t("perf_setting_regression", { tool: input.tool, value: String(body.maxRegressionPercent) }));
  }
  return { harness, budgets, baseline, maxRegressionPercent, problems };
}

/** The baseline file: an object of benchmark name -> mean in milliseconds; null when it is not one. */
export function readBaseline(abs: string): Record<string, number> | null {
  const doc = readJsonFile(abs);
  if (!doc) return null;
  const values = isRec(doc.benchmarks) ? doc.benchmarks : doc;
  const out: Record<string, number> = {};
  for (const [name, v] of Object.entries(values)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    out[name] = v;
  }
  return out;
}

function commandOf(env: NodeJS.ProcessEnv, executable: string): { executable: string; prefix: string[]; problem: string | null } {
  const named = inImageOverride(env, "JGATES_BENCHMARK");
  if (named === null) return { executable, prefix: [], problem: null };
  const abs = findOnPath(named, env);
  if (!abs) return { executable, prefix: [], problem: named };
  return /\.(?:mjs|cjs|js)$/i.test(abs) ? { executable: process.execPath, prefix: [abs, executable], problem: null } : { executable: abs, prefix: [executable], problem: null };
}

function planPerformance(input: ExternalPlanInput): ExternalPlan {
  const t = translator(AREA);
  const { root, dir } = componentDirOf(input);
  const settings = performanceSettings(input);
  const harness = settings.harness ?? detectHarness(dir, input.dir);
  const body = instanceBody(input);
  const component = typeof body.component === "string" ? body.component : null;
  const at = (rel: string): string => (root ? `${root}/${rel}` : rel);
  const out = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const cwd = root ? `${WORKSPACE}/${root}` : WORKSPACE;
  let missing: string | null = null;
  let version: string | null = null;
  let imageTool = "python";
  let args: string[] = [];
  let executable = "python";
  let env: Record<string, string> = { NO_COLOR: "1" };
  const configFiles: string[] = [];
  switch (harness) {
    case "pytest-benchmark": {
      const declared = declaredPythonPackage(dir, "pytest-benchmark");
      if (!declared) missing = "pytest-benchmark";
      version = declared?.version ?? null;
      args = ["-m", "pytest", "-p", "no:cacheprovider", "--benchmark-only", `--benchmark-json=${out}/benchmark.json`, "-q"];
      env = { ...env, PYTHONDONTWRITEBYTECODE: "1" };
      configFiles.push(...["pytest.ini", "pyproject.toml", "conftest.py"].filter((f) => fs.existsSync(path.join(dir, f))));
      break;
    }
    case "vitest-bench": {
      const declared = declaredNodePackage(dir, input.dir, ["vitest"]);
      version = declared?.version ?? probeImageTool("vitest", input.env).version;
      executable = "vitest";
      imageTool = declared ? "node" : "vitest";
      // Vitest 4+ reports the benchmarks of its benchmark project through the JSON reporter (each test's `benchmarks`).
      args = ["bench", "--run", "--reporter=json", `--outputFile=${out}/bench.json`];
      env = { ...env, CI: "1", FORCE_COLOR: "0" };
      configFiles.push(...listDir(dir).filter((n) => /^vite(?:st)?\.config\.(?:ts|js|mjs|cjs|mts)$/.test(n)));
      break;
    }
    case "go-bench": {
      const go = probeImageTool("go", input.env);
      version = go.version;
      executable = "go";
      imageTool = "go";
      args = ["test", "-run", "^$", "-bench", ".", "-benchmem", "-count=1", "./..."];
      // GOTMPDIR: go test executes the binaries it builds, and the step's /tmp is mounted noexec.
      env = { ...env, GOPROXY: "off", GOTOOLCHAIN: "local", GOTELEMETRY: "off", GOCACHE: `${RUN_DIR}/cache/performance`, GOTMPDIR: `${RUN_DIR}/cache/performance/tmp` };
      configFiles.push("go.mod");
      break;
    }
    case "criterion": {
      const cargo = probeImageTool("cargo", input.env);
      version = cargo.version;
      executable = "cargo";
      imageTool = "cargo";
      // Only the bench targets: the library's own test harness does not know criterion's options.
      args = ["bench", "--offline", "--bench", "*", "--", "--output-format", "bencher"];
      env = { ...env, CARGO_TERM_COLOR: "never", CARGO_TARGET_DIR: `${RUN_DIR}/cache/performance/target` };
      configFiles.push("Cargo.toml");
      break;
    }
    case "benchmarkdotnet": {
      const project = typeof body.dotnetProject === "string" ? body.dotnetProject : benchmarkProject(dir);
      const dotnet = probeImageTool("dotnet", input.env);
      version = /Include\s*=\s*"BenchmarkDotNet"\s+Version\s*=\s*"([^"]+)"/i.exec(project ? (readText(path.join(dir, project)) ?? "") : "")?.[1] ?? null;
      if (!project) missing = "BenchmarkDotNet";
      executable = "dotnet";
      imageTool = "dotnet";
      args = ["run", "-c", "Release", ...(project ? ["--project", project] : []), "--", "--filter", "*", "--inProcess", "--job", "short", "--exporters", "json", "--artifacts", `${out}/bdn`];
      env = { ...env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_CLI_UI_LANGUAGE: "en", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", MSBUILDDISABLENODEREUSE: "1" };
      if (dotnet.problem !== null) missing = `dotnet (${dotnet.detail})`;
      if (project) configFiles.push(project);
      break;
    }
  }
  const cmd = commandOf(input.env, executable);
  if (cmd.problem) missing = cmd.problem;
  let baseline: Record<string, number> | null = null;
  let baselineProblem: string | null = null;
  if (settings.baseline) {
    const abs = path.join(dir, ...settings.baseline.split("/"));
    if (!fs.existsSync(abs)) baselineProblem = t("perf_baseline_missing", { file: at(settings.baseline) });
    else {
      baseline = readBaseline(abs);
      if (!baseline) baselineProblem = t("perf_baseline_invalid", { file: at(settings.baseline) });
      configFiles.push(settings.baseline);
    }
  }
  let availability: ExternalPlan["availability"];
  if (settings.problems.length > 0) availability = { status: "unavailable", reason: settings.problems.join(" ") };
  else if (Object.keys(settings.budgets).length === 0 && settings.baseline === null) availability = { status: "unavailable", reason: t("perf_needs_budgets", { tool: input.tool }) };
  else if (baselineProblem) availability = { status: "unavailable", reason: baselineProblem };
  else if (harness === null) availability = { status: "unavailable", reason: t("perf_no_harness", { dir: root ?? "." }) };
  else if (missing !== null) availability = { status: "unavailable", reason: t("perf_missing", { harness: TOOL_OF[harness], detail: missing }) };
  else availability = { status: "available", reason: null };

  const contract: PerfContract = {
    component,
    root,
    harness,
    budgets: settings.budgets,
    baseline,
    baselineFile: settings.baseline ? at(settings.baseline) : null,
    maxRegressionPercent: settings.maxRegressionPercent,
  };
  const conditions = [t("perf_condition_machine")];
  if (Object.keys(settings.budgets).length > 0) conditions.push(t("perf_condition_budgets", { count: Object.keys(settings.budgets).length }));
  if (settings.baseline) conditions.push(t("perf_condition_baseline", { file: at(settings.baseline), percent: settings.maxRegressionPercent }));
  return {
    label: t("perf_label", { harness: harness ? TOOL_OF[harness] : "-" }),
    command: { executable: cmd.executable, args: [...cmd.prefix, ...args], cwd, env, stdin: null },
    runtime: { name: "native", interpreter: cmd.executable, available: missing === null && harness !== null },
    toolVersion: version,
    configFiles: [...new Set(configFiles)].map((f) => ({ file: at(f), sha256: sha256File(path.join(dir, ...f.split("/"))) })),
    availability,
    blocksPlan: settings.problems.length > 0,
    network: false,
    limitations: [t("perf_limitation")],
    conditions,
    output: { format: "json", schema: null },
    imageTool,
    contract,
    effects: { executesProjectCode: true, ...(harness === "benchmarkdotnet" ? { workspaceWrites: [at("bin"), at("obj"), at("BenchmarkDotNet.Artifacts")] } : {}) },
  };
}

function filesUnder(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 4) return;
    for (const e of (() => {
      try {
        return fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return [];
      }
    })().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && accept(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** The benchmarks a harness reported. */
export function readHarness(harness: Harness, outDir: string, stdout: string): BenchReading {
  switch (harness) {
    case "pytest-benchmark":
      return parsePytestBenchmark(readText(path.join(outDir, "benchmark.json")));
    case "vitest-bench":
      return parseVitestBench(readText(path.join(outDir, "bench.json")));
    case "go-bench":
      return parseGoBench(stdout);
    case "criterion":
      return parseBencher(stdout);
    case "benchmarkdotnet":
      return parseBenchmarkDotNet(filesUnder(path.join(outDir, "bdn"), (n) => /-report-full(?:-compressed)?\.json$/.test(n) || /-report\.json$/.test(n)).map((f) => readText(f) ?? ""));
  }
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
/** A time in milliseconds as the language writes it (comma decimals in pt-BR). */
const ms = (n: number): string => n.toLocaleString(getLocale() === "pt-BR" ? "pt-BR" : "en-US", { maximumFractionDigits: n < 1 ? 6 : 3 });

async function runPerformance(context: AdapterContext, planDoc: Plan, tool: string): Promise<AdapterOutput> {
  return runInstance<PerfContract>(ADAPTER_ID, context, planDoc, tool, async (run) => {
    const t = translator(AREA);
    const harness = run.contract.harness;
    if (harness === null) return run.all("blocked", t("perf_no_harness", { dir: run.contract.root ?? "." }));
    const executed = await run.exec(0);
    const stop = run.stopped(executed);
    if (stop) return stop;
    const { result } = executed;
    const native = `exit ${result.exitCode ?? "-"}`;
    const name = TOOL_OF[harness];
    if (result.exitCode !== 0) return run.all("error", t("perf_failed", { harness: name, code: result.exitCode ?? "-", detail: tail(result.stderr || result.stdout) || "-" }), { interpreted: false, nativeStatus: native });
    const reading = readHarness(harness, run.outDir, result.stdout);
    if (!reading.ok || result.truncated) return run.all("error", t("perf_no_report", { harness: name, detail: result.truncated ? "output truncated" : (reading.problem ?? "-") }), { interpreted: false, nativeStatus: native });
    const benchmarks = reading.benchmarks;
    if (benchmarks.length === 0) return run.all("completed", t("perf_no_benchmarks", { harness: name }), { interpreted: false, nativeStatus: native });
    fs.writeFileSync(path.join(run.outDir, "baseline-candidate.json"), `${JSON.stringify({ benchmarks: Object.fromEntries(benchmarks.map((b) => [b.name, round(b.meanMs)])) }, null, 2)}\n`, { mode: 0o600 });

    const item = run.items[0] as Plan["groups"]["willRun"][number];
    const component = run.contract.component;
    const scope = component ? "component" : "workspace";
    const withComponent = component ? { component } : {};
    const checks = compareBenchmarks(benchmarks, run.contract.budgets ?? {}, run.contract.baseline ?? null, run.contract.maxRegressionPercent ?? DEFAULT_REGRESSION_PERCENT);
    const findings: ResultFinding[] = checks.slice(0, MAX_FINDINGS).map((c) => ({
      stageId: item.id,
      tool: ADAPTER_ID,
      ...(run.version ? { toolVersion: run.version } : {}),
      ruleId: `performance.${c.kind === "budget" ? "budget-exceeded" : c.kind === "regression" ? "regression" : "budget-unmatched"}`,
      category: "performance",
      severity: "error",
      normalizedSeverity: "high",
      message:
        c.kind === "budget"
          ? t("perf_finding_budget", { name: c.name, mean: ms(c.meanMs ?? 0), limit: ms(c.limitMs), rule: c.rule })
          : c.kind === "regression"
            ? t("perf_finding_regression", { name: c.name, mean: ms(c.meanMs ?? 0), baseline: ms(Number(c.rule)), percent: run.contract.maxRegressionPercent, file: run.contract.baselineFile ?? "-" })
            : t("perf_finding_unmatched", { rule: c.rule }),
      ...(c.kind === "regression" && run.contract.baselineFile ? { location: { path: run.contract.baselineFile } } : {}),
      fingerprint: contentHash({ tool: ADAPTER_ID, kind: c.kind, name: c.name, rule: c.rule }),
      origin: ADAPTER_ID,
      blocking: true,
      blockingReason: "blocking-tool",
      waived: false,
    }));
    const metrics: ResultMetric[] = [
      { id: "performance.benchmarks", label: t("perf_metric_benchmarks"), unit: "count", value: benchmarks.length, ...withComponent, scope, origin: ADAPTER_ID },
      { id: "performance.breaches", label: t("perf_metric_breaches"), unit: "count", value: checks.length, ...withComponent, scope, origin: ADAPTER_ID },
      ...benchmarks.slice(0, MAX_METRICS).map((b): ResultMetric => ({ id: `performance.mean.${b.name}`, label: b.name, unit: "ms", value: round(b.meanMs), basis: "mean per iteration", format: name, ...withComponent, scope, origin: ADAPTER_ID })),
    ];
    const reason = t("perf_reason", { harness: name, version: run.version ?? "?", count: benchmarks.length, breaches: checks.length });
    return {
      ...run.base(),
      stages: run.items.map((i) => run.stage(i, "completed", reason, { blockingViolations: findings.length, findings: findings.length, nativeStatus: native })),
      findings,
      metrics,
    };
  });
}

export const performanceAdapter: ExternalAdapter = {
  manifest: performanceManifest,
  plan: planPerformance,
  run: runPerformance,
};
