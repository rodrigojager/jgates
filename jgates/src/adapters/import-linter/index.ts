// Import Linter adapter: architecture contracts for Python. The plan shows one `lint-imports` command per tool
// instance: the native configuration the user keeps (binding, .importlinter, setup.cfg, pyproject.toml) as it is, or a
// configuration generated in the run folder from the forbidden-dependency rules of .jgates/architecture.yml. A finding
// carries the id of the declared rule and the file of the import. The adapter also builds the normalized import graph
// (grimp) and hands it to the architecture evaluator: imports the tool cannot resolve, an empty graph or an unreadable
// source are a coverage gap, and a required architecture check over a graph that is not complete ends incomplete.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { ARCHITECTURE_FILE, evaluateArchitecture, readArchitecture, type ArchitectureContract, type NormalizedGraph } from "../../core/architecture/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ArchitectureCoverageRecord, ResultFinding, ResultStage } from "../../core/run/types.js";
import { chooseNativeConfig, generateConfig, sha256File, translatableRules } from "./config.js";
import { buildImportGraph, discoverPythonRoots, type PythonRoot } from "./graph.js";
import { importLinterManifest } from "./manifest.js";
import { parseImportLinterOutput, type ImportLinterReport } from "./parse.js";
import { probeImportLinter, pythonBeside, toolPath } from "./probe.js";

export { importLinterManifest } from "./manifest.js";
export { parseImportLinterOutput } from "./parse.js";
export { findImportLinter, probeImportLinter } from "./probe.js";
export { discoverPythonRoots, GRAPH_HELPER } from "./graph.js";
export { generateConfig, layerModules } from "./config.js";

const ADAPTER_ID = importLinterManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";
const GENERATED_NAME = "importlinter.ini";

interface InvocationContract {
  mode: "native" | "generated" | "none";
  nativeFile: string | null;
  architectureFile: string | null;
  roots: PythonRoot[];
  rules: Array<{ id: string; severity: string; blocking: boolean }>;
}

const slash = (p: string): string => p.split(path.sep).join("/");

function planImportLinter(input: ExternalPlanInput): ExternalPlan {
  const t = translator("import-linter");
  const probe = probeImportLinter(input.env);
  const architecture = readArchitecture(input.dir);
  const native = chooseNativeConfig(input.dir, input.tool, input.componentRoot);
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const base = path.resolve(input.dir, root ?? ".");
  const { roots } = discoverPythonRoots(input.dir, base);
  const rules = architecture.declaration ? translatableRules(architecture.declaration.contract) : [];
  const mode: InvocationContract["mode"] = native.file ? "native" : rules.length > 0 ? "generated" : "none";
  const outDir = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const configArg = native.file ? `${WORKSPACE}/${native.file}` : `${outDir}/${GENERATED_NAME}`;
  const sourceRoots = [...new Set(roots.map((r) => r.sourceRoot))];
  const pythonPath = sourceRoots.map((s) => (s === "." ? WORKSPACE : `${WORKSPACE}/${s}`)).join(path.delimiter);

  let availability: ExternalPlan["availability"];
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("il_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("il_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, importLinterManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: t("il_incompatible", { version: probe.version, range: importLinterManifest.toolVersionRange }) };
  } else if (mode === "none" && architecture.problems.length > 0) {
    const detail = architecture.problems.slice(0, 3).map((p) => `${p.path}: ${p.message}`).join("; ");
    availability = { status: "unavailable", reason: t("il_architecture_invalid", { tool: input.tool, detail }) };
  } else if (mode === "none") availability = { status: "unavailable", reason: t("il_no_contract", { tool: input.tool }) };
  else availability = { status: "available", reason: null };

  const configFiles: ExternalPlan["configFiles"] = [];
  if (architecture.declaration) configFiles.push({ file: ARCHITECTURE_FILE, sha256: sha256File(path.join(input.dir, ARCHITECTURE_FILE)) });
  if (native.file) configFiles.push({ file: native.file, sha256: native.sha256 });

  const contract: InvocationContract = {
    mode,
    nativeFile: native.file,
    architectureFile: architecture.declaration ? ARCHITECTURE_FILE : null,
    roots,
    rules: rules.map((r) => ({ id: r.id, severity: r.severity ?? "high", blocking: r.blocking !== false })),
  };
  return {
    label: t("il_label"),
    command: {
      executable: probe.executable ?? "lint-imports",
      args: ["--config", configArg, "--no-cache", "--no-logo"],
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: { ...(pythonPath ? { PYTHONPATH: pythonPath } : {}), PYTHONDONTWRITEBYTECODE: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.python ?? probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles,
    availability,
    blocksPlan: false,
    network: false,
    limitations: [t("il_limitation_python")],
    conditions: [mode === "native" ? t("il_condition_native", { file: native.file ?? "-" }) : t("il_condition_generated")],
    output: { format: "text", schema: null },
    contract: contract as unknown as Record<string, unknown>,
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

/** Component of a node: the one whose root is the longest prefix of the node's path. */
function assignComponents(graph: NormalizedGraph, components: Array<{ id: string; root: string }>): void {
  const sorted = [...components].filter((c) => c.root && c.root !== ".").sort((a, b) => b.root.length - a.root.length);
  for (const node of graph.nodes) {
    if (!node.path) continue;
    const hit = sorted.find((c) => node.path === c.root || node.path?.startsWith(`${c.root}/`));
    const only = components.length === 1 && (components[0] as { root: string }).root === "." ? components[0] : undefined;
    const found = hit ?? only;
    if (found) node.component = found.id;
  }
}

async function runImportLinter(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("import-linter");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("il_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = { PATH: toolPath(context.env.PATH) };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const required = items.some((i) => i.requirement === "required");
  const planned = (invocation.contract ?? {}) as Partial<InvocationContract>;
  const mode = planned.mode ?? "none";
  const roots = planned.roots ?? [];

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);
  const graphLog = path.join(context.logsDir, `${tool}.graph.stderr.log`);

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
  const errorAll = (reason: string): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, "error", reason, { interpreted: false })), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("il_blocked", { detail: command.executable }));

  const declaration = readArchitecture(context.workspacePath).declaration;
  const contract: ArchitectureContract = declaration?.contract ?? {};

  // 1. The normalized graph (it also tells which layers cover which modules, for the generated configuration).
  const python = pythonBeside(command.executable);
  const graphFile = path.join(outDir, "normalized-graph.json");
  let graph: NormalizedGraph;
  if (!python) graph = { nodes: [], edges: [], unresolved: [], coverage: { extractor: ADAPTER_ID, complete: false, reason: t("il_no_python", { executable: command.executable }) } };
  else if (roots.length === 0) graph = { nodes: [], edges: [], unresolved: [], coverage: { extractor: ADAPTER_ID, complete: false, reason: t("il_no_packages") } };
  else {
    const built = await buildImportGraph({ python, workspace: context.workspacePath, roots, env: context.env, cwd: context.runDir, outFile: graphFile, errFile: graphLog, timeoutMs: timeoutSeconds * 1000 });
    graph = built.graph;
  }
  assignComponents(graph, (items[0]?.components ?? []).map((c) => ({ id: c.id, root: c.root })));
  fs.writeFileSync(graphFile, JSON.stringify(graph, null, 2), { mode: 0o600 });

  // 2. The contracts: native as it is, or generated from the declared rules.
  let handled = new Set<string>();
  let skipped: Array<{ ruleId: string; reason: string }> = [];
  let runTool = mode === "native" || graph.nodes.length > 0;
  if (mode === "generated") {
    const rules = translatableRules(contract);
    const generated = generateConfig(contract, rules, graph, [...new Set(graph.nodes.map((n) => n.id.split(".")[0] as string))].sort());
    const configPath = args[args.indexOf("--config") + 1];
    if (configPath) fs.writeFileSync(configPath, generated.text, { mode: 0o600 });
    handled = new Set(generated.contracts.map((c) => c.ruleId));
    skipped = generated.skipped;
    if (generated.contracts.length === 0) runTool = false;
  }

  // 3. Import Linter itself.
  let report: ImportLinterReport | null = null;
  let nativeStatus = "not run";
  if (runTool) {
    const result = await runSpec(
      { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
      { parentEnv: context.env },
    );
    base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];
    if (result.spawnError) return { ...blockedAll(t("il_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
    if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("il_timeout", { seconds: timeoutSeconds }))), findings: [] };
    nativeStatus = `exit ${result.exitCode ?? "-"}`;
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
      return errorAll(t("il_exit_error", { code: result.exitCode ?? "-", detail }));
    }
    if (result.truncated || result.logTruncated) return errorAll(t("il_invalid_output", { detail: "output truncated" }));
    report = parseImportLinterOutput(result.stdout);
    if (!report.ok) {
      const tail = (result.stderr || "").trim().split(/\r?\n/).slice(-2).join(" ");
      return errorAll(t("il_invalid_output", { detail: `${report.problem ?? ""}${tail ? ` (${tail})` : ""}` }));
    }
    // Exit code and report must agree: a broken contract with exit 0 (or the reverse) proves nothing.
    if ((result.exitCode === 0) !== (report.broken === 0)) return errorAll(t("il_invalid_output", { detail: `exit ${result.exitCode} with ${report.broken} broken contract(s)` }));
    if (mode === "generated") {
      const missing = [...handled].filter((id) => !report?.contracts.some((c) => c.name === id));
      if (missing.length > 0) return errorAll(t("il_contract_missing", { rules: missing.join(", ") }));
    }
  }

  // 4. Findings of Import Linter: the id of the declared rule, the file of the importer.
  const ruleInfo = new Map((planned.rules ?? []).map((r) => [r.id, r]));
  const byModule = new Map(graph.nodes.map((n) => [n.id, n.path]));
  const origin = mode === "generated" ? ARCHITECTURE_FILE : (planned.nativeFile ?? "import-linter");
  const stageId = items[0]?.id as string;
  const findings: ResultFinding[] = [];
  for (const c of report?.contracts ?? []) {
    if (c.status !== "broken") continue;
    const declared = ruleInfo.get(c.name);
    const severity = declared?.severity ?? "high";
    const blocking = declared?.blocking ?? true;
    for (const g of c.groups) {
      for (const chain of g.chains) {
        const first = chain[0];
        if (!first) continue;
        const file = byModule.get(first.from) ?? first.from;
        const line = first.lines[0];
        const route = chain.map((l) => `${l.from} -> ${l.to}${l.lines.length ? ` (l.${l.lines.join(", l.")})` : ""}`).join("; ");
        findings.push({
          stageId,
          tool: ADAPTER_ID,
          ...(version ? { toolVersion: version } : {}),
          ruleId: c.name,
          category: "architecture-policy",
          severity,
          normalizedSeverity: severity as ResultFinding["normalizedSeverity"],
          message: t("il_finding", { header: g.header, route }),
          location: { path: file, ...(line !== undefined ? { line } : {}) },
          fingerprint: contentHash({ tool: ADAPTER_ID, rule: c.name, path: file, line: line ?? null, route }),
          origin,
          blocking,
          ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
          waived: false,
        });
      }
    }
  }

  // 5. The evaluator reads the graph: rules Import Linter did not take (and the coverage of everything).
  const evaluated: ArchitectureContract = mode === "generated" ? { ...contract, rules: (contract.rules ?? []).filter((r) => !handled.has(r.id)) } : { layers: [], rules: [] };
  const evaluation = await evaluateArchitecture({
    graph,
    declaration: { file: mode === "native" ? (planned.nativeFile ?? ARCHITECTURE_FILE) : ARCHITECTURE_FILE, contract: evaluated },
    required,
    cwd: context.runDir,
    env: context.env,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  fs.writeFileSync(
    path.join(outDir, "coverage.json"),
    JSON.stringify({ state: evaluation.state, verified: evaluation.verified, reason: evaluation.reason ?? null, coverage: evaluation.coverage, rules: evaluation.rules, skippedRules: skipped }, null, 2),
    { mode: 0o600 },
  );
  for (const f of evaluation.findings) {
    findings.push({
      stageId,
      tool: "architecture",
      ...(version ? { toolVersion: version } : {}),
      ruleId: f.ruleId,
      category: f.category,
      severity: f.severity,
      normalizedSeverity: f.severity,
      message: f.message,
      location: { path: f.path },
      fingerprint: contentHash({ tool: "architecture", rule: f.ruleId, kind: f.rule, path: f.path, metadata: f.metadata }),
      origin: f.file,
      blocking: f.blocking,
      ...(f.blocking ? { blockingReason: "blocking-tool" as const } : {}),
      waived: false,
    });
  }

  const blocking = findings.filter((f) => f.blocking).length;
  const counts = { version: version ?? "?", contracts: report?.contracts.length ?? 0, nodes: evaluation.coverage.nodes, edges: evaluation.coverage.edges, findings: findings.length, coverage: evaluation.coverage.status, unresolved: evaluation.coverage.unresolved };
  if (blocking === 0 && evaluation.state === "incomplete") {
    // Not proven: the graph is partial or empty, so the absence of findings is not the absence of violations.
    const gaps = evaluation.coverage.unresolvedSample.slice(0, 3).map((u) => `${u.from} -> ${u.specifier}`).join("; ");
    const reason = t("il_reason_incomplete", { detail: evaluation.reason ?? "-", coverage: counts.coverage, unresolved: counts.unresolved, gaps: gaps || "-" });
    return { ...base, stages: items.map((i) => stageFor(i, "completed", reason, { interpreted: false, nativeStatus, findings: findings.length })), findings, architecture: [coverageRecord("import-linter", evaluation)] };
  }
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", t("il_reason_completed", counts), { blockingViolations: blocking, findings: findings.length, nativeStatus })),
    findings,
    architecture: [coverageRecord("import-linter", evaluation)],
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

export const importLinterAdapter: ExternalAdapter = {
  manifest: importLinterManifest,
  plan: planImportLinter,
  run: runImportLinter,
};
