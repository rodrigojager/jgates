// jgates hooks install | uninstall pre-commit (D8): an optional Git hook that runs the PII check (hook.mode block) or the
// PII fix (hook.mode fix) on the staged files. The hook never replaces a hook of yours and does nothing when
// core.hooksPath is set: in both cases the command shows the line to add and changes nothing. The hook carries a mark,
// so uninstall removes only the hook this command wrote.
//
// How the hook finds jgates: the absolute path of the node and of the CLI file that ran `hooks install` is written into
// the hook (not a PATH lookup), so the hook runs the same jgates that installed it, in Git Bash on Windows too (the path
// is written with forward slashes). If that file is gone, the hook blocks the commit and says how to reinstall or remove it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { parseYamlFile } from "../../core/config/load/index.js";
import { readPiiSettings } from "../../core/pii-fix/config.js";

const t = translator("hooks");

export const HOOK_MARK = "# jgates-hook: pre-commit";
const HOOK_NAME = "pre-commit";
type Mode = "block" | "fix" | "off";

function git(cwd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) return { code: 127, out: "" };
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

/** Single-quotes a value for sh. */
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const toPosix = (p: string): string => p.replace(/\\/g, "/");

function readMode(projectDir: string): Mode {
  const file = path.join(projectDir, ".jgates", "pii.yml");
  if (!fs.existsSync(file)) return "block";
  const parsed = parseYamlFile(file, ".jgates/pii.yml");
  const value = parsed.value as { hook?: { mode?: unknown } } | undefined;
  const mode = value?.hook?.mode;
  return mode === "fix" || mode === "off" ? mode : "block";
}

export function hookScript(mode: Exclude<Mode, "off">, node: string, main: string): string {
  const q = (s: string): string => sq(s);
  const msg = (key: string): string => `echo ${q(t(key))} >&2`;
  const lines = [
    "#!/bin/sh",
    HOOK_MARK,
    `# ${t("hooks_script_managed")}`,
    `JGATES_NODE=${q(toPosix(node))}`,
    `JGATES_MAIN=${q(toPosix(main))}`,
    'if [ ! -x "$JGATES_NODE" ] && ! command -v "$JGATES_NODE" >/dev/null 2>&1 || [ ! -f "$JGATES_MAIN" ]; then',
    `  ${msg("hooks_script_missing")}`,
    "  exit 1",
    "fi",
  ];
  if (mode === "block") {
    lines.push(
      '"$JGATES_NODE" "$JGATES_MAIN" pii check --staged',
      "status=$?",
      'if [ "$status" -ne 0 ]; then',
      `  ${msg("hooks_script_blocked")}`,
      "  exit 1",
      "fi",
      "exit 0",
    );
  } else {
    lines.push(
      '"$JGATES_NODE" "$JGATES_MAIN" pii fix --staged --yes',
      "fix_status=$?",
      "# 3: no correction tool is configured. The commit is not let through silently: the check below decides.",
      'if [ "$fix_status" -eq 3 ]; then',
      `  ${msg("hooks_script_no_tool")}`,
      "  fix_status=0",
      "fi",
      '"$JGATES_NODE" "$JGATES_MAIN" pii check --staged',
      "check_status=$?",
      'if [ "$fix_status" -ne 0 ] || [ "$check_status" -ne 0 ]; then',
      `  ${msg("hooks_script_blocked")}`,
      "  exit 1",
      "fi",
      "exit 0",
    );
  }
  return lines.join("\n") + "\n";
}

export const command: CommandModule = {
  name: "hooks",
  description: t("hooks_cmd_description"),
  options: [{ name: "cwd", type: "string", description: t("hooks_cmd_option_cwd") }],
  run(ctx: CommandContext) {
    const fail = (code: string, key: string, params: Record<string, string> = {}, fixKey = "hooks_cmd_usage_fix"): number =>
      reportError(ctx, ctx.json, code, t(key, params), t(fixKey), EXIT_USAGE);
    const [action, hook] = ctx.args;
    if (action !== "install" && action !== "uninstall") return fail("UNKNOWN_ACTION", "hooks_cmd_unknown_action", { name: action ?? "" });
    if (hook !== HOOK_NAME) return fail("UNKNOWN_HOOK", "hooks_cmd_unknown_hook", { name: hook ?? "" });

    const cwd = path.resolve(typeof ctx.options.cwd === "string" ? ctx.options.cwd : process.cwd());
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || top.out === "") return fail("NOT_A_GIT_REPOSITORY", "hooks_cmd_not_git", { path: cwd }, "hooks_cmd_not_git_fix");
    const projectDir = path.resolve(top.out);
    const hooksPath = git(projectDir, ["config", "--get", "core.hooksPath"]);
    const hooksDir = path.resolve(projectDir, git(projectDir, ["rev-parse", "--git-path", "hooks"]).out || path.join(".git", "hooks"));
    const file = path.join(hooksDir, HOOK_NAME);
    const header = { schemaVersion: 1, tool: "jgates", version: ctx.version, command: `hooks ${action}`, hook: HOOK_NAME };
    const done = (status: string, key: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}): number => {
      if (ctx.json) writeJson(ctx, { ...header, status, exitCode: 0, ...extra });
      else ctx.stdout(t(key, params) + "\n");
      return 0;
    };

    if (action === "uninstall") {
      if (!fs.existsSync(file)) return done("NOT_INSTALLED", "hooks_cmd_not_installed");
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes(HOOK_MARK)) return done("FOREIGN", "hooks_cmd_uninstall_foreign", { path: file }, { path: file });
      fs.rmSync(file);
      return done("REMOVED", "hooks_cmd_removed", { path: file }, { path: file });
    }

    const problems = readPiiSettings(projectDir).problems;
    if (problems.length > 0) return fail("INVALID_CONFIG", "hooks_cmd_invalid_config", { problems: problems.join("; ") }, "hooks_cmd_invalid_config_fix");
    const mode = readMode(projectDir);
    if (mode === "off") return done("OFF", "hooks_cmd_mode_off");
    const node = process.execPath;
    const main = fs.realpathSync(process.argv[1] ?? "");
    const q = (s: string): string => `"${toPosix(s)}"`;
    const line = `${q(node)} ${q(main)} pii ${mode === "fix" ? "fix --staged --yes" : "check --staged"} || exit 1`;
    if (hooksPath.code === 0 && hooksPath.out !== "") return done("MANUAL", "hooks_cmd_hooks_path", { path: hooksPath.out, line }, { reason: "core.hooksPath", line });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (existing !== null && !existing.includes(HOOK_MARK)) return done("MANUAL", "hooks_cmd_existing", { path: file, line }, { reason: "existing-hook", path: file, line });
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(file, hookScript(mode, node, main), { mode: 0o755 });
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      // Windows: Git runs the hook through sh without the executable bit.
    }
    return done(existing === null ? "INSTALLED" : "UPDATED", "hooks_cmd_installed", { path: file, mode }, { path: file, mode });
  },
};
