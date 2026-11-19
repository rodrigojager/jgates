// Semgrep adapter: plans one `semgrep scan` per tool instance that uses only the local rules of the instance's
// binding (a rule file or a directory of rule files), with metrics and the version check off and the JSON output in
// the run folder. Its home (settings, log, caches) is the throwaway folder the manifest declares in the run folder.
// Nothing is downloaded and nothing is written in the workspace.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translator } from "../../i18n/index.js";
import type { ExternalAdapter, ExternalPlan, ExternalPlanInput } from "../../core/plan/adapters.js";
import type { Plan, PlanItem } from "../../core/plan/types.js";
import { collectRuleSource, issuesOf, type RuleSource } from "../../core/rules/index.js";
import { resolveHome } from "../../core/home/index.js";
import { LOCK_FILE, readLock } from "../../core/lock/index.js";
import { satisfiesRange } from "../../core/prepare/semver.js";
import { SEMGREP_RULES_REF, preparedRulesOf } from "../../core/prepare/store.js";
import { runSpec, substituteTokens } from "../../core/runner/index.js";
import { stepViewOfPaths } from "../../core/runner/container.js";
import { createOutputPaths, redirectionEnv } from "../../core/run/redirection.js";
import type { AdapterContext, AdapterOutput, ResultStage } from "../../core/run/types.js";
import { semgrepManifest } from "./manifest.js";
import { labelOf } from "../../core/discovery/vocabulary.js";
import { parseSemgrepOutput, scannedLanguageCounts } from "./normalize.js";
import { PACK_LANGUAGE_PREFIX, buildPackIndex, listPackRuleFiles, packLanguageOf } from "./pack-index.js";
import { probeSemgrep, scannerPath } from "./probe.js";

export { semgrepManifest } from "./manifest.js";
export { parseSemgrepOutput, scannedLanguageCounts } from "./normalize.js";
export { findSemgrep, probeSemgrep, scannerPath } from "./probe.js";
export { PACK_LANGUAGE_PREFIX, PACK_LISTS, buildPackIndex, listPackRuleFiles, packRuleIndex, type PackIndex, type PackLists, type PackRule, type PackSignal } from "./pack-index.js";

/** Ids of the rule packs that ship with JGates (tools.<id>.rulePack), mapped to their pack folder under packs/semgrep. */
export const BUNDLED_RULE_PACKS: Readonly<Record<string, string>> = { jgates: "jgates-semgrep" };

/** The rules folder of a bundled pack, resolved from the installed package (src/ and dist/ sit at the same depth). */
export function bundledPackRulesDir(packId: string): string | null {
  const folder = BUNDLED_RULE_PACKS[packId];
  if (!folder) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "packs", "semgrep", folder, "rules");
}

/** The languages a pack folder has rule files for, read from the files themselves, in the pack's own order. */
export function packLanguagesOf(files: readonly string[]): string[] {
  const found = new Set(files.map(packLanguageOf));
  return Object.keys(PACK_LANGUAGE_PREFIX).filter((l) => found.has(l));
}

/**
 * The languages the bundled packs have rules for (JavaScript also serves TypeScript), read from the pack's own rule
 * files, never from a list kept by hand. What the screens and `jgates discover` use to say that the JGates Semgrep
 * rules run for a language that has no stack.
 */
export function bundledPackLanguages(): string[] {
  const out = new Set<string>();
  for (const id of Object.keys(BUNDLED_RULE_PACKS)) {
    const dir = bundledPackRulesDir(id);
    if (!dir) continue;
    for (const language of packLanguagesOf(listPackRuleFiles(dir))) {
      out.add(language);
      if (language === "javascript") out.add("typescript");
    }
  }
  return [...out].sort();
}

/** Display name of a pack language (the JavaScript rules also serve TypeScript; the two kinds of file are named in words). */
export const packLanguageLabel = (language: string, locale?: string): string => {
  if (language === "javascript") return "JavaScript/TypeScript";
  if (language === "html") return translator("semgrep", locale)("semgrep_pack_language_html");
  if (language === "config") return translator("semgrep", locale)("semgrep_pack_language_config");
  return labelOf(language);
};

/** The pack languages of a bundled pack that a run's arguments select (`--config <pack rules folder>`), else an empty list. */
function packLanguagesOfArgs(args: readonly string[]): string[] {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== "--config") continue;
    const value = path.resolve(args[i + 1] as string);
    for (const id of Object.keys(BUNDLED_RULE_PACKS)) {
      const dir = bundledPackRulesDir(id);
      if (dir && path.resolve(dir) === value) return packLanguagesOf(listPackRuleFiles(dir));
    }
  }
  return [];
}

/** Languages the discovery recognized but JGates has no stack for, and the pack has no rule for (Kotlin, Ruby...). */
function languagesWithoutPackRules(input: ExternalPlanInput, packLanguages: readonly string[]): string[] {
  const covered = new Set<string>([...packLanguages, ...(packLanguages.includes("javascript") ? ["typescript"] : [])]);
  const missing = (input.inventory?.classifications ?? [])
    .filter((c) => c.classificationStatus === "unsupported" && c.language !== null && !covered.has(c.language))
    .map((c) => c.language as string);
  return [...new Set(missing)].sort();
}

/**
 * For the bundled pack folders a run's arguments select: rule id to the requirement ids the rule was written for (the
 * checks), and rule id to the tag of a signal rule (the signals). Both absent without the pack.
 */
function packRulesOfArgs(args: readonly string[]): { rules?: Map<string, readonly string[]>; signals?: Map<string, string>; reviewRules?: Set<string> } {
  let rules: Map<string, readonly string[]> | undefined;
  let signals: Map<string, string> | undefined;
  let reviewRules: Set<string> | undefined;
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== "--config") continue;
    const value = path.resolve(args[i + 1] as string);
    for (const id of Object.keys(BUNDLED_RULE_PACKS)) {
      const dir = bundledPackRulesDir(id);
      if (!dir || path.resolve(dir) !== value) continue;
      rules ??= new Map();
      signals ??= new Map();
      reviewRules ??= new Set();
      for (const rule of buildPackIndex(dir).rules) {
        if (rule.signal === null) rules.set(rule.id, rule.asvsRequirements);
        else signals.set(rule.id, rule.signal);
        if (rule.signal === null && rule.class === "review") reviewRules.add(rule.id);
      }
    }
  }
  return { ...(rules ? { rules } : {}), ...(signals ? { signals } : {}), ...(reviewRules ? { reviewRules } : {}) };
}

/** The pack the instance selects in its settings, if any. */
function selectedPack(input: ExternalPlanInput): string | null {
  const tools = input.config?.tools;
  const body = tools && typeof tools === "object" ? (tools as Record<string, unknown>)[input.tool] : null;
  const value = body && typeof body === "object" ? (body as Record<string, unknown>).rulePack : undefined;
  return typeof value === "string" ? value : null;
}

const sha256Of = (file: string): string | null => {
  try {
    return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
  } catch {
    return null;
  }
};

const ADAPTER_ID = semgrepManifest.id;
const RUN_DIR = "{runDir}";
const WORKSPACE = "{workspace}";
const MAX_SHOWN = 3;

/** Environment of the scanner: no metrics, no version check, the throwaway home of the manifest's output paths. */
const scannerEnv = (): Record<string, string> => ({
  ...redirectionEnv(semgrepManifest),
  SEMGREP_SEND_METRICS: "off",
  SEMGREP_ENABLE_VERSION_CHECK: "0",
});

function unusableReason(source: RuleSource, tool: string): string | null {
  const t = translator("semgrep");
  const where = source.relPath ?? source.binding ?? "-";
  if (source.problem?.code === "NO_BINDING") return t("semgrep_no_binding", { tool });
  if (source.problem?.code === "BINDING_REFUSED") return t("semgrep_binding_refused", { tool, detail: where });
  if (source.problem?.code === "BINDING_MISSING") return t("semgrep_binding_missing", { tool, detail: where });
  if (source.problem?.code === "NO_RULE_FILES") return t("semgrep_no_rule_files", { tool, detail: where });
  if (!source.valid) {
    const issues = issuesOf(source);
    const shown = issues.slice(0, MAX_SHOWN).map((i) => t("semgrep_issue", { file: i.file, where: i.line ? `:${i.line}` : "", message: i.message }));
    const more = issues.length > MAX_SHOWN ? ` ${t("semgrep_rules_hidden", { count: issues.length - MAX_SHOWN })}` : "";
    return t("semgrep_rules_invalid", { tool, detail: shown.join("; ") + more });
  }
  return null;
}

/** The command the plan shows: only the local rule files, no registry. */
function planSemgrep(input: ExternalPlanInput): ExternalPlan {
  const t = translator("semgrep");
  const probe = probeSemgrep(input.env);
  // Under a CI policy the rules and the lock are the policy's (absolute paths), never files of the analyzed project.
  const governed = input.policyDir !== undefined;
  const configDir = input.policyDir ?? input.dir;
  const source = collectRuleSource(configDir, input.tool);
  // Rules prepared by `jgates tools prepare` (pinned in .jgates/lock.json): the run uses that stored copy, never the network.
  const lockRead = readLock(configDir);
  const home = resolveHome({ env: input.env });
  const prepared = preparedRulesOf(lockRead.lock, input.tool, home);
  const usePrepared = prepared.state === "ready";
  const nothingLocal = source.problem?.code === "NO_BINDING" || source.problem?.code === "NO_RULE_FILES" || source.problem?.code === "BINDING_MISSING";
  // A bundled pack chosen in the settings (UI/CLI) runs next to the customer's own rules; it is the package's, never the project's.
  const packId = selectedPack(input);
  const packDir = packId ? bundledPackRulesDir(packId) : null;
  const packRules = packDir ? listPackRuleFiles(packDir) : [];
  const packProblem = packId && packRules.length === 0 ? t("semgrep_pack_unknown", { tool: input.tool, pack: packId }) : null;
  const usePack = packId !== null && packProblem === null;
  const packLanguages = usePack ? packLanguagesOf(packRules) : [];
  const noRuleFor = usePack ? languagesWithoutPackRules(input, packLanguages) : [];
  const rulesProblem = packProblem ?? ((usePrepared || usePack) && nothingLocal ? null : unusableReason(source, input.tool));
  const root = input.componentRoot && input.componentRoot !== "." ? input.componentRoot : null;
  const configArgs = [
    ...source.files.flatMap((f) => ["--config", f.path && !governed ? `${WORKSPACE}/${f.path}` : f.abs]),
    ...(usePrepared && prepared.abs ? ["--config", prepared.abs] : []),
    ...(usePack && packDir ? ["--config", packDir] : []),
  ];
  const packFiles = usePack && packDir ? packRules.map((n) => ({ file: path.join(packDir, n), sha256: sha256Of(path.join(packDir, n)) })) : [];
  const args = [
    "scan",
    ...configArgs,
    "--metrics=off",
    "--disable-version-check",
    "--no-rewrite-rule-ids",
    // jgates ci: nosem / nosemgrep comments, .semgrepignore and .gitignore of the project are ignored.
    ...(governed ? ["--disable-nosem", "--x-ignore-semgrepignore-files", "--no-git-ignore"] : []),
    "--quiet",
    "--json",
    "--output",
    `${RUN_DIR}/outputs/${ADAPTER_ID}/${input.tool}/semgrep.json`,
    ".",
  ];
  let availability: ExternalPlan["availability"];
  let blocksPlan = false;
  if (prepared.state === "missing" || prepared.state === "corrupt") {
    // The lock pins a rule set that is no longer on disk (or was altered): never fall back to something else silently.
    availability = { status: "unavailable", reason: t(prepared.state === "missing" ? "semgrep_prepared_missing" : "semgrep_prepared_corrupt", { tool: input.tool, ref: SEMGREP_RULES_REF, file: LOCK_FILE }) };
    blocksPlan = rulesProblem !== null;
  } else if (rulesProblem) {
    // A rule set that is missing or invalid cannot be run at all: the plan itself is blocked until it is fixed.
    availability = { status: "unavailable", reason: rulesProblem };
    blocksPlan = true;
  } else if (probe.problem === "not_found") availability = { status: "unavailable", reason: t("semgrep_missing", { detail: probe.detail }) };
  else if (probe.problem === "no_answer") availability = { status: "unavailable", reason: t("semgrep_probe_failed", { path: probe.detail }) };
  else if (probe.version !== null && satisfiesRange(probe.version, semgrepManifest.toolVersionRange) !== true) {
    availability = { status: "unavailable", reason: translator("prepare")("prepare_incompatible", { tool: semgrepManifest.toolName, version: probe.version, range: semgrepManifest.toolVersionRange, what: ADAPTER_ID }) };
  } else availability = { status: "available", reason: null };
  const preparedFiles = usePrepared && lockRead.exists ? [{ file: LOCK_FILE, sha256: lockRead.sha256 }] : [];
  return {
    label: t("semgrep_label"),
    command: {
      executable: probe.executable ?? "semgrep",
      args,
      cwd: root ? `${WORKSPACE}/${root}` : WORKSPACE,
      env: scannerEnv(),
      stdin: null,
    },
    runtime: { name: "native", interpreter: probe.executable, available: probe.executable !== null && probe.version !== null },
    toolVersion: probe.version,
    configFiles: [
      ...(governed ? source.files.map((f) => ({ file: f.abs, sha256: f.sha256 })) : source.files.filter((f) => f.path !== null).map((f) => ({ file: f.path as string, sha256: f.sha256 }))),
      ...(governed ? preparedFiles.map((f) => ({ ...f, file: path.join(configDir, f.file) })) : preparedFiles),
      ...packFiles,
    ],
    availability,
    blocksPlan,
    network: false,
    limitations: noRuleFor.length > 0 ? [t("semgrep_limitation_pack_missing", { languages: noRuleFor.map(labelOf).join(", ") })] : [],
    conditions: [
      usePrepared && prepared.entry ? t("semgrep_condition_prepared", { ref: prepared.entry.ref, hash: prepared.entry.hash.slice(0, 12), source: prepared.entry.source }) : t("semgrep_condition_local"),
      ...(usePack && packId ? [t("semgrep_condition_pack", { pack: packId, count: packRules.length }), t("semgrep_condition_pack_languages", { languages: packLanguages.map((l) => packLanguageLabel(l)).join(", ") })] : []),
      ...(governed ? [translator("governed")("governed_semgrep_condition")] : []),
    ],
    output: { format: "json", schema: null },
  };
}

const relToRun = (runDir: string, p: string): string => path.relative(runDir, p).split(path.sep).join("/");

const insideAny = (roots: string[], target: string): boolean =>
  roots.some((root) => {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });

/** Copies every `--config <path>` outside the given roots (and present on the host) under `into`, and points the argument at the copy. */
function stageRules(args: string[], visible: string[], into: string): string[] {
  const out = [...args];
  let n = 0;
  for (let i = 0; i < out.length - 1; i += 1) {
    const value = out[i + 1] as string;
    if (out[i] !== "--config" || !path.isAbsolute(value) || insideAny(visible, value) || !fs.existsSync(value)) continue;
    n += 1;
    const target = path.join(into, String(n), path.basename(value));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.cpSync(value, target, { recursive: true });
    out[i + 1] = target;
  }
  return out;
}

async function runSemgrep(context: AdapterContext, plan: Plan, tool: string): Promise<AdapterOutput> {
  const t = translator("semgrep");
  const invocation = plan.invocations.find((i) => i.adapter === ADAPTER_ID && i.id === tool);
  const items = plan.groups.willRun.filter((i) => i.adapter === ADAPTER_ID && i.tool === tool);
  if (!invocation || items.length === 0) throw new Error(t("semgrep_no_invocation", { tool }));

  const tokens = { runDir: context.runDir, workspace: context.workspacePath };
  const command = invocation.command;
  const cwd = substituteTokens(command.cwd, tokens);
  let args = command.args.map((a) => substituteTokens(a, tokens));
  const env: Record<string, string> = { PATH: scannerPath(context.env.PATH) };
  for (const [name, value] of Object.entries(command.env)) env[name] = substituteTokens(value, tokens);
  const timeoutSeconds = Math.min(...items.map((i) => i.limits.timeoutSeconds));
  const version = items[0]?.versions.toolVersion ?? null;
  const ruleFiles = (items[0]?.configFiles ?? []).filter((f) => f.file !== LOCK_FILE).length;

  const outDir = path.join(context.outputsDir, ADAPTER_ID, tool);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // The folders the manifest says the scanner writes into instead of the workspace (its home).
  createOutputPaths(semgrepManifest, context.runDir);
  const outFile = path.join(outDir, "semgrep.json");
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
  if (unavailable) return blockedAll(unavailable.availability.reason ?? t("semgrep_blocked", { detail: command.executable }));

  // The step container sees the synchronized project and the run folder only: rules that live elsewhere on the host (a
  // bundled pack, the rules `tools prepare` stored, the policy's under jgates ci) are copied into the run folder first.
  const packLanguages = packLanguagesOfArgs(args);
  const pack = packRulesOfArgs(args);
  args = stageRules(args, [context.workspacePath, context.runDir], path.join(outDir, "rules"));
  // The runner streams both outputs to the log files with its size limit (JGATES_MAX_LOG_BYTES) and the process facts.
  const result = await runSpec(
    { executable: command.executable, args, cwd, env, stdin: command.stdin === null ? null : JSON.stringify(command.stdin), timeoutMs: timeoutSeconds * 1000, stdoutFile: stdoutLog, stderrFile: stderrLog },
    { parentEnv: context.env },
  );
  base.logs = [relToRun(context.runDir, stdoutLog), relToRun(context.runDir, stderrLog)];

  if (result.spawnError) return { ...blockedAll(t("semgrep_blocked", { detail: `${result.spawnError.code}: ${result.spawnError.message}` })), logs: base.logs };
  if (result.timedOut) return { ...base, stages: items.map((i) => stageFor(i, "timeout", t("semgrep_timeout", { seconds: timeoutSeconds }))), findings: [] };
  // Without --error Semgrep exits 0 whether or not it found something; any other code proves nothing.
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || String(result.signal ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "error", t("semgrep_exit_error", { code: result.exitCode ?? "-", detail }), { interpreted: false })), findings: [] };
  }
  let json: string;
  try {
    json = fs.readFileSync(outFile, "utf8");
  } catch (error) {
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("semgrep_invalid_output", { detail: (error as Error).message }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  // Semgrep prints the paths it was given: /workspace/... in the step container, the host paths inside the image.
  const view = (p: string): string => stepViewOfPaths(context.env, { workspace: context.workspacePath, runDir: context.runDir }, p);
  const parsed = parseSemgrepOutput(json, { stageId: items[0]?.id as string, version, workspace: view(context.workspacePath), cwd: view(cwd), ...(pack.rules ? { packRules: pack.rules } : {}), ...(pack.signals ? { packSignals: pack.signals } : {}), ...(pack.reviewRules ? { packReviewRules: pack.reviewRules } : {}) });
  if (!parsed.ok || result.truncated) {
    const detail = result.truncated ? "output truncated" : (parsed.problem ?? "");
    return { ...base, stages: items.map((i) => stageFor(i, "completed", t("semgrep_invalid_output", { detail }), { interpreted: false, nativeStatus: "exit 0" })), findings: [] };
  }
  const count = parsed.findings.length;
  const blocking = parsed.findings.filter((f) => f.blocking).length;
  // What the scan really covered, from the scanner's own list of scanned paths (a pack language with no file is 0).
  const scannedLanguages = parsed.scanned
    ? scannedLanguageCounts(parsed.scanned.map(view), packLanguages.flatMap((l) => (l === "javascript" ? ["javascript", "typescript"] : [l])))
    : null;
  const notScanned = scannedLanguages ? packLanguages.filter((l) => (l === "javascript" ? (scannedLanguages.javascript ?? 0) + (scannedLanguages.typescript ?? 0) : (scannedLanguages[l] ?? 0)) === 0) : [];
  const completedReason = t("semgrep_reason_completed", { version: version ?? "?", count, rules: ruleFiles });
  const reason = notScanned.length > 0 ? `${completedReason}. ${t("semgrep_reason_scanned_none", { languages: notScanned.map((l) => packLanguageLabel(l)).join(", "), count: notScanned.length })}` : completedReason;
  return {
    ...base,
    stages: items.map((i) =>
      stageFor(i, "completed", reason, {
        blockingViolations: blocking,
        findings: count,
        nativeStatus: "exit 0",
        ...(scannedLanguages ? { scannedLanguages } : {}),
        // Which technologies the signal rules of the pack matched (tag to matches): a record of the scan, never findings.
        ...(parsed.signals ? { signals: parsed.signals } : {}),
      }),
    ),
    findings: parsed.findings,
  };
}

export const semgrepAdapter: ExternalAdapter = {
  manifest: semgrepManifest,
  plan: planSemgrep,
  run: runSemgrep,
};
