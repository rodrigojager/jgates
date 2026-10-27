import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator, type Translator } from "../../i18n/index.js";
import { resolveHome, workspaceDir } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { createProfile, deleteProfile, listProfiles, ProfileError, setDefaultProfile } from "../../core/profiles/index.js";
import { parseSkipList } from "../../core/selection/index.js";

const tr = translator("profiles");

interface Subcommand {
  run: (ctx: CommandContext, projectDir: string, t: Translator) => number;
  /** Positional arguments after the action. */
  args: number;
  /** Options besides --cwd, --json and --no-interactive. */
  options: string[];
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  list: { run: runList, args: 0, options: [] },
  create: { run: runCreate, args: 1, options: ["from", "skip", "label", "description", "replace", "if-match"] },
  save: { run: runSave, args: 0, options: ["run", "as", "label", "description", "replace", "if-match"] },
  "set-default": { run: runSetDefault, args: 1, options: ["if-match"] },
  delete: { run: runDelete, args: 1, options: ["if-match"] },
};
const VALUE_OPTIONS = ["from", "skip", "run", "as", "label", "description", "replace", "if-match"];

function ok(ctx: CommandContext, payload: Record<string, unknown>): void {
  writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, ...payload });
}

function reportProfileError(ctx: CommandContext, error: ProfileError): number {
  if (ctx.json) {
    writeJson(ctx, { ...errorPayload(error.code, error.message, error.fix, EXIT_USAGE), ...error.details });
  } else {
    ctx.stderr(`ERROR ${error.code}\n${error.message}\n${error.fix ?? ""}\n`);
    const errors = error.details.errors;
    if (Array.isArray(errors)) for (const e of errors as Array<{ message?: string }>) if (e.message && e.message !== error.message) ctx.stderr(`- ${e.message}\n`);
  }
  return EXIT_USAGE;
}

function ifMatch(ctx: CommandContext): { expectedHash?: string } {
  const v = ctx.options["if-match"];
  return typeof v === "string" ? { expectedHash: v } : {};
}

function runList(ctx: CommandContext, projectDir: string, t: Translator): number {
  const list = listProfiles(projectDir);
  if (ctx.json) {
    ok(ctx, { projectDir, default: list.default, revisions: list.revisions, profiles: list.profiles });
    return 0;
  }
  ctx.stdout(t("profiles_listed", { count: list.profiles.length, default: list.default }) + "\n");
  for (const p of list.profiles) {
    ctx.stdout(t("profiles_line", { marker: p.isDefault ? "*" : "-", ref: p.ref, label: p.label ? `  ${p.label}` : "", extends: p.extends ? `  (herda de ${p.extends})` : "" }) + "\n");
  }
  return 0;
}

function runCreate(ctx: CommandContext, projectDir: string, t: Translator): number {
  const id = ctx.args[1];
  if (id === undefined) return reportError(ctx, ctx.json, "PROFILE_ID_REQUIRED", t("profiles_missing_id"), t("profiles_missing_id_fix", { action: "create" }), EXIT_USAGE);
  const from = ctx.options.from;
  if (typeof from !== "string") return reportError(ctx, ctx.json, "FROM_REQUIRED", t("profiles_missing_from"), t("profiles_missing_from_fix"), EXIT_USAGE);
  const str = (name: string): { [k: string]: string } => (typeof ctx.options[name] === "string" ? { [name]: ctx.options[name] as string } : {});
  const result = createProfile(projectDir, id, {
    from,
    skip: ctx.lists?.skip && ctx.lists.skip.length > 0 ? [...ctx.lists.skip] : typeof ctx.options.skip === "string" ? [ctx.options.skip] : [],
    ...str("label"),
    ...str("description"),
    replace: ctx.options.replace === true,
    ...ifMatch(ctx),
  });
  if (ctx.json) ok(ctx, { projectDir, ...result });
  else ctx.stdout(t("profiles_created", { id: result.id, file: result.file, from: result.extends }) + "\n");
  return 0;
}

/** Saves what a run executed (its profile plus the run-only --skip) as a project profile. */
function runSave(ctx: CommandContext, projectDir: string, t: Translator): number {
  const runId = ctx.options.run;
  const id = ctx.options.as;
  if (typeof runId !== "string") return reportError(ctx, ctx.json, "RUN_REQUIRED", t("profiles_save_missing_run"), t("profiles_save_missing_run_fix"), EXIT_USAGE);
  if (typeof id !== "string") return reportError(ctx, ctx.json, "PROFILE_ID_REQUIRED", t("profiles_save_missing_as"), t("profiles_save_missing_as_fix"), EXIT_USAGE);
  const notFound = () => reportError(ctx, ctx.json, "RUN_NOT_FOUND", t("profiles_save_run_not_found", { run: runId }), t("profiles_save_run_not_found_fix"), EXIT_USAGE);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) return notFound();
  const planFile = path.join(workspaceDir(resolveHome(), workspaceId(projectDir)), "runs", runId, "plan.json");
  let plan: { profile?: { id?: string } | null; selection?: { request?: { profile?: string | null; skip?: string[]; only?: string[] } } };
  try {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as typeof plan;
  } catch {
    return notFound();
  }
  const request = plan.selection?.request;
  if (!request) return notFound();
  if ((request.only ?? []).length > 0) return reportError(ctx, ctx.json, "RUN_USED_ONLY", t("profiles_save_only", { run: runId }), t("profiles_save_only_fix"), EXIT_USAGE);
  const from = plan.profile?.id ?? request.profile ?? "standard";
  const skip = parseSkipList(request.skip ?? []);
  const str = (name: string): { [k: string]: string } => (typeof ctx.options[name] === "string" ? { [name]: ctx.options[name] as string } : {});
  const result = createProfile(projectDir, id, {
    from,
    skip,
    ...str("label"),
    description: typeof ctx.options.description === "string" ? ctx.options.description : t("profiles_save_description", { run: runId }),
    replace: ctx.options.replace === true,
    ...ifMatch(ctx),
  });
  if (ctx.json) ok(ctx, { projectDir, run: runId, from, skip, ...result });
  else ctx.stdout(t("profiles_saved", { id: result.id, file: result.file, run: runId, from: result.extends, count: skip.length }) + "\n");
  return 0;
}

function runSetDefault(ctx: CommandContext, projectDir: string, t: Translator): number {
  const id = ctx.args[1];
  if (id === undefined) return reportError(ctx, ctx.json, "PROFILE_ID_REQUIRED", t("profiles_missing_id"), t("profiles_missing_id_fix", { action: "set-default" }), EXIT_USAGE);
  const result = setDefaultProfile(projectDir, id, ifMatch(ctx));
  if (ctx.json) ok(ctx, { projectDir, ...result });
  else ctx.stdout(t(result.changed ? "profiles_default_set" : "profiles_unchanged", { id: result.default, file: result.file }) + "\n");
  return 0;
}

function runDelete(ctx: CommandContext, projectDir: string, t: Translator): number {
  const id = ctx.args[1];
  if (id === undefined) return reportError(ctx, ctx.json, "PROFILE_ID_REQUIRED", t("profiles_missing_id"), t("profiles_missing_id_fix", { action: "delete" }), EXIT_USAGE);
  const result = deleteProfile(projectDir, id, ifMatch(ctx));
  if (ctx.json) ok(ctx, { projectDir, ...result });
  else ctx.stdout(t("profiles_deleted", { id: result.id, file: result.file }) + "\n");
  return 0;
}

export const command: CommandModule = {
  name: "profiles",
  description: tr("profiles_description"),
  options: [
    { name: "cwd", type: "string", description: tr("profiles_option_cwd") },
    { name: "from", type: "string", description: tr("profiles_option_from") },
    { name: "skip", type: "string", description: tr("profiles_option_skip") },
    { name: "run", type: "string", description: tr("profiles_option_run") },
    { name: "as", type: "string", description: tr("profiles_option_as") },
    { name: "label", type: "string", description: tr("profiles_option_label") },
    { name: "description", type: "string", description: tr("profiles_option_description") },
    { name: "replace", type: "boolean", description: tr("profiles_option_replace") },
    { name: "if-match", type: "string", description: tr("profiles_option_if_match") },
    { name: "no-interactive", type: "boolean", description: tr("profiles_option_no_interactive") },
  ],
  run(ctx) {
    const t = tr;
    const usage = (code: string, key: string, params: Record<string, string> = {}) => reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);
    const action = ctx.args[0] ?? "list";
    const handler = Object.hasOwn(SUBCOMMANDS, action) ? SUBCOMMANDS[action] : undefined;
    if (!handler) return usage("UNKNOWN_ACTION", "profiles_unknown_action", { name: action });
    const extra = ctx.args[1 + handler.args];
    if (extra !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("profiles_unexpected_argument", { name: extra }), t("profiles_usage"), EXIT_USAGE);
    for (const name of VALUE_OPTIONS) {
      if (ctx.options[name] !== undefined && !handler.options.includes(name)) return usage("OPTION_NOT_SUPPORTED", "profiles_option_not_supported", { name, action });
    }
    const cwdOption = ctx.options.cwd;
    const projectDir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(projectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return usage("BAD_CWD", "profiles_bad_cwd", { path: projectDir });
    try {
      return handler.run(ctx, projectDir, t);
    } catch (error) {
      if (error instanceof ProfileError) return reportProfileError(ctx, error);
      throw error;
    }
  },
};
