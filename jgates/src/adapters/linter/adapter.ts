// The adapter the engine makes of one descriptor. The plan finds the tool's files with the census, builds the exact
// command (the files, the report in the run folder, the default configuration when the project has none, the jgates ci
// arguments) and says why the tool does not apply when it does not. The run executes that command in the step container
// of the tools image (in batches when the list of files is long; one call per file inside one container in the
// each-file mode), reads the output with the descriptor's reader, and checks the exit code against what was read:
// anything they do not agree on is an error stage, never a pass. Nothing is rewritten.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getLocale, translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { findOnPath } from "../../core/bridge/index.js";
import { inImageOverride, probeImageTool } from "../../core/tools-image/catalogue.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { DEFAULT_ENV_ALLOWLIST, runSpec, shellQuote, stepMode, substituteTokens, type ExecutionResult } from "../../core/runner/index.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import type { AdapterContext, AdapterOutput, ResultFinding, ResultStage } from "../../core/run/types.js";
import { RUN_DIR, toFindings, type LintDiagnostic } from "../lint-common/index.js";
import { activatedFiles, fileCensus, requiredFilePresent } from "./census.js";
import { linterOverrideEnv, linterTexts, type LoadedLinter } from "./descriptor.js";
import { linterManifest } from "./manifest.js";
import { mapLevel, readerOf, statusFinding, type RawFinding, type ReaderInput } from "./readers.js";

const WORKSPACE = "{workspace}";
/** Files per call in the files mode; a longer list runs in several calls of the same command. */
export const BATCH_FILES = 200;
/** And at most this many characters of file arguments per call. */
export const BATCH_CHARS = 60_000;
/** Marker lines of the each-file loop (record separator, then the word). */
export const EACH_FILE_MARK = "\u001ejgates-file ";
export const EACH_EXIT_MARK = "\u001ejgates-exit ";

const ENV_ALLOWLIST: readonly string[] = [...DEFAULT_ENV_ALLOWLIST];

interface Probe {
  executable: string | null;
  prefix: string[];
  version: string | null;
  missing: string | null;
}

/** Whether the program is in the tools image and its version, from image.json (nothing starts); an override inside the image wins. */
export function probeLinter(linter: LoadedLinter, env: NodeJS.ProcessEnv): Probe {
  const { program } = linter.descriptor;
  const named = inImageOverride(env, linterOverrideEnv(linter.descriptor.id));
  if (named !== null) {
    const abs = findOnPath(named, env);
    if (!abs) return { executable: null, prefix: [], version: null, missing: named };
    const version = probeImageTool(program.tool, env).version ?? "0.0.0";
    return /\.(?:mjs|cjs|js)$/i.test(abs) ? { executable: process.execPath, prefix: [abs], version, missing: null } : { executable: abs, prefix: [], version, missing: null };
  }
  const tool = probeImageTool(program.tool, env);
  if (tool.problem !== null || tool.executable === null) return { executable: null, prefix: [], version: null, missing: tool.detail };
  const executable = program.command ? (stepMode(env) === "in-image" ? (findOnPath(program.command, env) ?? program.command) : program.command) : tool.executable;
  return { executable, prefix: [], version: tool.version, missing: null };
}

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** The run folder of a tool instance's reports and default configuration, as a plan token path. */
const toolDir = (id: string): string => `${RUN_DIR}/linters/${id}`;

export interface LinterContract {
  tool: string;
  mode: "files" | "each-file" | "project";
  /** The files the activation picked (workspace-relative). */
  files: string[];
  /** files mode: where the files sit in the command's arguments. */
  fileArgs?: { start: number; count: number };
  /** The report the tool writes ({runDir}/linters/<id>/<name>). */
  report?: string;
  /** The default configuration file of the descriptor, copied into the run folder before the call. */
  defaultConfig?: string;
  /** Whether the tool only reads the synchronized copy of the project (it may run beside other steps). */
  readOnly: boolean;
  needsDependencies: boolean;
  /** The census listing the files were picked from. */
  listingHash: string;
}

/** The sh loop of the each-file mode: every file gets a marker, the tool's output and its exit code, all in one container. */
export function eachFileScript(command: string[], fromStderr: boolean): string {
  const quoted = command.map((part) => (part === "{file}" ? '"$f"' : shellQuote(part)));
  if (!command.includes("{file}")) quoted.push('"$f"');
  const call = `${quoted.join(" ")}${fromStderr ? " 2>&1 >/dev/null" : ""}`;
  return `for f do printf '\\n\\036jgates-file %s\\n' "$f"; ${call}; printf '\\n\\036jgates-exit %s\\n' "$?"; done`;
}

/** Splits the each-file loop's output into one chunk per file; null when the markers do not add up. */
export function splitEachFile(stdout: string, files: string[]): Array<{ file: string; exitCode: number; text: string }> | null {
  const chunks: Array<{ file: string; exitCode: number; text: string }> = [];
  const parts = stdout.split(`\n${EACH_FILE_MARK}`);
  if (parts.length - 1 !== files.length || (parts[0] ?? "").trim() !== "") return null;
  for (const [index, part] of parts.slice(1).entries()) {
    const newline = part.indexOf("\n");
    const file = newline < 0 ? part : part.slice(0, newline);
    const rest = newline < 0 ? "" : part.slice(newline + 1);
    const exitAt = rest.lastIndexOf(`\n${EACH_EXIT_MARK}`);
    if (file !== files[index] || exitAt < 0) return null;
    const code = Number.parseInt(rest.slice(exitAt + 1 + EACH_EXIT_MARK.length).trim(), 10);
    if (!Number.isInteger(code)) return null;
    chunks.push({ file, exitCode: code, text: rest.slice(0, exitAt) });
  }
  return chunks;
}

/** The exit code and the findings must agree; a code in both lists lets the report decide. */
export function concludeExit(count: number, exitCode: number | null, exit: { clean: number[]; findings: number[] }): string | null {
  if (exitCode === null) return "the tool did not exit";
  const clean = exit.clean.includes(exitCode);
  const dirty = exit.findings.includes(exitCode);
  if (clean && dirty) return null;
  if (clean) return count === 0 ? null : `exit ${exitCode} but ${count} finding(s) are listed`;
  if (dirty) return count > 0 ? null : `exit ${exitCode} but no finding was listed`;
  return `unexpected exit ${exitCode}`;
}

/** Splits the files into batches by count and by length. */
export function batches(files: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const f of files) {
    if (current.length > 0 && (current.length >= BATCH_FILES || chars + f.length + 1 > BATCH_CHARS)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(f);
    chars += f.length + 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const tailOf = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ");
const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

export function makeLinterAdapter(linter: LoadedLinter): ExternalAdapter {
  const d = linter.descriptor;
  const manifest = linterManifest(linter);
  const ADAPTER_ID = d.id;

  function plan(input: ExternalPlanInput): ExternalPlan {
    const t = translator("linter");
    const texts = linterTexts(d, getLocale());
    const probe = probeLinter(linter, input.env);
    const census = fileCensus(input.dir);
    const files = d.activation.project === true && !d.activation.extensions && !d.activation.names && !d.activation.content ? [] : activatedFiles(census, d.activation);

    let skip: string | null = null;
    if (d.activation.requires && requiredFilePresent(census, d.activation.requires) === null) skip = t("linter_requires", { tool: d.name, files: d.activation.requires.join(", ") });
    else if (d.activation.project !== true && files.length === 0) skip = t("linter_no_files", { tool: d.name });
    else if (d.run.mode !== "project" && files.length === 0) skip = t("linter_no_files", { tool: d.name });

    const projectConfig = d.configuration.files.filter((f) => fs.existsSync(path.join(input.dir, ...f.split("/"))));
    const defaultConfig = projectConfig.length === 0 && d.configuration.default !== "tool" ? d.configuration.default : undefined;
    const report = d.output.from === "file" ? `${toolDir(d.id)}/${d.output.file as string}` : undefined;
    const replaceTokens = (arg: string): string => {
      let out = arg;
      if (report) out = out.split("{report}").join(report);
      if (defaultConfig) out = out.split("{config}").join(`${toolDir(d.id)}/${defaultConfig}`);
      return out;
    };
    const head = [...(d.program.prefix ?? []), ...(defaultConfig ? (d.configuration.args ?? []) : []), ...(input.policyDir ? (d.configuration.ci?.args ?? []) : [])].map(replaceTokens);
    const own = d.run.args.map(replaceTokens);

    const executable = probe.executable ?? d.program.command ?? d.program.tool;
    let args: string[];
    let fileArgs: LinterContract["fileArgs"];
    if (d.run.mode === "files") {
      const at = own.indexOf("{files}");
      const before = [...probe.prefix, ...head, ...(at < 0 ? own : own.slice(0, at))];
      const after = at < 0 ? [] : own.slice(at + 1);
      args = [...before, ...files, ...after];
      fileArgs = { start: before.length, count: files.length };
    } else if (d.run.mode === "each-file") {
      // The command of one file ({file} stands for it); the run calls it for every file of the contract.
      args = [...probe.prefix, ...head, ...own];
      if (!args.includes("{file}")) args.push("{file}");
    } else args = [...probe.prefix, ...head, ...own];

    let availability: ExternalPlan["availability"];
    if (probe.missing !== null) availability = { status: "unavailable", reason: t("linter_missing", { tool: d.name, detail: probe.missing }) };
    else if (probe.version !== null && satisfiesRange(probe.version, d.program.versionRange) !== true) {
      availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: d.name, version: probe.version, range: d.program.versionRange, what: ADAPTER_ID }) };
    } else if (skip !== null) availability = { status: "unavailable", reason: skip };
    else availability = { status: "available", reason: null };

    const contract: LinterContract = {
      tool: d.id,
      mode: d.run.mode,
      files,
      ...(fileArgs ? { fileArgs } : {}),
      ...(report ? { report } : {}),
      ...(defaultConfig ? { defaultConfig } : {}),
      readOnly: d.run.readOnly,
      needsDependencies: d.run.needsDependencies === true,
      listingHash: census.listingHash,
    };
    return {
      label: texts.label,
      command: { executable, args, cwd: WORKSPACE, env: { NO_COLOR: "1", ...(d.run.env ?? {}) }, stdin: null },
      runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
      toolVersion: probe.version,
      configFiles: projectConfig.map((file) => ({ file, sha256: sha256File(path.join(input.dir, ...file.split("/"))) })),
      availability,
      blocksPlan: false,
      network: d.run.network,
      limitations: [texts.limitation],
      conditions: d.run.readOnly ? [t("linter_condition_read_only")] : [],
      imageTool: d.program.tool,
      contract: contract as unknown as Record<string, unknown>,
      output: { format: d.output.reader === "sarif" ? "sarif" : "text", schema: null },
      effects: { executesProjectCode: d.run.executesProjectCode, workspaceWrites: d.run.workspaceWrites ?? [] },
    };
  }

  async function run(context: AdapterContext, planDoc: Plan, tool: string): Promise<AdapterOutput> {
    const t = translator("linter");
    const invocation = planDoc.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
    const items = planDoc.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
    if (!invocation || items.length === 0) throw new Error(t("linter_no_invocation", { tool }));
    const contract = invocation.contract as unknown as LinterContract | undefined;
    const tokens = { runDir: context.runDir, workspace: context.workspacePath };
    const command = invocation.command;
    const cwd = substituteTokens(command.cwd, tokens);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
    const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds), d.run.timeoutSeconds ?? Number.POSITIVE_INFINITY);
    const version = items[0]?.versions.toolVersion ?? null;

    const runToolDir = path.join(context.runDir, "linters", d.id);
    fs.mkdirSync(runToolDir, { recursive: true, mode: 0o700 });
    const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

    const stageFor = (item: PlanItem, state: ResultStage["state"], reason?: string, extra: Partial<ResultStage> = {}): ResultStage => ({ id: item.id, label: item.label, kind: "step", adapter: ADAPTER_ID, state, ...(reason ? { reason } : {}), ...extra });
    const base = {
      requirements: items.map((i) => ({ id: i.id, required: i.requirement === "required", reason: i.reason.message })),
      disabled: [],
      logs: [] as string[],
      outputs: [relToRun(context.runDir, outDir)],
    };
    const all = (state: ResultStage["state"], reason: string, extra: Partial<ResultStage> = {}): AdapterOutput => ({ ...base, stages: items.map((i) => stageFor(i, state, reason, extra)), findings: [] });

    const unavailable = items.find((i) => i.availability.status !== "available");
    if (unavailable) return all("blocked", unavailable.availability.reason ?? t("linter_blocked", { tool: d.name, detail: command.executable }));
    if (!contract) return all("error", t("linter_no_invocation", { tool }));

    if (contract.defaultConfig) fs.copyFileSync(path.join(linter.dir, contract.defaultConfig), path.join(runToolDir, contract.defaultConfig));

    // The calls: one per batch of files (files mode), else the one command.
    const planned = command.args;
    // each-file: in a step container, one container runs the loop over the files (sh); inside the tools image, one process per file.
    const loop = contract.mode === "each-file" && stepMode(context.env) !== "in-image";
    const calls: Array<{ executable: string; args: string[]; files: string[]; report: string | null }> = [];
    const reportOf = (index: number): string | null => (contract.report ? substituteTokens(index === 0 ? contract.report : contract.report.replace(`/linters/${d.id}/`, `/linters/${d.id}/${index + 1}/`), tokens) : null);
    if (contract.mode === "files" && contract.fileArgs && contract.fileArgs.count > 0) {
      const { start, count } = contract.fileArgs;
      const files = planned.slice(start, start + count);
      for (const [index, batch] of batches(files).entries()) {
        const callArgs = [...planned.slice(0, start), ...batch, ...planned.slice(start + count)].map((a) => {
          const value = index > 0 && contract.report && a.includes(contract.report) ? a.split(contract.report).join(contract.report.replace(`/linters/${d.id}/`, `/linters/${d.id}/${index + 1}/`)) : a;
          return substituteTokens(value, tokens);
        });
        calls.push({ executable: command.executable, args: callArgs, files: batch, report: reportOf(index) });
      }
    } else if (contract.mode === "each-file" && loop) {
      for (const batch of batches(contract.files)) {
        const script = eachFileScript([command.executable, ...planned.map((a) => (a === "{file}" ? a : substituteTokens(a, tokens)))], d.output.from === "stderr");
        calls.push({ executable: "sh", args: ["-c", script, "jgates-each-file", ...batch], files: batch, report: null });
      }
    } else if (contract.mode === "each-file") {
      for (const file of contract.files) calls.push({ executable: command.executable, args: planned.map((a) => (a === "{file}" ? file : substituteTokens(a, tokens))), files: [file], report: null });
    } else calls.push({ executable: command.executable, args: planned.map((a) => substituteTokens(a, tokens)), files: contract.files, report: reportOf(0) });

    const reader = await readerOf(d);
    const view = (p: string): string => stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, p);
    const diagnostics: LintDiagnostic[] = [];
    const exitCodes: string[] = [];
    const transcript: string[] = [];

    for (const [index, call] of calls.entries()) {
      const suffix = calls.length > 1 ? `.${index + 1}` : "";
      const stdoutLog = path.join(context.logsDir, `${tool}${suffix}.stdout.log`);
      const stderrLog = path.join(context.logsDir, `${tool}${suffix}.stderr.log`);
      if (call.report) {
        fs.mkdirSync(path.dirname(call.report), { recursive: true });
        fs.rmSync(call.report, { force: true });
      }
      const result: ExecutionResult = await runSpec(
        { executable: call.executable, args: call.args, cwd, env, stdin: null, timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
        { parentEnv: context.env, envAllowlist: ENV_ALLOWLIST },
      );
      base.logs.push(relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog));
      if (result.spawnError) return all("blocked", t("linter_blocked", { tool: d.name, detail: `${result.spawnError.code}: ${result.spawnError.message}` }));
      if (result.cancelled) return all("cancelled", t("linter_cancelled", { tool: d.name }));
      if (result.timedOut) return all("timeout", t("linter_timeout", { tool: d.name, seconds: timeoutSeconds }));
      transcript.push(`${result.stdout}${result.stderr === "" ? "" : `\n--- stderr ---\n${result.stderr}`}`);
      exitCodes.push(String(result.exitCode ?? "-"));
      const errorStage = (detail: string): AdapterOutput =>
        all("error", t("linter_exit_error", { tool: d.name, code: result.exitCode ?? "-", detail: detail || String(result.signal ?? "") }), { interpreted: false, nativeStatus: `exit ${result.exitCode ?? "-"}` });
      if (result.truncated) return errorStage(t("linter_truncated"));

      // The chunks the reader reads: the files of the each-file loop, or the one output of the call.
      let inputs: ReaderInput[];
      if (contract.mode === "each-file" && !loop) {
        const file = call.files[0] as string;
        inputs = [{ text: d.output.from === "stderr" ? result.stderr : result.stdout, other: d.output.from === "stderr" ? result.stdout : result.stderr, exitCode: result.exitCode, file }];
      } else if (contract.mode === "each-file") {
        if (result.exitCode !== 0) return errorStage(`${t("linter_each_file_loop")} ${tailOf(result.stderr || result.stdout)}`.trim());
        const chunks = splitEachFile(result.stdout, call.files);
        if (chunks === null) return errorStage(t("linter_each_file_markers"));
        inputs = chunks.map((c) => ({ text: c.text, other: "", exitCode: c.exitCode, file: c.file }));
      } else {
        let text: string;
        if (d.output.from === "file") {
          if (!call.report || !fs.existsSync(call.report)) return errorStage(`${t("linter_no_report", { file: d.output.file ?? "" })} ${tailOf(result.stderr || result.stdout)}`.trim());
          text = fs.readFileSync(call.report, "utf8");
          fs.copyFileSync(call.report, path.join(outDir, calls.length > 1 ? `${index + 1}-${path.basename(call.report)}` : path.basename(call.report)));
        } else text = d.output.from === "stderr" ? result.stderr : result.stdout;
        inputs = [{ text, other: d.output.from === "stderr" ? result.stdout : result.stderr, exitCode: result.exitCode }];
      }
      for (const input of inputs) {
        const read = reader(input, d.output);
        if (!read.ok) return errorStage(`${read.problem ?? ""} ${tailOf(input.text || input.other)}`.trim());
        const found: RawFinding[] = [...read.findings];
        if (d.output.reader === "status" && input.exitCode !== null && d.run.exit.findings.includes(input.exitCode) && !d.run.exit.clean.includes(input.exitCode)) found.push(statusFinding(input, d.output));
        const problem = concludeExit(found.length, input.exitCode, d.run.exit);
        if (problem) return errorStage(`${problem}${input.file ? ` (${input.file})` : ""} ${tailOf(input.other || input.text)}`.trim());
        for (const f of found) diagnostics.push({ file: f.file ?? view(context.workspacePath), ...(f.line !== undefined ? { line: f.line } : {}), ...(f.column !== undefined ? { column: f.column } : {}), ruleId: f.rule, level: mapLevel(f.level, d), message: f.message });
      }
    }
    fs.writeFileSync(path.join(outDir, `${d.id}.txt`), transcript.join("\n--- next call ---\n"), { mode: 0o600 });

    // A finding without a location is placed on the workspace itself (".").
    const findings: ResultFinding[] = toFindings({ manifest, tool: d.id }, diagnostics, { stageId: items[0]?.id as string, version, workspace: view(context.workspacePath), cwd: view(cwd), category: d.place.capability }).map((f) =>
      f.location && f.location.path === "" ? { ...f, location: { ...f.location, path: "." } } : f,
    );
    const reason = t("linter_reason_completed", { tool: d.name, version: version ?? "?", count: findings.length });
    return { ...base, stages: items.map((i) => stageFor(i, "completed", reason, { blockingViolations: findings.length, findings: findings.length, nativeStatus: `exit ${exitCodes.join(",")}` })), findings };
  }

  return { manifest, plan, run };
}
