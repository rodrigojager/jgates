import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_INTERNAL, EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator, type Translator } from "../../i18n/index.js";
import { loadProjectConfig } from "../../core/config/load/index.js";
import { decodePointer, getField, resolveConfig, type ResolvedField, type ResolveResult } from "../../core/config/resolve/index.js";
import { BuiltinError } from "../../builtin/index.js";
import { parseSkipList, resolveSelection, skipOverrides, type SelectionIssue, type SelectionResult } from "../../core/selection/index.js";

const tr = translator("config");

/** Subcommands of `jgates config`; later tasks add entries. `args` is how many positional arguments it takes. */
interface Subcommand {
  run: (ctx: CommandContext, projectDir: string, t: Translator) => number | Promise<number>;
  args: number;
  /** Options besides --cwd and --json that the subcommand accepts. */
  options: string[];
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  validate: { run: runValidate, args: 0, options: [] },
  resolve: { run: runResolve, args: 0, options: ["profile", "explain", "skip"] },
  get: { run: runGet, args: 1, options: ["profile"] },
};

function runValidate(ctx: CommandContext, projectDir: string, t: Translator): number {
  const result = loadProjectConfig(projectDir);
  const valid = result.valid;
  if (ctx.json) {
    writeJson(ctx, {
      schemaVersion: 1,
      status: valid ? "OK" : "INVALID",
      tool: "jgates",
      version: ctx.version,
      valid,
      projectDir: result.projectDir,
      files: result.documents.map((d) => ({ file: d.file, kind: d.kind, schemaPending: d.schemaPending })),
      diagnostics: result.diagnostics,
    });
  } else if (valid) {
    ctx.stdout(t("config_valid", { count: result.documents.length }) + "\n");
  } else {
    ctx.stderr(t("config_invalid", { count: result.diagnostics.length }) + "\n");
    for (const d of result.diagnostics) {
      const where = `${d.file}${d.line ? `:${d.line}` : ""}${d.path ? ` (${d.path})` : ""}`;
      ctx.stderr(`[${t(`config_kind_${d.kind}`)}] ${where}: ${d.message}\n`);
    }
  }
  return valid ? 0 : EXIT_USAGE;
}

function resolveFor(ctx: CommandContext, projectDir: string): ResolveResult {
  const profile = ctx.options.profile;
  const skip = typeof ctx.options.skip === "string" ? parseSkipList([ctx.options.skip]) : [];
  return resolveConfig(projectDir, { ...(typeof profile === "string" ? { profile } : {}), ...(skip.length > 0 ? { overrides: skipOverrides(skip) } : {}) });
}

/** A failed resolution: the first error is the error of the command; every error and diagnostic goes along. */
function reportResolveFailure(ctx: CommandContext, result: ResolveResult, t: Translator): number {
  const first = result.errors[0] ?? { code: "RESOLVE_FAILED", message: t("config_resolve_failed", { count: 0 }) };
  if (ctx.json) {
    writeJson(ctx, {
      ...errorPayload(first.code, first.message, first.fix ?? null, EXIT_USAGE),
      projectDir: result.projectDir,
      errors: result.errors,
      warnings: result.warnings,
      diagnostics: result.diagnostics,
    });
  } else {
    ctx.stderr(`ERROR ${first.code}\n${t("config_resolve_failed", { count: result.errors.length })}\n`);
    for (const e of result.errors) ctx.stderr(`- ${e.message}${e.fix ? `\n  ${e.fix}` : ""}\n`);
    for (const d of result.diagnostics) ctx.stderr(`- ${d.file}${d.path ? ` (${d.path})` : ""}: ${d.message}\n`);
  }
  return EXIT_USAGE;
}

const show = (value: unknown): string => JSON.stringify(value);
const fileOf = (file: string | null, filePath: string | null): string => (file ? ` ${file}${filePath ? `#${filePath}` : ""}` : "");

function printField(ctx: CommandContext, field: ResolvedField, t: Translator): void {
  ctx.stdout(t("config_layer_line", { pointer: field.pointer, value: show(field.value), layer: field.layer, source: field.source, file: fileOf(field.file, field.path) }) + "\n");
  if (field.previous) {
    const p = field.previous;
    ctx.stdout(t("config_layer_previous", { value: show(p.value), layer: p.layer, source: p.source, file: fileOf(p.file, p.path) }) + "\n");
  }
}

function runResolve(ctx: CommandContext, projectDir: string, t: Translator): number {
  const result = resolveFor(ctx, projectDir);
  if (!result.ok) return reportResolveFailure(ctx, result, t);
  const explain = ctx.options.explain === true;
  const selection = resolveSelection(result);
  if (!selection.ok) return reportSelectionFailure(ctx, result, selection.errors);
  if (ctx.json) {
    writeJson(ctx, {
      schemaVersion: 1,
      status: "OK",
      tool: "jgates",
      version: ctx.version,
      projectDir: result.projectDir,
      profile: result.profile,
      templates: result.templates,
      layers: result.layers,
      config: result.config,
      ...(explain ? { fields: result.fields } : {}),
      selection: { items: selection.items, locks: selection.locks },
      warnings: result.warnings,
    });
    return 0;
  }
  ctx.stdout(t("config_resolved", { profile: result.profile?.id ?? "-", templates: result.templates.active.length, fields: Object.keys(result.fields).length }) + "\n");
  if (explain) {
    for (const field of Object.values(result.fields)) printField(ctx, field, t);
    printSelection(ctx, selection);
  } else ctx.stdout(`${JSON.stringify(result.config, null, 2)}\n`);
  for (const w of result.warnings) ctx.stderr(`WARNING ${w.code}: ${w.message}\n`);
  return 0;
}

/** A selector that names nothing or a locked requirement turned off: the first issue is the error, all go along. */
function reportSelectionFailure(ctx: CommandContext, result: ResolveResult, issues: SelectionIssue[]): number {
  const first = issues[0] as SelectionIssue;
  if (ctx.json) {
    writeJson(ctx, { ...errorPayload(first.code, first.message, first.fix ?? null, EXIT_USAGE), projectDir: result.projectDir, errors: issues });
  } else {
    ctx.stderr(`ERROR ${first.code}\n`);
    for (const e of issues) ctx.stderr(`- ${e.message}${e.fix ? `\n  ${e.fix}` : ""}\n`);
  }
  return EXIT_USAGE;
}

/** One line per check: the state and the decision that produced it (layer, source, file). */
function printSelection(ctx: CommandContext, selection: SelectionResult): void {
  const t = translator("selection");
  for (const item of selection.items) {
    const d = item.decision;
    const origin = d ? t("selection_origin", { decision: `${d.selector}=${String(d.value)}`, layer: d.layer, source: d.source, file: d.file ? ` ${d.file}${d.path ? `#${d.path}` : ""}` : "" }) : "";
    ctx.stdout(t("selection_item_line", { selector: item.selector, state: t(item.enabled ? "selection_state_on" : "selection_state_off"), reason: item.reason, origin }) + "\n");
  }
}

function runGet(ctx: CommandContext, projectDir: string, t: Translator): number {
  const pointer = ctx.args[1];
  const usage = (code: string, key: string, params: Record<string, string> = {}) =>
    reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);
  if (pointer === undefined) return usage("POINTER_REQUIRED", "config_get_pointer_required");
  if (!decodePointer(pointer)) return usage("BAD_POINTER", "config_get_bad_pointer", { pointer });
  const result = resolveFor(ctx, projectDir);
  if (!result.ok) return reportResolveFailure(ctx, result, t);
  const lookup = getField(result, pointer);
  if (!lookup.found) {
    const message = lookup.suggestion ? t("config_get_not_found_suggest", { pointer, suggestion: lookup.suggestion }) : t("config_get_not_found", { pointer });
    if (ctx.json) {
      writeJson(ctx, { ...errorPayload("POINTER_NOT_FOUND", message, t("config_get_not_found_fix"), EXIT_USAGE), pointer, ...(lookup.suggestion ? { suggestion: lookup.suggestion } : {}) });
    } else ctx.stderr(`ERROR POINTER_NOT_FOUND\n${message}\n${t("config_get_not_found_fix")}\n`);
    return EXIT_USAGE;
  }
  if (ctx.json) {
    const f = lookup.field;
    writeJson(ctx, {
      schemaVersion: 1,
      status: "OK",
      tool: "jgates",
      version: ctx.version,
      pointer,
      value: lookup.value,
      ...(f
        ? {
            layer: f.layer,
            source: f.source,
            file: f.file,
            path: f.path,
            ...(f.previous ? { previous: f.previous } : {}),
            history: f.history,
          }
        : { fields: lookup.fields }),
    });
    return 0;
  }
  if (lookup.field) printField(ctx, lookup.field, t);
  else for (const field of Object.values(lookup.fields ?? {})) printField(ctx, field, t);
  return 0;
}

export const command: CommandModule = {
  name: "config",
  description: tr("config_description"),
  options: [
    { name: "cwd", type: "string", description: tr("config_option_cwd") },
    { name: "profile", type: "string", description: tr("config_option_profile") },
    { name: "explain", type: "boolean", description: tr("config_option_explain") },
    { name: "skip", type: "string", description: tr("config_option_skip") },
  ],
  async run(ctx) {
    const t = tr;
    const usage = (code: string, key: string, params: Record<string, string> = {}) =>
      reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);

    const action = ctx.args[0] ?? "validate";
    const handler = Object.hasOwn(SUBCOMMANDS, action) ? SUBCOMMANDS[action] : undefined;
    if (!handler) return usage("UNKNOWN_ACTION", "config_unknown_action", { name: action });
    const extra = ctx.args[1 + handler.args];
    if (extra !== undefined) return usage("UNEXPECTED_ARGUMENT", "config_unexpected_argument", { name: extra });
    for (const name of ["profile", "explain", "skip"]) {
      if (ctx.options[name] !== undefined && !handler.options.includes(name)) return usage("OPTION_NOT_SUPPORTED", "config_option_not_supported", { name, action });
    }

    const cwdOption = ctx.options.cwd;
    const projectDir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(projectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return usage("BAD_CWD", "config_bad_cwd", { path: projectDir });
    try {
      return await handler.run(ctx, projectDir, t);
    } catch (error) {
      if (error instanceof BuiltinError) return reportError(ctx, ctx.json, "BUILTIN_INVALID", t("config_builtin_broken", { detail: error.message }), t("config_builtin_broken_fix"), EXIT_INTERNAL);
      throw error;
    }
  },
};
