// jgates ci: the governed CI path. The rules come only from a CI policy folder (--policy or JGATES_POLICY_DIR) pinned by
// JGATES_POLICY_SHA256; the checkout is analyzed in a clean copy of the commit. Exit codes are those of jgates run
// (0 passed, 1 failed, 2 incomplete, 4 internal, 130 cancelled), with 3 for every refused option and every problem of
// the policy; nothing runs before the policy is checked.
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator, type Params, type Translator } from "../../i18n/index.js";
import { executeRun, type RunResult } from "../../core/run/index.js";
import { planDisabled, planSteps } from "../../core/run/plan-run.js";
import {
  buildGovernedPlan,
  checkGovernedProfile,
  GOVERNED_SCOPES,
  governedRunFiles,
  policyRecord,
  prepareGovernedPolicy,
  type GovernedError,
  type GovernedPolicy,
} from "../../core/run/governed.js";
import { SnapshotError } from "../../core/snapshot/index.js";
import { governSteps } from "../../core/governed/steps.js";
import { checkCommitTree } from "../../core/governed/tree.js";
import type { RunEvent } from "../../core/events/index.js";
import { ADAPTER_ID } from "../../adapters/quality-bridge/index.js";
import { BuiltinError } from "../../builtin/index.js";
import { encodePointer, resolveConfig } from "../../core/config/resolve/index.js";
import { toSarif } from "../../core/results/index.js";
import type { Plan, PlanScopeKind } from "../../core/plan/index.js";
import { blockVault } from "../../core/secrets/index.js";
import { blockUserPreferences } from "../../core/providers/index.js";

/** Environment variables of the governed path. */
export const POLICY_DIR_ENV = "JGATES_POLICY_DIR";
export const POLICY_SHA256_ENV = "JGATES_POLICY_SHA256";

/** Options that would let the evaluated job choose its own rules; declared only to be refused with a clear code. */
const REFUSED_OPTIONS = ["skip", "only", "waiver", "no-cache", "plan", "path", "template"] as const;

const tr = translator("ci");

const str = (ctx: CommandContext, name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A file path whose folder exists and that is not itself a folder. */
const writableFile = (file: string): boolean => isDirectory(path.dirname(file)) && !isDirectory(file);

function summary(t: Translator, r: RunResult): string {
  const missing = r.unsatisfied.length;
  switch (r.decision) {
    case "passed":
      return t("ci_summary_passed");
    case "failed":
      return r.complete ? t("ci_summary_failed", { count: r.blockingViolations }) : t("ci_summary_failed_incomplete", { count: r.blockingViolations, missing });
    case "incomplete":
      return r.reduced && missing === 0 ? t("ci_summary_reduced") : t("ci_summary_incomplete", { count: missing });
    default:
      return t("ci_summary_other", { decision: r.decision });
  }
}

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
      return `! ${tr("ci_cancel_requested")}`;
    default:
      return null;
  }
}

/** Ctrl+C, SIGTERM and SIGHUP cancel the run (partial result written, exit 130); a second signal exits at once. */
async function withCancellation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (): void => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort("cancel");
  };
  for (const name of signals) process.on(name, onSignal);
  try {
    return await work(controller.signal);
  } finally {
    for (const name of signals) process.off(name, onSignal);
  }
}

/** `execution.failFast` of the policy's configuration (never the project's). */
function policyFailFast(projectDir: string, policyDir: string): boolean {
  try {
    return resolveConfig(projectDir, { configDir: policyDir }).fields[encodePointer(["execution", "failFast"])]?.value === true;
  } catch {
    return false;
  }
}

function policyError(ctx: CommandContext, t: Translator, error: GovernedError, extra: Params = {}): number {
  const key = `ci_error_${error.code.toLowerCase()}`;
  const params: Params = { path: error.path ?? "-", detail: error.detail, expected: error.expected ?? "-", actual: error.actual ?? "-", ...extra };
  if (ctx.json) {
    writeJson(ctx, {
      ...errorPayload(error.code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE),
      executed: false,
      ...(error.expected ? { expected: error.expected, actual: error.actual } : {}),
    });
  } else ctx.stderr(`ERROR ${error.code}\n${t(key, params)}\n${t(`${key}_fix`, params)}\n`);
  return EXIT_USAGE;
}

export const command: CommandModule = {
  name: "ci",
  description: tr("ci_description"),
  options: [
    { name: "cwd", type: "string", description: tr("ci_option_cwd") },
    { name: "policy", type: "string", description: tr("ci_option_policy") },
    { name: "head", type: "string", description: tr("ci_option_head") },
    { name: "scope", type: "string", description: tr("ci_option_scope") },
    { name: "base", type: "string", description: tr("ci_option_base") },
    { name: "profile", type: "string", description: tr("ci_option_profile") },
    { name: "out", type: "string", description: tr("ci_option_out") },
    { name: "sarif", type: "string", description: tr("ci_option_sarif") },
    { name: "fail-fast", type: "boolean", description: tr("ci_option_fail_fast") },
    { name: "events-jsonl", type: "string", description: tr("ci_option_events_jsonl") },
    { name: "no-interactive", type: "boolean", description: tr("ci_option_no_interactive") },
    { name: "bridge-mode", type: "string", description: tr("ci_option_bridge_mode") },
    { name: "skip", type: "string", description: tr("ci_option_refused") },
    { name: "only", type: "string", description: tr("ci_option_refused") },
    { name: "waiver", type: "string", description: tr("ci_option_refused") },
    { name: "no-cache", type: "boolean", description: tr("ci_option_refused") },
    { name: "plan", type: "string", description: tr("ci_option_refused") },
    { name: "path", type: "string", description: tr("ci_option_refused") },
    { name: "template", type: "string", description: tr("ci_option_refused") },
  ],
  async run(ctx) {
    // The governed path uses only the environment (the pipeline's secrets): the user key store is never read in this
    // process, whatever runs later (a provider's key, a PII tool's passEnv). Nor are the user's provider preferences
    // (base URL, model, key name, named connections): only the policy and the environment count.
    blockVault();
    blockUserPreferences();
    const t = tr;
    const usage = (code: string, key: string, params: Params = {}) => reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);

    // 1. What the call may not choose: refused before the policy or the checkout is even looked at.
    const extra = ctx.args[0];
    if (extra !== undefined) return usage("UNEXPECTED_ARGUMENT", "ci_unexpected_argument", { name: extra });
    const refused = REFUSED_OPTIONS.find((name) => ctx.options[name] !== undefined);
    if (refused) return usage("CI_OPTION_REFUSED", "ci_option_refused_error", { name: `--${refused}` });
    const bridgeMode = ctx.options["bridge-mode"];
    if (bridgeMode !== undefined && bridgeMode !== "full") return usage("CI_BRIDGE_MODE_REFUSED", "ci_bridge_mode_refused", { value: String(bridgeMode) });
    const scope = str(ctx, "scope");
    if (scope !== undefined && !GOVERNED_SCOPES.includes(scope as PlanScopeKind)) return usage("CI_SCOPE_REFUSED", "ci_scope_refused", { value: scope });

    const projectDir = path.resolve(str(ctx, "cwd") ?? process.cwd());
    if (!isDirectory(projectDir)) return usage("BAD_CWD", "ci_bad_cwd", { path: projectDir });
    const eventsOption = str(ctx, "events-jsonl");
    const eventsFile = eventsOption !== undefined ? path.resolve(eventsOption) : undefined;
    if (eventsFile !== undefined && !writableFile(eventsFile)) return usage("BAD_EVENTS_PATH", "ci_bad_path", { name: "--events-jsonl", path: eventsFile });
    const sarifOption = str(ctx, "sarif");
    const sarifFile = sarifOption !== undefined ? path.resolve(sarifOption) : undefined;
    if (sarifFile !== undefined && !writableFile(sarifFile)) return usage("BAD_SARIF_PATH", "ci_bad_path", { name: "--sarif", path: sarifFile });
    const outOption = str(ctx, "out");
    const outDir = outOption !== undefined ? path.resolve(outOption) : undefined;
    if (outDir !== undefined && fs.existsSync(outDir) && !isDirectory(outDir)) return usage("BAD_OUT", "ci_bad_out", { path: outDir });

    // 2. The policy, before anything runs: folder, hash variable, location, bundle, hash, quality policy, waivers.
    const policyOption = str(ctx, "policy");
    const envDir = process.env[POLICY_DIR_ENV];
    const prepared = prepareGovernedPolicy({
      policyDir: policyOption ?? (envDir !== undefined && envDir !== "" ? envDir : undefined),
      from: policyOption !== undefined ? "option" : "env",
      expectedSha256: process.env[POLICY_SHA256_ENV],
      projectDir,
    });
    if (!prepared.ok) return policyError(ctx, t, prepared.error);
    const policy: GovernedPolicy = prepared.policy;
    const profile = str(ctx, "profile");
    const profileProblem = checkGovernedProfile(policy, profile);
    if (profileProblem) return policyError(ctx, t, profileProblem, { profile: profile ?? "-", allowed: policy.profiles.join(", ") || "-" });

    // 3. The plan: only the policy's rules, for a clean copy of the commit.
    const base = str(ctx, "base");
    const head = str(ctx, "head");
    let plan: Plan;
    try {
      const built = buildGovernedPlan(projectDir, policy, {
        version: ctx.version,
        ...(head !== undefined ? { head } : {}),
        ...(scope !== undefined ? { scope: scope as PlanScopeKind } : {}),
        ...(base !== undefined ? { base } : {}),
        ...(profile !== undefined ? { profile } : {}),
      });
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
    } catch (error) {
      if (error instanceof BuiltinError) return reportError(ctx, ctx.json, "BUILTIN_INVALID", error.message, null, 4);
      throw error;
    }
    if (plan.blocked || !plan.approvable) {
      const blockers = plan.blocked ? [plan.blocked, ...plan.blockers] : plan.blockers;
      const message = t("ci_plan_not_approvable", { code: blockers[0]?.code ?? "-", detail: blockers.map((b) => b.message).join(" ") });
      const fix = t("ci_plan_not_approvable_fix");
      if (ctx.json) writeJson(ctx, { ...errorPayload("PLAN_NOT_APPROVABLE", message, fix, EXIT_USAGE), executed: false, blockers });
      else ctx.stderr(`ERROR PLAN_NOT_APPROVABLE\n${message}\n${fix}\n`);
      return EXIT_USAGE;
    }
    // The budgets of the quality gate are mandatory: a policy whose selection turns the file size check off is refused.
    if (!plan.groups.willRun.some((i) => i.adapter === ADAPTER_ID && i.subcheck === "file-size")) {
      return policyError(ctx, t, { code: "POLICY_BUDGETS_DISABLED", detail: "the policy's selection turns quality-bridge.file-size off", path: null });
    }
    // The commit itself: a submodule (not analyzed) or a symbolic link out of the checkout is refused before anything runs.
    const treeProblem = checkCommitTree(projectDir, plan.scope.head ?? "HEAD");
    if (treeProblem) return policyError(ctx, t, { code: treeProblem.code, detail: treeProblem.detail, path: treeProblem.path });

    // 4. The run: the policy's waivers only, the cache on, a reduced selection never passes.
    const failFast = ctx.options["fail-fast"] === true || policyFailFast(projectDir, policy.bundle.dir);
    const request = plan.selection.request;
    let result: RunResult;
    try {
      result = await withCancellation((signal) =>
        executeRun({
          workspacePath: projectDir,
          version: ctx.version,
          adapter: ADAPTER_ID,
          options: {
            planHash: plan.planHash,
            planSource: "built",
            profile: request.profile ?? plan.profile?.id ?? "",
            scope: request.scope,
            governed: true,
            policySha256: policy.bundle.sha256,
            ...(failFast ? { failFast: true } : {}),
          },
          selection: {
            planHash: plan.planHash,
            planSource: "built",
            profile: plan.profile?.id ?? request.profile,
            scope: plan.scope.requested,
            request: request as unknown as Record<string, unknown>,
            planOverrides: plan.selection.overrides as unknown as Array<Record<string, unknown>>,
          },
          runFiles: governedRunFiles(plan, policy),
          plan,
          // The plan's steps with what the run can trust marked, plus the report of the suppressions in the code.
          steps: (context) => governSteps(context, plan, planSteps(context, plan)),
          disabled: planDisabled(plan),
          waivers: policy.waivers,
          cache: true,
          policy: policyRecord(policy),
          neverPassReduced: true,
          // A self-reported stage (the project's tests, MSBuild, coverage) approves alone only if the policy says so.
          selfReportedSatisfies: policy.trustSelfReported,
          summarize: (r) => summary(t, r),
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
        }),
      );
    } catch (error) {
      if (!(error instanceof SnapshotError)) throw error;
      return reportError(ctx, ctx.json, error.code, t("ci_snapshot_failed", { commit: plan.scope.head ?? "-", detail: error.message }), t("ci_snapshot_failed_fix"), EXIT_USAGE);
    }

    // 5. Artifacts for the CI: a copy of the run folder and the SARIF.
    if (outDir !== undefined) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.cpSync(result.runDir, outDir, { recursive: true });
    }
    if (sarifFile !== undefined) fs.writeFileSync(sarifFile, `${JSON.stringify(toSarif(result), null, 2)}\n`);

    if (ctx.json) writeJson(ctx, result);
    else {
      ctx.stdout(`${t("ci_text_decision", { decision: result.decision, summary: result.summary ?? "" })}\n`);
      ctx.stdout(`${t("ci_text_policy", { sha256: policy.bundle.sha256, count: policy.bundle.files.length })}\n`);
      ctx.stdout(`${t("ci_text_commit", { commit: result.analyzed?.snapshot.commit ?? "-" })}\n`);
      for (const s of result.stages) ctx.stdout(`  ${s.state.padEnd(14)} ${s.id}${s.reason ? `  (${s.reason})` : ""}\n`);
      ctx.stdout(`${t("ci_text_run", { runId: result.runId })}\n${t("ci_text_folder", { path: result.runDir })}\n`);
      if (outDir !== undefined) ctx.stdout(`${t("ci_text_out", { path: outDir })}\n`);
      if (sarifFile !== undefined) ctx.stdout(`${t("ci_text_sarif", { path: sarifFile })}\n`);
    }
    return result.exitCode;
  },
};
