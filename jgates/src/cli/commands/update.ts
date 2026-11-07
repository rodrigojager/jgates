// `jgates update`: checks the repository for a newer JGates and, after the person confirms, installs it the same way
// this one was installed. Nothing checks on its own: the network is used only when this command runs.
import type { CommandModule } from "../command.js";
import { EXIT_INTERNAL, EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { isYes, lineTerminal } from "../../core/install/index.js";
import { compare, describeInstallation, findPackageDir, installCommand, remoteCommit, runInstall, UpdateError } from "../../core/update/index.js";

const t = translator("update");
const short = (commit: string | null): string => (commit ? commit.slice(0, 12) : "?");

async function confirm(question: string): Promise<boolean> {
  const terminal = lineTerminal(process.stdin, process.stderr, true);
  try {
    return isYes(await terminal.ask(question));
  } finally {
    terminal.close();
  }
}

export const command: CommandModule = {
  name: "update",
  description: t("update_description"),
  options: [
    { name: "check", type: "boolean", description: t("update_option_check") },
    { name: "yes", type: "boolean", description: t("update_option_yes") },
    { name: "ref", type: "string", description: t("update_option_ref") },
  ],
  async run(ctx) {
    if (ctx.args[0] !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("update_unexpected_argument", { name: ctx.args[0] }), t("update_usage"), EXIT_USAGE);
    const ref = typeof ctx.options.ref === "string" && ctx.options.ref.trim() ? ctx.options.ref.trim() : "main";
    const packageDir = process.env.JGATES_UPDATE_PACKAGE_DIR || findPackageDir();
    if (!packageDir) return reportError(ctx, ctx.json, "INSTALLATION_NOT_FOUND", t("update_not_found"), null, EXIT_INTERNAL);
    const installed = describeInstallation(packageDir);
    const repository = process.env.JGATES_UPDATE_REPOSITORY || installed.repository;
    if (!repository) return reportError(ctx, ctx.json, "NO_REPOSITORY", t("update_no_repository"), null, EXIT_INTERNAL);

    if (!ctx.json) ctx.stderr(t("update_text_asking", { repository, ref }) + "\n");
    let latest: string;
    try {
      latest = remoteCommit(repository, ref);
    } catch (e) {
      if (e instanceof UpdateError) {
        const code = e.code;
        const msg = code === "GIT_MISSING" ? t("update_git_missing") : code === "REF_NOT_FOUND" ? t("update_ref_not_found", { ref }) : t("update_remote_failed", { repository, detail: e.message });
        const fix = code === "GIT_MISSING" ? t("update_git_missing_fix") : code === "REF_NOT_FOUND" ? t("update_ref_not_found_fix") : t("update_remote_failed_fix");
        return reportError(ctx, ctx.json, code, msg, fix, code === "REF_NOT_FOUND" ? EXIT_USAGE : EXIT_INTERNAL);
      }
      throw e;
    }
    const state = compare(installed, latest);
    const install = installCommand(installed, repository, latest);
    const manual = t(installed.kind === "clone" ? "update_manual_clone" : "update_manual_global", { repository: repository.replace(/^git\+/, ""), ref, packageDir: installed.packageDir });

    const report = (applied: boolean | null, exitCode = 0) => {
      if (ctx.json) {
        writeJson(ctx, {
          schemaVersion: 1,
          status: "OK",
          tool: "jgates",
          version: ctx.version,
          installation: { kind: installed.kind, packageDir: installed.packageDir, prefix: installed.prefix, commit: installed.commit, dirty: installed.dirty },
          repository,
          ref,
          latest,
          state,
          command: install,
          manual: install ? null : manual,
          applied,
        });
      }
      return exitCode;
    };

    if (!ctx.json) {
      ctx.stdout(t("update_text_installed", { version: installed.version, commit: short(installed.commit), kind: t(`update_kind_${installed.kind}`), dirty: installed.dirty ? t("update_text_dirty") : "" }) + "\n");
      ctx.stdout(t("update_text_latest", { ref, commit: short(latest) }) + "\n");
      ctx.stdout(t(`update_state_${state.replace(/-/g, "_")}`) + "\n");
    }
    if (state === "up-to-date" || ctx.options.check === true) return report(null);
    if (!install) {
      if (!ctx.json) ctx.stdout(manual + "\n");
      return report(null);
    }
    if (!ctx.json) ctx.stdout(t("update_text_command", { command: install.join(" ") }) + "\n");
    const interactive = process.stdin.isTTY === true && !ctx.json;
    const go = ctx.options.yes === true || (interactive && (await confirm(t("update_ask"))));
    if (!go) {
      if (!ctx.json) ctx.stdout(t(interactive ? "update_text_cancelled" : "update_text_use_yes") + "\n");
      return report(false);
    }
    const status = runInstall(install);
    if (status !== 0) {
      if (ctx.json) return report(false, EXIT_INTERNAL);
      return reportError(ctx, false, "INSTALL_FAILED", t("update_install_failed", { status }), t("update_install_failed_fix"), EXIT_INTERNAL);
    }
    if (!ctx.json) ctx.stdout(t("update_text_done", { commit: short(latest) }) + "\n" + t("update_text_after") + "\n");
    return report(true);
  },
};
