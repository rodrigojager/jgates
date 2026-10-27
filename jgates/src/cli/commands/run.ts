import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator, type Translator } from "../../i18n/index.js";
import { executeRun, isLegacyPlan, legacyPlan, legacySteps, validateLegacyPlan, type RunOptions, type RunResult } from "../../core/run/index.js";
import { planDisabled, planSteps } from "../../core/run/plan-run.js";
import { SnapshotError } from "../../core/snapshot/index.js";
import type { RunEvent } from "../../core/events/index.js";
import { semanticHook } from "../../adapters/semantic-gate/index.js";
import { ADAPTER_ID, selectionFromOptions } from "../../adapters/quality-bridge/index.js";
import { BuiltinError } from "../../builtin/index.js";
import { ROOT_FILE } from "../../core/config/load/index.js";
import { encodePointer, resolveConfig } from "../../core/config/resolve/index.js";
import { loadWaiverFile, parseWaiverFlag, WAIVERS_FILE, type Waiver } from "../../core/results/index.js";
import { assessEnvironment, lineTerminal, NO_TERMINAL, isYes, offerInstall, type InstallExecutor, type InstallTerminal } from "../../core/install/index.js";
import { buildPlan, readPlanFile, validatePlanAgainstWorkspace, type Plan, type PlanScopeKind } from "../../core/plan/index.js";

function summarize(t: Translator, r: RunResult): string {
  const notes = r.analyzed?.stale ? t("run_summary_stale") : r.analyzed?.dirty === true ? t("run_summary_dirty") : "";
  return decisionSummary(t, r) + notes;
}

function decisionSummary(t: Translator, r: RunResult): string {
  const missing = r.unsatisfied.length;
  switch (r.decision) {
    case "passed":
      return r.reduced ? t("run_summary_passed_reduced", { count: r.disabled.filter((d) => d.origin === "run").length }) : t("run_summary_passed");
    case "failed":
      return r.complete
        ? t("run_summary_failed", { count: r.blockingViolations })
        : t("run_summary_failed_incomplete", { count: r.blockingViolations, missing });
    case "incomplete":
      return t("run_summary_incomplete", { count: missing });
    default:
      return t("run_summary_other", { decision: r.decision });
  }
}

/** Flags that describe the plan (a plan received with --plan already carries them). */
const PLAN_OPTIONS = ["profile", "scope", "path", "base", "head", "skip", "only", "template"] as const;
/** Flags of the option-driven bridge run (valid only while the project has no JGates configuration). */
const LEGACY_OPTIONS = ["bridge-mode", "enable-pii", "enable-secrets", "disable-iac", "run-project-tests", "enable-coverage"] as const;

function many(ctx: CommandContext, name: string): string[] {
  const list = ctx.lists?.[name];
  if (list && list.length > 0) return [...list];
  const one = ctx.options[name];
  return typeof one === "string" ? [one] : [];
}

const str = (ctx: CommandContext, name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Progress for people goes to stderr, only without --json (the JSON on stdout stays the one document). */
function progressLine(event: RunEvent): string | null {
  const d = event.data;
  switch (event.type) {
    case "step-started":
      return `> ${String(d.step)}`;
    case "step-finished":
      return `< ${String(d.step)} ${String(d.status)} (${String(d.durationMs)} ms)`;
    case "step-skipped":
      return `- ${String(d.step)} ${String(d.cause)}`;
    case "cancel-requested":
      return `! ${tr("run_cancel_requested")}`;
    default:
      return null;
  }
}

/** `execution.failFast` of the configuration (Configuração > Execução): the run behaves as if --fail-fast had been passed. */
function configuredFailFast(workspacePath: string): boolean {
  try {
    return resolveConfig(workspacePath).fields[encodePointer(["execution", "failFast"])]?.value === true;
  } catch {
    // A configuration that cannot be resolved is reported by the run itself; the flag alone decides here.
    return false;
  }
}

/** The run controls every run of this command shares: cancellation, --fail-fast, --events-jsonl and the progress lines. */
function runControls(ctx: CommandContext, signal: AbortSignal, failFast: boolean, eventsFile: string | undefined) {
  return {
    signal,
    failFast,
    ownsProcess: true,
    ...(eventsFile !== undefined ? { eventsFile } : {}),
    ...(ctx.json
      ? {}
      : {
          onEvent: (event: RunEvent) => {
            const line = progressLine(event);
            if (line) ctx.stderr(`${line}\n`);
          },
        }),
  };
}

/**
 * Runs with Ctrl+C (SIGINT), SIGTERM (the server's cancel) and SIGHUP turned into a cancellation of the run: the
 * running process tree is stopped, the partial result is written and the run exits with 130. A second signal while
 * the run is stopping exits at once with 130.
 */
async function withCancellation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (name: NodeJS.Signals): void => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort(name);
  };
  for (const name of signals) process.on(name, onSignal);
  try {
    return await work(controller.signal);
  } finally {
    for (const name of signals) process.off(name, onSignal);
  }
}

// Descriptions resolved from the "run" catalog at load time: help shows plain text as is.
const tr = translator("run");

export const command: CommandModule = {
  name: "run",
  description: tr("run_description"),
  options: [
    { name: "cwd", type: "string", description: tr("run_option_cwd") },
    { name: "profile", type: "string", description: tr("run_option_profile") },
    { name: "scope", type: "string", description: tr("run_option_scope") },
    { name: "path", type: "string", description: tr("run_option_path") },
    { name: "base", type: "string", description: tr("run_option_base") },
    { name: "head", type: "string", description: tr("run_option_head") },
    { name: "skip", type: "string", description: tr("run_option_skip") },
    { name: "only", type: "string", description: tr("run_option_only") },
    { name: "template", type: "string", description: tr("run_option_template") },
    { name: "plan", type: "string", description: tr("run_option_plan") },
    { name: "bridge-mode", type: "string", description: tr("run_option_bridge_mode") },
    { name: "enable-pii", type: "boolean", description: tr("run_option_enable_pii") },
    { name: "enable-secrets", type: "boolean", description: tr("run_option_enable_secrets") },
    { name: "disable-iac", type: "boolean", description: tr("run_option_disable_iac") },
    { name: "run-project-tests", type: "boolean", description: tr("run_option_run_project_tests") },
    { name: "enable-coverage", type: "boolean", description: tr("run_option_enable_coverage") },
    { name: "semantic", type: "boolean", description: tr("run_option_semantic") },
    { name: "no-cache", type: "boolean", description: tr("run_option_no_cache") },
    { name: "waiver", type: "string", description: tr("run_option_waiver") },
    { name: "fail-fast", type: "boolean", description: tr("run_option_fail_fast") },
    { name: "events-jsonl", type: "string", description: tr("run_option_events_jsonl") },
    { name: "ci", type: "boolean", description: tr("run_option_ci") },
    { name: "no-interactive", type: "boolean", description: tr("run_option_no_interactive") },
  ],
  async run(ctx) {
    // A run that ended for lack of a tool offers to install it and, when it did, to run again (D7).
    for (;;) {
      const holder: { result: RunResult | null } = { result: null };
      const code = await runOnce(ctx, holder);
      if (holder.result === null) return code;
      const workspace = path.resolve(str(ctx, "cwd") ?? process.cwd());
      if (!(await offerAfterMissingTools(ctx, holder.result, workspace))) return code;
    }
  },
};

/** Test seam: replaces the terminal, the executor of the recipes and the environment of the offer after a run. */
export const installHooks: { terminal?: InstallTerminal & { close?: () => void }; executor?: InstallExecutor; env?: NodeJS.ProcessEnv } = {};

/** Whether the run may ask: a TTY, and neither --json, --ci nor --no-interactive. */
function canAsk(ctx: CommandContext): boolean {
  return !ctx.json && ctx.options.ci !== true && ctx.options["no-interactive"] !== true && process.stdin.isTTY === true;
}

/**
 * When the run left a stage blocked and something it needs is missing: on a terminal, lists it, offers the recipes of
 * `jgates doctor` and, after installing, asks whether to run again (returns true). Anywhere else it asks nothing and
 * only points to `jgates doctor --fix`. The exit code of the run is never changed here.
 */
async function offerAfterMissingTools(ctx: CommandContext, result: RunResult, workspacePath: string): Promise<boolean> {
  if (!result.stages.some((s) => s.state === "blocked")) return false;
  const env = installHooks.env ?? process.env;
  let assessment;
  try {
    assessment = assessEnvironment(workspacePath, { env });
  } catch {
    return false;
  }
  if (!assessment.items.some((i) => i.missing && i.classification !== "unused")) return false;
  const t = tr;
  const terminal: InstallTerminal & { close?: () => void } = installHooks.terminal ?? (canAsk(ctx) ? lineTerminal(process.stdin, process.stderr, true) : NO_TERMINAL);
  try {
    if (!terminal.interactive) {
      ctx.stderr(`${t("run_install_hint")}\n`);
      return false;
    }
    const session = await offerInstall(assessment, {
      fix: true,
      yes: false,
      includeOptional: false,
      terminal,
      out: (text) => ctx.stderr(text),
      env,
      ...(installHooks.executor ? { executor: installHooks.executor } : {}),
    });
    if (!session.ran || session.failed) return false;
    return isYes(await terminal.ask(t("run_install_again")));
  } finally {
    terminal.close?.();
  }
}

async function runOnce(ctx: CommandContext, holder: { result: RunResult | null }): Promise<number> {
  {
    const t = tr;
    const usage = (code: string, key: string, params: Record<string, string> = {}) =>
      reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);

    const extra = ctx.args[0];
    if (extra !== undefined) return usage("UNEXPECTED_ARGUMENT", "run_unexpected_argument", { name: extra });
    const workspacePath = path.resolve(str(ctx, "cwd") ?? process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(workspacePath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return usage("BAD_CWD", "run_bad_cwd", { path: workspacePath });

    const eventsOption = str(ctx, "events-jsonl");
    const eventsFile = eventsOption !== undefined ? path.resolve(eventsOption) : undefined;
    if (eventsFile !== undefined && !isDirectory(path.dirname(eventsFile))) return usage("BAD_EVENTS_PATH", "run_bad_events_path", { path: eventsFile });
    const failFast = ctx.options["fail-fast"] === true || configuredFailFast(workspacePath);

    // Waivers of the call come on top of .jgates/waivers.json; a spec that cannot be read stops the run before it starts.
    const flagWaivers: Waiver[] = [];
    for (const spec of many(ctx, "waiver")) {
      const parsed = parseWaiverFlag(spec);
      if (!("waiver" in parsed)) return usage("BAD_WAIVER", "run_bad_waiver", { spec, problem: parsed.problem });
      flagWaivers.push(parsed.waiver);
    }
    const noCache = ctx.options["no-cache"] === true;
    // The semantic gate is an optional integration: only this flag asks for it, never a profile or a template.
    const semantic = semanticHook(ctx.options.semantic === true);
    const waiverFile = loadWaiverFile(path.join(workspacePath, WAIVERS_FILE));
    const waivers = flagWaivers.length > 0 ? [...waiverFile.waivers, ...flagWaivers] : undefined;

    const planFile = str(ctx, "plan");
    const planFlags = PLAN_OPTIONS.filter((name) => ctx.options[name] !== undefined);
    const legacyFlags = LEGACY_OPTIONS.filter((name) => ctx.options[name] !== undefined);
    const plannedRun = planFile !== undefined || planFlags.length > 0 || fs.existsSync(path.join(workspacePath, ROOT_FILE));

    // A commit that cannot be written as a snapshot stops the run before anything starts (no run is left).
    const execute = async (options: RunOptions): Promise<RunResult | number> => {
      try {
        return await withCancellation((signal) => executeRun({ ...options, ...(noCache ? { cache: false } : {}), ...(semantic ? { semantic } : {}), ...(waivers ? { waivers } : {}), ...runControls(ctx, signal, failFast, eventsFile) }));
      } catch (error) {
        if (!(error instanceof SnapshotError)) throw error;
        const commit = options.plan?.scope.head ?? "-";
        return reportError(ctx, ctx.json, error.code, t("run_snapshot_failed", { commit, detail: error.message }), t("run_snapshot_failed_fix"), EXIT_USAGE);
      }
    };

    let outcome: RunResult | number;
    if (!plannedRun) {
      // No JGates configuration and no plan flag: the option flags become an equivalent plan, which the run
      // writes to plan.json and executes; the bridge request and the requirement table are those of the option-driven run.
      const selection = selectionFromOptions(ctx.options);
      if ("kind" in selection) {
        return usage("INVALID_VALUE", "run_invalid_value", { name: selection.name, value: selection.value, allowed: selection.allowed });
      }
      const options: Record<string, string | boolean> = { bridgeMode: selection.mode };
      for (const key of ["pii", "secrets", "iac", "projectTests", "coverage"] as const) options[key] = selection[key];
      if (failFast) options.failFast = true;
      const plan = legacyPlan(workspacePath, selection, { version: ctx.version });
      options.planHash = plan.planHash;
      options.planSource = "options";
      outcome = await execute({
        workspacePath,
        version: ctx.version,
        adapter: ADAPTER_ID,
        options,
        selection: {
          planHash: plan.planHash,
          planSource: "options",
          profile: null,
          scope: plan.scope.requested,
          request: plan.selection.request as unknown as Record<string, unknown>,
          planOverrides: [],
        },
        runFiles: { "plan.json": `${JSON.stringify(plan, null, 2)}\n` },
        plan,
        steps: (context) => legacySteps(context, plan),
        summarize: (r) => summarize(t, r),
      });
    } else {
      // The run executes exactly one plan: the one assembled now or the one received with --plan.
      if (legacyFlags.length > 0) return usage("OPTION_NOT_SUPPORTED", "run_legacy_option_with_plan", { name: `--${legacyFlags[0]}` });
      if (planFile !== undefined && planFlags.length > 0) return usage("PLAN_WITH_FLAGS", "run_plan_with_flags", { name: `--${planFlags[0]}` });

      let plan: Plan;
      let source: "built" | "file" = "built";
      if (planFile !== undefined) {
        source = "file";
        let doc: unknown;
        try {
          doc = readPlanFile(planFile);
        } catch (error) {
          return usage("PLAN_UNREADABLE", "run_plan_unreadable", { path: path.resolve(planFile), detail: error instanceof Error ? error.message : String(error) });
        }
        const check = validateLegacyPlan(doc, workspacePath, { version: ctx.version }) ?? validatePlanAgainstWorkspace(doc, workspacePath, { version: ctx.version });
        if (!check.ok) {
          const code = check.code ?? "PLAN_INVALID";
          if (ctx.json) {
            writeJson(ctx, { ...errorPayload(code, check.message ?? code, check.fix, EXIT_USAGE), executed: false, problems: check.problems, changes: check.changes });
          } else {
            ctx.stderr(`ERROR ${code}\n${check.message ?? ""}\n${check.fix ?? ""}\n`);
            for (const p of check.problems) ctx.stderr(`- ${p}\n`);
          }
          return EXIT_USAGE;
        }
        plan = doc as Plan;
      } else {
        const profile = str(ctx, "profile");
        const scope = str(ctx, "scope");
        const base = str(ctx, "base");
        const head = str(ctx, "head");
        let built;
        try {
          built = buildPlan(workspacePath, {
            ...(profile !== undefined ? { profile } : {}),
            ...(scope !== undefined ? { scope: scope as PlanScopeKind } : {}),
            ...(base !== undefined ? { base } : {}),
            ...(head !== undefined ? { head } : {}),
            paths: many(ctx, "path"),
            skip: many(ctx, "skip"),
            only: many(ctx, "only"),
            templates: many(ctx, "template"),
            version: ctx.version,
            compare: false,
          });
        } catch (error) {
          if (error instanceof BuiltinError) return reportError(ctx, ctx.json, "BUILTIN_INVALID", error.message, null, 4);
          throw error;
        }
        if (!built.ok) {
          const { code, message, fix } = built.error;
          if (ctx.json) writeJson(ctx, { ...errorPayload(code, message, fix ?? null, EXIT_USAGE), executed: false, errors: built.errors, diagnostics: built.diagnostics });
          else {
            ctx.stderr(`ERROR ${code}\n${message}\n${fix ?? ""}\n`);
            for (const e of built.errors.slice(1)) ctx.stderr(`- ${e.message}\n`);
          }
          return EXIT_USAGE;
        }
        plan = built.plan;
      }

      // A plan that cannot be approved (empty, uncovered requirement, tool unavailable) never runs.
      if (plan.blocked || !plan.approvable) {
        const blockers = plan.blocked ? [plan.blocked, ...plan.blockers] : plan.blockers;
        const code = "PLAN_NOT_APPROVABLE";
        const message = t("run_plan_not_approvable", { code: blockers[0]?.code ?? "-", detail: blockers.map((b) => b.message).join(" ") });
        const fix = t("run_plan_not_approvable_fix");
        if (ctx.json) writeJson(ctx, { ...errorPayload(code, message, fix, EXIT_USAGE), executed: false, blockers });
        else ctx.stderr(`ERROR ${code}\n${message}\n${fix}\n`);
        return EXIT_USAGE;
      }

      const request = plan.selection.request;
      const reviewed = plan;
      outcome = await execute({
        workspacePath,
        version: ctx.version,
        adapter: ADAPTER_ID,
        options: { planHash: plan.planHash, planSource: source, profile: request.profile ?? plan.profile?.id ?? "", scope: request.scope, ...(failFast ? { failFast: true } : {}) },
        selection: {
          planHash: plan.planHash,
          planSource: source,
          profile: plan.profile?.id ?? request.profile,
          scope: plan.scope.requested,
          request: request as unknown as Record<string, unknown>,
          planOverrides: plan.selection.overrides as unknown as Array<Record<string, unknown>>,
        },
        runFiles: { "plan.json": `${JSON.stringify(plan, null, 2)}\n` },
        plan: reviewed,
        // A plan assembled from the option flags keeps the step that built it (no jgates.yml to plan from).
        steps: (context) => (isLegacyPlan(reviewed) ? legacySteps(context, reviewed) : planSteps(context, reviewed)),
        ...(isLegacyPlan(reviewed) ? {} : { disabled: planDisabled(reviewed) }),
        summarize: (r) => summarize(t, r),
      });
    }
    if (typeof outcome === "number") return outcome;
    const result = outcome;
    holder.result = result;

    if (ctx.json) writeJson(ctx, result);
    else {
      ctx.stdout(`${t("run_text_decision", { decision: result.decision, summary: result.summary ?? "" })}\n`);
      const analyzed = result.analyzed;
      if (analyzed) {
        const ta = translator("analysis");
        const commit = analyzed.snapshot.commit ?? "-";
        const line =
          analyzed.target === "commit"
            ? ta("analysis_text_target_commit", { commit, path: analyzed.path })
            : analyzed.target === "working-tree"
              ? ta("analysis_text_target_tree", { commit, dirty: analyzed.dirty ? ta("analysis_text_dirty") : "" })
              : ta("analysis_text_target_directory");
        ctx.stdout(`${line}\n${analyzed.approval.message}\n${ta("analysis_text_identity", { identity: analyzed.identity })}\n`);
      }
      for (const s of result.stages) ctx.stdout(`  ${s.state.padEnd(14)} ${s.id}${s.reason ? `  (${s.reason})` : ""}\n`);
      if (result.semantic) {
        const c = result.semantic.conclusion;
        const detail = c ? ` (${String(c.status)}, ${String(c.score)})` : result.semantic.reason ? ` (${result.semantic.reason})` : "";
        ctx.stdout(`${t("run_text_semantic", { state: result.semantic.state, detail })}\n`);
      }
      ctx.stdout(`${t("run_text_run", { runId: result.runId })}\n${t("run_text_folder", { path: result.runDir })}\n`);
      const changed = result.workspaceChanges.added.length + result.workspaceChanges.modified.length + result.workspaceChanges.removed.length;
      if (changed > 0) ctx.stdout(`${t("run_text_workspace_changes", { count: changed })}\n`);
    }
    return result.exitCode;
  }
}
