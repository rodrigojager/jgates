// ZAP adapter: plans one step of the JGates tools image per tool instance against the running target the instance
// names (zap.sh -cmd -autorun with an Automation Framework plan the run writes in the instance's output folder) and
// normalizes its traditional JSON report into findings. Passive by default (the spider, or the OpenAPI import when a
// spec is given, plus the passive rules); the active scan is refused unless the instance sets mode: active AND
// allowActive: true, and then the plan lists what it does to the target. Without a target the stage is blocked, never
// passed. Cancellation and the removal of the step container belong to the engine (the run's labels).
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { outputToken } from "../container-scanner/index.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { stepMode } from "../../core/runner/in-image.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { checkTarget, instanceBody, intSetting, isLoopbackHost, readAuth, safeRelative, type AuthSetting } from "../schemathesis/target.js";
import { zapManifest } from "./manifest.js";
import { parseZapReport, RISK_LEVELS, type RiskLevel } from "./normalize.js";
import { probeZap } from "./probe.js";

export { zapManifest } from "./manifest.js";
export { parseZapReport, RISK_LEVELS } from "./normalize.js";
export { probeZap } from "./probe.js";

const ADAPTER_ID = zapManifest.id;
/** The variable the step is given with the authentication header value; the plan file refers to it, never to the secret. */
const AUTH_ENV = "JGATES_RUNTIME_AUTH";
const REPORT_BASE = "zap-report";
const REPORT = `${REPORT_BASE}.json`;
const PLAN_FILE = "automation.yaml";
/** How the container reaches a target on the host's loopback. */
export const HOST_ALIAS = "host.docker.internal";

export type ZapMode = "passive" | "active";

export interface ZapSettings {
  target: string | null;
  /** The compose service of a `service:<name>:<port>` target (reached on the run's services network). */
  service: { name: string; port: number; path: string } | null;
  spec: string | null;
  mode: ZapMode;
  allowActive: boolean;
  auth: AuthSetting | null;
  blockingRisk: RiskLevel;
  spiderMinutes: number;
  problems: string[];
}

/** Reads and validates the instance; an active mode that is not explicitly allowed is a problem the plan refuses. */
export function zapSettings(input: Pick<ExternalPlanInput, "config" | "tool">): ZapSettings {
  const t = translator("zap");
  const body = instanceBody(input.config, input.tool);
  const problems: string[] = [];
  const target = checkTarget(body.target);
  if (target.problem === "invalid") problems.push(t("zap_setting_target", { tool: input.tool, value: String(body.target) }));
  let spec: string | null = null;
  if (body.spec !== undefined) {
    if (typeof body.spec === "string" && safeRelative(body.spec)) spec = body.spec.replace(/\\/g, "/");
    else problems.push(t("zap_setting_spec", { tool: input.tool, value: String(body.spec) }));
  }
  let mode: ZapMode = "passive";
  if (body.mode !== undefined) {
    if (body.mode === "passive" || body.mode === "active") mode = body.mode;
    else problems.push(t("zap_setting_mode", { tool: input.tool, value: String(body.mode) }));
  }
  let allowActive = false;
  if (body.allowActive !== undefined) {
    if (typeof body.allowActive === "boolean") allowActive = body.allowActive;
    else problems.push(t("zap_setting_allow_active", { tool: input.tool, value: String(body.allowActive) }));
  }
  // The active scan attacks the target: it never runs because of one setting alone.
  if (mode === "active" && !allowActive) problems.push(t("zap_active_refused", { tool: input.tool }));
  const auth = readAuth(body.auth);
  if (auth.problem) problems.push(t("zap_setting_auth", { tool: input.tool }));
  // The scan runs in the JGates tools image; another image cannot be named any more.
  if (body.image !== undefined) problems.push(t("zap_setting_image", { tool: input.tool }));
  let blockingRisk: RiskLevel = "medium";
  if (body.blockingRisk !== undefined) {
    if (typeof body.blockingRisk === "string" && (RISK_LEVELS as readonly string[]).includes(body.blockingRisk)) blockingRisk = body.blockingRisk as RiskLevel;
    else problems.push(t("zap_setting_risk", { tool: input.tool, value: String(body.blockingRisk), allowed: RISK_LEVELS.join(", ") }));
  }
  const minutes = intSetting(body.spiderMinutes, 1, 1, 60);
  if (minutes === "invalid") problems.push(t("zap_setting_minutes", { tool: input.tool, value: String(body.spiderMinutes) }));
  return { target: target.url, service: target.service ?? null, spec, mode, allowActive, auth: auth.auth, blockingRisk, spiderMinutes: typeof minutes === "number" ? minutes : 1, problems };
}

/** The target as the step container sees it: a loopback host becomes host.docker.internal (inside the image it stays). */
export function containerTarget(target: string, env: NodeJS.ProcessEnv = process.env): string {
  // A placeholder (no target configured) is shown as is.
  if (stepMode(env) === "in-image" || !URL.canParse(target) || !isLoopbackHost(target)) return target;
  const u = new URL(target);
  u.hostname = HOST_ALIAS;
  return u.toString().replace(/\/+$/, "");
}

/** What the scan does to the target, listed in the plan (and in the reviewed contract). */
export function zapEffects(settings: Pick<ZapSettings, "mode" | "spec">): string[] {
  const t = translator("zap");
  if (settings.mode === "active") return [t("zap_effect_requests"), t("zap_effect_attacks"), t("zap_effect_data"), t("zap_effect_load")];
  return [t("zap_effect_requests"), settings.spec ? t("zap_effect_passive_api") : t("zap_effect_passive_spider")];
}

const quote = (value: string): string => JSON.stringify(value);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the plan the run writes finds its files, as the step sees them. */
export interface ZapPaths {
  /** The OpenAPI file (when the instance has a spec). */
  spec: string | null;
  /** The folder ZAP writes the report in. */
  reportDir: string;
}

/**
 * The Automation Framework plan of the scan (YAML; every string is a JSON string, which is valid YAML). The tools image
 * carries the ZAP Linux package, so the scan is described to `zap.sh -cmd -autorun` instead of calling the official
 * image's zap-baseline.py / zap-api-scan.py / zap-full-scan.py. The authentication header is not in the file: its value
 * reaches ZAP's replacer through the environment of the step (see zapLaunch), so the secret is never written to disk.
 */
export function zapAutomationPlan(settings: Pick<ZapSettings, "mode" | "spiderMinutes" | "spec">, target: string, paths: ZapPaths): string {
  const lines: string[] = [
    "env:",
    "  contexts:",
    "    - name: jgates",
    "      urls:",
    `        - ${quote(target)}`,
    "      includePaths:",
    `        - ${quote(`${escapeRegExp(target.replace(/\/+$/, ""))}.*`)}`,
    "  parameters:",
    "    failOnError: true",
    "    failOnWarning: false",
    "    progressToStdout: true",
    "jobs:",
  ];
  if (settings.spec && paths.spec) {
    lines.push("  - type: openapi", "    parameters:", "      context: jgates", `      apiFile: ${quote(paths.spec)}`, `      targetUrl: ${quote(target.replace(/\/+$/, ""))}`);
  } else {
    lines.push("  - type: spider", "    parameters:", "      context: jgates", `      maxDuration: ${settings.spiderMinutes}`);
  }
  if (settings.mode === "active") lines.push("  - type: activeScan", "    parameters:", "      context: jgates", "      maxScanDurationInMins: 20");
  lines.push(
    "  - type: passiveScan-wait",
    "    parameters:",
    "      maxDuration: 5",
    "  - type: report",
    "    parameters:",
    "      template: traditional-json",
    `      reportDir: ${quote(paths.reportDir)}`,
    `      reportFile: ${quote(REPORT_BASE)}`,
  );
  return lines.join("\n") + "\n";
}

/**
 * The process of the scan. With an authentication header the replacer rule is set on ZAP's command line, from the
 * variable the step is given: a shell expands it inside the container, so neither the plan nor any file of the run holds
 * the value (the header name was validated as an HTTP token, the value is only ever in the environment).
 */
export function zapLaunch(executable: string, args: string[], auth: { header: string } | null): { executable: string; args: string[] } {
  if (!auth) return { executable, args };
  const rule = (key: string, value: string): string => `-config 'replacer.full_list(0).${key}=${value}'`;
  const script = `exec ${executable} "$@" ${rule("description", "jgates authentication header")} ${rule("enabled", "true")} ${rule("matchtype", "REQ_HEADER")} ${rule("matchstr", auth.header)} ${rule("regex", "false")} -config "replacer.full_list(0).replacement=$${AUTH_ENV}"`;
  return { executable: "sh", args: ["-c", script, executable, ...args] };
}

function planZap(input: ExternalPlanInput): ExternalPlan {
  const t = translator("zap");
  const settings = zapSettings(input);
  const probe = probeZap(input.env);
  const specFile = settings.spec ? path.join(input.dir, ...settings.spec.split("/")) : null;
  const out = outputToken(ADAPTER_ID, input.tool);
  const args = ["-cmd", "-silent", "-dir", `${out}/home/.ZAP`, "-autorun", `${out}/${PLAN_FILE}`];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (settings.problems.length > 0) {
    // An invalid setting, or an active scan that is not explicitly allowed, never falls back to something else.
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (settings.target === null) availability = { status: "unavailable", reason: t("zap_no_target") };
  else if (probe.problem !== null) availability = { status: "unavailable", reason: translator("security")("security_not_in_image", { tool: zapManifest.displayName, instance: input.tool, runtime: probe.runtimeName, image: probe.image ?? "-", detail: probe.detail }) };
  else if (probe.version === null || satisfiesRange(probe.version, zapManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: zapManifest.toolName, version: probe.version ?? "?", range: zapManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else if (specFile && !fs.existsSync(specFile)) availability = { status: "unavailable", reason: t("zap_spec_missing", { spec: settings.spec ?? "" }) };
  else availability = { status: "available", reason: null };

  const effects = zapEffects(settings);
  const conditions = [
    settings.target ? t("zap_condition_target", { target: settings.target }) : t("zap_condition_no_target"),
    settings.mode === "active" ? t("zap_condition_active") : t("zap_condition_passive"),
    ...effects.map((e) => t("zap_condition_effect", { effect: e })),
    t("zap_condition_risk", { risk: settings.blockingRisk }),
    settings.auth ? t("zap_condition_auth", { header: settings.auth.header, env: settings.auth.valueEnv }) : t("zap_condition_no_auth"),
    t("zap_condition_image", { image: probe.image ?? "-" }),
  ];
  return {
    label: t("zap_label"),
    command: { executable: "zap.sh", args, cwd: "{runDir}", env: { HOME: `${out}/home`, TMPDIR: `${out}/tmp` }, stdin: null },
    runtime: { name: "container", interpreter: probe.runtime, available: probe.problem === null },
    toolVersion: probe.version,
    configFiles: [],
    availability,
    blocksPlan,
    network: true,
    limitations: [t("zap_limitation_target")],
    conditions,
    contract: {
      target: settings.target,
      service: settings.service,
      spec: settings.spec,
      mode: settings.mode,
      allowActive: settings.allowActive,
      effects,
      auth: settings.auth,
      blockingRisk: settings.blockingRisk,
      spiderMinutes: settings.spiderMinutes,
    },
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runZap(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("zap");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("zap_no_invocation", { tool }));
  const command = invocation.command;
  const contract = (invocation.contract ?? {}) as Record<string, unknown>;
  const target = typeof contract.target === "string" ? contract.target : null;
  const spec = typeof contract.spec === "string" ? contract.spec : null;
  const mode: ZapMode = contract.mode === "active" ? "active" : "passive";
  const auth = readAuth(contract.auth ?? undefined).auth;
  const blockingRisk = (RISK_LEVELS as readonly string[]).includes(String(contract.blockingRisk)) ? (contract.blockingRisk as RiskLevel) : "medium";
  const spiderMinutes = typeof contract.spiderMinutes === "number" && contract.spiderMinutes >= 1 ? Math.floor(contract.spiderMinutes) : 1;
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  // ZAP creates its home folder (<out>/home/.ZAP) but not the folder above it.
  for (const sub of ["", "home", "tmp"]) fs.mkdirSync(path.join(outDir, sub), { recursive: true, mode: 0o700 });
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);
  const reportFile = path.join(outDir, REPORT);
  fs.rmSync(reportFile, { force: true });

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
  const blockedAll = (reason: string, nativeStatus?: string): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, "blocked", reason, nativeStatus ? { nativeStatus } : {})), findings: [] });

  if (target === null) return blockedAll(t("zap_no_target"), "no-target");
  // Defense in depth: a plan whose contract says active without the explicit permission is never executed.
  if (mode === "active" && contract.allowActive !== true) return blockedAll(t("zap_active_refused", { tool }), "active-refused");
  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("zap_blocked", { detail: command.executable }));
  let secret: string | null = null;
  if (auth) {
    secret = context.env[auth.valueEnv] ?? null;
    if (!secret) return blockedAll(t("zap_auth_missing", { env: auth.valueEnv }), "no-auth");
  }
  let specCopy: string | null = null;
  if (spec) {
    const source = path.join(context.workspacePath, ...spec.split("/"));
    if (!fs.existsSync(source)) return blockedAll(t("zap_spec_missing", { spec }), "no-spec");
    // The spec the scan imports is read from the run folder (the step container sees the workspace read-only too, but a
    // copy keeps the file ZAP read with the evidence of the run).
    specCopy = path.join(outDir, `openapi${path.extname(spec) || ".yaml"}`);
    fs.copyFileSync(source, specCopy);
  }

  const view = (p: string): string => stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, p);
  const inside = containerTarget(target, context.env);
  fs.writeFileSync(
    path.join(outDir, PLAN_FILE),
    zapAutomationPlan({ mode, spiderMinutes, spec }, inside, { spec: specCopy ? view(specCopy) : null, reportDir: view(outDir) }),
    { mode: 0o600 },
  );

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  if (secret) env[AUTH_ENV] = secret;
  const launch = zapLaunch(command.executable, args, auth);
  const result = await runSpec(
    { executable: launch.executable, args: launch.args, cwd: substituteTokens(command.cwd, tokens), env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  if (secret) {
    for (const file of [stdoutLog, stderrLog, reportFile, path.join(outDir, PLAN_FILE)]) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(secret)) fs.writeFileSync(file, text.split(secret).join("***"));
    }
  }
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("zap_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("zap_timeout", { seconds: timeoutSeconds }))), findings: [] };
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("zap_cancelled"))), findings: [] };
  // 0 (the plan succeeded) and 2 (warnings) are finished scans; a failed job (1) or anything else means it did not run.
  if (result.exitCode === null || (result.exitCode !== 0 && result.exitCode !== 2)) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("zap_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  const insideOrigin = new URL(inside).origin;
  const outside = new URL(target).origin;
  const rewrite = (url: string): string => (url.startsWith(insideOrigin) ? `${outside}${url.slice(insideOrigin.length)}` : url);
  const parsed = parseZapReport(fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : "", { stageId: items[0]?.id as string, blockingRisk, rewrite });
  if (!parsed.ok) return { ...base, stages: items.map((i) => stageFor(i, "error", t("zap_invalid_output", { detail: parsed.problem ?? "" }), { interpreted: false, nativeStatus: `exit ${result.exitCode}` })), findings: [] };
  const zapVersion = parsed.version;
  if (zapVersion && satisfiesRange(zapVersion, zapManifest.toolVersionRange) !== true) {
    return { ...base, stages: items.map((i) => stageFor(i, "error", translator("prepare")("prepare_incompatible", { tool: zapManifest.toolName, version: zapVersion, range: zapManifest.toolVersionRange, what: ADAPTER_ID }), { interpreted: false })), findings: [] };
  }
  for (const f of parsed.findings) if (parsed.version) f.toolVersion = parsed.version;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  const reason = t("zap_reason_completed", { version: parsed.version ?? "?", mode, count: parsed.findings.length, blocking, target });
  return {
    ...base,
    stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: blocking, findings: parsed.findings.length, nativeStatus: `exit ${result.exitCode}` })),
    findings: parsed.findings,
  };
}

export const zapAdapter: ExternalAdapter = {
  manifest: zapManifest,
  plan: planZap,
  run: runZap,
};
