import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";

const t = translator("skill");

/** The agent skill shipped with this installation: jgates/skill/SKILL.md, beside dist/. */
export function skillFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skill", "SKILL.md");
}

/**
 * `jgates skill`: the shortcut for coding agents. Without options it prints the skill (an agent can read it straight
 * from the terminal); --path prints where it is; --install <folder> copies it into an agent's skills folder as
 * <folder>/SKILL.md, refusing to overwrite a different file unless --force.
 */
export const command: CommandModule = {
  name: "skill",
  description: t("skill_description"),
  options: [
    { name: "path", type: "boolean", description: t("skill_option_path") },
    { name: "install", type: "string", description: t("skill_option_install") },
    { name: "force", type: "boolean", description: t("skill_option_force") },
  ],
  run(ctx) {
    const extra = ctx.args[0];
    if (extra !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("skill_unexpected_argument", { name: extra }), t("skill_unexpected_argument_fix"), EXIT_USAGE);
    const file = skillFile();
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return reportError(ctx, ctx.json, "SKILL_MISSING", t("skill_missing", { path: file }), t("skill_missing_fix"), EXIT_USAGE);
    }

    const install = ctx.options.install;
    if (typeof install === "string") {
      const dir = path.resolve(install);
      const target = path.join(dir, "SKILL.md");
      let current: string | null = null;
      try {
        current = fs.readFileSync(target, "utf8");
      } catch {
        current = null;
      }
      if (current !== null && current !== text && ctx.options.force !== true) {
        return reportError(ctx, ctx.json, "SKILL_EXISTS", t("skill_exists", { path: target }), t("skill_exists_fix"), EXIT_USAGE);
      }
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (current !== text) fs.writeFileSync(target, text, "utf8");
      } catch (error) {
        return reportError(ctx, ctx.json, "WRITE_FAILED", t("skill_write_failed", { path: target, reason: error instanceof Error ? error.message : String(error) }), t("skill_write_failed_fix"), EXIT_USAGE);
      }
      if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, skill: file, installed: target, changed: current !== text });
      else ctx.stdout(`${t(current === text ? "skill_installed_same" : "skill_installed", { path: target })}\n`);
      return 0;
    }

    if (ctx.options.path === true) {
      if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, skill: file });
      else ctx.stdout(`${file}\n`);
      return 0;
    }
    if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, skill: file, text });
    else ctx.stdout(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  },
};
