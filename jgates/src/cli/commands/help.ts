import type { CommandModule } from "../command.js";
import { writeJson } from "../output.js";

/**
 * Pattern of a command module: export `command` with name, description, options and run.
 * Descriptions are keys of the "cli" message catalog (an unknown key is shown as is).
 */
export const command: CommandModule = {
  name: "help",
  description: "help_description",
  options: [],
  run(ctx) {
    const commands = ctx.commands.map((c) => ({
      name: c.name,
      description: ctx.t(c.description),
      options: c.options.map((o) => ({ name: `--${o.name}`, type: o.type, description: ctx.t(o.description) })),
    }));
    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: "OK",
        tool: "jgates",
        version: ctx.version,
        commands,
        globalOptions: ["--json", "--version", "--help", "--locale"],
      });
      return 0;
    }
    const lines = [ctx.t("help_title", { version: ctx.version }), "", ctx.t("help_usage"), "", ctx.t("help_commands")];
    for (const c of commands) lines.push(`  ${c.name.padEnd(14)}${c.description}`);
    lines.push("", ctx.t("help_global"), "");
    ctx.stdout(lines.join("\n"));
    return 0;
  },
};
