import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_INTERNAL, EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { projectDirExists } from "../../core/discovery/index.js";
import { DEFAULT_PROFILE, STARTER_PROFILES, existingConfigFiles, planInit, writeInit } from "../../core/init/index.js";

const tr = translator("init");

export const command: CommandModule = {
  name: "init",
  description: tr("init_description"),
  options: [
    { name: "cwd", type: "string", description: tr("init_option_cwd") },
    { name: "profile", type: "string", description: tr("init_option_profile") },
    { name: "no-interactive", type: "boolean", description: tr("init_option_no_interactive") },
  ],
  run(ctx) {
    const usage = (code: string, key: string, params: Record<string, string> = {}) =>
      reportError(ctx, ctx.json, code, tr(key, params), tr(`${key}_fix`, params), EXIT_USAGE);

    const extra = ctx.args[0];
    if (extra !== undefined) return usage("UNEXPECTED_ARGUMENT", "init_unexpected_argument", { name: extra });
    const cwdOption = ctx.options.cwd;
    const projectDir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    if (!projectDirExists(projectDir)) return usage("BAD_CWD", "init_bad_cwd", { path: projectDir });

    // There is no prompt: without --profile the documented default applies, with or without --no-interactive.
    const profile = typeof ctx.options.profile === "string" ? ctx.options.profile : DEFAULT_PROFILE;
    if (!(STARTER_PROFILES as readonly string[]).includes(profile)) {
      return usage("BAD_PROFILE", "init_bad_profile", { profile, available: STARTER_PROFILES.join(", ") });
    }

    const existing = existingConfigFiles(projectDir);
    if (existing.length > 0) return usage("CONFIG_EXISTS", "init_exists", { files: existing.join(", ") });

    const plan = planInit(projectDir, profile);
    let written: string[];
    try {
      written = writeInit(projectDir, plan);
    } catch (error) {
      const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
      const key = exists ? "init_exists" : "init_write_failed";
      const params = exists
        ? { files: existingConfigFiles(projectDir).join(", ") }
        : { reason: error instanceof Error ? error.message : String(error) };
      return reportError(ctx, ctx.json, exists ? "CONFIG_EXISTS" : "WRITE_FAILED", tr(key, params), tr(`${key}_fix`, params), exists ? EXIT_USAGE : EXIT_INTERNAL);
    }

    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: "OK",
        tool: "jgates",
        version: ctx.version,
        projectDir,
        profile: plan.profile,
        templates: plan.templates,
        components: plan.components,
        created: written,
      });
    } else {
      ctx.stdout(tr("init_done", { profile: plan.profile, templates: plan.templates.join(", ") }) + "\n");
      for (const file of written) ctx.stdout(tr("init_created", { file }) + "\n");
      ctx.stdout(tr("init_next") + "\n");
    }
    return 0;
  },
};
