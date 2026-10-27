// jscpd adapter: plans one `jscpd` scan per tool instance with the configuration the user chose (the tools.yml binding,
// else .jscpd.json), the JSON report in the run folder, and reads the duplications back as findings. A scan that
// exits 1 (the configured threshold was crossed) also fails the stage. It never installs anything.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { contentHash } from "../../core/ids/index.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { resolveToolBindings } from "../../core/tools/index.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";
import { findNodeTool } from "../eslint/probe.js";
import { jscpdManifest } from "./manifest.js";

export { jscpdManifest } from "./manifest.js";

const ADAPTER_ID = jscpdManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";
const NATIVE_CONFIG = ".jscpd.json";
/** Never scanned, whatever the configuration says: dependencies, VCS data and the tools' own folders. */
const ALWAYS_IGNORED = ["**/node_modules/**", "**/.git/**", "**/.quality/**", "**/.jgates/**"];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export const findJscpd = (workspace: string, componentRoot: string | null, env: NodeJS.ProcessEnv) =>
  findNodeTool({ pkgName: "jscpd", bin: "jscpd", envVar: "JGATES_JSCPD", workspace, componentRoot, env });

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function chooseConfig(input: ExternalPlanInput): { file: string | null; source: "binding" | "native" | "none" } {
  try {
    const bound = resolveToolBindings(input.dir, { skipInventory: true, manifests: [jscpdManifest] }).instances.find((i) => i.id === input.tool);
    const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.relPath !== null && b.exists);
    if (binding?.relPath) return { file: binding.relPath, source: "binding" };
  } catch {
    // an unreadable tools.yml is reported by config validate
  }
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : "";
  if (isFile(path.join(input.dir, root, NATIVE_CONFIG))) return { file: root ? `${root}/${NATIVE_CONFIG}` : NATIVE_CONFIG, source: "native" };
  return { file: null, source: "none" };
}

/** The configuration as data, or why it is not usable (fail-closed: a config that does not parse is not run). */
function readConfig(abs: string): { ok: true; value: Rec } | { ok: false; problem: string } {
  try {
    const doc = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
    return isRec(doc) ? { ok: true, value: doc } : { ok: false, problem: "not an object" };
  } catch (error) {
    return { ok: false, problem: (error as Error).message };
  }
}

function planJscpd(input: ExternalPlanInput): ExternalPlan {
  const t = translator("jscpd");
  const probe = findJscpd(input.dir, input.componentRoot, input.env);
  const config = chooseConfig(input);
  const out = `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}`;
  const args = [
    ...probe.prefix,
    ...(config.file ? ["--config", `${WORKSPACE}/${config.file}`] : []),
    "--no-gitignore",
    "--silent",
    "--reporters",
    "json",
    "--ignore",
    ALWAYS_IGNORED.join(","),
    "--output",
    out,
    ".",
  ];
  let availability: ExternalPlan["availability"];
  const configRead = config.file ? readConfig(path.join(input.dir, config.file)) : null;
  if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("jscpd_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_version") availability = { status: "unavailable", reason: t("jscpd_no_version", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, jscpdManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: jscpdManifest.toolName, version: probe.version, range: jscpdManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (configRead && !configRead.ok) availability = { status: "unavailable", reason: t("jscpd_config_invalid", { file: config.file ?? "-", detail: configRead.problem }) };
  else availability = { status: "available", reason: null };

  const conditions = [config.file ? t(config.source === "binding" ? "jscpd_condition_config_binding" : "jscpd_condition_config_native", { file: config.file }) : t("jscpd_condition_config_none")];
  return {
    label: t("jscpd_label"),
    command: {
      executable: probe.executable ?? "jscpd",
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
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");
const toPath = (name: string): string => name.split(path.sep).join("/").replace(/^\.\//, "");
const rounded = (n: number | null): string => (n === null ? "?" : String(Math.round(n * 100) / 100));

export interface JscpdParse {
  ok: boolean;
  findings: ResultFinding[];
  clones: number;
  percentage: number | null;
  problem?: string;
}

/** The duplications of jscpd-report.json, as findings located at the first file of each clone. */
export function parseJscpdReport(text: string, opts: { stageId: string; version: string | null; prefix: string }): JscpdParse {
  const t = translator("jscpd");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, findings: [], clones: 0, percentage: null, problem: (error as Error).message };
  }
  if (!isRec(doc) || !Array.isArray(doc.duplicates)) return { ok: false, findings: [], clones: 0, percentage: null, problem: "the report has no duplicates list" };
  const findings: ResultFinding[] = [];
  for (const [index, entry] of doc.duplicates.entries()) {
    if (!isRec(entry) || !isRec(entry.firstFile) || !isRec(entry.secondFile) || typeof entry.firstFile.name !== "string" || typeof entry.secondFile.name !== "string") {
      return { ok: false, findings: [], clones: 0, percentage: null, problem: `duplicate ${index} has no firstFile or secondFile` };
    }
    const first = entry.firstFile;
    const second = entry.secondFile;
    const lineOf = (f: Rec): number | undefined => {
      const loc = isRec(f.startLoc) ? f.startLoc.line : f.start;
      return typeof loc === "number" && loc >= 1 ? loc : undefined;
    };
    const file = toPath(opts.prefix + (first.name as string));
    const other = toPath(opts.prefix + (second.name as string));
    const line = lineOf(first);
    const otherLine = lineOf(second);
    const lines = typeof entry.lines === "number" ? entry.lines : null;
    findings.push({
      stageId: opts.stageId,
      tool: "jscpd",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: "jscpd.duplicate",
      category: "duplication",
      severity: "medium",
      normalizedSeverity: "medium",
      message: t("jscpd_finding_duplicate", { other: `${other}${otherLine ? `:${otherLine}` : ""}`, lines: lines ?? "?" }),
      location: { path: file, ...(line !== undefined ? { line } : {}) },
      fingerprint: contentHash({ tool: "jscpd", file, line: line ?? null, other, otherLine: otherLine ?? null, lines }),
      origin: "jscpd",
      blocking: false,
      waived: false,
    });
  }
  const total = isRec(doc.statistics) && isRec(doc.statistics.total) ? doc.statistics.total : null;
  const percentage = total && typeof total.percentage === "number" ? total.percentage : null;
  return { ok: true, findings, clones: findings.length, percentage };
}

async function runJscpd(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("jscpd");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("jscpd_no_invocation", { tool }));

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
  const reportFile = path.join(outDir, "jscpd-report.json");
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
  const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, state, reason, extra)), findings: [] });

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("jscpd_blocked", { detail: command.executable }));

  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...all("blocked", t("jscpd_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...all("timeout", t("jscpd_timeout", { seconds: timeoutSeconds })), logs: base.logs };
  // 1 is the exit of a scan over the configured threshold; the report decides. Anything else proves nothing.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return { ...all("error", t("jscpd_exit_error", { code: result.exitCode ?? "-", detail: tail(result.stderr) || String(result.signal ?? "") }), { interpreted: false }), logs: base.logs };
  }
  let text: string;
  try {
    text = fs.readFileSync(reportFile, "utf8");
  } catch (error) {
    return { ...all("error", t("jscpd_invalid_output", { detail: (error as Error).message }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` }), logs: base.logs };
  }
  // Names in the report are relative to the scanned folder (the component), the findings to the workspace.
  const rel = path.relative(context.workspacePath, cwd).split(path.sep).join("/");
  const parsed = parseJscpdReport(text, { stageId: items[0]?.id as string, version, prefix: rel && !rel.startsWith("..") ? `${rel}/` : "" });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...all("error", t("jscpd_invalid_output", { detail }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` }), logs: base.logs };
  }
  const findings = [...parsed.findings];
  let blocking = 0;
  if (result.exitCode === 1) {
    blocking = 1;
    findings.push({
      stageId: items[0]?.id as string,
      tool: "jscpd",
      ...(version ? { toolVersion: version } : {}),
      ruleId: "jscpd.threshold-exceeded",
      category: "duplication",
      severity: "error",
      normalizedSeverity: "high",
      message: t("jscpd_finding_threshold", { percent: rounded(parsed.percentage) }),
      origin: "jscpd",
      blocking: true,
      blockingReason: "blocking-tool",
      waived: false,
    });
  }
  return {
    ...base,
    stages: items.map((i) =>
      stageFor(i, "completed", t("jscpd_reason_completed", { version: version ?? "?", count: parsed.clones, percent: rounded(parsed.percentage) }), {
        blockingViolations: blocking,
        findings: findings.length,
        nativeStatus: `exit ${result.exitCode}`,
      }),
    ),
    findings,
  };
}

export const jscpdAdapter: ExternalAdapter = {
  manifest: jscpdManifest,
  plan: planJscpd,
  run: runJscpd,
};
