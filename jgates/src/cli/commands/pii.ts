// jgates pii check | fix: personal data in the project files (D8). check detects and changes nothing; fix corrects
// only through the tools of .jgates/pii.yml (fix.tools), shows what would change, asks (or --yes) and keeps the
// originals for --undo. No value found is ever written to the output, a log or the result; only --diff shows the
// change, on the terminal.
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { unifiedDiff } from "../../core/documents/diff.js";
import { isYes, lineTerminal } from "../../core/install/index.js";
import { applyFix, checkPii, FIX_ID, PiiCommandError, prepareFix, undoFix, type LeftOut, type PiiScopeInput } from "../../core/pii-fix/index.js";

const t = translator("pii");

const ERROR_KEYS: Record<string, string> = {
  CONFIG_INVALID: "pii_cmd_config_invalid",
  NOT_A_GIT_REPOSITORY: "pii_cmd_not_git",
  GIT_FAILED: "pii_cmd_git_failed",
  PATH_OUTSIDE_PROJECT: "pii_cmd_path_outside",
  PATH_NOT_FOUND: "pii_cmd_path_missing",
  NO_FIX_TOOL: "pii_cmd_no_tool",
  NOTHING_TO_UNDO: "pii_cmd_nothing_to_undo",
};

const formatCounts = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, n]) => `${label} ${n}`)
    .join(", ") || "-";

function leftOutLines(ctx: CommandContext, skipped: readonly LeftOut[], refused: readonly LeftOut[]): void {
  for (const s of refused) ctx.stdout(t("pii_cmd_text_refused", { path: s.path, reason: s.reason }) + "\n");
  for (const s of skipped) ctx.stdout(t("pii_cmd_text_skipped", { path: s.path, reason: s.reason }) + "\n");
}

function canAsk(ctx: CommandContext): boolean {
  return !ctx.json && process.stdin.isTTY === true;
}

async function confirm(question: string): Promise<boolean> {
  const terminal = lineTerminal(process.stdin, process.stderr, true);
  try {
    return isYes(await terminal.ask(question));
  } finally {
    terminal.close();
  }
}

function header(ctx: CommandContext, action: string): Record<string, unknown> {
  return { schemaVersion: 1, tool: "jgates", version: ctx.version, command: `pii ${action}` };
}

async function runCheck(ctx: CommandContext, projectDir: string, scope: PiiScopeInput): Promise<number> {
  const r = await checkPii({ projectDir, scope });
  const status = r.decision === "passed" ? "OK" : r.decision === "failed" ? "FINDINGS" : "INCOMPLETE";
  if (ctx.json) {
    writeJson(ctx, { ...header(ctx, "check"), status, decision: r.decision, exitCode: r.exitCode, scope: { kind: r.scope, files: r.scanned }, counts: r.counts, files: r.files, detectors: r.detectors, skipped: r.skipped, refused: r.refused });
    return r.exitCode;
  }
  ctx.stdout(t("pii_cmd_text_scope", { kind: r.scope, count: r.scanned }) + "\n");
  if (r.decision === "failed") {
    ctx.stdout(t("pii_cmd_text_found", { count: r.files.length }) + "\n");
    for (const f of r.files) ctx.stdout(t("pii_cmd_text_file", { path: f.path, counts: Object.keys(f.counts).length > 0 ? formatCounts(f.counts) : f.detectors.join(", ") }) + "\n");
    ctx.stdout(t("pii_cmd_text_counts", { counts: formatCounts(r.counts) }) + "\n");
  }
  for (const d of r.detectors) if (d.state !== "completed" && d.state !== "disabled") ctx.stdout(t("pii_cmd_text_detector_failed", { id: d.id, reason: d.reason ?? d.state }) + "\n");
  leftOutLines(ctx, r.skipped, r.refused);
  if (r.decision === "passed") ctx.stdout(t("pii_cmd_text_clean") + "\n");
  else if (r.decision === "incomplete") ctx.stdout(t("pii_cmd_text_incomplete") + "\n");
  else ctx.stdout(t("pii_cmd_text_fix_hint") + "\n");
  return r.exitCode;
}

async function runFix(ctx: CommandContext, projectDir: string, scope: PiiScopeInput): Promise<number> {
  const dry = ctx.options["dry-run"] === true;
  const yes = ctx.options.yes === true;
  const prep = await prepareFix({ projectDir, scope });
  const base = {
    ...header(ctx, "fix"),
    scope: { kind: prep.scope, files: prep.scanned },
    counts: prep.counts,
    tools: prep.tools,
    changes: prep.changes.map((c) => ({ path: c.path })),
    skipped: prep.skipped,
    refused: prep.refused,
  };
  const textSummary = (): void => {
    ctx.stdout(t("pii_cmd_text_scope", { kind: prep.scope, count: prep.scanned }) + "\n");
    if (prep.changes.length === 0) ctx.stdout(t("pii_cmd_text_fix_nothing") + "\n");
    else {
      ctx.stdout(t("pii_cmd_text_fix_would", { count: prep.changes.length }) + "\n");
      for (const c of prep.changes) ctx.stdout(t("pii_cmd_text_fix_file", { path: c.path }) + "\n");
      ctx.stdout(t("pii_cmd_text_counts", { counts: formatCounts(prep.counts) }) + "\n");
    }
    leftOutLines(ctx, prep.skipped, prep.refused);
  };

  if (prep.failure) {
    if (ctx.json) writeJson(ctx, { ...base, status: "FAILED", mode: "failed", exitCode: 2, failure: prep.failure, changes: [], applied: [] });
    else {
      ctx.stdout(t("pii_cmd_text_scope", { kind: prep.scope, count: prep.scanned }) + "\n");
      ctx.stdout(t("pii_cmd_text_tool_failed", { code: prep.failure.code, reason: prep.failure.reason }) + "\n");
    }
    return 2;
  }
  const pendingExit = prep.changes.length > 0 || prep.refused.length > 0 ? 1 : 0;
  const finish = (mode: string, status: string, exitCode: number, textKey: string | null): number => {
    if (ctx.json) writeJson(ctx, { ...base, status, mode, exitCode, applied: [] });
    else {
      textSummary();
      if (textKey) ctx.stdout(t(textKey) + "\n");
    }
    return exitCode;
  };
  if (prep.changes.length === 0) return finish("nothing", pendingExit === 0 ? "OK" : "REFUSED", pendingExit, null);
  if (!ctx.json && ctx.options.diff === true) {
    for (const c of prep.changes) ctx.stdout(unifiedDiff(c.before.toString("utf8"), c.after.toString("utf8"), { oldLabel: `a/${c.path}`, newLabel: `b/${c.path}` }) + "\n");
  }
  if (dry) return finish("dry-run", "PREVIEW", 1, "pii_cmd_text_dry_run");
  if (!yes) {
    if (!canAsk(ctx)) return finish("pending", "PENDING", 1, "pii_cmd_text_needs_yes");
    textSummary();
    if (!(await confirm(t("pii_cmd_text_confirm", { count: prep.changes.length })))) {
      ctx.stdout(t("pii_cmd_text_declined") + "\n");
      return 1;
    }
  }

  const applied = applyFix(prep);
  const exitCode = applied.skipped.length > 0 || prep.refused.length > 0 || applied.stageError ? 1 : 0;
  if (ctx.json) {
    writeJson(ctx, {
      ...base,
      status: exitCode === 0 ? "APPLIED" : "PARTIAL",
      mode: "applied",
      exitCode,
      applied: applied.applied,
      skipped: [...prep.skipped, ...applied.skipped],
      fixId: applied.fixId,
      expiresAt: applied.expiresAt,
      staged: prep.scope === "staged",
      ...(applied.stageError ? { stageError: applied.stageError } : {}),
    });
    return exitCode;
  }
  if (yes) textSummary();
  if (applied.fixId) ctx.stdout(t("pii_cmd_text_applied", { count: applied.applied.length, expires: applied.expiresAt ?? "-", id: applied.fixId }) + "\n");
  for (const s of applied.skipped) ctx.stdout(t("pii_cmd_text_not_applied", { path: s.path, reason: s.reason }) + "\n");
  if (prep.scope === "staged" && applied.applied.length > 0) ctx.stdout(t(applied.stageError ? "pii_cmd_text_stage_failed" : "pii_cmd_text_staged_again", { detail: applied.stageError ?? "" }) + "\n");
  if (applied.applied.length > 0) ctx.stdout(t("pii_cmd_text_history") + "\n");
  return exitCode;
}

function runUndo(ctx: CommandContext, projectDir: string, fixId: string | undefined): number {
  const r = undoFix({ projectDir, ...(fixId ? { fixId } : {}) });
  const exitCode = r.skipped.length > 0 || r.stageError ? 1 : 0;
  if (ctx.json) {
    writeJson(ctx, { ...header(ctx, "fix --undo"), status: exitCode === 0 ? "RESTORED" : "PARTIAL", exitCode, fixId: r.fixId, restored: r.restored, skipped: r.skipped, originalsDeleted: r.removed, ...(r.stageError ? { stageError: r.stageError } : {}) });
    return exitCode;
  }
  ctx.stdout(t("pii_cmd_text_undo_done", { count: r.restored.length, id: r.fixId }) + "\n");
  for (const s of r.skipped) ctx.stdout(t("pii_cmd_text_not_restored", { path: s.path, reason: s.reason }) + "\n");
  if (r.stageError) ctx.stdout(t("pii_cmd_text_stage_failed", { detail: r.stageError }) + "\n");
  return exitCode;
}

export const command: CommandModule = {
  name: "pii",
  description: t("pii_cmd_description"),
  options: [
    { name: "cwd", type: "string", description: t("pii_cmd_option_cwd") },
    { name: "staged", type: "boolean", description: t("pii_cmd_option_staged") },
    { name: "changed", type: "boolean", description: t("pii_cmd_option_changed") },
    { name: "all", type: "boolean", description: t("pii_cmd_option_all") },
    { name: "dry-run", type: "boolean", description: t("pii_cmd_option_dry_run") },
    { name: "diff", type: "boolean", description: t("pii_cmd_option_diff") },
    { name: "yes", type: "boolean", description: t("pii_cmd_option_yes") },
    { name: "undo", type: "boolean", description: t("pii_cmd_option_undo") },
  ],
  async run(ctx) {
    const usage = (code: string, key: string, params: Record<string, string> = {}, fixKey = "pii_cmd_usage_fix"): number =>
      reportError(ctx, ctx.json, code, t(key, params), t(fixKey), EXIT_USAGE);
    const [action, ...rest] = ctx.args;
    if (action !== "check" && action !== "fix") return usage("UNKNOWN_ACTION", "pii_cmd_unknown_action", { name: action ?? "" });

    const projectDir = path.resolve(typeof ctx.options.cwd === "string" ? ctx.options.cwd : process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(projectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return usage("BAD_CWD", "pii_cmd_bad_cwd", { path: projectDir });

    const fixOnly = ["dry-run", "diff", "yes", "undo"].filter((name) => ctx.options[name] === true);
    if (action === "check" && fixOnly.length > 0) return usage("FIX_ONLY_OPTION", "pii_cmd_fix_only_option", { name: `--${fixOnly[0]}` });
    const undo = ctx.options.undo === true;
    const scopeFlags = (["staged", "changed", "all"] as const).filter((name) => ctx.options[name] === true);

    try {
      if (undo) {
        if (scopeFlags.length > 0 || rest.length > 1 || fixOnly.length > 1) return usage("UNDO_WITH_OPTIONS", "pii_cmd_undo_with_options");
        if (rest[0] !== undefined && !FIX_ID.test(rest[0])) return usage("BAD_FIX_ID", "pii_cmd_bad_fix_id", { id: rest[0] });
        return runUndo(ctx, projectDir, rest[0]);
      }
      if (scopeFlags.length + (rest.length > 0 ? 1 : 0) > 1) return usage("SCOPE_CONFLICT", "pii_cmd_scope_conflict");
      if (ctx.options["dry-run"] === true && ctx.options.yes === true) return usage("DRY_RUN_WITH_YES", "pii_cmd_dry_and_yes");
      if (ctx.json && ctx.options.diff === true) return usage("DIFF_WITH_JSON", "pii_cmd_diff_json");
      const scope: PiiScopeInput = { kind: scopeFlags[0] ?? (rest.length > 0 ? "paths" : "default"), paths: rest };
      return action === "check" ? await runCheck(ctx, projectDir, scope) : await runFix(ctx, projectDir, scope);
    } catch (error) {
      if (!(error instanceof PiiCommandError)) throw error;
      const key = error.code === "NOTHING_TO_UNDO" && error.detail !== "" ? "pii_cmd_fix_not_found" : (ERROR_KEYS[error.code] ?? "pii_cmd_git_failed");
      return reportError(ctx, ctx.json, error.code, t(key, { detail: error.detail, path: error.detail, id: error.detail }), t(`${key}_fix`), error.exitCode);
    }
  },
};
