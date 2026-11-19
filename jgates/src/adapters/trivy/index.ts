// Trivy adapter: one `trivy fs` per tool instance in the container runner, with the scanners its capabilities ask
// for, the project's trivy.yaml and ignore file as two documents. The scan is offline (--network none): the
// vulnerability database is the jgates-data volume mounted read-only (core/data), and the fetch time of the database the
// run read is recorded in the result.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";
import { scanImage, trivyImageArgs, type TrivyImageTarget } from "./image.js";
import { outputToken, planScanner, probeScannerImage, REPORT_FILE, runScanner, workspaceToken, type ScannerDefinition } from "../container-scanner/index.js";
import { trivyManifest } from "./manifest.js";
import { parseTrivyReport, parseTrivySbom, trivyFacts } from "./normalize.js";
import { databaseDir, recordedDatabaseFacts } from "../../core/data/index.js";

export { trivyManifest } from "./manifest.js";
export { databaseSource, parseTrivyReport, parseTrivySbom, trivyFacts, TRIVY_DEFAULT_DB, TRIVY_SCHEMA_VERSION } from "./normalize.js";

/** Trivy scanner of each capability. */
export const TRIVY_SCANNERS: Record<string, string> = { dependencies: "vuln", iac: "misconfig", secrets: "secret", licenses: "license" };

export const trivyScanner: ScannerDefinition = {
  manifest: trivyManifest,
  label: "trivy_label",
  capabilities: Object.keys(TRIVY_SCANNERS),
  documents: [
    { binding: "config", native: ["trivy.yaml"] },
    { binding: "ignore", native: [".trivyignore", ".trivyignore.yaml"] },
  ],
  args(input) {
    const config = input.documents.config?.file ?? null;
    const ignore = input.documents.ignore?.file ?? null;
    const scanners = input.capabilities.map((c) => TRIVY_SCANNERS[c]).filter((s): s is string => s !== undefined);
    const withDatabase = input.capabilities.includes("dependencies");
    return [
      ...(config ? ["--config", workspaceToken(config)] : []),
      "fs",
      "--scanners",
      scanners.join(","),
      "--format",
      "json",
      "--output",
      `${input.out}/${REPORT_FILE}`,
      "--exit-code",
      "0",
      // The vulnerability database is the jgates-data volume (read-only): the scan never downloads anything, and the scan
      // cache stays in memory because the database folder cannot be written. Without the vulnerability scanner the
      // cache is the instance's output folder.
      ...(withDatabase ? ["--cache-dir", databaseDir("trivy", input.env), "--cache-backend", "memory", "--skip-db-update", "--offline-scan"] : ["--cache-dir", `${input.out}/cache`]),
      "--skip-check-update",
      "--skip-java-db-update",
      "--skip-version-check",
      "--disable-telemetry",
      "--no-progress",
      ...(ignore ? ["--ignorefile", workspaceToken(ignore)] : []),
      ".",
    ];
  },
  exitCodes: [0],
  network: false,
  conditions(input, t) {
    const scanners = input.capabilities.map((c) => TRIVY_SCANNERS[c]).filter(Boolean).join(", ");
    return [t("trivy_condition_scanners", { scanners }), ...(input.capabilities.includes("dependencies") ? [t("trivy_condition_database")] : [])];
  },
  limitations(_input, t) {
    return [t("trivy_limitation_download"), t("trivy_limitation_exceptions")];
  },
  parse: parseTrivyReport,
  facts: (outputDir, stderr) => recordedDatabaseFacts(outputDir, "trivy") ?? trivyFacts(databaseDir("trivy"), stderr),
};

/** File the SBOM instance writes in its output folder: the project's CycloneDX bill of materials, an artifact of the run. */
export const SBOM_FILE = "sbom.cdx.json";

/**
 * The SBOM instance of the same adapter: `trivy fs --format cyclonedx` with no scanner, so no database is read and
 * nothing is downloaded. The document is the product; a well-formed one has no finding.
 */
export const trivySbomScanner: ScannerDefinition = {
  manifest: trivyManifest,
  label: "trivy_sbom_label",
  capabilities: ["sbom"],
  documents: [{ binding: "config", native: ["trivy.yaml"] }],
  report: SBOM_FILE,
  args(input) {
    const config = input.documents.config?.file ?? null;
    return [
      ...(config ? ["--config", workspaceToken(config)] : []),
      "fs",
      "--scanners=",
      "--format",
      "cyclonedx",
      "--output",
      `${input.out}/${SBOM_FILE}`,
      "--exit-code",
      "0",
      "--cache-dir",
      `${input.out}/cache`,
      "--skip-check-update",
      "--skip-java-db-update",
      "--skip-version-check",
      "--disable-telemetry",
      "--no-progress",
      ".",
    ];
  },
  exitCodes: [0],
  network: false,
  conditions(_input, t) {
    return [t("trivy_sbom_condition", { file: SBOM_FILE })];
  },
  limitations(_input, t) {
    return [t("trivy_sbom_limitation")];
  },
  parse: parseTrivySbom,
};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const WORKSPACE = "{workspace}";

/** Final-image mode of an instance: `imageRef` (a reference) or `imageTarball` (a saved tarball) replaces the filesystem scan. */
export interface TrivyImageSettings {
  mode: "fs" | "image";
  /** What `trivy image` scans, as the plan shows it (a tarball under the workspace uses the {workspace} token). */
  target: { reference: string } | { tarball: string } | null;
  /** Workspace-resolved path of the tarball (to check that it exists). */
  tarballPath: string | null;
  problems: string[];
}

export function trivyImageSettings(input: Pick<ExternalPlanInput, "config" | "tool" | "dir">): TrivyImageSettings {
  const t = translator("trivy");
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const body = isRec(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  const ref = body.imageRef;
  const tar = body.imageTarball;
  const problems: string[] = [];
  if (ref === undefined && tar === undefined) return { mode: "fs", target: null, tarballPath: null, problems };
  if (ref !== undefined && tar !== undefined) problems.push(t("trivy_image_both", { tool: input.tool }));
  if (ref !== undefined && (typeof ref !== "string" || ref === "" || ref.startsWith("-") || /\s/.test(ref))) problems.push(t("trivy_image_ref_invalid", { tool: input.tool, value: String(ref) }));
  if (tar !== undefined && (typeof tar !== "string" || tar === "" || tar.startsWith("-"))) problems.push(t("trivy_image_tarball_invalid", { tool: input.tool, value: String(tar) }));
  if (problems.length > 0) return { mode: "image", target: null, tarballPath: null, problems };
  if (typeof ref === "string") return { mode: "image", target: { reference: ref }, tarballPath: null, problems };
  const file = tar as string;
  const absolute = path.isAbsolute(file);
  const resolved = absolute ? file : path.join(input.dir, ...file.split(/[\\/]/));
  return { mode: "image", target: { tarball: absolute ? file : `${WORKSPACE}/${file.replace(/\\/g, "/")}` }, tarballPath: resolved, problems };
}

function planTrivyImage(input: ExternalPlanInput, settings: TrivyImageSettings): ExternalPlan {
  const t = translator("trivy");
  const blocksPlan = settings.problems.length > 0;
  let availability: ExternalPlan["availability"] = { status: "available", reason: null };
  if (blocksPlan) availability = { status: "unavailable", reason: settings.problems.join(" ") };
  else if (settings.tarballPath !== null && !fs.existsSync(settings.tarballPath)) availability = { status: "unavailable", reason: t("trivy_image_tarball_missing", { tool: input.tool, file: settings.tarballPath }) };
  const out = outputToken(trivyManifest.id, input.tool);
  // The step sees the synchronized project, not the host: a tarball outside the workspace is out of its reach.
  if (!blocksPlan && availability.status === "available" && settings.target && "tarball" in settings.target && path.isAbsolute(settings.target.tarball)) {
    availability = { status: "unavailable", reason: t("trivy_image_tarball_outside", { tool: input.tool, file: settings.target.tarball }) };
  }
  const args = settings.target ? trivyImageArgs(settings.target, databaseDir("trivy", input.env)) : [];
  const probe = probeScannerImage(input.env, trivyManifest.toolName);
  if (availability.status === "available") {
    if (probe.problem !== null) availability = { status: "unavailable", reason: translator("security")("security_not_in_image", { tool: trivyManifest.displayName, instance: input.tool, runtime: probe.runtimeName, image: probe.image ?? "-", detail: probe.detail }) };
    else if (probe.version === null || satisfiesRange(probe.version, trivyManifest.toolVersionRange) !== true) {
      availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: trivyManifest.toolName, version: probe.version ?? "?", range: trivyManifest.toolVersionRange, what: trivyManifest.id }) };
    }
  }
  const uncredited: Record<string, string> = {};
  for (const cap of new Set([input.capability, ...Object.keys(TRIVY_SCANNERS)])) {
    if (cap !== "dependencies") uncredited[cap] = t("trivy_image_only_vulnerabilities", { capability: cap });
  }
  // The scan runs in the step container of the tools image (like every other tool): the plan only names the command.
  return {
    label: t("trivy_image_label"),
    command: {
      executable: trivyManifest.toolName,
      args,
      cwd: WORKSPACE,
      env: { HOME: `${out}/home`, TMPDIR: `${out}/tmp` },
      stdin: null,
    },
    runtime: { name: "container", interpreter: probe.runtime, available: availability.status === "available" },
    toolVersion: probe.version,
    configFiles: [],
    availability,
    blocksPlan,
    // A tarball is read from the workspace; only a registry reference needs the network (the database never does).
    network: settings.target !== null && "reference" in settings.target,
    limitations: [t("trivy_image_limitation")],
    conditions: [t("trivy_image_condition", { target: settings.target ? ("reference" in settings.target ? settings.target.reference : settings.target.tarball) : "-" })],
    output: { format: "json", schema: null },
    uncredited,
    contract: { mode: "image", report: "trivy image --format json", parser: trivyManifest.toolVersionRange },
  };
}

async function runTrivyImage(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("trivy");
  const invocation = plan.invocations.find((i) => i.adapter === trivyManifest.id && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === trivyManifest.id && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("trivy_image_no_invocation", { tool }));
  const stageFor = (item: PlanItem, state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({
    id: item.id,
    label: item.label,
    kind: "step",
    adapter: trivyManifest.id,
    state,
    ...(reason ? { reason } : {}),
    ...extra,
  });
  const base = {
    requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
    disabled: [],
    logs: [] as string[],
    outputs: [] as string[],
  };
  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return { ...base, stages: items.map((i) => stageFor(i, "blocked", unavailable.availability.reason ?? t("trivy_image_blocked"))), findings: [] };

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const args = invocation.command.args.map((a) => substituteTokens(a, tokens));
  const input = args.indexOf("--input");
  const target: TrivyImageTarget = input >= 0 ? { tarball: args[input + 1] as string } : { reference: args[args.length - 1] as string };
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const outDir = path.join(context.outputsDir, trivyManifest.id, tool);
  for (const sub of ["", "home", "tmp", "cache"]) fs.mkdirSync(path.join(outDir, sub), { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(invocation.command.env)) env[name] = substituteTokens(value, tokens);
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);
  const cwd = substituteTokens(invocation.command.cwd, tokens);
  const scan = await scanImage(target, {
    cacheDir: databaseDir("trivy", context.env),
    run: async (scanArgs) => {
      const r = await runSpec({ executable: invocation.command.executable, args: scanArgs, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog }, { parentEnv: context.env });
      return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr, ...(r.spawnError ? { errorCode: r.spawnError.code, errorMessage: r.spawnError.message } : {}) };
    },
  });
  base.logs = [stdoutLog, stderrLog].filter((f) => fs.existsSync(f)).map((f) => path.relative(context.runDir, f).split(path.sep).join("/"));
  if (scan.state === "missing-tool") {
    // A missing Trivy (or a stopped container runtime) is a blocked stage with the way to fix it, never a clean image.
    return { ...base, stages: items.map((i) => stageFor(i, "blocked", t("trivy_image_missing_tool", { reason: scan.reason }))), findings: [] };
  }
  if (scan.state === "error") {
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("trivy_image_error", { reason: scan.reason }), { interpreted: false })), findings: [] };
  }
  fs.writeFileSync(path.join(outDir, "image-findings.json"), JSON.stringify(scan.findings, null, 2), { mode: 0o600 });
  const stage = items.find((i) => i.capabilities[0] === "dependencies") ?? (items[0] as PlanItem);
  const findings: ResultFinding[] = scan.findings.map(({ capability: _capability, ...f }) => ({ stageId: stage.id, ...f }));
  const blocking = findings.filter((f) => f.blocking).length;
  const reason = t("trivy_image_reason_completed", { version: scan.reportedVersion ?? "?", count: findings.length, runner: scan.runner });
  return {
    ...base,
    outputs: [path.relative(context.runDir, outDir).split(path.sep).join("/")],
    stages: items.map((i) => (i.id === stage.id ? stageFor(i, "completed", reason, { findings: findings.length, blockingViolations: blocking, nativeStatus: "exit 0" }) : stageFor(i, "not_applicable", t("trivy_image_only_vulnerabilities", { capability: i.capabilities[0] ?? "-" })))),
    findings,
  };
}

/** Runs the SBOM instance and names the document itself, next to its folder, among the outputs of the run. */
async function runTrivySbom(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const output = await runScanner(trivySbomScanner, context, plan, tool);
  const file = path.join(context.outputsDir, trivyManifest.id, tool, SBOM_FILE);
  if (!output.stages.every((s) => s.state === "completed") || !fs.existsSync(file)) return output;
  return { ...output, outputs: [...output.outputs, path.relative(context.runDir, file).split(path.sep).join("/")] };
}

export const trivyAdapter: ExternalAdapter = {
  manifest: trivyManifest,
  plan: (input) => {
    if (input.capability === "sbom") return planScanner(trivySbomScanner, input);
    const settings = trivyImageSettings(input);
    return settings.mode === "image" ? planTrivyImage(input, settings) : planScanner(trivyScanner, input);
  },
  run: (context, plan, tool) => {
    const invocation = plan.invocations.find((i) => i.adapter === trivyManifest.id && i.id === tool);
    if (invocation?.command.args.includes("cyclonedx")) return runTrivySbom(context, plan, tool);
    return invocation?.command.args[0] === "image" || invocation?.command.args.length === 0 ? runTrivyImage(context, plan, tool) : runScanner(trivyScanner, context, plan, tool);
  },
};
export { scanImage, trivyImageArgs, type TrivyImageState, type TrivyImageTarget } from "./image.js";
