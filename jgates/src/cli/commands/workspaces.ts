import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { listWorkspaces, registerWorkspace, RelinkError, relinkWorkspace, resolveHome } from "../../core/home/index.js";

const t = translator("workspaces");

export const command: CommandModule = {
  name: "workspaces",
  description: t("workspaces_description"),
  options: [{ name: "cwd", type: "string", description: t("workspaces_option_cwd") }],
  run(ctx) {
    const action = ctx.args[0] ?? "list";
    const home = resolveHome();
    if (action === "list") {
      const workspaces = listWorkspaces(home);
      if (ctx.json) {
        writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, home, workspaces });
        return 0;
      }
      if (workspaces.length === 0) ctx.stdout(t("workspaces_empty") + "\n");
      for (const w of workspaces) ctx.stdout(`${w.id}  ${w.name}  ${w.path}\n`);
      return 0;
    }
    if (action === "add") {
      const target = ctx.args[1];
      if (!target) return reportError(ctx, ctx.json, "MISSING_PATH", t("workspaces_missing_path"), t("workspaces_missing_path_fix"), EXIT_USAGE);
      let entry;
      try {
        entry = registerWorkspace(target, { home });
      } catch {
        return reportError(ctx, ctx.json, "BAD_PATH", t("workspaces_bad_path", { path: target }), t("workspaces_bad_path_fix"), EXIT_USAGE);
      }
      if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, workspace: entry });
      else ctx.stdout(t("workspaces_registered", { id: entry.id, path: entry.path }) + "\n");
      return 0;
    }
    if (action === "relink") {
      const oldId = ctx.args[1];
      if (!oldId) return reportError(ctx, ctx.json, "MISSING_ID", t("workspaces_relink_missing_id"), t("workspaces_relink_missing_id_fix"), EXIT_USAGE);
      const cwd = ctx.options.cwd;
      if (typeof cwd !== "string") return reportError(ctx, ctx.json, "MISSING_PATH", t("workspaces_relink_missing_cwd"), t("workspaces_relink_missing_id_fix"), EXIT_USAGE);
      try {
        const entry = relinkWorkspace(oldId, cwd, { home });
        if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, workspace: entry, relinkedFrom: oldId });
        else ctx.stdout(t("workspaces_relinked", { old: oldId, id: entry.id, path: entry.path }) + "\n");
        return 0;
      } catch (error) {
        if (error instanceof RelinkError) {
          const key = error.code === "WORKSPACE_NOT_FOUND" ? "workspaces_relink_not_found" : error.code === "RELINK_SAME_WORKSPACE" ? "workspaces_relink_same" : "workspaces_relink_cycle";
          return reportError(ctx, ctx.json, error.code, t(key, { id: oldId }), t(`${key}_fix`), EXIT_USAGE);
        }
        return reportError(ctx, ctx.json, "BAD_PATH", t("workspaces_bad_path", { path: cwd }), t("workspaces_bad_path_fix"), EXIT_USAGE);
      }
    }
    return reportError(ctx, ctx.json, "UNKNOWN_ACTION", t("workspaces_unknown_action", { name: action }), t("workspaces_unknown_action_fix"), EXIT_USAGE);
  },
};
