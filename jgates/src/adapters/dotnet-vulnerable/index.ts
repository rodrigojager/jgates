// dotnet-vulnerable adapter: `dotnet list <solution or project> package --vulnerable --include-transitive --format json`
// in the step container of the tools image, over the assets the deps phase restored into the dependency volume, with the
// network to the package sources (their vulnerability resource is the data). One blocking finding per vulnerable
// package and advisory (top-level and transitive) with NuGet's severity; a report with an error problem (a project that
// is not restored, a source that did not answer) or without any source is an error stage, never a clean result.
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan } from "../../core/plan/types.js";
import type { NormalizedSeverity, AdapterContext, AdapterOutput, ResultFinding, ResultMetric } from "../../core/run/types.js";
import { findOnPath } from "../../core/runner/path-lookup.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { dotnetTarget } from "../dotnet-analyzers/index.js";
import { AREA, WORKSPACE, componentDirOf, instanceBody, isRec, runInstance, sha256File, tail, workspaceRelative, type KitContract } from "../playwright/kit.js";
import { dotnetVulnerableManifest } from "./manifest.js";

export { dotnetVulnerableManifest } from "./manifest.js";

const ADAPTER_ID = dotnetVulnerableManifest.id;

export interface VulnerablePackage {
  project: string;
  framework: string;
  id: string;
  version: string;
  transitive: boolean;
  severity: string;
  advisory: string;
}

export interface VulnerableReading {
  ok: boolean;
  problem?: string;
  packages: VulnerablePackage[];
  /** Projects listed (with or without vulnerable packages). */
  projects: string[];
  sources: string[];
}

/** The vulnerable packages of `dotnet list package --vulnerable --format json` (output version 1). */
export function parseVulnerableReport(text: string): VulnerableReading {
  const bad = (problem: string): VulnerableReading => ({ ok: false, problem, packages: [], projects: [], sources: [] });
  const start = text.indexOf("{");
  if (start < 0) return bad("no JSON in the output");
  let doc: unknown;
  try {
    doc = JSON.parse(text.slice(start));
  } catch {
    return bad("the output is not JSON");
  }
  if (!isRec(doc) || !Array.isArray(doc.projects)) return bad("not a dotnet list package report (no projects)");
  const problems = Array.isArray(doc.problems) ? doc.problems.filter(isRec) : [];
  const errors = problems.filter((p) => String(p.level ?? "").toLowerCase() === "error");
  if (errors.length > 0) return bad(errors.map((p) => String(p.text ?? "")).join(" "));
  const sources = Array.isArray(doc.sources) ? doc.sources.filter((s): s is string => typeof s === "string") : [];
  if (sources.length === 0) return bad("no package source was asked for vulnerability data");
  const packages: VulnerablePackage[] = [];
  const projects: string[] = [];
  for (const project of doc.projects) {
    if (!isRec(project) || typeof project.path !== "string") return bad("a project without a path");
    projects.push(project.path);
    for (const fw of Array.isArray(project.frameworks) ? project.frameworks : []) {
      if (!isRec(fw)) continue;
      for (const [key, transitive] of [["topLevelPackages", false], ["transitivePackages", true]] as const) {
        for (const pkg of Array.isArray(fw[key]) ? fw[key] : []) {
          if (!isRec(pkg) || typeof pkg.id !== "string") continue;
          for (const v of Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : []) {
            if (!isRec(v)) continue;
            packages.push({
              project: project.path,
              framework: typeof fw.framework === "string" ? fw.framework : "",
              id: pkg.id,
              version: typeof pkg.resolvedVersion === "string" ? pkg.resolvedVersion : "",
              transitive,
              severity: typeof v.severity === "string" ? v.severity : "Unknown",
              advisory: typeof v.advisoryurl === "string" ? v.advisoryurl : "",
            });
          }
        }
      }
    }
  }
  return { ok: true, packages, projects, sources };
}

export function normalizeNugetSeverity(severity: string): NormalizedSeverity {
  switch (severity.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "unknown";
  }
}

function planVulnerable(input: ExternalPlanInput): ExternalPlan {
  const t = translator(AREA);
  const { root, dir } = componentDirOf(input);
  const body = instanceBody(input);
  const component = typeof body.component === "string" ? body.component : null;
  const target = dotnetTarget(dir);
  const named = inImageOverride(input.env, "JGATES_DOTNET");
  const image = probeImageTool("dotnet", input.env);
  let executable = "dotnet";
  let prefix: string[] = [];
  let missing: string | null = null;
  if (named !== null) {
    const abs = findOnPath(named, input.env);
    if (!abs) missing = named;
    else if (/\.(?:mjs|cjs|js)$/i.test(abs)) {
      executable = process.execPath;
      prefix = [abs];
    } else executable = abs;
  } else if (image.problem !== null) missing = image.detail;
  const file = "file" in target ? target.file : null;
  let availability: ExternalPlan["availability"];
  if ("skip" in target) availability = { status: "unavailable", reason: target.skip };
  else if (missing !== null) availability = { status: "unavailable", reason: t("vuln_missing", { detail: missing }) };
  else availability = { status: "available", reason: null };
  const contract: KitContract = { component, root, target: file };
  return {
    label: t("vuln_label"),
    command: {
      executable,
      args: [...prefix, "list", ...(file ? [file] : []), "package", "--vulnerable", "--include-transitive", "--format", "json", "--output-version", "1"],
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: { DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_CLI_UI_LANGUAGE: "en", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", MSBUILDDISABLENODEREUSE: "1", NO_COLOR: "1" },
      stdin: null,
    },
    runtime: { name: "native", interpreter: executable, available: missing === null },
    toolVersion: image.version,
    configFiles: (file ? [file, "nuget.config", "Directory.Packages.props"] : []).filter((f) => sha256File(path.join(dir, f)) !== null).map((f) => ({ file: root ? `${root}/${f}` : f, sha256: sha256File(path.join(dir, f)) })),
    availability,
    blocksPlan: false,
    network: true,
    limitations: [t("vuln_limitation")],
    conditions: [t("vuln_condition_network")],
    output: { format: "json", schema: null },
    imageTool: "dotnet",
    contract,
    effects: {},
  };
}

async function runVulnerable(context: AdapterContext, planDoc: Plan, tool: string): Promise<AdapterOutput> {
  return runInstance<KitContract>(ADAPTER_ID, context, planDoc, tool, async (run) => {
    const t = translator(AREA);
    const executed = await run.exec(0);
    const stop = run.stopped(executed);
    if (stop) return stop;
    const { result, command } = executed;
    const native = `exit ${result.exitCode ?? "-"}`;
    const reading = parseVulnerableReport(result.stdout);
    if (result.exitCode !== 0 || !reading.ok || result.truncated) {
      return run.all("error", t("vuln_error", { code: result.exitCode ?? "-", detail: `${reading.problem ?? ""} ${tail(result.stderr || result.stdout)}`.trim() || "-" }), { interpreted: false, nativeStatus: native });
    }
    const item = run.items[0] as Plan["groups"]["willRun"][number];
    const workspaceView = run.view(context.workspacePath);
    const cwdView = run.view(command.cwd);
    const findings: ResultFinding[] = reading.packages.map((p) => {
      const file = workspaceRelative(p.project, workspaceView, cwdView);
      const advisory = /GHSA-[\w-]+/i.exec(p.advisory)?.[0] ?? p.advisory;
      return {
        stageId: item.id,
        tool: ADAPTER_ID,
        ...(run.version ? { toolVersion: run.version } : {}),
        ruleId: advisory || "dotnet-vulnerable.package",
        category: "dependencies",
        severity: p.severity,
        normalizedSeverity: normalizeNugetSeverity(p.severity),
        message: t(p.transitive ? "vuln_finding_transitive" : "vuln_finding", { package: p.id, version: p.version, severity: p.severity, advisory: p.advisory || "-", framework: p.framework || "-" }),
        ...(file ? { location: { path: file } } : {}),
        fingerprint: contentHash({ tool: ADAPTER_ID, package: p.id, version: p.version, advisory: p.advisory, project: file }),
        origin: ADAPTER_ID,
        blocking: true,
        blockingReason: "blocking-tool",
        waived: false,
      };
    });
    const component = run.contract.component;
    const metrics: ResultMetric[] = [{ id: "dependencies.vulnerable", label: t("vuln_metric"), unit: "count", value: findings.length, ...(component ? { component } : {}), scope: component ? "component" : "workspace", origin: ADAPTER_ID }];
    const reason = t("vuln_reason", { version: run.version ?? "?", projects: reading.projects.length, count: findings.length, sources: reading.sources.join(", ") });
    return {
      ...run.base(),
      stages: run.items.map((i) => run.stage(i, "completed", reason, { blockingViolations: findings.length, findings: findings.length, nativeStatus: native })),
      findings,
      metrics,
    };
  });
}

export const dotnetVulnerableAdapter: ExternalAdapter = {
  manifest: dotnetVulnerableManifest,
  plan: planVulnerable,
  run: runVulnerable,
};
