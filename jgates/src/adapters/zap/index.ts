// ZAP adapter: plans one container run of the official ZAP image per tool instance against the running target the
// instance names, and normalizes its JSON report into findings. Passive by default (baseline, or the API scan in safe
// mode when an OpenAPI spec is given); the active scan is refused unless the instance sets mode: active AND
// allowActive: true, and then the plan lists what it does to the target. Without a target the stage is blocked, never
// passed. The image is the customer's (never pulled during a run); the run uses the image id the plan recorded.
// Cancellation stops the run-owned client process and removes the run-owned container by name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { runtimeClientEnv } from "../container-scanner/image.js";
import { DOCKER_CLIENT_ENV, DEFAULT_ENV_ALLOWLIST, runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { checkTarget, instanceBody, intSetting, isLoopbackHost, readAuth, safeRelative, type AuthSetting } from "../schemathesis/target.js";
import { zapManifest } from "./manifest.js";
import { parseZapReport, RISK_LEVELS, type RiskLevel } from "./normalize.js";
import { DEFAULT_ZAP_IMAGE, probeZap } from "./probe.js";

export { zapManifest } from "./manifest.js";
export { parseZapReport, RISK_LEVELS } from "./normalize.js";
export { probeZap, DEFAULT_ZAP_IMAGE } from "./probe.js";

const ADAPTER_ID = zapManifest.id;
/** Replaced at run time: the instance's output folder (mounted at /zap/wrk), the container name and the image id. */
export const OUT_TOKEN = "{zapOut}";
export const NAME_TOKEN = "{zapContainer}";
export const IMAGE_TOKEN = "{zapImage}";
const WRK = "/zap/wrk";
const REPORT = "zap-report.json";
/** How the container reaches a target on the host's loopback. */
export const HOST_ALIAS = "host.docker.internal";
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?$/;

export type ZapMode = "passive" | "active";

export interface ZapSettings {
  target: string | null;
  spec: string | null;
  mode: ZapMode;
  allowActive: boolean;
  auth: AuthSetting | null;
  image: string;
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
  let image = DEFAULT_ZAP_IMAGE;
  if (body.image !== undefined) {
    if (typeof body.image === "string" && IMAGE_PATTERN.test(body.image)) image = body.image;
    else problems.push(t("zap_setting_image", { tool: input.tool, value: String(body.image) }));
  }
  let blockingRisk: RiskLevel = "medium";
  if (body.blockingRisk !== undefined) {
    if (typeof body.blockingRisk === "string" && (RISK_LEVELS as readonly string[]).includes(body.blockingRisk)) blockingRisk = body.blockingRisk as RiskLevel;
    else problems.push(t("zap_setting_risk", { tool: input.tool, value: String(body.blockingRisk), allowed: RISK_LEVELS.join(", ") }));
  }
  const minutes = intSetting(body.spiderMinutes, 1, 1, 60);
  if (minutes === "invalid") problems.push(t("zap_setting_minutes", { tool: input.tool, value: String(body.spiderMinutes) }));
  return { target: target.url, spec, mode, allowActive, auth: auth.auth, image, blockingRisk, spiderMinutes: typeof minutes === "number" ? minutes : 1, problems };
}

/** The target as the container sees it: a loopback host becomes host.docker.internal. */
export function containerTarget(target: string): string {
  // A placeholder (no target configured) is shown as is.
  if (!URL.canParse(target) || !isLoopbackHost(target)) return target;
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

/** The scan script and its arguments (inside the container). */
export function zapScript(settings: Pick<ZapSettings, "mode" | "spec" | "spiderMinutes">, target: string): string[] {
  const inside = containerTarget(target);
  const report = ["-J", REPORT, "-I"];
  if (settings.spec) {
    const specFile = `${WRK}/openapi${path.extname(settings.spec) || ".yaml"}`;
    return ["zap-api-scan.py", "-t", specFile, "-f", "openapi", "-O", inside, ...(settings.mode === "passive" ? ["-S"] : []), ...report];
  }
  return [settings.mode === "active" ? "zap-full-scan.py" : "zap-baseline.py", "-t", inside, "-m", String(settings.spiderMinutes), ...report];
}

function planZap(input: ExternalPlanInput): ExternalPlan {
  const t = translator("zap");
  const settings = zapSettings(input);
  const probe = probeZap(input.env, settings.image);
  const specFile = settings.spec ? path.join(input.dir, ...settings.spec.split("/")) : null;
  const docker = [
    "run",
    "--rm",
    "--name",
    NAME_TOKEN,
    "--pull",
    "never",
    "--label",
    "jproject.project=jgates",
    "--label",
    "org.jgates.adapter=zap",
    "--add-host",
    `${HOST_ALIAS}:host-gateway`,
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "2048m",
    "--mount",
    `type=bind,src=${OUT_TOKEN},dst=${WRK}`,
    ...(settings.auth ? ["--env", `ZAP_AUTH_HEADER=${settings.auth.header}`, "--env", "ZAP_AUTH_HEADER_VALUE"] : []),
    IMAGE_TOKEN,
    ...zapScript(settings, settings.target ?? "<target>"),
  ];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (settings.problems.length > 0) {
    // An invalid setting, or an active scan that is not explicitly allowed, never falls back to something else.
    availability = { status: "unavailable", reason: settings.problems.join(" ") };
    blocksPlan = true;
  } else if (settings.target === null) availability = { status: "unavailable", reason: t("zap_no_target") };
  else if (probe.problem === "no_runtime") availability = { status: "unavailable", reason: t("zap_no_runtime", { runtime: probe.detail }) };
  else if (probe.problem === "no_daemon") availability = { status: "unavailable", reason: t("zap_no_daemon", { detail: probe.detail }) };
  else if (probe.problem === "no_image") availability = { status: "unavailable", reason: t("zap_no_image", { image: settings.image }) };
  else if (specFile && !fs.existsSync(specFile)) availability = { status: "unavailable", reason: t("zap_spec_missing", { spec: settings.spec ?? "" }) };
  else availability = { status: "available", reason: null };

  const effects = zapEffects(settings);
  const conditions = [
    settings.target ? t("zap_condition_target", { target: settings.target }) : t("zap_condition_no_target"),
    settings.mode === "active" ? t("zap_condition_active") : t("zap_condition_passive"),
    ...effects.map((e) => t("zap_condition_effect", { effect: e })),
    t("zap_condition_risk", { risk: settings.blockingRisk }),
    settings.auth ? t("zap_condition_auth", { header: settings.auth.header, env: settings.auth.valueEnv }) : t("zap_condition_no_auth"),
    t("zap_condition_image", { image: settings.image, id: probe.imageId ?? "-" }),
  ];
  return {
    label: t("zap_label"),
    command: { executable: probe.runtime ?? "docker", args: docker, cwd: "{runDir}", env: {}, stdin: null },
    runtime: { name: "container", interpreter: probe.runtime, available: probe.problem === null },
    toolVersion: null,
    configFiles: [],
    availability,
    blocksPlan,
    network: true,
    limitations: [t("zap_limitation_target")],
    conditions,
    contract: {
      target: settings.target,
      spec: settings.spec,
      mode: settings.mode,
      allowActive: settings.allowActive,
      effects,
      auth: settings.auth,
      image: settings.image,
      imageId: probe.imageId,
      blockingRisk: settings.blockingRisk,
      spiderMinutes: settings.spiderMinutes,
    },
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
/** Never-aborting signal: removing the container must run even when the run itself was cancelled. */
const NEVER = new AbortController().signal;

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
  const imageId = typeof contract.imageId === "string" ? contract.imageId : null;
  const blockingRisk = (RISK_LEVELS as readonly string[]).includes(String(contract.blockingRisk)) ? (contract.blockingRisk as RiskLevel) : "medium";
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true });
  // The container runs as its own user: the output folder (inside the private run folder) must be writable by it.
  fs.chmodSync(outDir, 0o777);
  const stdoutLog = path.join(context.logsDir, `${tool}.stdout.log`);
  const stderrLog = path.join(context.logsDir, `${tool}.stderr.log`);
  const reportFile = path.join(outDir, REPORT);

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
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("zap_no_image", { image: String(contract.image ?? DEFAULT_ZAP_IMAGE) }));
  if (!imageId) return blockedAll(t("zap_no_image", { image: String(contract.image ?? DEFAULT_ZAP_IMAGE) }), "no-image");
  let secret: string | null = null;
  if (auth) {
    secret = context.env[auth.valueEnv] ?? null;
    if (!secret) return blockedAll(t("zap_auth_missing", { env: auth.valueEnv }), "no-auth");
  }
  if (spec) {
    const source = path.join(context.workspacePath, ...spec.split("/"));
    if (!fs.existsSync(source)) return blockedAll(t("zap_spec_missing", { spec }), "no-spec");
    fs.copyFileSync(source, path.join(outDir, `openapi${path.extname(spec) || ".yaml"}`));
  }

  const name = `jgates-zap-${randomBytes(6).toString("hex")}`;
  const tokens = { runDir: context.runDir, workspace: context.workspacePath, zapOut: outDir, zapContainer: name, zapImage: imageId };
  const args = command.args.map((a) => substituteTokens(a, tokens));
  // The Docker client gets its connection settings and, for authentication, the header value it forwards by name.
  const env: Record<string, string> = { ...runtimeClientEnv(context.env) };
  if (secret) env.ZAP_AUTH_HEADER_VALUE = secret;
  const runnerOptions = { parentEnv: context.env, envAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...DOCKER_CLIENT_ENV] };
  let removal: Promise<unknown> | null = null;
  const remove = (): Promise<unknown> => (removal ??= runSpec({ executable: command.executable, args: ["rm", "--force", name], cwd: os.tmpdir(), timeoutMs: 30_000, signal: NEVER }, runnerOptions).catch(() => undefined));
  const result = await runSpec(
    { executable: command.executable, args, cwd: context.runDir, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    runnerOptions,
  );
  // Cancelled, timed out or a client that died: the container belongs to the daemon, so it is removed by name.
  if (result.cancelled || result.timedOut || (result.exitCode === null && !result.spawnError)) await remove();
  if (secret) {
    for (const file of [stdoutLog, stderrLog, reportFile]) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(secret)) fs.writeFileSync(file, text.split(secret).join("***"));
    }
  }
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("zap_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("zap_timeout", { seconds: timeoutSeconds }))), findings: [] };
  if (result.cancelled) return { ...base, stages: items.map((i) => stageFor(i, "cancelled", t("zap_cancelled"))), findings: [] };
  // 0, 1 and 2 are finished scans (the alerts are in the report); 3 and anything else mean the scan did not run.
  if (result.exitCode === null || result.exitCode > 2) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("zap_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  const inside = new URL(containerTarget(target)).origin;
  const outside = new URL(target).origin;
  const rewrite = (url: string): string => (url.startsWith(inside) ? `${outside}${url.slice(inside.length)}` : url);
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
