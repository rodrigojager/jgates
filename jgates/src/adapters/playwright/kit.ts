// Shared body of the checks that came with the services and the budgets of the container-first image: Playwright e2e,
// migration drift, performance budgets and the vulnerable .NET packages (adapters playwright, migration-drift,
// performance, dotnet-vulnerable). Each one plans one or more commands of the project's own tools (or of the tools
// image) and reads what they wrote; this module holds what they do alike:
//   - the instance settings (tools.<id>, with the template's `config` under them);
//   - the services rule: an e2e or migration check needs the project's compose services (jgates.yml `services:`), and
//     without them it is SERVICES_REQUIRED, which the plan reports as "not applicable here" with the action to set them
//     up, never as a blocker (`requires: "services"` of the plan);
//   - the run: the commands of the plan in order, in the step container, with one log pair per command, and the stage
//     states every check shares (blocked, cancelled, timeout) before the adapter reads the outputs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { resolveReason } from "../../core/reasons/index.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec, substituteTokens, type ExecutionResult } from "../../core/runner/index.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import { looksLikeServiceTarget, parseServiceTarget, readServicesConfig, type ServicesConfig } from "../../core/services/config.js";
import type { AdapterContext, AdapterOutput, ResultMetric, ResultStage } from "../../core/run/types.js";

export const WORKSPACE = "{workspace}";
export const RUN_DIR = "{runDir}";
/** The i18n area of the four adapters. */
export const AREA = "services-checks";

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Variables a toolchain needs beyond the runner's default allowlist (only used when a step runs natively, inside the image). */
const TOOLCHAIN_ENV = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "WINDIR", "CARGO_HOME", "CARGO_TARGET_DIR", "RUSTUP_HOME", "GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "GOFLAGS", "DOTNET_ROOT", "NUGET_PACKAGES", "NUGET_HTTP_CACHE_PATH", "NODE_PATH", "VIRTUAL_ENV", "PLAYWRIGHT_BROWSERS_PATH"] as const;
export const ENV_ALLOWLIST: readonly string[] = [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV];

/** The settings of an instance: tools.<id>, with the template's `config` block under the keys written next to the adapter. */
export function instanceBody(input: Pick<ExternalPlanInput, "config" | "tool">): Rec {
  const tools = isRec(input.config) && isRec(input.config.tools) ? input.config.tools : {};
  const raw = isRec(tools[input.tool]) ? (tools[input.tool] as Rec) : {};
  return { ...(isRec(raw.config) ? raw.config : {}), ...raw };
}

/** The component folder of an instance (absolute) and its root relative to the workspace (null for the root). */
export function componentDirOf(input: Pick<ExternalPlanInput, "dir" | "componentRoot">): { root: string | null; dir: string } {
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  return { root, dir: root ? path.join(input.dir, ...root.split("/")) : input.dir };
}

export function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

export function readJsonFile(abs: string): Rec | null {
  try {
    const doc = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
    return isRec(doc) ? doc : null;
  } catch {
    return null;
  }
}

export function readText(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** The jgates.yml `services:` section of the configuration folder (the project, or the CI policy). */
export function servicesOf(input: Pick<ExternalPlanInput, "dir" | "policyDir">): ServicesConfig | null {
  try {
    return readServicesConfig(input.policyDir ?? input.dir);
  } catch {
    return null;
  }
}

export interface CheckTarget {
  /** The URL the step uses (`http://web:80/base`), or null when nothing names one. */
  url: string | null;
  /** The compose service the URL names (`service:<name>:<port>` or the services target), or null for a plain URL. */
  service: { name: string; port: number; path: string } | null;
  /** A setting that is not a valid target. */
  problem: string | null;
}

/**
 * The application an e2e check drives: tools.<id>.target (`service:<name>:<port>[/path]` or an http(s) URL), else the
 * `services.target` of jgates.yml; none: the tests use the URLs of their own configuration.
 */
export function checkTarget(value: unknown, services: ServicesConfig | null): CheckTarget {
  if (value !== undefined && value !== null && value !== "") {
    const service = parseServiceTarget(value);
    if (service) return { url: service.url, service: { name: service.service, port: service.port, path: service.path }, problem: null };
    if (!looksLikeServiceTarget(value) && typeof value === "string" && /^https?:\/\/[^\s]+$/.test(value.trim())) return { url: value.trim(), service: null, problem: null };
    return { url: null, service: null, problem: String(value) };
  }
  const t = services?.target;
  if (t) {
    const base = t.path === "/" ? "" : t.path.replace(/\/+$/, "");
    return { url: `http://${t.service}:${t.port}${base}`, service: { name: t.service, port: t.port, path: base }, problem: null };
  }
  return { url: null, service: null, problem: null };
}

/** The SERVICES_REQUIRED text of the plan and of the stage: the shared cause and what is missing. */
export function servicesRequiredReason(): string {
  return `${resolveReason("SERVICES_REQUIRED").message} ${translator(AREA)("checks_services_not_configured")}`;
}

export interface KitCommand {
  executable: string;
  args: string[];
  /** With the {workspace} / {runDir} placeholders. */
  cwd: string;
  env: Record<string, string>;
}

/** What every contract of the four adapters carries besides its own fields. */
export interface KitContract {
  component: string | null;
  root: string | null;
  /** The plan found no services for an e2e or migration check: the stage is SERVICES_REQUIRED, never run. */
  servicesRequired?: boolean;
  /** Commands after the first one (the first one is the plan's command). */
  more?: KitCommand[];
  [key: string]: unknown;
}

export interface Executed {
  command: KitCommand;
  result: ExecutionResult;
  stdoutLog: string;
  stderrLog: string;
}

export interface KitRun<C extends KitContract> {
  context: AdapterContext;
  tool: string;
  items: PlanItem[];
  contract: C;
  version: string | null;
  outDir: string;
  timeoutSeconds: number;
  /** The commands of the plan with the placeholders substituted. */
  commands: KitCommand[];
  /** Runs one command (by index) with its own log pair. */
  exec(index: number): Promise<Executed>;
  /** A host path as the tool saw it (the step container's /workspace and /output). */
  view(p: string): string;
  /** A stage for an item. */
  stage(item: PlanItem, state: ResultStage["state"], reason?: string, extra?: Partial<ResultStage>): ResultStage;
  /** The output with every item in one state. */
  all(state: ResultStage["state"], reason: string, extra?: Partial<ResultStage>, metrics?: ResultMetric[]): AdapterOutput;
  /** The output skeleton (requirements, logs, outputs). */
  base(): Omit<AdapterOutput, "stages" | "findings">;
  /** The common stop of a command that did not run to its end (spawn error, cancellation, timeout); null when it ran. */
  stopped(e: Executed, metrics?: ResultMetric[]): AdapterOutput | null;
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");
export const tail = (text: string, lines = 3): string => text.trim().split(/\r?\n/).slice(-lines).join(" ");

/**
 * Runs an instance: finds its plan items and invocation, handles what every check handles alike (an unavailable tool,
 * SERVICES_REQUIRED), then hands the run to the adapter's body.
 */
export async function runInstance<C extends KitContract>(
  adapterId: string,
  context: AdapterContext,
  planDoc: Plan,
  tool: string,
  body: (run: KitRun<C>) => Promise<AdapterOutput>,
): Promise<AdapterOutput> {
  const t = translator(AREA);
  const invocation = planDoc.invocations.find((i) => i.adapter === adapterId && i.id === tool);
  const items = planDoc.groups.willRun.filter((i) => i.adapter === adapterId && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("checks_no_invocation", { tool, adapter: adapterId }));
  const contract = { component: null, root: null, ...(invocation.contract ?? {}) } as C;
  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const sub = (c: KitCommand): KitCommand => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(c.env)) env[name] = substituteTokens(value, tokens);
    return { executable: c.executable, args: c.args.map((a) => substituteTokens(a, tokens)), cwd: substituteTokens(c.cwd, tokens), env };
  };
  const first: KitCommand = { executable: invocation.command.executable, args: invocation.command.args, cwd: invocation.command.cwd, env: invocation.command.env };
  const commands = [first, ...(Array.isArray(contract.more) ? contract.more : [])].map(sub);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const outDir = path.join(context.outputsDir, adapterId, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const logs: string[] = [];
  const base = (): Omit<AdapterOutput, "stages" | "findings"> => ({
    requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
    disabled: [],
    logs: [...logs],
    outputs: [relToRun(context.runDir, outDir)],
  });
  const stage = (item: PlanItem, state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({
    id: item.id,
    label: item.label,
    kind: "step",
    adapter: adapterId,
    state,
    ...(reason ? { reason } : {}),
    ...extra,
  });
  const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}, metrics: ResultMetric[] = []): AdapterOutput => ({
    ...base(),
    stages: items.map((i) => stage(i, state, reason, extra)),
    findings: [],
    ...(metrics.length > 0 ? { metrics } : {}),
  });
  const exec = async (index: number): Promise<Executed> => {
    const command = commands[index] as KitCommand;
    const suffix = index === 0 ? "" : `.${index + 1}`;
    const stdoutLog = path.join(context.logsDir, `${tool}${suffix}.stdout.log`);
    const stderrLog = path.join(context.logsDir, `${tool}${suffix}.stderr.log`);
    // Folders the plan points into the run folder exist before the tool starts.
    for (const value of Object.values(command.env)) if (value.startsWith(context.runDir) && !path.extname(value)) fs.mkdirSync(value, { recursive: true });
    const result = await runSpec(
      { executable: command.executable, args: command.args, cwd: command.cwd, env: command.env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
      { parentEnv: context.env, envAllowlist: ENV_ALLOWLIST },
    );
    logs.push(relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog));
    return { command, result, stdoutLog, stderrLog };
  };
  const stopped = (e: Executed, metrics: ResultMetric[] = []): AdapterOutput | null => {
    const r = e.result;
    if (r.spawnError) return all("blocked", t("checks_blocked", { tool: path.basename(e.command.executable), detail: `${r.spawnError.code}: ${r.spawnError.message}` }), {}, metrics);
    if (r.cancelled) return all("cancelled", t("checks_cancelled", { tool: path.basename(e.command.executable) }), {}, metrics);
    if (r.timedOut) return all("timeout", t("checks_timeout", { tool: path.basename(e.command.executable), seconds: timeoutSeconds }), {}, metrics);
    return null;
  };
  const run: KitRun<C> = {
    context,
    tool,
    items,
    contract,
    version,
    outDir,
    timeoutSeconds,
    commands,
    exec,
    view: (p) => stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, p),
    stage,
    all,
    base,
    stopped,
  };
  // SERVICES_REQUIRED: the check needs the project's services and none are configured; nothing starts (never a pass).
  if (contract.servicesRequired === true) return all("blocked", servicesRequiredReason());
  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return all("blocked", unavailable.availability.reason ?? t("checks_blocked", { tool: path.basename(first.executable), detail: "-" }));
  return body(run);
}

/** First meaningful line of a text, bounded. */
export function firstLine(text: string, max = 300): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  const line = (plain.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A path the tool printed as the workspace-relative POSIX path (null outside the workspace). */
export function workspaceRelative(printed: string, workspaceView: string, cwdView: string): string | null {
  if (!printed) return null;
  const file = printed.replace(/\\/g, "/");
  const ws = workspaceView.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = file.startsWith("/") || /^[A-Za-z]:\//.test(file) ? file : `${cwdView.replace(/\\/g, "/").replace(/\/+$/, "")}/${file}`;
  const norm = path.posix.normalize(abs);
  const lower = (s: string): string => (/^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s);
  if (lower(norm).startsWith(`${lower(ws)}/`)) return norm.slice(ws.length + 1);
  return null;
}
