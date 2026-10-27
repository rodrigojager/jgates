// Generic command adapter: runs one explicit executable with args (spawned directly, never through a shell) for stacks
// that have no adapter. The tool instance declares the executable (`command`), the `args`, and a `config` block with the
// effects and the evidence contract (schemas/catalog/generic-evidence.schema.json). Without a findings parser the
// result is a boolean check by exit code. A claim over security, architecture or tests needs a verifiable contract,
// otherwise the item still runs but does not cover the capability (the requirement is reported without coverage).
import fs from "node:fs";
import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { fileURLToPath } from "node:url";
import { translator } from "../../i18n/index.js";
import { createCoreCatalog } from "../../core/catalog/index.js";
import { contentHash } from "../../core/ids/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { resolveExecutable, runSpec, substituteTokens } from "../../core/runner/index.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { genericCommandManifest } from "./manifest.js";

export { genericCommandManifest } from "./manifest.js";

const ADAPTER_ID = genericCommandManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";

type Evidence = { kind: "exit-code" } | { kind: "test-runner"; runner: string } | { kind: "json-file"; file: string; schema: string };
interface Effects {
  readsCode: boolean;
  writesOutputs: boolean;
  mayChangeCode: boolean;
  executesProjectCode: boolean;
  usesNetwork: boolean;
  workspaceWrites?: string[];
}
interface Declared {
  cwd?: string;
  successExitCodes?: number[];
  support?: string;
  limitations?: string[];
  effects: Effects;
  evidence: Evidence;
}

type Validator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
type AjvCtor = new (opts: object) => { compile(schema: object): Validator };
const Ajv = ((Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor)) as AjvCtor;
const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas", "catalog");

let declarationValidator: Validator | undefined;
function declarationOf(): Validator {
  declarationValidator ??= new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(path.join(schemaDir, "generic-evidence.schema.json"), "utf8")) as object);
  return declarationValidator;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const messages = (v: Validator): string => (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`).join("; ");

/** Renders the placeholders of the plan; the others ({workspace}, {runDir}) are replaced when the run starts. */
function render(text: string, tool: string, componentRoot: string | null): string {
  return text
    .split("{componentRoot}").join(componentRoot && componentRoot !== "" ? componentRoot : ".")
    .split("{outputDir}").join(`${RUN_DIR}/outputs/${ADAPTER_ID}/${tool}`);
}

/** The schema file of a json-file contract: workspace-relative, inside the workspace, and a valid JSON Schema. */
function readEvidenceSchema(dir: string, file: string): { sha256: string; schema: object } | { problem: "missing" | "invalid"; detail: string } {
  const abs = path.resolve(dir, file);
  const rel = path.relative(dir, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { problem: "missing", detail: file };
  const text = fs.readFileSync(abs, "utf8");
  try {
    const schema = JSON.parse(text) as object;
    new Ajv({ allErrors: true, strict: false }).compile(schema);
    return { sha256: contentHash(text), schema };
  } catch (error) {
    return { problem: "invalid", detail: (error as Error).message };
  }
}

function declaredOf(body: Record<string, unknown>): { declared: Declared | null; detail: string } {
  const v = declarationOf();
  const config = isObject(body.config) ? body.config : {};
  if (!v(config)) return { declared: null, detail: messages(v) };
  return { declared: config as unknown as Declared, detail: "" };
}

/** Which capabilities of the instance have no verifiable contract, by the category of each one. */
function unprovenCapabilities(capabilities: string[], evidence: Evidence): Record<string, string> {
  const t = translator("generic-command");
  const byId = new Map(createCoreCatalog().toDocument().capabilities.map((c) => [c.id, c.category ?? null]));
  const out: Record<string, string> = {};
  for (const capability of capabilities) {
    const category = byId.get(capability) ?? null;
    if (category === "security" || category === "architecture") {
      if (evidence.kind !== "json-file") out[capability] = t("generic_unproven_category", { capability, category, need: t("generic_need_json") });
    } else if (category === "tests") {
      if (evidence.kind !== "json-file" && evidence.kind !== "test-runner") out[capability] = t("generic_unproven_category", { capability, category, need: t("generic_need_json_or_runner") });
    }
  }
  return out;
}

function planGeneric(input: ExternalPlanInput): ExternalPlan {
  const t = translator("generic-command");
  const tools = isObject(input.config?.tools) ? input.config.tools : {};
  const body = isObject(tools[input.tool]) ? (tools[input.tool] as Record<string, unknown>) : {};
  const problems: string[] = [];
  const executableText = typeof body.command === "string" && body.command !== "" ? body.command : null;
  if (executableText === null) problems.push(t("generic_no_command", { tool: input.tool }));
  const rawArgs = body.args;
  if (rawArgs !== undefined && !(Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === "string"))) problems.push(t("generic_bad_args", { tool: input.tool }));
  const { declared, detail } = declaredOf(body);
  if (declared === null) problems.push(t("generic_bad_config", { tool: input.tool, detail }));

  const componentRoot = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const executable = executableText ?? "";
  const args = (Array.isArray(rawArgs) ? (rawArgs as string[]) : []).map((a) => render(a, input.tool, componentRoot));
  const cwdRel = declared?.cwd ? render(declared.cwd, input.tool, componentRoot) : componentRoot;
  const cwd = cwdRel && cwdRel !== "." ? `${WORKSPACE}/${cwdRel.replace(/^\.\//, "")}` : WORKSPACE;

  const configFiles: ExternalPlan["configFiles"] = [];
  const conditions: string[] = [];
  const limitations: string[] = [];
  let output: ExternalPlan["output"] = { format: "exit-code", schema: null };
  const evidence = declared?.evidence;
  if (evidence?.kind === "json-file") {
    const read = readEvidenceSchema(input.dir, evidence.schema);
    if ("problem" in read) problems.push(t(read.problem === "missing" ? "generic_schema_missing" : "generic_schema_invalid", { tool: input.tool, file: evidence.schema, detail: read.detail }));
    else configFiles.push({ file: evidence.schema, sha256: read.sha256 });
    conditions.push(t("generic_condition_evidence", { file: evidence.file, schema: evidence.schema }));
    output = { format: "json", schema: evidence.schema };
  } else if (evidence?.kind === "test-runner") conditions.push(t("generic_condition_runner", { runner: evidence.runner }));
  else conditions.push(t("generic_condition_boolean"));
  if (declared?.support === "partial") limitations.push(t("generic_partial"));
  for (const l of declared?.limitations ?? []) limitations.push(l);

  const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string") : [];
  const uncredited = evidence ? unprovenCapabilities(capabilities, evidence) : {};

  const found = executableText ? resolveExecutable(executable, input.env) : null;
  let availability: ExternalPlan["availability"] = { status: "available", reason: null };
  let blocksPlan = false;
  if (problems.length > 0) {
    // A declaration that breaks the contract is a defect of the configuration: the plan itself is blocked until fixed.
    availability = { status: "unavailable", reason: problems.join(" ") };
    blocksPlan = true;
  } else if (found === null) availability = { status: "unavailable", reason: t("generic_missing_executable", { executable }) };

  const effects = declared?.effects;
  return {
    label: t("generic_label", { tool: input.tool }),
    command: { executable, args, cwd, env: {}, stdin: null },
    runtime: { name: "native", interpreter: found, available: found !== null },
    toolVersion: null,
    configFiles,
    availability,
    blocksPlan,
    network: effects?.usesNetwork === true,
    limitations,
    conditions,
    output,
    ...(effects
      ? {
          effects: {
            readsCode: effects.readsCode,
            writesOutputs: effects.writesOutputs,
            mayChangeCode: effects.mayChangeCode,
            executesProjectCode: effects.executesProjectCode,
            workspaceWrites: [...(effects.workspaceWrites ?? [])],
          },
        }
      : {}),
    uncredited,
    contract: { successExitCodes: declared?.successExitCodes ?? [0], evidence: declared?.evidence ?? null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

async function runGeneric(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("generic-command");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("generic_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  const args = command.args.map((a) => substituteTokens(a, tokens));
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
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

  const unavailable = items.find((i) => i.availability.status !== "available");
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("generic_blocked", { detail: command.executable }));

  const contract = contractOf(invocation);
  const result = await runSpec(
    { executable: command.executable, args, cwd, env: command.env, stdin: null, timeoutMs: timeoutSeconds * 1000 },
    { parentEnv: context.env },
  );
  fs.writeFileSync(stdoutLog, result.stdout, { mode: 0o600 });
  fs.writeFileSync(
    stderrLog,
    `executable: ${command.executable}\nargs: ${JSON.stringify(args)}\nexit code: ${result.exitCode ?? "(none)"}\nduration ms: ${result.durationMs}\n---\n${result.stderr}`,
    { mode: 0o600 },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("generic_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("generic_timeout", { seconds: timeoutSeconds }))), findings: [] };
  const code = result.exitCode;
  const success = code !== null && contract.successExitCodes.includes(code);
  if (!success) {
    // A signal or a missing code proves nothing; a different code is the command's own "no".
    if (code === null) {
      return { ...base, stages: items.map((i) => stageFor(i, "error", t("generic_blocked", { detail: String(result.signal ?? "-") }), { interpreted: false })), findings: [] };
    }
    const reason = t("generic_reason_failed", { executable: command.executable, code, expected: contract.successExitCodes.join(", ") });
    return { ...base, stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: 1, findings: 0, nativeStatus: `exit ${code}` })), findings: [] };
  }
  if (contract.evidence?.kind === "json-file") {
    const verdict = checkEvidence(context, contract.evidence, outDir);
    if (verdict !== null) return { ...base, stages: items.map((i) => stageFor(i, "completed", verdict, { interpreted: false, nativeStatus: `exit ${code}` })), findings: [] };
    const reason = t("generic_reason_evidence", { executable: command.executable, code, file: contract.evidence.file });
    return { ...base, stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: 0, findings: 0, nativeStatus: `exit ${code}` })), findings: [] };
  }
  const reason = t("generic_reason_passed", { executable: command.executable, code });
  return { ...base, stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: 0, findings: 0, nativeStatus: `exit ${code}` })), findings: [] };
}

/** The exit codes and the evidence contract of the instance, as the plan recorded them (the plan hash covers them). */
function contractOf(invocation: Plan["invocations"][number]): { successExitCodes: number[]; evidence: Evidence | null } {
  const c = invocation.contract ?? {};
  const codes = Array.isArray(c.successExitCodes) ? c.successExitCodes.filter((n): n is number => typeof n === "number") : [];
  return { successExitCodes: codes.length > 0 ? codes : [0], evidence: isObject(c.evidence) ? (c.evidence as unknown as Evidence) : null };
}

/** null when the evidence file exists and satisfies the declared schema; otherwise the reason. */
function checkEvidence(context: AdapterContext, evidence: Extract<Evidence, { kind: "json-file" }>, outDir: string): string | null {
  const t = translator("generic-command");
  const file = path.join(outDir, evidence.file);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return t("generic_evidence_missing", { file: evidence.file, detail: (error as Error).message });
  }
  const read = readEvidenceSchema(context.workspacePath, evidence.schema);
  if ("problem" in read) return t("generic_evidence_invalid", { file: evidence.file, schema: evidence.schema, detail: read.detail });
  const validate = new Ajv({ allErrors: true, strict: false }).compile(read.schema);
  if (!validate(data)) return t("generic_evidence_invalid", { file: evidence.file, schema: evidence.schema, detail: messages(validate) });
  return null;
}

export const genericCommandAdapter: ExternalAdapter = {
  manifest: genericCommandManifest,
  plan: planGeneric,
  run: runGeneric,
};
