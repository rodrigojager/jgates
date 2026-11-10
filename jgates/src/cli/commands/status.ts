import fs from "node:fs";
import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { collectStatus, renderStatus } from "../../core/lifecycle/index.js";

const t = translator("lifecycle");

/**
 * `jgates status [--json]`: one screen of readiness (engine, tools image, extension images, data ages, the workspace's
 * dependencies and services, disk use). Read-only. Exit 0 when a run can start, 2 when it cannot (reason codes in the report).
 */
export const command: CommandModule = {
  name: "status",
  description: t("lifecycle_status_description"),
  options: [{ name: "cwd", type: "string", description: t("lifecycle_option_cwd") }],
  async run(ctx) {
    const extra = ctx.args[0];
    if (extra !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("lifecycle_unexpected_argument", { name: extra }), t("lifecycle_status_usage"), EXIT_USAGE);
    const projectDir = path.resolve(typeof ctx.options.cwd === "string" ? ctx.options.cwd : process.cwd());
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return reportError(ctx, ctx.json, "BAD_CWD", t("lifecycle_bad_cwd", { path: projectDir }), t("lifecycle_bad_cwd_fix"), EXIT_USAGE);
    const report = await collectStatus({ version: ctx.version, projectDir });
    if (ctx.json) writeJson(ctx, { status: report.ready ? "OK" : "NOT_READY", tool: "jgates", version: ctx.version, ...report });
    else ctx.stdout(renderStatus(report));
    return report.ready ? 0 : 2;
  },
};
