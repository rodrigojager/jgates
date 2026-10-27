import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { discoverWorkspace, projectDirExists } from "../../core/discovery/index.js";

const tr = translator("discover");

export const command: CommandModule = {
  name: "discover",
  description: tr("discover_description"),
  options: [{ name: "cwd", type: "string", description: tr("discover_option_cwd") }],
  run(ctx) {
    const usage = (code: string, key: string, params: Record<string, string> = {}) =>
      reportError(ctx, ctx.json, code, tr(key, params), tr(`${key}_fix`, params), EXIT_USAGE);

    const extra = ctx.args[0];
    if (extra !== undefined) return usage("UNEXPECTED_ARGUMENT", "discover_unexpected_argument", { name: extra });
    const cwdOption = ctx.options.cwd;
    const projectDir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    if (!projectDirExists(projectDir)) return usage("BAD_CWD", "discover_bad_cwd", { path: projectDir });

    const { inventory, diagnostics } = discoverWorkspace(projectDir);
    const valid = diagnostics.length === 0;

    if (ctx.json) {
      writeJson(ctx, {
        status: valid ? "OK" : "INVALID",
        tool: "jgates",
        version: ctx.version,
        projectDir,
        ...inventory,
        diagnostics,
      });
    } else {
      if (!valid) {
        ctx.stderr(tr("discover_config_invalid", { count: diagnostics.length }) + "\n");
        for (const d of diagnostics) ctx.stderr(`${d.file}${d.line ? `:${d.line}` : ""}${d.path ? ` (${d.path})` : ""}: ${d.message}\n`);
      }
      const shown = inventory.classifications;
      ctx.stdout(tr("discover_header", { mode: inventory.mode, count: inventory.summary.explicit + inventory.summary.detected }) + "\n");
      if (!inventory.templatesActive) ctx.stdout(tr("discover_report_only") + "\n");
      if (shown.length === 0) ctx.stdout(tr("discover_none") + "\n");
      for (const c of shown) {
        ctx.stdout(
          tr("discover_entry", {
            status: tr(`discover_status_${c.classificationStatus}`),
            root: c.componentRoot,
            language: c.language ?? "-",
            reason: tr(`discover_reason_${c.reasonCode}`),
          }) + "\n",
        );
      }
      for (const i of inventory.inconsistencies) ctx.stdout(tr("discover_inconsistency", { code: i.code, root: i.componentRoot }) + "\n");
      if (inventory.indexed.truncated) ctx.stdout(tr("discover_truncated") + "\n");
    }
    return valid ? 0 : EXIT_USAGE;
  },
};
