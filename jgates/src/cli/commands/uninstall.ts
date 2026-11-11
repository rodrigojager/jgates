import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import {
  KEPT_CONFIG,
  applyCleanup,
  checkHome,
  cliRemoval,
  engineContextFor,
  homeBytes,
  itemsJson,
  keyStoreFacts,
  listProjectFiles,
  planCleanup,
  removeHome,
  removeKeyStore,
  renderAppliedLine,
  renderPlanLines,
  type AppliedLine,
} from "../../core/cleanup/index.js";
import { formatBytes } from "../../core/reasons/index.js";
import { confirmOnTerminal } from "./clean.js";

const t = translator("cleanup");
const EXIT_PARTIAL = 2;
const WORKSPACE_ID = /^ws_[0-9a-f]{16}$/;

/**
 * `jgates uninstall [--keep-config-notes] [--include-key-store] [--dry-run] [--yes]`: removes everything JGates created on
 * this machine: the labelled engine objects (by label only), the old tools folder and the data folder. The key store goes
 * only after its own confirmation. Files inside projects are listed with the command that removes each, never touched.
 * Without --yes (and without a terminal to ask) it only lists.
 */
export const command: CommandModule = {
  name: "uninstall",
  description: t("cleanup_uninstall_description"),
  options: [
    { name: "keep-config-notes", type: "boolean", description: t("cleanup_option_keep_config_notes") },
    { name: "include-key-store", type: "boolean", description: t("cleanup_option_include_key_store") },
    { name: "only-workspace", type: "string", description: t("cleanup_option_only_workspace") },
    { name: "dry-run", type: "boolean", description: t("cleanup_option_uninstall_dry_run") },
    { name: "yes", type: "boolean", description: t("cleanup_option_uninstall_yes") },
  ],
  async run(ctx) {
    if (ctx.args[0] !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("cleanup_unexpected_argument", { name: ctx.args[0] }), t("cleanup_uninstall_usage"), EXIT_USAGE);
    const dry = ctx.options["dry-run"] === true;
    const yes = ctx.options.yes === true;
    if (dry && yes) return reportError(ctx, ctx.json, "DRY_RUN_WITH_YES", t("cleanup_dry_and_yes"), t("cleanup_dry_and_yes_fix"), EXIT_USAGE);
    const only = typeof ctx.options["only-workspace"] === "string" ? ctx.options["only-workspace"] : undefined;
    if (only !== undefined && !WORKSPACE_ID.test(only)) return reportError(ctx, ctx.json, "BAD_WORKSPACE", t("cleanup_bad_workspace", { id: only }), t("cleanup_bad_workspace_fix"), EXIT_USAGE);

    const home = resolveHome();
    // Everything is read before anything goes: the registry of projects lives in the data folder.
    const plan = await planCleanup({ version: ctx.version, home, mode: "uninstall", ...(only ? { onlyWorkspace: only } : {}) });
    const projects = listProjectFiles(home, [process.cwd()]);
    const verdict = checkHome(home);
    const homeSize = homeBytes(home);
    const keep = ctx.options["keep-config-notes"] === true ? KEPT_CONFIG : [];
    const keyStore = keyStoreFacts();
    const cli = cliRemoval();
    const isTerminal = !ctx.json && ctx.options["no-interactive"] !== true && ctx.options.ci !== true && process.stdin.isTTY === true;

    const printPlan = (): void => {
      ctx.stdout(t("cleanup_uninstall_header") + "\n");
      for (const line of renderPlanLines(plan)) ctx.stdout(line + "\n");
      if (only) ctx.stdout(t("cleanup_uninstall_workspace_scope", { id: only }) + "\n");
      if (verdict.ok) ctx.stdout(t("cleanup_uninstall_home", { path: home, size: formatBytes(homeSize), kept: keep.length ? t("cleanup_uninstall_home_kept", { names: keep.join(", ") }) : "" }) + "\n");
      else if (verdict.code !== "MISSING") ctx.stdout(t("cleanup_uninstall_home_refused", { reason: t(`cleanup_home_${verdict.code}`, { detail: verdict.detail }) }) + "\n");
      if (keyStore.exists) ctx.stdout(t("cleanup_uninstall_key_store", { path: keyStore.path }) + "\n");
      if (projects.length > 0) {
        ctx.stdout(t("cleanup_uninstall_projects_header") + "\n");
        for (const p of projects) {
          for (const f of p.files) {
            ctx.stdout(t("cleanup_uninstall_project_file", { path: f.path }) + "\n");
            if (f.removeCommand) ctx.stdout(t("cleanup_uninstall_project_remove", { command: f.removeCommand }) + "\n");
          }
        }
      }
    };

    let go = yes && !dry;
    let removeKeys = ctx.options["include-key-store"] === true && go;
    let asked = false;
    if (!go && !dry && isTerminal) {
      printPlan();
      asked = true;
      go = await confirmOnTerminal(t("cleanup_confirm"));
      if (!go) ctx.stdout(t("cleanup_cancelled") + "\n");
      else if (keyStore.exists && ctx.options["include-key-store"] !== true) removeKeys = await confirmOnTerminal(t("cleanup_uninstall_key_store_confirm", { path: keyStore.path }));
      else removeKeys = ctx.options["include-key-store"] === true;
    }

    let applied: Awaited<ReturnType<typeof applyCleanup>> | null = null;
    let homeRemoval: ReturnType<typeof removeHome> | null = null;
    let keyRemoval: ReturnType<typeof removeKeyStore> | null = null;
    const lines: AppliedLine[] = [];
    if (go) {
      applied = await applyCleanup(plan, home, engineContextFor(process.env), (line) => {
        lines.push(line);
        if (!ctx.json) ctx.stdout(renderAppliedLine(line) + "\n");
      });
      // The data folder stays when something is still in use, so that running this again finds the same registry.
      if (applied.inUse + applied.failed + plan.totals.skipped === 0) homeRemoval = removeHome(home, keep);
      if (removeKeys && keyStore.exists) keyRemoval = removeKeyStore();
    }
    const incomplete = applied !== null && homeRemoval === null;
    const exit = applied && (applied.failed > 0 || (homeRemoval !== null && !homeRemoval.removed && verdict.ok)) ? EXIT_PARTIAL : 0;
    const mode = applied ? "applied" : "dry-run";

    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: "OK",
        tool: "jgates",
        version: ctx.version,
        mode,
        explicitDryRun: dry,
        ...(only ? { onlyWorkspace: only } : {}),
        engine: plan.engine,
        items: itemsJson(plan.items),
        unmanaged: plan.unmanaged,
        home: {
          path: home,
          sizeBytes: homeSize,
          removable: verdict.ok,
          ...(verdict.ok ? {} : { refused: verdict.code === "MISSING" ? null : { code: verdict.code, detail: verdict.detail } }),
          keeps: keep,
          removed: homeRemoval?.removed ?? false,
        },
        legacyTools: plan.legacyTools,
        keyStore: { path: keyStore.path, exists: keyStore.exists, removed: keyRemoval?.removed ?? false },
        projectFiles: projects,
        cli: { kind: cli.kind, command: cli.command, folder: cli.folder },
        totals: plan.totals,
        ...(applied
          ? {
              applied: {
                removed: applied.removed,
                inUse: applied.inUse,
                failed: applied.failed,
                freedBytes: applied.freedBytes,
                incomplete,
                lines: applied.lines.map((l) => ({ resource: l.item.resource, id: l.item.id, name: l.item.name, outcome: l.outcome, freedBytes: l.freedBytes, ...(l.details ? { details: l.details } : {}) })),
              },
            }
          : {}),
        exitCode: exit,
      });
      return exit;
    }

    if (!asked) printPlan();
    if (applied) {
      const freed = applied.freedBytes + (homeRemoval?.removed ? homeSize : 0);
      ctx.stdout(t("cleanup_summary_done", { count: applied.removed, size: formatBytes(freed) }) + "\n");
      if (incomplete) ctx.stdout(t("cleanup_uninstall_incomplete") + "\n");
      if (homeRemoval && !homeRemoval.removed && homeRemoval.details) ctx.stdout(t("cleanup_uninstall_home_refused", { reason: homeRemoval.details }) + "\n");
      if (keyRemoval?.removed) ctx.stdout(t("cleanup_uninstall_key_store_removed", { path: keyStore.path }) + "\n");
    } else if (!asked || !go) {
      ctx.stdout(t("cleanup_uninstall_summary_dry") + "\n");
    }
    if (cli.command) ctx.stdout(t("cleanup_uninstall_cli_global", { command: cli.command }) + "\n");
    else if (cli.folder) ctx.stdout(t("cleanup_uninstall_cli_clone", { folder: path.resolve(cli.folder) }) + "\n");
    return exit;
  },
};
