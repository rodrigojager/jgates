import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { BuiltinError } from "../../builtin/index.js";
import { resolveHome } from "../../core/home/index.js";
import { buildPlan, saveLastPlan, writePlanFile, type Plan, type PlanItem, type PlanScopeKind } from "../../core/plan/index.js";

const tr = translator("plan");

/** Every value of a repeatable flag (falls back to the single value when the parser gave no list). */
function many(ctx: CommandContext, name: string): string[] {
  const list = ctx.lists?.[name];
  if (list && list.length > 0) return [...list];
  const one = ctx.options[name];
  return typeof one === "string" ? [one] : [];
}

const str = (ctx: CommandContext, name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);

function printText(ctx: CommandContext, plan: Plan, savedTo: string, outFile: string | null): void {
  const t = tr;
  ctx.stdout(t("plan_text_header", { hash: plan.planHash, profile: plan.profile?.id ?? "-", scope: plan.scope.requested }) + "\n");
  const line = (i: PlanItem): string =>
    t("plan_text_item", { id: i.id, requirement: i.requirement, reason: i.reason.message, origin: i.state.originLabel }) + "\n";
  ctx.stdout(t("plan_text_group_will_run", { count: plan.groups.willRun.length }) + "\n");
  if (plan.groups.willRun.length === 0) ctx.stdout(t("plan_text_none") + "\n");
  for (const i of plan.groups.willRun) {
    ctx.stdout(line(i));
    // The flags the sidecar really uses for a scanner whose configuration file can be chosen.
    const effective = i.bridge?.effectiveCommand;
    if (effective) {
      ctx.stdout(
        t("plan_text_effective_command", {
          command: [effective.executable, ...effective.args].join(" "),
          file: effective.config.file,
          source: t(`plan_text_config_source_${effective.config.source}`),
        }) + "\n",
      );
    }
  }
  ctx.stdout(t("plan_text_group_disabled", { count: plan.groups.notApplicableOrDisabled.length }) + "\n");
  if (plan.groups.notApplicableOrDisabled.length === 0) ctx.stdout(t("plan_text_none") + "\n");
  for (const i of plan.groups.notApplicableOrDisabled) ctx.stdout(line(i));
  // The third group is always printed, even when empty: it never hides behind a green count.
  ctx.stdout(t("plan_text_group_uncovered", { count: plan.groups.uncoveredRequirements.length }) + "\n");
  if (plan.groups.uncoveredRequirements.length === 0) ctx.stdout(t("plan_text_none") + "\n");
  for (const u of plan.groups.uncoveredRequirements) ctx.stdout(t("plan_text_uncovered_item", { selector: u.selector, message: u.message }) + "\n");
  for (const inc of plan.incompatibilities) ctx.stdout(t("plan_text_incompat", { message: inc.message }) + "\n");
  for (const w of plan.warnings) ctx.stdout(t("plan_text_warning", { code: w.code, message: w.message }) + "\n");
  if (plan.selection.reduced) ctx.stdout(t("plan_text_reduced") + "\n");
  if (plan.changes === null) ctx.stdout(t("plan_text_no_previous") + "\n");
  else if (plan.changes.same) ctx.stdout(t("plan_text_same") + "\n");
  else {
    const c = plan.changes;
    ctx.stdout(
      t("plan_text_changes", {
        added: c.items.added.length,
        removed: c.items.removed.length,
        changed: c.items.changed.length,
        files: c.configFiles.added.length + c.configFiles.removed.length + c.configFiles.changed.length,
      }) + "\n",
    );
  }
  if (plan.blocked) ctx.stdout(t("plan_text_blocked", { code: plan.blocked.code, message: plan.blocked.message }) + "\n");
  else if (!plan.approvable) ctx.stdout(t("plan_text_not_approvable", { reasons: plan.blockers.map((b) => b.message).join(" ") }) + "\n");
  ctx.stdout(t("plan_text_saved", { path: savedTo }) + "\n");
  if (outFile) ctx.stdout(t("plan_text_out", { path: outFile }) + "\n");
}

export const command: CommandModule = {
  name: "plan",
  description: tr("plan_description"),
  options: [
    { name: "cwd", type: "string", description: tr("plan_option_cwd") },
    { name: "profile", type: "string", description: tr("plan_option_profile") },
    { name: "scope", type: "string", description: tr("plan_option_scope") },
    { name: "path", type: "string", description: tr("plan_option_path") },
    { name: "base", type: "string", description: tr("plan_option_base") },
    { name: "head", type: "string", description: tr("plan_option_head") },
    { name: "skip", type: "string", description: tr("plan_option_skip") },
    { name: "only", type: "string", description: tr("plan_option_only") },
    { name: "template", type: "string", description: tr("plan_option_template") },
    { name: "out", type: "string", description: tr("plan_option_out") },
    { name: "no-interactive", type: "boolean", description: tr("plan_option_no_interactive") },
  ],
  run(ctx) {
    const t = tr;
    const usage = (code: string, key: string, params: Record<string, string> = {}) =>
      reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);

    const extra = ctx.args[0];
    if (extra !== undefined) return usage("UNEXPECTED_ARGUMENT", "plan_unexpected_argument", { name: extra });
    const projectDir = path.resolve(str(ctx, "cwd") ?? process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(projectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return usage("BAD_CWD", "plan_bad_cwd", { path: projectDir });

    const profile = str(ctx, "profile");
    const scope = str(ctx, "scope");
    const base = str(ctx, "base");
    const head = str(ctx, "head");
    let result;
    try {
      result = buildPlan(projectDir, {
        ...(profile !== undefined ? { profile } : {}),
        ...(scope !== undefined ? { scope: scope as PlanScopeKind } : {}),
        ...(base !== undefined ? { base } : {}),
        ...(head !== undefined ? { head } : {}),
        paths: many(ctx, "path"),
        skip: many(ctx, "skip"),
        only: many(ctx, "only"),
        templates: many(ctx, "template"),
        version: ctx.version,
      });
    } catch (error) {
      if (error instanceof BuiltinError) return reportError(ctx, ctx.json, "BUILTIN_INVALID", error.message, null, 4);
      throw error;
    }
    if (!result.ok) {
      const { code, message, fix } = result.error;
      if (ctx.json) writeJson(ctx, { ...errorPayload(code, message, fix ?? null, EXIT_USAGE), projectDir, errors: result.errors, diagnostics: result.diagnostics });
      else {
        ctx.stderr(`ERROR ${code}\n${message}\n${fix ?? ""}\n`);
        for (const e of result.errors.slice(1)) ctx.stderr(`- ${e.message}\n`);
      }
      return EXIT_USAGE;
    }

    const plan = result.plan;
    const savedTo = saveLastPlan(plan, resolveHome());
    let outFile: string | null = null;
    const out = str(ctx, "out");
    if (out !== undefined) {
      try {
        outFile = writePlanFile(plan, out);
      } catch (error) {
        return usage("OUT_FAILED", "plan_out_failed", { path: path.resolve(out), detail: error instanceof Error ? error.message : String(error) });
      }
    }

    const exitCode = plan.blocked ? EXIT_USAGE : 0;
    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: plan.blocked ? "BLOCKED" : "OK",
        tool: "jgates",
        version: ctx.version,
        exitCode,
        projectDir,
        planHash: plan.planHash,
        approvable: plan.approvable,
        reduced: plan.selection.reduced,
        ...(plan.blocked
          ? { code: plan.blocked.code, error: { code: plan.blocked.code, message: plan.blocked.message, fix: t("plan_blocked_fix") } }
          : {}),
        savedTo,
        outFile,
        plan,
      });
    } else printText(ctx, plan, savedTo, outFile);
    return exitCode;
  },
};
