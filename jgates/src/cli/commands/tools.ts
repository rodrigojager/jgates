import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator, type Translator } from "../../i18n/index.js";
import { createCoreCatalog } from "../../core/catalog/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { resolveToolBindings, type ResolvedBinding, type ToolInstance } from "../../core/tools/index.js";
import { buildMatrix, renderMatrixMarkdown, verifyMatrix } from "../../core/matrix/index.js";
import { PrepareError, prepareInstance, previewPrepare } from "../../core/prepare/index.js";
import { decodeBytes, DocumentError, openDocument, saveDocument, validateDocument, type DocumentValidation } from "../../core/documents/index.js";

const tr = translator("tools");

/** Catalog with the core entries and the built-in adapters. */
export function builtinCatalog() {
  const catalog = createCoreCatalog();
  for (const manifest of builtinManifests()) catalog.addAdapter(manifest);
  return catalog;
}

/** Subcommands of `jgates tools`. `args` is the number of positionals after the subcommand name. */
interface Subcommand {
  run: (ctx: CommandContext, projectDir: string, t: Translator) => number | Promise<number>;
  args: number;
}

const summary = (i: ToolInstance) => ({
  id: i.id,
  adapter: i.adapter,
  component: i.component,
  componentRoot: i.componentRoot,
  runner: i.runner,
  enabled: i.enabled,
  required: i.required,
  supportLevel: i.supportLevel,
});

function runList(ctx: CommandContext, projectDir: string, t: Translator): number {
  const doc = builtinCatalog().toDocument();
  const resolved = resolveToolBindings(projectDir, { manifests: builtinManifests() });
  const instances = resolved.instances.map(summary);
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, ...doc, instances, diagnostics: resolved.diagnostics });
    return 0;
  }
  const lines = [t("tools_categories")];
  for (const c of doc.categories) lines.push(`  ${c.id.padEnd(16)}${c.label}`);
  lines.push("", t("tools_capabilities"));
  for (const c of doc.capabilities) lines.push(`  ${c.id.padEnd(16)}${c.label}`);
  lines.push("", t("tools_adapters"));
  for (const a of doc.adapters) lines.push(`  ${a.id.padEnd(16)}${a.displayName} (${a.subchecks?.length ?? 0} ${t("tools_subchecks")})`);
  lines.push("", t("tools_instances"));
  if (instances.length === 0) lines.push(`  ${t("tools_no_instances")}`);
  for (const i of instances) lines.push(`  ${i.id.padEnd(20)}${(i.component ?? "-").padEnd(14)}${i.runner.padEnd(12)}${t(`tools_support_${i.supportLevel}`)}`);
  ctx.stdout(lines.join("\n") + "\n");
  return 0;
}

function runMatrix(ctx: CommandContext): number {
  const matrix = buildMatrix();
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, matrix, problems: verifyMatrix(matrix) });
    return 0;
  }
  ctx.stdout(renderMatrixMarkdown(matrix, "pt-BR"));
  return 0;
}

function runInspect(ctx: CommandContext, projectDir: string, t: Translator): number {
  const name = ctx.args[1];
  if (!name) return reportError(ctx, ctx.json, "MISSING_INSTANCE", t("tools_missing_instance"), t("tools_missing_instance_fix"), EXIT_USAGE);
  const resolved = resolveToolBindings(projectDir, { manifests: builtinManifests() });
  const instance = resolved.instances.find((i) => i.id === name);
  if (!instance) {
    const available = resolved.instances.map((i) => i.id).join(", ") || "-";
    return reportError(ctx, ctx.json, "INSTANCE_NOT_FOUND", t("tools_instance_not_found", { name }), t("tools_instance_not_found_fix", { available }), EXIT_USAGE);
  }
  const diagnostics = resolved.diagnostics.filter((d) => d.pathSegments[0] !== "tools" || d.pathSegments[1] === instance.id);
  if (ctx.json) {
    writeJson(ctx, {
      schemaVersion: 1,
      status: "OK",
      tool: "jgates",
      version: ctx.version,
      instance: { ...summary(instance), base: instance.base, bindings: instance.bindings },
      externalRoots: resolved.externalRoots,
      diagnostics,
    });
    return 0;
  }
  const lines = [`${instance.id}  (${instance.adapter}, ${t(`tools_support_${instance.supportLevel}`)})`];
  for (const b of instance.bindings) {
    const state = b.refused ? t("tools_refused") : b.exists ? t("tools_exists") : t("tools_absent");
    lines.push(`  ${t("tools_inspect_binding")} ${b.id}  ${b.role}  ${b.access}  ${b.relPath ?? b.absPath}  [${state}]`);
    for (const f of b.files) lines.push(`    ${f.path}`);
  }
  for (const d of diagnostics) lines.push(`  ! ${d.code}: ${d.message}`);
  ctx.stdout(lines.join("\n") + "\n");
  return 0;
}

/** Options that only `tools config` takes. */
const CONFIG_OPTIONS = ["file", "entry", "from", "if-match", "allow-invalid"];
const BINDING_ID = /^[a-z0-9][a-z0-9._-]*$/;
const ROLES = new Set(["primary", "support", "rules", "ignore"]);
const REVISION = /^[0-9a-f]{64}$/;

function ok(ctx: CommandContext, payload: Record<string, unknown>): number {
  writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, ...payload });
  return 0;
}

function reportDocumentError(ctx: CommandContext, error: DocumentError): number {
  if (ctx.json) writeJson(ctx, { ...errorPayload(error.code, error.message, error.fix, EXIT_USAGE), ...error.details });
  else ctx.stderr(`ERROR ${error.code}\n${error.message}\n${error.fix ?? ""}\n`);
  return EXIT_USAGE;
}

/**
 * Maps --file to a binding of the instance. The value is a binding id (or a role such as "primary" when exactly one
 * binding has it), never a path: anything that looks like a path is refused with exit 3.
 */
function pickBinding(ctx: CommandContext, projectDir: string, instance: ToolInstance, value: string, t: Translator): ResolvedBinding | number {
  const ids = instance.bindings.map((b) => b.id);
  const available = ids.join(", ") || "-";
  const notId = () => reportError(ctx, ctx.json, "FILE_NOT_BINDING_ID", t("tools_file_not_binding_id", { value }), t("tools_file_not_binding_id_fix", { available }), EXIT_USAGE);
  if (!BINDING_ID.test(value)) return notId();
  const byId = instance.bindings.find((b) => b.id === value);
  if (byId) return byId;
  if (ROLES.has(value)) {
    const withRole = instance.bindings.filter((b) => b.role === value);
    if (withRole.length === 1) return withRole[0] as ResolvedBinding;
  }
  const looksLikePath =
    instance.bindings.some((b) => b.declared === value || b.relPath === value || path.basename(b.declared) === value) || fs.existsSync(path.join(projectDir, value));
  if (looksLikePath) return notId();
  return reportError(ctx, ctx.json, "BINDING_NOT_FOUND", t("tools_binding_not_found", { binding: value, instance: instance.id }), t("tools_file_not_binding_id_fix", { available }), EXIT_USAGE);
}

/** Text to write: --from <file>, --from - or stdin. */
function readInput(ctx: CommandContext, t: Translator): string | number {
  const from = ctx.options.from;
  let bytes: Buffer;
  try {
    if (typeof from === "string" && from !== "-") bytes = fs.readFileSync(path.resolve(from));
    else {
      if (process.stdin.isTTY) return reportError(ctx, ctx.json, "INPUT_REQUIRED", t("tools_input_required"), t("tools_input_required_fix"), EXIT_USAGE);
      bytes = fs.readFileSync(0);
    }
  } catch (error) {
    return reportError(ctx, ctx.json, "INPUT_UNREADABLE", t("tools_input_unreadable", { detail: (error as Error).message }), t("tools_input_required_fix"), EXIT_USAGE);
  }
  const decoded = decodeBytes(bytes);
  if (decoded.text === null) return reportError(ctx, ctx.json, "INPUT_NOT_TEXT", t("tools_input_not_text"), t("tools_input_required_fix"), EXIT_USAGE);
  return decoded.text;
}

function configRead(ctx: CommandContext, projectDir: string, instance: ToolInstance, binding: ResolvedBinding, t: Translator): number {
  const entry = ctx.options.entry;
  const doc = openDocument(projectDir, instance.id, binding.id, typeof entry === "string" ? { entry } : {});
  if (ctx.json) return ok(ctx, { document: doc });
  if (!doc.exists) return reportError(ctx, false, "DOCUMENT_MISSING", t("tools_document_missing", { path: doc.relPath ?? doc.path }), t("tools_document_missing_fix"), EXIT_USAGE);
  if (doc.text === null) return reportError(ctx, false, "DOCUMENT_NOT_TEXT", t("tools_document_not_text", { path: doc.relPath ?? doc.path }), null, EXIT_USAGE);
  ctx.stdout(doc.text);
  ctx.stderr(`revision ${doc.revision}\n`);
  return 0;
}

type ValidateRow = (DocumentValidation & { binding: string; entry: string | null; exists: true }) | { binding: string; entry: string | null; exists: false; status: "missing" };

function validateOne(projectDir: string, instance: ToolInstance, binding: ResolvedBinding, entry: string | undefined, text: string | undefined): ValidateRow {
  const opts = { ...(entry !== undefined ? { entry } : {}), ...(text !== undefined ? { text } : {}) };
  const result = text === undefined && !binding.exists ? null : validateDocument(projectDir, instance.id, binding.id, opts);
  if (!result) return { binding: binding.id, entry: entry ?? null, exists: false, status: "missing" };
  return { ...result, binding: binding.id, entry: entry ?? null, exists: true };
}

function configValidate(ctx: CommandContext, projectDir: string, instance: ToolInstance, binding: ResolvedBinding | null, t: Translator): number {
  const entryOption = typeof ctx.options.entry === "string" ? ctx.options.entry : undefined;
  let text: string | undefined;
  if (ctx.options.from !== undefined) {
    if (!binding) return reportError(ctx, ctx.json, "FILE_REQUIRED", t("tools_file_required", { action: "validate --from" }), t("tools_file_required_fix", { available: instance.bindings.map((b) => b.id).join(", ") || "-" }), EXIT_USAGE);
    const input = readInput(ctx, t);
    if (typeof input === "number") return input;
    text = input;
  }
  const rows: ValidateRow[] = [];
  const targets = binding ? [binding] : instance.bindings.filter((b) => !b.refused);
  for (const b of targets) {
    if (b.kind === "directory" && (entryOption === undefined || !binding)) {
      for (const f of b.files) rows.push(validateOne(projectDir, instance, b, f.path, undefined));
    } else rows.push(validateOne(projectDir, instance, b, b.kind === "directory" ? entryOption : undefined, text));
  }
  const invalid = rows.some((r) => r.status === "invalid");
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status: invalid ? "INVALID" : "OK", tool: "jgates", version: ctx.version, instance: instance.id, results: rows });
    return invalid ? EXIT_USAGE : 0;
  }
  for (const r of rows) {
    const name = r.entry ? `${r.binding}/${r.entry}` : r.binding;
    if (!r.exists) ctx.stdout(`${name}: ${t("tools_validate_missing")}\n`);
    else if (r.status === "unavailable") ctx.stdout(`${name}: ${r.reason?.message ?? r.status}\n`);
    else ctx.stdout(`${name}: ${t(`tools_validate_${r.status}`)}\n`);
    if (r.exists) for (const e of r.errors) ctx.stdout(`  ${e.line ?? "?"}:${e.column ?? "?"} ${e.message}\n`);
  }
  return invalid ? EXIT_USAGE : 0;
}

function configWrite(ctx: CommandContext, projectDir: string, instance: ToolInstance, binding: ResolvedBinding, t: Translator): number {
  const ifMatch = ctx.options["if-match"];
  if (typeof ifMatch !== "string") return reportError(ctx, ctx.json, "REVISION_REQUIRED", t("tools_revision_required"), t("tools_revision_required_fix"), EXIT_USAGE);
  if (ifMatch !== "absent" && !REVISION.test(ifMatch)) return reportError(ctx, ctx.json, "REVISION_INVALID", t("tools_revision_invalid", { value: ifMatch }), t("tools_revision_required_fix"), EXIT_USAGE);
  const input = readInput(ctx, t);
  if (typeof input === "number") return input;
  const entry = ctx.options.entry;
  const result = saveDocument(projectDir, instance.id, binding.id, {
    expectedRevision: ifMatch === "absent" ? null : ifMatch,
    text: input,
    ...(typeof entry === "string" ? { entry } : {}),
    ...(ctx.options["allow-invalid"] === true ? { allowInvalid: true } : {}),
  });
  if (result.status === "conflict") {
    const message = t("tools_conflict", { binding: binding.id, instance: instance.id });
    if (ctx.json) writeJson(ctx, { ...errorPayload("REVISION_CONFLICT", message, t("tools_conflict_fix"), EXIT_USAGE), ref: result.ref, identity: result.identity, conflict: result.conflict, diff: result.diff });
    else ctx.stderr(`ERROR REVISION_CONFLICT\n${message}\n${t("tools_conflict_fix")}\n${result.diff}`);
    return EXIT_USAGE;
  }
  if (ctx.json) {
    const { status, ...rest } = result;
    return ok(ctx, { result: status, ...rest });
  }
  ctx.stdout(`${t(result.status === "saved" ? "tools_saved" : "tools_unchanged", { binding: binding.id, revision: result.revision })}\n`);
  return 0;
}

function runConfig(ctx: CommandContext, projectDir: string, t: Translator): number {
  const action = ctx.args[1];
  const name = ctx.args[2];
  if (action !== "read" && action !== "validate" && action !== "write") {
    return reportError(ctx, ctx.json, "UNKNOWN_ACTION", t("tools_config_unknown_action", { name: action ?? "-" }), t("tools_config_usage"), EXIT_USAGE);
  }
  if (!name) return reportError(ctx, ctx.json, "MISSING_INSTANCE", t("tools_missing_instance"), t("tools_config_usage"), EXIT_USAGE);
  const resolved = resolveToolBindings(projectDir, { skipInventory: true });
  const instance = resolved.instances.find((i) => i.id === name);
  if (!instance) {
    const available = resolved.instances.map((i) => i.id).join(", ") || "-";
    return reportError(ctx, ctx.json, "INSTANCE_NOT_FOUND", t("tools_instance_not_found", { name }), t("tools_instance_not_found_fix", { available }), EXIT_USAGE);
  }
  const fileOption = ctx.options.file;
  let binding: ResolvedBinding | null = null;
  if (typeof fileOption === "string") {
    const picked = pickBinding(ctx, projectDir, instance, fileOption, t);
    if (typeof picked === "number") return picked;
    binding = picked;
  } else if (action === "write" || (action === "read" && instance.bindings.length !== 1)) {
    return reportError(ctx, ctx.json, "FILE_REQUIRED", t("tools_file_required", { action }), t("tools_file_required_fix", { available: instance.bindings.map((b) => b.id).join(", ") || "-" }), EXIT_USAGE);
  } else if (action === "read") binding = instance.bindings[0] as ResolvedBinding;
  try {
    if (action === "read") return configRead(ctx, projectDir, instance, binding as ResolvedBinding, t);
    if (action === "validate") return configValidate(ctx, projectDir, instance, binding, t);
    return configWrite(ctx, projectDir, instance, binding as ResolvedBinding, t);
  } catch (error) {
    if (error instanceof DocumentError) return reportDocumentError(ctx, error);
    throw error;
  }
}

/** Asks y/N on the terminal; anything but yes is a no. Only used when stdin is a TTY and --no-interactive is absent. */
async function confirm(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "s" || answer === "sim" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * `tools prepare --instance <id>`: the only step that downloads. It shows the versions and the network first;
 * --dry-run stops there. Without --no-interactive on a terminal it also asks for a yes.
 */
async function runPrepare(ctx: CommandContext, projectDir: string, t: Translator): Promise<number> {
  const instance = ctx.options.instance;
  if (typeof instance !== "string" || instance === "") return reportError(ctx, ctx.json, "MISSING_INSTANCE", t("tools_prepare_missing_instance"), t("tools_prepare_usage"), EXIT_USAGE);
  const failure = (error: PrepareError) => {
    if (ctx.json) writeJson(ctx, { ...errorPayload(error.code, error.message, error.fix, EXIT_USAGE), ...error.details });
    else ctx.stderr(`ERROR ${error.code}\n${error.message}\n${error.fix ?? ""}\n`);
    return EXIT_USAGE;
  };
  const image = typeof ctx.options.image === "string" && ctx.options.image !== "" ? ctx.options.image : undefined;
  const options = { ...(image ? { image } : {}) };
  try {
    const preview = previewPrepare(projectDir, instance, options);
    if (!ctx.json) {
      ctx.stdout(`${t("tools_prepare_header", { instance: preview.instance, adapter: preview.adapter })}\n`);
      ctx.stdout(`${t("tools_prepare_versions", { tool: preview.versions.tool, installed: preview.versions.installed ?? "-", range: preview.versions.range, pinned: preview.versions.pinned ?? "-" })}\n`);
      if (preview.rules) ctx.stdout(`${t("tools_prepare_network", { ref: preview.rules.ref, url: preview.rules.url })}\n`);
      if (preview.image) {
        ctx.stdout(`${t(preview.image.present ? "tools_prepare_image_present" : "tools_prepare_image_absent", { image: preview.image.reference ?? "-", id: preview.image.id ?? "-" })}\n`);
        ctx.stdout(`${preview.network.required ? t("tools_prepare_image_network", { hosts: preview.network.hosts.join(", ") }) : t("tools_prepare_image_no_network")}\n`);
      }
      ctx.stdout(`${t("tools_prepare_writes", { paths: preview.writes.join(", ") })}\n`);
    }
    if (ctx.options["dry-run"] === true) {
      if (ctx.json) return ok(ctx, { dryRun: true, preview });
      ctx.stdout(`${t("tools_prepare_dry_run")}\n`);
      return 0;
    }
    if (ctx.options["no-interactive"] !== true && process.stdin.isTTY && !ctx.json) {
      if (!(await confirm(t("tools_prepare_confirm")))) {
        ctx.stdout(`${t("tools_prepare_cancelled")}\n`);
        return EXIT_USAGE;
      }
    }
    const result = await prepareInstance(projectDir, instance, { ...options, allowVersionChange: ctx.options["allow-version-change"] === true });
    if (ctx.json) return ok(ctx, { dryRun: false, preview, result });
    if (result.image) {
      const key = result.changed ? "tools_prepare_image_done" : "tools_prepare_image_unchanged";
      ctx.stdout(`${t(key, { image: result.image.reference, pinned: result.image.pinned, version: result.toolVersion ?? "-", lock: result.lockFile })}\n`);
    } else if (result.rules) {
      ctx.stdout(`${t(result.changed ? "tools_prepare_done" : "tools_prepare_unchanged", { ref: result.rules.ref, hash: result.rules.hash, lock: result.lockFile })}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof PrepareError) return failure(error);
    throw error;
  }
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  prepare: { run: runPrepare, args: 0 },
  list: { run: runList, args: 0 },
  inspect: { run: runInspect, args: 1 },
  matrix: { run: runMatrix, args: 0 },
  config: { run: runConfig, args: 2 },
};

export const command: CommandModule = {
  name: "tools",
  description: tr("tools_description"),
  options: [
    { name: "cwd", type: "string", description: tr("tools_option_cwd") },
    { name: "file", type: "string", description: tr("tools_option_file") },
    { name: "entry", type: "string", description: tr("tools_option_entry") },
    { name: "from", type: "string", description: tr("tools_option_from") },
    { name: "if-match", type: "string", description: tr("tools_option_if_match") },
    { name: "allow-invalid", type: "boolean", description: tr("tools_option_allow_invalid") },
    { name: "no-interactive", type: "boolean", description: tr("tools_option_no_interactive") },
    { name: "instance", type: "string", description: tr("tools_option_instance") },
    { name: "dry-run", type: "boolean", description: tr("tools_option_dry_run") },
    { name: "allow-version-change", type: "boolean", description: tr("tools_option_allow_version_change") },
    { name: "image", type: "string", description: tr("tools_option_image") },
  ],
  async run(ctx) {
    const t = tr;
    const action = ctx.args[0] ?? "list";
    const handler = Object.hasOwn(SUBCOMMANDS, action) ? SUBCOMMANDS[action] : undefined;
    if (!handler) return reportError(ctx, ctx.json, "UNKNOWN_ACTION", t("tools_unknown_action", { name: action }), t("tools_unknown_action_fix"), EXIT_USAGE);
    const extra = ctx.args[1 + handler.args];
    if (extra !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("tools_unexpected_argument", { name: extra }), t("tools_unexpected_argument_fix"), EXIT_USAGE);
    if (action !== "config") {
      const misplaced = CONFIG_OPTIONS.find((o) => ctx.options[o] !== undefined);
      if (misplaced) return reportError(ctx, ctx.json, "OPTION_NOT_SUPPORTED", t("tools_option_not_supported", { name: misplaced, action }), t("tools_config_usage"), EXIT_USAGE);
    }
    const cwdOption = ctx.options.cwd;
    const projectDir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    let isDir = false;
    try {
      isDir = fs.statSync(projectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return reportError(ctx, ctx.json, "BAD_CWD", t("tools_bad_cwd", { path: projectDir }), t("tools_bad_cwd_fix"), EXIT_USAGE);
    return await handler.run(ctx, projectDir, t);
  },
};
