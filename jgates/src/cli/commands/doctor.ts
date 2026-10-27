import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { assessEnvironment, lineTerminal, NO_TERMINAL, offerInstall, type Assessment, type EnvironmentAssessment, type InstallSession, type InstallTerminal } from "../../core/install/index.js";

const tr = translator("doctor");

/** Exit code of `doctor --fix` when an installation that ran failed. */
const EXIT_INSTALL_FAILED = 1;

function itemLines(x: { classification: string; alternative: { message: string; command: string } | null; disable: { command: string } | null; missing: boolean; recipe: { commands: string[]; available: boolean; reason: string | null } | null }): string[] {
  if (!x.missing) return [];
  const lines = [`    ${tr(`doctor_class_${x.classification}`)}`];
  if (x.alternative) lines.push(`    ${tr("doctor_alternative", { alternative: x.alternative.message, command: x.alternative.command })}`);
  if (x.recipe?.available) lines.push(`    ${tr("doctor_recipe", { commands: x.recipe.commands.join(" && ") })}`);
  else if (x.recipe?.reason) lines.push(`    ${tr("doctor_recipe_unavailable", { reason: x.recipe.reason })}`);
  if (x.disable && x.classification === "essential") lines.push(`    ${tr("doctor_disable", { command: x.disable.command })}`);
  return lines;
}

function render(d: EnvironmentAssessment): string {
  const lines = [d.environmentReady ? tr("doctor_header_ready") : tr("doctor_header_not_ready", { absent: d.summary.absent, incompatible: d.summary.incompatible }), tr("doctor_note"), ""];
  lines.push(tr("doctor_runtimes"));
  for (const r of d.runtimes) {
    lines.push(`  ${r.id.padEnd(10)}${tr(`doctor_state_${r.state}`).padEnd(20)}${r.version ?? ""}`);
    if (r.state !== "ready") lines.push(`    ${r.message}`);
    if (r.fix) lines.push(`    ${tr("doctor_fix", { fix: r.fix })}`);
    lines.push(...itemLines(r));
  }
  lines.push("", tr("doctor_tools"));
  if (d.tools.length === 0) lines.push(`  ${tr("doctor_no_tools")}`);
  for (const x of d.tools) {
    lines.push(`  ${x.instance.padEnd(20)}${tr(`doctor_state_${x.state}`).padEnd(20)}${x.version ?? ""}  (${x.adapter}, ${x.range})`);
    if (x.state !== "ready") lines.push(`    ${x.message}`);
    if (x.fix) lines.push(`    ${tr("doctor_fix", { fix: x.fix })}`);
    if (x.lock.message) lines.push(`    ${x.lock.message}`);
    if (x.preparation.supported && x.preparation.command) {
      lines.push(`    ${tr("doctor_prepare", { command: x.preparation.command, hosts: x.preparation.network.hosts.join(", "), state: x.preparation.state })}`);
    }
    lines.push(...itemLines(x));
  }
  const lockState = !d.lock.exists ? tr("doctor_lock_state_missing") : d.lock.valid ? tr("doctor_lock_state_ok") : tr("doctor_lock_state_invalid", { problem: d.lock.problem ?? "" });
  lines.push("", tr("doctor_lock", { file: d.lock.file, state: lockState }));
  return lines.join("\n") + "\n";
}

const sessionJson = (s: InstallSession) => ({ asked: s.asked, accepted: s.accepted, outcomes: s.outcomes, manual: s.manual, failed: s.failed });

/** The terminal of the doctor: a person answers only on a TTY, and never with --json, --ci or --no-interactive. */
function terminalOf(ctx: CommandContext): InstallTerminal & { close?: () => void } {
  const interactive = !ctx.json && ctx.options.ci !== true && ctx.options["no-interactive"] !== true && process.stdin.isTTY === true;
  return interactive ? lineTerminal(process.stdin, process.stderr, true) : NO_TERMINAL;
}

/**
 * `jgates doctor`: reads the environment and prints the state of every runtime and tool, with the classification of
 * what is missing (essential, optional with its alternative, unused) and the recipe that installs it. On a terminal
 * it offers to install (essential items first, then the optional ones); --fix asks even when nothing essential is
 * missing, --fix --yes installs the essential items without asking. Without --fix and without a terminal it only reads.
 */
export const command: CommandModule = {
  name: "doctor",
  description: tr("doctor_description"),
  options: [
    { name: "cwd", type: "string", description: tr("doctor_option_cwd") },
    { name: "fix", type: "boolean", description: tr("doctor_option_fix") },
    { name: "yes", type: "boolean", description: tr("doctor_option_yes") },
    { name: "include-optional", type: "boolean", description: tr("doctor_option_include_optional") },
    { name: "ci", type: "boolean", description: tr("doctor_option_ci") },
    { name: "no-interactive", type: "boolean", description: tr("doctor_option_no_interactive") },
  ],
  async run(ctx) {
    const extra = ctx.args[0];
    if (extra !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", tr("doctor_unexpected_argument", { name: extra }), tr("doctor_unexpected_argument_fix"), EXIT_USAGE);
    const cwdOption = ctx.options.cwd;
    const projectDir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(projectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return reportError(ctx, ctx.json, "BAD_CWD", tr("doctor_bad_cwd", { path: projectDir }), tr("doctor_bad_cwd_fix"), EXIT_USAGE);

    const yes = ctx.options.yes === true;
    const includeOptional = ctx.options["include-optional"] === true;
    const fix = ctx.options.fix === true || yes || includeOptional;
    const assessment: Assessment = assessEnvironment(projectDir);
    const terminal = terminalOf(ctx);
    // With --json the lists and the progress go to stderr: stdout is the one JSON document.
    const out = ctx.json ? ctx.stderr : ctx.stdout;
    if (!ctx.json) ctx.stdout(render(assessment.report));
    let session: InstallSession | null = null;
    try {
      if (fix || terminal.interactive) {
        session = await offerInstall(assessment, { fix, yes, includeOptional, terminal, out });
      }
    } finally {
      terminal.close?.();
    }
    const after = session?.ran ? assessEnvironment(projectDir).report : assessment.report;
    const missingCount = after.install.essential.length + after.install.optional.length;
    if (ctx.json) {
      writeJson(ctx, { status: "OK", tool: "jgates", version: ctx.version, ...after, session: session ? sessionJson(session) : null });
      return session?.failed ? EXIT_INSTALL_FAILED : 0;
    }
    if (session?.ran) {
      ctx.stdout(`\n${missingCount === 0 ? tr("doctor_after_ready") : tr("doctor_after_missing", { essential: after.install.essential.join(", ") || "-", optional: after.install.optional.join(", ") || "-" })}\n`);
    } else if (missingCount > 0 && (session?.asked.length ?? 0) === 0 && (session?.accepted.length ?? 0) === 0) {
      if (fix && !terminal.interactive && !yes) ctx.stdout(`\n${tr("doctor_fix_needs_terminal")}\n`);
      else if (!fix) ctx.stdout(`\n${tr("doctor_hint_fix")}\n`);
    }
    for (const m of session?.manual ?? []) if (m.reason) ctx.stdout(`${tr("doctor_manual", { key: m.key, reason: m.reason })}\n`);
    return session?.failed ? EXIT_INSTALL_FAILED : 0;
  },
};
