// Mutation testing adapter: one engine run per tool instance (StrykerJS for JavaScript/TypeScript, mutmut for Python)
// over an isolated copy of the component inside the run folder, so neither the engines' working folders nor their
// reports touch the workspace. The engine mutates the copy and re-runs the project's tests: it executes project code
// and the cache never reuses the result. The mutation score and the surviving mutants are reported as a metric and
// as findings; a score that could not be measured (engine missing, red baseline, timeout, unreadable report) is "not
// measured", never 0 and never passed. The engines come from the project; a run never installs them.
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
import { mutationManifest } from "./manifest.js";
import { parseMutmutOutput, parseStrykerReport, type MutationReading, type SurvivingMutant } from "./normalize.js";
import { findMutmut, findStryker, findStrykerNet } from "./probe.js";
import { stepViewOfPaths } from "../../core/runner/container.js";

export { mutationManifest } from "./manifest.js";
export { mutationScore, parseMutmutOutput, parseStrykerReport } from "./normalize.js";
export { findMutmut, findStryker, findStrykerNet } from "./probe.js";

const ADAPTER_ID = mutationManifest.id;
const WORKSPACE = "{workspace}";
const RUN_DIR = "{runDir}";
const MIN_RULE = "mutation.minimum";
const ENGINES = ["stryker", "mutmut", "stryker-net"] as const;
export type MutationEngine = (typeof ENGINES)[number];
/** mutmut 3 (stats export and results format); Stryker's range is the manifest's. */
const MUTMUT_RANGE = ">=3.0.0 <4.0.0";
/** Stryker.NET 4-5 (the same mutation-testing-elements JSON report); the tools image ships 5.1.0. */
const STRYKER_NET_RANGE = ">=4.0.0 <6.0.0";
/** Findings listed per run; the metric always counts every survivor. */
const MAX_FINDINGS = 100;
const EXCLUDED_DIRS = new Set([".git", ".jgates", "node_modules", ".stryker-tmp", "reports", "mutants", "__pycache__", ".pytest_cache", ".venv", "venv", ".mypy_cache", ".ruff_cache"]);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The settings of an instance (tools.<id> in .jgates/tools.yml). */
export interface MutationSettings {
  engine: MutationEngine | null;
  /** Scope: files to mutate (Stryker globs) or mutant-name patterns (mutmut). Empty: the engine's own configuration. */
  mutate: string[];
  minimumScore: number | null;
  component: string | null;
  /** Time bound of the instance (tools.<id>.timeoutSeconds); the run uses the lower of it and the stage limit. */
  timeoutSeconds: number | null;
  /** What the instance wrote that is not valid; the plan refuses it instead of guessing. */
  problems: string[];
}

export function mutationSettings(input: Pick<ExternalPlanInput, "config" | "tool">): MutationSettings {
  const t = translator("mutation");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const raw = isRec(tools[input.tool]) ? (tools[input.tool] as Rec) : {};
  // A template carries the settings under `config` (its schema allows nothing else); tools.yml writes them next to the adapter.
  const body: Rec = { ...(isRec(raw.config) ? raw.config : {}), ...raw };
  const problems: string[] = [];
  let engine: MutationEngine | null = null;
  if (body.engine !== undefined) {
    if (typeof body.engine === "string" && (ENGINES as readonly string[]).includes(body.engine)) engine = body.engine as MutationEngine;
    else problems.push(t("mutation_setting_engine", { tool: input.tool, value: String(body.engine), allowed: ENGINES.join(", ") }));
  }
  let mutate: string[] = [];
  if (body.mutate !== undefined) {
    if (Array.isArray(body.mutate) && body.mutate.every((p) => typeof p === "string" && p.trim() !== "" && !p.includes(",") && !p.startsWith("-") && !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."))) mutate = body.mutate as string[];
    else problems.push(t("mutation_setting_mutate", { tool: input.tool }));
  }
  let minimumScore: number | null = null;
  if (body.minimumScore !== undefined) {
    if (typeof body.minimumScore === "number" && Number.isFinite(body.minimumScore) && body.minimumScore >= 0 && body.minimumScore <= 100) minimumScore = body.minimumScore;
    else problems.push(t("mutation_setting_minimum", { tool: input.tool, value: String(body.minimumScore) }));
  }
  const timeoutSeconds = typeof body.timeoutSeconds === "number" && Number.isInteger(body.timeoutSeconds) && body.timeoutSeconds >= 1 ? body.timeoutSeconds : null;
  return { engine, mutate, minimumScore, component: typeof body.component === "string" ? body.component : null, timeoutSeconds, problems };
}

const STRYKER_CONFIG = /^stryker\.(?:conf|config)\.(?:json|js|mjs|cjs)$/;
/** Stryker.NET's configuration file (stryker-config.json / .yaml / .yml). */
const STRYKER_NET_CONFIG = /^stryker-config\.(?:json|ya?ml)$/;
const DOTNET_FILE = /\.(?:sln|slnx|csproj|fsproj)$/;
/** The JSON report of Stryker.NET under its --output folder. */
const STRYKER_NET_REPORT = ["reports", "mutation-report.json"] as const;

/** Which engine the component uses when the instance does not say: Stryker config or dependency, else a Python project. */
export function detectEngine(componentDir: string): MutationEngine | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(componentDir);
  } catch {
    return null;
  }
  if (names.some((n) => STRYKER_CONFIG.test(n))) return "stryker";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(componentDir, "package.json"), "utf8")) as Rec;
    const deps = { ...(isRec(pkg.dependencies) ? pkg.dependencies : {}), ...(isRec(pkg.devDependencies) ? pkg.devDependencies : {}) };
    if ("@stryker-mutator/core" in deps) return "stryker";
  } catch {
    // no package.json
  }
  const text = (n: string): string => {
    try {
      return fs.readFileSync(path.join(componentDir, n), "utf8");
    } catch {
      return "";
    }
  };
  if (/^\s*\[mutmut\]/m.test(text("setup.cfg")) || /^\s*\[tool\.mutmut\]/m.test(text("pyproject.toml"))) return "mutmut";
  if (names.some((n) => STRYKER_NET_CONFIG.test(n))) return "stryker-net";
  if (names.includes("package.json")) return "stryker";
  if (names.some((n) => DOTNET_FILE.test(n))) return "stryker-net";
  if (names.some((n) => n === "pyproject.toml" || n === "setup.cfg" || n === "setup.py" || n === "requirements.txt")) return "mutmut";
  return null;
}

/** The minimum score of the policy: `mutation.minimum.<component>` over `mutation.minimum` (rules.<id>.threshold). */
function policyMinimum(config: Rec | undefined, component: string | null): { value: number | null; source: string | null } {
  const policy = config && isRec(config.policy) ? config.policy : {};
  const rules = isRec(policy.rules) ? policy.rules : {};
  for (const id of [...(component ? [`${MIN_RULE}.${component}`] : []), MIN_RULE]) {
    const rule = rules[id];
    if (isRec(rule) && rule.enabled !== false && typeof rule.threshold === "number" && Number.isFinite(rule.threshold)) return { value: rule.threshold, source: `policy.rules.${id}` };
  }
  return { value: null, source: null };
}

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** What the plan records about an instance (the plan hash covers it) and the run reads back. */
interface MutationContract {
  engine: MutationEngine | null;
  component: string | null;
  root: string | null;
  mutate: string[];
  minimum: number | null;
  minimumSource: string | null;
  /** The component folder the engine copies, with the {workspace} placeholder. */
  source: string;
  /** The isolated copy the engine runs in, with the {runDir} placeholder. */
  workDir: string;
  /** tools.<id>.timeoutSeconds; null: only the stage limit bounds the run. */
  timeoutSeconds?: number | null;
}

function planMutation(input: ExternalPlanInput): ExternalPlan {
  const t = translator("mutation");
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const componentDir = root ? path.join(input.dir, root) : input.dir;
  const settings = mutationSettings(input);
  const engine = settings.engine ?? detectEngine(componentDir);
  const fromPolicy = policyMinimum(input.config, settings.component);
  const minimum = settings.minimumScore !== null ? { value: settings.minimumScore, source: "tools.minimumScore" } : fromPolicy;
  const workDir = `${RUN_DIR}/work/mutation/${input.tool}`;

  let command: ExternalPlan["command"] = { executable: "stryker", args: [], cwd: RUN_DIR, env: {}, stdin: null };
  let runtime: ExternalPlan["runtime"] = { name: "native", interpreter: null, available: false };
  let toolVersion: string | null = null;
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  const configFiles = new Map<string, string | null>();
  const conditions: string[] = [t("mutation_condition_isolated")];

  if (settings.problems.length > 0) {
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (engine === null) {
    availability = { status: "unavailable", reason: t("mutation_no_engine", { dir: root ?? "." }) };
  } else if (engine === "stryker") {
    const probe = findStryker(input.dir, input.componentRoot, input.env);
    toolVersion = probe.version;
    command = {
      executable: probe.executable ?? "stryker",
      args: [
        ...probe.prefix,
        "run",
        // The JSON report is the evidence; no dashboard, no clear-text progress bar, no log file.
        "--reporters",
        "json",
        "--logLevel",
        "warn",
        "--concurrency",
        "2",
        ...(settings.mutate.length > 0 ? ["--mutate", settings.mutate.join(",")] : []),
      ],
      cwd: RUN_DIR,
      env: { CI: "1" },
      stdin: null,
    };
    runtime = { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null };
    if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("mutation_stryker_missing", { detail: probe.detail }) };
    else if (probe.problem === "no_version") availability = { status: "unavailable", reason: t("mutation_stryker_no_version", { detail: probe.detail }) };
    else if (probe.version !== null && satisfiesRange(probe.version, mutationManifest.toolVersionRange) !== true) {
      availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: "stryker", version: probe.version, range: mutationManifest.toolVersionRange, what: ADAPTER_ID }) };
    } else availability = { status: "available", reason: null };
    for (const n of fs.existsSync(componentDir) ? fs.readdirSync(componentDir) : []) {
      if (STRYKER_CONFIG.test(n)) configFiles.set(root ? `${root}/${n}` : n, sha256File(path.join(componentDir, n)));
    }
    conditions.push(t("mutation_condition_stryker", { scope: settings.mutate.length > 0 ? settings.mutate.join(", ") : t("mutation_scope_config") }));
  } else if (engine === "stryker-net") {
    const probe = findStrykerNet(input.env);
    toolVersion = probe.version;
    const names = fs.existsSync(componentDir) ? fs.readdirSync(componentDir).sort() : [];
    const solution = names.find((n) => /\.(?:sln|slnx)$/.test(n)) ?? null;
    const testProject = solution ? null : (names.find((n) => /\.(?:csproj|fsproj)$/.test(n) && /Include\s*=\s*"Microsoft\.NET\.Test\.Sdk"/i.test(readTextOf(path.join(componentDir, n)))) ?? null);
    command = {
      executable: probe.executable ?? "dotnet-stryker",
      args: [
        ...probe.prefix,
        ...(solution ? ["--solution", solution] : testProject ? ["--test-project", testProject] : []),
        // The JSON report is the evidence (mutation-testing-elements, as StrykerJS); the clear text table is for the log.
        "--reporter",
        "json",
        "--reporter",
        "cleartext",
        "--output",
        `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}/stryker-net`,
        "--concurrency",
        "2",
        "--skip-version-check",
        ...settings.mutate.flatMap((m) => ["--mutate", m]),
      ],
      cwd: RUN_DIR,
      env: { DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_CLI_UI_LANGUAGE: "en", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", MSBUILDDISABLENODEREUSE: "1", NO_COLOR: "1" },
      stdin: null,
    };
    runtime = { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null };
    if (probe.problem !== null) availability = { status: "unavailable", reason: t("mutation_stryker_net_missing", { detail: probe.detail }) };
    else if (probe.version !== null && satisfiesRange(probe.version, STRYKER_NET_RANGE) !== true) {
      availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: "dotnet-stryker", version: probe.version, range: STRYKER_NET_RANGE, what: ADAPTER_ID }) };
    } else if (!solution && !testProject) availability = { status: "unavailable", reason: t("mutation_stryker_net_no_target", { dir: root ?? "." }) };
    else availability = { status: "available", reason: null };
    for (const n of names) {
      if (STRYKER_NET_CONFIG.test(n) || n === solution || n === testProject || n === "Directory.Build.props") configFiles.set(root ? `${root}/${n}` : n, sha256File(path.join(componentDir, n)));
    }
    conditions.push(t("mutation_condition_stryker_net", { scope: settings.mutate.length > 0 ? settings.mutate.join(", ") : t("mutation_scope_config") }));
  } else {
    const probe = findMutmut(input.env);
    toolVersion = probe.version;
    command = {
      // The image's own `mutmut` (its private Python); `python -m mutmut` for the interpreter an override names.
      executable: probe.python ?? "python",
      args: [...(probe.command ? [] : ["-m", "mutmut"]), "run", ...settings.mutate],
      cwd: RUN_DIR,
      env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
      stdin: null,
    };
    runtime = { name: "native", interpreter: probe.python, available: probe.python !== null && probe.version !== null && probe.problem === null };
    if (probe.problem === "python_missing") availability = { status: "unavailable", reason: t("mutation_python_missing", { detail: probe.detail }) };
    else if (probe.problem === "no_mutmut") availability = { status: "unavailable", reason: t("mutation_mutmut_missing", { python: probe.detail }) };
    else if (probe.problem === "not_in_image") availability = { status: "unavailable", reason: t("mutation_mutmut_not_in_image", { detail: probe.detail }) };
    else if (probe.problem === "windows") availability = { status: "unavailable", reason: t("mutation_mutmut_windows", { version: probe.version ?? "?" }) };
    else if (probe.version !== null && satisfiesRange(probe.version, MUTMUT_RANGE) !== true) {
      availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: "mutmut", version: probe.version, range: MUTMUT_RANGE, what: ADAPTER_ID }) };
    } else availability = { status: "available", reason: null };
    for (const n of ["setup.cfg", "pyproject.toml"]) {
      if (fs.existsSync(path.join(componentDir, n))) configFiles.set(root ? `${root}/${n}` : n, sha256File(path.join(componentDir, n)));
    }
    conditions.push(t("mutation_condition_mutmut", { scope: settings.mutate.length > 0 ? settings.mutate.join(", ") : t("mutation_scope_config") }));
  }
  if (settings.timeoutSeconds !== null) conditions.push(t("mutation_condition_timeout", { seconds: Math.min(settings.timeoutSeconds, input.timeoutSeconds) }));
  if (minimum.value !== null) conditions.push(t("mutation_condition_minimum", { minimum: minimum.value, source: minimum.source ?? "-" }));

  const contract: MutationContract = {
    engine,
    component: settings.component,
    root,
    mutate: settings.mutate,
    minimum: minimum.value,
    minimumSource: minimum.source,
    source: root ? `${WORKSPACE}/${root}` : WORKSPACE,
    workDir,
    timeoutSeconds: settings.timeoutSeconds,
  };
  return {
    label: t("mutation_label"),
    command,
    runtime,
    toolVersion,
    configFiles: [...configFiles].map(([file, sha256]) => ({ file, sha256 })),
    availability,
    blocksPlan,
    network: false,
    limitations: [t("mutation_limitation_executes"), t("mutation_limitation_bounded")],
    conditions,
    output: { format: "json", schema: null },
    effects: { executesProjectCode: true },
    // Stryker.NET is its own tool of the image: when it is missing, the shared TOOL_MISSING cause names it.
    ...(engine === "stryker-net" ? { imageTool: "dotnet-stryker" } : {}),
    contract: contract as unknown as Record<string, unknown>,
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");

function readTextOf(abs: string): string {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

function contractOf(invocation: Plan["invocations"][number]): MutationContract {
  const c = (invocation.contract ?? {}) as Partial<MutationContract>;
  return {
    engine: c.engine === "stryker" || c.engine === "mutmut" || c.engine === "stryker-net" ? c.engine : null,
    component: c.component ?? null,
    root: c.root ?? null,
    mutate: Array.isArray(c.mutate) ? c.mutate : [],
    minimum: typeof c.minimum === "number" ? c.minimum : null,
    minimumSource: c.minimumSource ?? null,
    source: c.source ?? WORKSPACE,
    workDir: c.workDir ?? "",
    timeoutSeconds: typeof c.timeoutSeconds === "number" ? c.timeoutSeconds : null,
  };
}

/** The nearest node_modules from the component folder up to the workspace root (hoisted installs live above). */
function nearestNodeModules(workspace: string, componentDir: string): string | null {
  let dir = path.resolve(componentDir);
  const stop = path.resolve(workspace);
  for (let i = 0; i < 32; i++) {
    const candidate = path.join(dir, "node_modules");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir || path.relative(stop, parent).startsWith("..")) return null;
    dir = parent;
  }
  return null;
}

/** Build output folders of a .NET component, never copied (the copy builds its own). */
const DOTNET_BUILD_DIRS = new Set(["bin", "obj", "StrykerOutput"]);

const REDIRECT_PROPS =
  "<PropertyGroup>\n" +
  "    <!-- JGates: the copy builds every project into its own bin/ and obj/ (the dependency volume's single obj/ is\n" +
  "         read through NUGET_PACKAGES instead, offline). Properties of a project file win over the environment. -->\n" +
  "    <BaseIntermediateOutputPath>$(MSBuildProjectDirectory)/obj/</BaseIntermediateOutputPath>\n" +
  "    <BaseOutputPath>$(MSBuildProjectDirectory)/bin/</BaseOutputPath>\n" +
  "  </PropertyGroup>";

/**
 * Stryker.NET builds every project of the solution in the copy. The dependency environment points obj/ and bin/ of
 * every project at one folder of the dependency volume (fine for one project, not for a test project and the project it
 * tests): in the copy, a Directory.Build.props (the project's own, or a new one) sends them back next to each project.
 */
export function redirectDotnetBuild(workDir: string): void {
  const file = path.join(workDir, "Directory.Build.props");
  const current = readTextOf(file);
  const open = /<Project\b[^>]*>/.exec(current);
  const text = open ? `${current.slice(0, open.index + open[0].length)}\n  ${REDIRECT_PROPS}\n${current.slice(open.index + open[0].length)}` : `<Project>\n  ${REDIRECT_PROPS}\n</Project>\n`;
  fs.writeFileSync(file, text);
}

/** Copies the component into the run folder (without dependency, VCS and tool folders) and links its node_modules. */
function prepareCopy(workspace: string, source: string, workDir: string, engine: MutationEngine): void {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workDir), { recursive: true, mode: 0o700 });
  const dotnet = engine === "stryker-net";
  fs.cpSync(source, workDir, { recursive: true, filter: (from) => !EXCLUDED_DIRS.has(path.basename(from)) && !(dotnet && DOTNET_BUILD_DIRS.has(path.basename(from))) });
  if (dotnet) redirectDotnetBuild(workDir);
  if (engine === "stryker") {
    const modules = nearestNodeModules(workspace, source);
    if (modules) fs.symlinkSync(modules, path.join(workDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
}

/** A report whose file names are absolute paths of the copy, with the names relative to the copy. */
export function relativizeReport(reading: MutationReading, roots: string[]): MutationReading {
  const rel = (file: string): string => {
    const slashed = file.replace(/\\/g, "/");
    for (const root of roots) {
      const lower = (s: string): string => (/^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s);
      if (root && lower(slashed).startsWith(`${lower(root)}/`)) return slashed.slice(root.length + 1);
    }
    return slashed;
  };
  return { ...reading, survivors: reading.survivors.map((s) => ({ ...s, file: rel(s.file) })) };
}

/** The workspace-relative file of a survivor: JSON keys are relative to the copy, mutmut gives a module path. */
function locate(copy: string, root: string | null, mutant: SurvivingMutant, engine: MutationEngine): string {
  let rel = mutant.file;
  if (engine === "mutmut") {
    const candidates = [`${rel}.py`, `${rel}/__init__.py`];
    rel = candidates.find((c) => fs.existsSync(path.join(copy, ...c.split("/")))) ?? candidates[0] ?? rel;
  }
  return root ? `${root}/${rel}` : rel;
}

async function runMutation(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("mutation");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("mutation_no_invocation", { tool }));
  const contract = contractOf(invocation);
  const item = items[0] as PlanItem;

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  // The plan's cwd is the run folder (it must exist when the step starts); the engine runs in the copy of the component.
  const cwd = substituteTokens(contract.workDir, tokens);
  const source = substituteTokens(contract.source, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = { PATH: context.env.PATH ?? "" };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds), contract.timeoutSeconds ?? Number.POSITIVE_INFINITY);
  const version = item.versions.toolVersion ?? null;
  const engine = contract.engine;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);

  const scope = contract.component ? "component" : "workspace";
  const withComponent = contract.component ? { component: contract.component } : {};
  const stageFor = (state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({
    id: item.id,
    label: item.label,
    kind: "step",
    adapter: ADAPTER_ID,
    state,
    ...(reason ? { reason } : {}),
    ...extra,
  });
  const notMeasured = (reason: string): ResultMetric => ({ id: "mutation.score", label: t("mutation_metric_score"), unit: "percent", measured: false, reason, basis: "mutants", ...withComponent, scope, origin: ADAPTER_ID });
  const base = {
    requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
    disabled: [],
    logs: [] as string[],
    outputs: [relToRun(context.runDir, outDir)],
  };
  const withLogs = (o: AdapterOutput): AdapterOutput => ({ ...o, logs: base.logs });
  const stopped = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => withLogs({ ...base, stages: [stageFor(state, reason, extra)], findings: [], metrics: [notMeasured(reason)] });

  if (item.availability.status !== "available") return stopped("blocked", item.availability.reason ?? t("mutation_blocked", { detail: command.executable }));
  if (engine === null) return stopped("blocked", t("mutation_no_engine", { dir: contract.root ?? "." }));

  try {
    prepareCopy(context.workspacePath, source, cwd, engine);
  } catch (error) {
    return stopped("error", t("mutation_copy_failed", { detail: (error as Error).message }), { interpreted: false });
  }

  const spawn = (spec: { executable: string; args: string[] }, files: { stdout: string; stderr: string } | null) =>
    runSpec({ executable: spec.executable, args: spec.args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, ...(files ? { stdoutFile: files.stdout, stderrFile: files.stderr } : {}) }, { parentEnv: context.env });
  const result = await spawn({ executable: command.executable, args }, { stdout: stdoutLog, stderr: stderrLog });
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return stopped("blocked", t("mutation_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` }));
  if (result.timedOut) return stopped("timeout", t("mutation_timeout", { seconds: timeoutSeconds }));
  // Only the run-owned process is stopped; whatever the engine wrote before stays in the logs as partial evidence.
  if (result.cancelled) return stopped("cancelled", t("mutation_cancelled"));

  let reading: MutationReading;
  const detail = tail(result.stderr) || tail(result.stdout) || String(result.signal ?? "");
  if (engine === "stryker-net") {
    const reportFile = path.join(outDir, "stryker-net", ...STRYKER_NET_REPORT);
    let text: string | null = null;
    try {
      text = fs.readFileSync(reportFile, "utf8");
    } catch {
      text = null;
    }
    if (text === null) {
      const red = /initial test run|No test result reported|no tests? (?:were )?found/i.test(`${result.stdout}\n${result.stderr}`);
      return stopped("error", red ? t("mutation_baseline_red") : t("mutation_no_report", { code: result.exitCode ?? "-", detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` });
    }
    // Stryker.NET names the files by their path in the copy (as the step saw it): relative to the copy here.
    const copyView = stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, cwd).replace(/\\/g, "/").replace(/\/+$/, "");
    reading = relativizeReport(parseStrykerReport(text), [copyView, cwd.replace(/\\/g, "/").replace(/\/+$/, "")]);
  } else if (engine === "stryker") {
    const reportFile = path.join(cwd, "reports", "mutation", "mutation.json");
    let text: string | null = null;
    try {
      text = fs.readFileSync(reportFile, "utf8");
      fs.copyFileSync(reportFile, path.join(outDir, "mutation.json"));
    } catch {
      text = null;
    }
    if (text === null) {
      const red = /failed tests in the initial test run|initial test run/i.test(`${result.stdout}\n${result.stderr}`);
      return stopped("error", red ? t("mutation_baseline_red") : t("mutation_no_report", { code: result.exitCode ?? "-", detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` });
    }
    reading = parseStrykerReport(text);
  } else {
    if (result.exitCode !== 0) return stopped("error", t("mutation_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` });
    const sub = (name: string): string[] => (args[0] === "-m" ? ["-m", "mutmut", name] : [name]);
    const results = await spawn({ executable: command.executable, args: sub("results") }, null);
    const stats = await spawn({ executable: command.executable, args: sub("export-cicd-stats") }, null);
    let statsText = "";
    try {
      statsText = fs.readFileSync(path.join(cwd, "mutants", "mutmut-cicd-stats.json"), "utf8");
      fs.copyFileSync(path.join(cwd, "mutants", "mutmut-cicd-stats.json"), path.join(outDir, "mutmut-cicd-stats.json"));
    } catch {
      statsText = "";
    }
    fs.writeFileSync(path.join(outDir, "mutmut-results.txt"), results.stdout, { mode: 0o600 });
    reading = stats.exitCode === 0 && statsText !== "" ? parseMutmutOutput(statsText, results.stdout) : { ...parseMutmutOutput("", ""), problem: t("mutation_no_report", { code: stats.exitCode ?? "-", detail: tail(stats.stderr) }) };
  }

  if (result.truncated || !reading.ok) {
    return stopped("completed", t("mutation_invalid_output", { detail: result.truncated ? "output truncated" : (reading.problem ?? "") }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` });
  }
  if (reading.valid === 0 || reading.score === null) {
    return stopped("completed", t("mutation_no_mutants"), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` });
  }

  const findings: ResultFinding[] = [];
  const common = { stageId: item.id, tool: ADAPTER_ID, ...(version ? { toolVersion: version } : {}), category: "tests", origin: ADAPTER_ID, waived: false } as const;
  for (const s of reading.survivors.slice(0, MAX_FINDINGS)) {
    const file = locate(cwd, contract.root, s, engine);
    findings.push({
      ...common,
      ruleId: s.kind === "survived" ? "mutation.survived" : "mutation.not-covered",
      severity: "warning",
      normalizedSeverity: "medium",
      message: t(s.kind === "survived" ? "mutation_survived" : "mutation_not_covered", { file, line: s.line ?? "?", mutator: s.mutator, replacement: s.replacement || "-" }),
      location: { path: file, ...(s.line !== null ? { line: s.line } : {}), ...(s.column !== null ? { column: s.column } : {}) },
      fingerprint: contentHash({ tool: ADAPTER_ID, rule: s.kind, file, line: s.line, mutator: s.mutator, replacement: s.replacement }),
      blocking: false,
    });
  }
  const below = contract.minimum !== null && reading.score < contract.minimum;
  if (below) {
    findings.push({
      ...common,
      ruleId: "mutation.score-below-minimum",
      severity: "error",
      normalizedSeverity: "high",
      message: t("mutation_below", { component: contract.component ?? ".", score: reading.score, detected: reading.detected, valid: reading.valid, minimum: contract.minimum as number, source: contract.minimumSource ?? "-" }),
      fingerprint: contentHash({ tool: ADAPTER_ID, rule: "score-below-minimum", component: contract.component, minimum: contract.minimum }),
      blocking: true,
      blockingReason: "blocking-tool",
    });
  }

  const count = (id: string, key: string, value: number): ResultMetric => ({ id, label: t(key), unit: "count", value, ...withComponent, scope, origin: ADAPTER_ID });
  const metrics: ResultMetric[] = [
    ratioMetric({
      id: "mutation.score",
      label: t("mutation_metric_score"),
      numerator: reading.detected,
      denominator: reading.valid,
      ...withComponent,
      scope,
      origin: ADAPTER_ID,
      basis: "mutants",
      exclusions: reading.excluded > 0 ? [t("mutation_exclusion_invalid", { count: reading.excluded })] : [],
      format: engine === "mutmut" ? "mutmut cicd stats" : "mutation-testing-elements json",
    }),
    count("mutation.killed", "mutation_metric_killed", reading.detected),
    count("mutation.survived", "mutation_metric_survived", reading.survived),
    count("mutation.not-covered", "mutation_metric_not_covered", reading.notCovered),
  ];
  const reason =
    contract.minimum !== null
      ? t("mutation_reason_minimum", { engine, version: version ?? "?", score: reading.score, detected: reading.detected, valid: reading.valid, survived: reading.survived, notCovered: reading.notCovered, minimum: contract.minimum })
      : t("mutation_reason", { engine, version: version ?? "?", score: reading.score, detected: reading.detected, valid: reading.valid, survived: reading.survived, notCovered: reading.notCovered });
  const listed = reading.survivors.length > MAX_FINDINGS ? `; ${t("mutation_truncated", { listed: MAX_FINDINGS, total: reading.survivors.length })}` : "";
  return withLogs({
    ...base,
    stages: [stageFor("completed", reason + listed, { blockingViolations: below ? 1 : 0, findings: findings.length, nativeStatus: `exit ${result.exitCode ?? "-"}` })],
    findings,
    metrics,
  });
}

export const mutationAdapter: ExternalAdapter = {
  manifest: mutationManifest,
  plan: planMutation,
  run: runMutation,
};
