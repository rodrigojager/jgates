// dependency-cruiser adapter: extracts the dependency graph of the JavaScript and TypeScript components and hands it
// to the architecture evaluator, which applies .jgates/architecture.yml (forbidden dependencies, component boundaries,
// cycles). The command is the executable of the project or of JGates (never npx; nothing is downloaded in a run). The
// configuration is generated in the run folder, or the user's own is imported through the `config` binding.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { ARCHITECTURE_FILE, evaluateArchitecture, readArchitecture, type ArchitectureEvaluation } from "../../core/architecture/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ArchitectureCoverageRecord, ResultFinding, ResultStage } from "../../core/run/types.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { GENERATED_CONFIG_NAME, generatedConfig } from "./config.js";
import { parseDepcruiseOutput } from "./graph.js";
import { dependencyCruiserManifest } from "./manifest.js";
import { probeDepcruise } from "./probe.js";

export { dependencyCruiserManifest } from "./manifest.js";
export { parseDepcruiseOutput, componentOf } from "./graph.js";
export { findDepcruise, probeDepcruise } from "./probe.js";
export { generatedConfig } from "./config.js";

const ADAPTER_ID = dependencyCruiserManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";

const sha256 = (abs: string): string | null => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
};
const isFile = (abs: string): boolean => {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
};

/** The config binding of the instance (the user's own dependency-cruiser configuration), when it points to a file. */
function boundConfig(dir: string, tool: string): string | null {
  try {
    const instance = resolveToolBindings(dir, { skipInventory: true, manifests: [dependencyCruiserManifest] }).instances.find((i) => i.id === tool);
    const binding = instance?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.relPath !== null && b.exists);
    return binding?.relPath ?? null;
  } catch {
    return null;
  }
}

function planDepcruise(input: ExternalPlanInput): ExternalPlan {
  const t = translator("dependency-cruiser");
  const probe = probeDepcruise(input.dir, input.env);
  const architecture = readArchitecture(input.dir);
  const bound = boundConfig(input.dir, input.tool);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const outDir = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const config = bound ? `${WORKSPACE}/${bound}` : `${outDir}/${GENERATED_CONFIG_NAME}`;
  const tsconfig = [root ? `${root}/tsconfig.json` : null, "tsconfig.json"].find((c) => c !== null && isFile(path.join(input.dir, c))) ?? null;
  const args = [
    ...probe.prefix,
    "--config",
    config,
    "--output-type",
    "json",
    "--output-to",
    `${outDir}/graph.json`,
    ...(tsconfig ? ["--ts-config", tsconfig] : []),
    root ?? ".",
  ];

  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("dependency_cruiser_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("dependency_cruiser_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, dependencyCruiserManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: t("dependency_cruiser_incompatible", { version: probe.version, range: dependencyCruiserManifest.toolVersionRange }) };
  } else if (!architecture.declaration && architecture.problems.length === 0) availability = { status: "unavailable", reason: t("dependency_cruiser_no_architecture", { tool: input.tool }) };
  else if (!architecture.declaration) {
    const detail = architecture.problems.slice(0, 3).map((p) => `${p.path}: ${p.message}`).join("; ");
    availability = { status: "unavailable", reason: t("dependency_cruiser_architecture_invalid", { tool: input.tool, detail }) };
  } else availability = { status: "available", reason: null };

  const configFiles: ExternalPlan["configFiles"] = [];
  if (architecture.declaration) configFiles.push({ file: ARCHITECTURE_FILE, sha256: sha256(path.join(input.dir, ARCHITECTURE_FILE)) });
  if (bound) configFiles.push({ file: bound, sha256: sha256(path.join(input.dir, bound)) });
  if (tsconfig) configFiles.push({ file: tsconfig, sha256: sha256(path.join(input.dir, tsconfig)) });

  const ruleIds = (architecture.declaration?.contract.rules ?? []).filter((r) => r.enabled !== false).map((r) => r.id);
  return {
    label: t("dependency_cruiser_label"),
    command: {
      executable: probe.executable ?? "depcruise",
      args,
      cwd: WORKSPACE,
      env: {},
      stdin: null,
    },
    runtime: { name: "node", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles,
    availability,
    blocksPlan: false,
    network: false,
    limitations: [],
    conditions: [
      bound ? t("dependency_cruiser_condition_binding", { file: bound }) : t("dependency_cruiser_condition_generated"),
      ...(probe.tool ? [t("dependency_cruiser_condition_binary", { tool: probe.tool, source: probe.source ?? "-" })] : []),
    ],
    output: { format: "json", schema: null },
    // The user's own configuration is JavaScript the tool loads; the generated one is data.
    ...(bound ? { effects: { executesProjectCode: true } } : {}),
    contract: {
      extractor: ADAPTER_ID,
      configSource: bound ? "binding" : "generated",
      configFile: bound,
      architectureFile: ARCHITECTURE_FILE,
      ruleIds,
      tsconfig,
    },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

function toFinding(f: ArchitectureEvaluation["findings"][number], stageId: string, version: string | null): ResultFinding {
  return {
    stageId,
    tool: ADAPTER_ID,
    ...(version ? { toolVersion: version } : {}),
    ruleId: f.ruleId,
    category: f.category,
    severity: f.severity,
    normalizedSeverity: f.severity,
    message: f.message,
    location: { path: f.path },
    fingerprint: contentHash({ tool: ADAPTER_ID, rule: f.ruleId, kind: f.rule, path: f.path, metadata: f.metadata }),
    origin: f.file,
    blocking: f.blocking,
    ...(f.blocking ? { blockingReason: "blocking-tool" as const } : {}),
    waived: false,
  };
}

async function runDepcruise(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("dependency-cruiser");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("dependency_cruiser_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  // Node's folder is the only thing the tool needs on PATH; nothing else leaks from the caller.
  const env: Record<string, string> = { PATH: path.dirname(process.execPath) };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const required = items.some((i) => i.requirement === "required");
  const generated = (invocation.contract as { configSource?: string } | undefined)?.configSource !== "binding";

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const graphFile = path.join(outDir, "graph.json");
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
  const uninterpreted = (detail: string): AdapterOutput => ({
    ...base,
    stages: items.map((i) => stageFor(i, "completed", t("dependency_cruiser_invalid_output", { detail }), { interpreted: false, nativeStatus: "exit 0" })),
    findings: [],
  });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("dependency_cruiser_blocked", { detail: command.executable }));
  const declaration = readArchitecture(context.workspacePath).declaration;
  if (!declaration) return blockedAll(t("dependency_cruiser_no_architecture", { tool }));

  if (generated) {
    const configPath = args[args.indexOf("--config") + 1];
    if (configPath) fs.writeFileSync(configPath, generatedConfig({ architectureFile: ARCHITECTURE_FILE, ruleIds: (declaration.contract.rules ?? []).filter((r) => r.enabled !== false).map((r) => r.id) }), { mode: 0o600 });
  }

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];
  if (result.spawnError) return { ...blockedAll(t("dependency_cruiser_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("dependency_cruiser_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // No rule is evaluated by the tool itself, so anything but 0 is an error reading the configuration or the sources.
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("dependency_cruiser_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  let text: string;
  try {
    text = fs.readFileSync(graphFile, "utf8");
  } catch (error) {
    return uninterpreted((error as Error).message);
  }
  const components = (items[0]?.components ?? []).map((c) => ({ id: c.id, root: c.root }));
  const parsed = parseDepcruiseOutput(text, { version, components });
  if (!parsed.ok || result.truncated) return uninterpreted(result.truncated ? "output truncated" : (parsed.problem ?? ""));

  const evaluation = await evaluateArchitecture({ graph: parsed.graph, declaration, required, cwd: context.runDir, env: context.env, ...(context.signal ? { signal: context.signal } : {}) });
  fs.writeFileSync(path.join(outDir, "normalized-graph.json"), JSON.stringify(parsed.graph, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, "coverage.json"), JSON.stringify({ state: evaluation.state, verified: evaluation.verified, reason: evaluation.reason ?? null, coverage: evaluation.coverage, rules: evaluation.rules }, null, 2), { mode: 0o600 });

  const findings = evaluation.findings.map((f) => toFinding(f, items[0]?.id as string, version));
  const blocking = findings.filter((f) => f.blocking).length;
  const counts = { version: version ?? "?", nodes: evaluation.coverage.nodes, edges: evaluation.coverage.edges, findings: findings.length, coverage: evaluation.coverage.status, unresolved: evaluation.coverage.unresolved };
  if (evaluation.state === "incomplete") {
    // Not proven: the stage proves nothing, so the required architecture check ends incomplete (never passed).
    return {
      ...base,
      stages: items.map((i) => stageFor(i, "completed", t("dependency_cruiser_reason_incomplete", { detail: evaluation.reason ?? "-", coverage: counts.coverage, unresolved: counts.unresolved }), { interpreted: false, nativeStatus: "exit 0", findings: findings.length })),
      findings,
      architecture: [coverageRecord("dependency-cruiser", evaluation)],
    };
  }
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", t("dependency_cruiser_reason_completed", counts), { blockingViolations: blocking, findings: findings.length, nativeStatus: "exit 0" })),
    findings,
    architecture: [coverageRecord("dependency-cruiser", evaluation)],
  };
}

/** The coverage of the graph this check judged, as result.architecture records it. */
function coverageRecord(tool: string, evaluation: Awaited<ReturnType<typeof evaluateArchitecture>>): ArchitectureCoverageRecord {
  const c = evaluation.coverage;
  return {
    tool,
    status: c.status,
    verified: evaluation.verified,
    nodes: c.nodes,
    edges: c.edges,
    unresolved: c.unresolved,
    unresolvedSample: c.unresolvedSample.slice(0, 20).map((u) => ({ from: u.from, specifier: u.specifier, ...(u.reason ? { reason: u.reason } : {}) })),
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
  };
}

export const dependencyCruiserAdapter: ExternalAdapter = {
  manifest: dependencyCruiserManifest,
  plan: planDepcruise,
  run: runDepcruise,
};
