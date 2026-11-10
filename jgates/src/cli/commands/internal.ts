// jgates internal <name> ...: the commands the product calls on itself and its helper containers (hidden from help).
// `internal sync` copies the project into the workspace's source volume with the same code a run uses for its sync
// phase, and prints the counts. The other helpers (deps, pii, toml) arrive with their features.
import fs from "node:fs";
import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { EngineError, inspectImageSync } from "../../core/engine/index.js";
import { resolveHome } from "../../core/home/index.js";
import { SyncError, syncProject } from "../../core/sync/index.js";
import { syncDetails } from "../../core/sync/phase.js";
import { toolsImageTarget } from "../../core/tools-image/index.js";

const t = translator("sync");

export const command: CommandModule = {
  name: "internal",
  hidden: true,
  description: "Internal helper commands (sync).",
  options: [{ name: "cwd", type: "string", description: "Project folder (default: the current folder)." }],
  async run(ctx) {
    const name = ctx.args[0];
    if (name !== "sync") return reportError(ctx, ctx.json, "UNKNOWN_INTERNAL", t("sync_cmd_unknown", { name: name ?? "-" }), t("sync_cmd_unknown_fix"), EXIT_USAGE);
    const cwd = path.resolve(typeof ctx.options.cwd === "string" ? ctx.options.cwd : process.cwd());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return reportError(ctx, ctx.json, "BAD_CWD", t("sync_cmd_bad_cwd", { path: cwd }), t("sync_cmd_bad_cwd_fix"), EXIT_USAGE);
    const reference = process.env.JGATES_TOOLS_IMAGE?.trim() || toolsImageTarget().reference;
    try {
      const image = inspectImageSync(reference);
      if (!image) return reportError(ctx, ctx.json, "IMAGE_MISSING", t("sync_cmd_no_image", { image: reference }), t("sync_cmd_no_image_fix"), EXIT_USAGE);
      const result = await syncProject({ projectDir: cwd, image: image.id, version: ctx.version, home: resolveHome() });
      if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, sync: syncDetails(result) });
      else ctx.stdout(t("sync_cmd_done", { total: result.totalFiles, changed: result.changedFiles, deleted: result.deletedFiles, volume: result.volume }) + "\n");
      return 0;
    } catch (error) {
      if (!(error instanceof SyncError || error instanceof EngineError)) throw error;
      return reportError(ctx, ctx.json, "SYNC_FAILED", t("sync_cmd_failed", { message: error.message }), t("sync_cmd_failed_fix"), 1);
    }
  },
};
