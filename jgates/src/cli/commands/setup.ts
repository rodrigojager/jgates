import fs from "node:fs";
import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { pullLine, renderSetup, runSetup, type SetupEvent } from "../../core/lifecycle/index.js";

const t = translator("lifecycle");

/** Exit codes of `setup`: 0 ready, 2 not ready (with reason codes), 4 internal error (the program's own). */
const EXIT_NOT_READY = 2;

/**
 * `jgates setup [--yes] [--no-data] [--from <file>] [--json]`: makes the machine ready (engine, disk, tools image, shared
 * volumes, advisory data) and says what is still missing, with one action per reason. Idempotent. With --json stdout is one
 * document; progress goes to stderr as JSON lines (the objects the UI streams).
 */
export const command: CommandModule = {
  name: "setup",
  description: t("lifecycle_setup_description"),
  options: [
    { name: "cwd", type: "string", description: t("lifecycle_option_cwd") },
    { name: "yes", type: "boolean", description: t("lifecycle_option_yes") },
    { name: "no-data", type: "boolean", description: t("lifecycle_option_no_data") },
    { name: "from", type: "string", description: t("lifecycle_option_from") },
  ],
  async run(ctx) {
    const extra = ctx.args[0];
    if (extra !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("lifecycle_unexpected_argument", { name: extra }), t("lifecycle_setup_usage"), EXIT_USAGE);
    const projectDir = path.resolve(typeof ctx.options.cwd === "string" ? ctx.options.cwd : process.cwd());
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return reportError(ctx, ctx.json, "BAD_CWD", t("lifecycle_bad_cwd", { path: projectDir }), t("lifecycle_bad_cwd_fix"), EXIT_USAGE);

    let lastPercent = -10;
    const onEvent = (event: SetupEvent): void => {
      if (ctx.json) {
        ctx.stderr(JSON.stringify(event) + "\n");
        return;
      }
      if (event.type === "setup-step" && event.state === "started") ctx.stderr(`${t(`lifecycle_step_${event.step}`)}...\n`);
      else if (event.type === "image-pull" && event.total > 0) {
        const percent = Math.floor((event.downloaded / event.total) * 100);
        if (percent >= lastPercent + 10 || event.phase === "done") {
          lastPercent = percent;
          ctx.stderr(pullLine(event.downloaded, event.total) + "\n");
        }
      }
    };
    const result = await runSetup({
      version: ctx.version,
      projectDir,
      withData: ctx.options["no-data"] !== true,
      yes: ctx.options.yes === true,
      ...(typeof ctx.options.from === "string" ? { from: path.resolve(ctx.options.from) } : {}),
      onEvent,
    });
    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: result.ready ? "OK" : "NOT_READY",
        tool: "jgates",
        version: ctx.version,
        ready: result.ready,
        pulled: result.pulled,
        steps: result.steps,
        reasons: [...result.reasons, ...result.status.reasons.filter((r) => !result.reasons.some((x) => x.code === r.code))],
        warnings: result.status.warnings,
        exitCode: result.ready ? 0 : EXIT_NOT_READY,
      });
    } else ctx.stdout(renderSetup(result));
    return result.ready ? 0 : EXIT_NOT_READY;
  },
};
