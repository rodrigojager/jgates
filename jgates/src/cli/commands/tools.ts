import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, errorPayload, reportError, writeJson } from "../output.js";
import { translator, type Translator } from "../../i18n/index.js";
import { createCoreCatalog } from "../../core/catalog/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { resolveToolBindings, type ResolvedBinding, type ToolInstance } from "../../core/tools/index.js";
import { buildMatrix, renderMatrixMarkdown, renderStackMatrixMarkdown, unitApplicability, verifyMatrix } from "../../core/matrix/index.js";
import { checkDistribution } from "../../core/distribution/index.js";
import { discoverWorkspace } from "../../core/discovery/index.js";
import { PrepareError, prepareInstance, previewPrepare } from "../../core/prepare/index.js";
import { decodeBytes, DocumentError, openDocument, saveDocument, validateDocument, type DocumentValidation } from "../../core/documents/index.js";

import { CODEQL_VOLUME, prepareCodeql, type PrepareResult } from "../../core/codeql-prepare/index.js";
import { exportImage, importImage, TransferError } from "../../core/lifecycle/transfer.js";
import { formatBytes } from "../../core/reasons/index.js";
import { buildExtension, CustomToolError, hasExtension, parseReport, planCustomTool, writeCustomTool, type CustomToolPlan, type CustomToolRequest } from "../../core/extension/index.js";
import { testTool } from "../../core/extension/test-tool.js";
import { toolsImageTarget } from "../../core/tools-image/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { DATABASE_IDS, updateData, type DatabaseId, type UpdateProgress, type UpdateResult } from "../../core/data/index.js";

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

/** `tools matrix`: adapters, capability-by-stack rows and, with --units, the per-unit applicability of --cwd. */
function runMatrix(ctx: CommandContext, projectDir: string): number {
  const matrix = buildMatrix();
  const applicability = ctx.options.units === true ? unitApplicability(discoverWorkspace(projectDir).inventory, matrix) : undefined;
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, matrix, problems: verifyMatrix(matrix), ...(applicability ? { applicability } : {}) });
    return 0;
  }
  ctx.stdout(renderMatrixMarkdown(matrix, "pt-BR"));
  ctx.stdout(`\n${renderStackMatrixMarkdown(matrix, "pt-BR")}`);
  for (const u of applicability ?? []) {
    ctx.stdout(`${tr("tools_matrix_unit", { unit: u.unit, root: u.componentRoot, language: u.language ?? "-", validated: u.validated.join(", ") || "-", gaps: u.gaps.join(", ") || "-" })}\n`);
  }
  return 0;
}

/**
 * `tools distribution [--packs <dir>[,<dir>...]]`: the distribution metadata of every built-in adapter and, for each
 * shipping folder given, every pack in it. Exit 1 when anything cannot ship.
 */
function runDistribution(ctx: CommandContext, projectDir: string, t: Translator): number {
  const packs = typeof ctx.options.packs === "string" ? ctx.options.packs.split(",").map((p) => p.trim()).filter(Boolean) : [];
  const report = checkDistribution({ roots: packs.map((p) => path.resolve(projectDir, p)) });
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status: report.ok ? "OK" : "FAILED", tool: "jgates", version: ctx.version, report });
    return report.ok ? 0 : 1;
  }
  if (report.ok) ctx.stdout(`${t("tools_distribution_ok", { adapters: report.adapters.length, packs: report.packs.length })}\n`);
  else {
    ctx.stdout(`${t("tools_distribution_failed", { count: report.problems.length })}\n`);
    for (const p of report.problems) ctx.stdout(`  ${p.code}  ${p.message}\n`);
    ctx.stdout(`${t("tools_distribution_fix")}\n`);
  }
  return report.ok ? 0 : 1;
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
  try {
    const preview = previewPrepare(projectDir, instance);
    if (!ctx.json) {
      ctx.stdout(`${t("tools_prepare_header", { instance: preview.instance, adapter: preview.adapter })}\n`);
      ctx.stdout(`${t("tools_prepare_versions", { tool: preview.versions.tool, installed: preview.versions.installed ?? "-", range: preview.versions.range, pinned: preview.versions.pinned ?? "-" })}\n`);
      ctx.stdout(`${t("tools_prepare_network", { ref: preview.rules.ref, url: preview.rules.url })}\n`);
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
    const result = await prepareInstance(projectDir, instance, { allowVersionChange: ctx.options["allow-version-change"] === true });
    if (ctx.json) return ok(ctx, { dryRun: false, preview, result });
    ctx.stdout(`${t(result.changed ? "tools_prepare_done" : "tools_prepare_unchanged", { ref: result.rules.ref, hash: result.rules.hash, lock: result.lockFile })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof PrepareError) return failure(error);
    throw error;
  }
}

/** `jgates tools update-data`: refreshes the advisory databases into the jgates-data volume (the only step with a network there). */
async function runUpdateData(ctx: CommandContext): Promise<number> {
  const d = translator("data");
  const requested = (ctx.lists.database ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const unknown = requested.find((v) => !(DATABASE_IDS as readonly string[]).includes(v));
  if (unknown) return reportError(ctx, ctx.json, "UNKNOWN_DATABASE", d("data_unknown_database", { name: unknown, known: DATABASE_IDS.join(", ") }), d("data_unknown_database", { name: unknown, known: DATABASE_IDS.join(", ") }), EXIT_USAGE);
  const progress = (event: UpdateProgress): void => {
    if (ctx.json) {
      ctx.stderr(JSON.stringify({ type: "data-update", ...event }) + "\n");
      return;
    }
    if (event.state === "started") ctx.stderr(d("data_update_started", { database: event.database }) + "\n");
  };
  let result: UpdateResult;
  try {
    result = await updateData({ env: process.env, version: ctx.version, ...(requested.length > 0 ? { only: requested as DatabaseId[] } : {}), onProgress: progress });
  } catch (error) {
    const message = d("data_engine_error", { error: error instanceof Error ? error.message : String(error) });
    return reportError(ctx, ctx.json, "DATA_UPDATE_FAILED", message, message, 2);
  }
  const failed = result.databases.filter((db) => !db.ok);
  const status = result.blocked || failed.length > 0 ? "INCOMPLETE" : "OK";
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status, tool: "jgates", version: ctx.version, databases: result.databases, ...(result.blocked ? { blocked: result.blocked } : {}) });
  } else if (result.blocked) {
    ctx.stderr(d("data_update_blocked", { reason: result.blocked }) + "\n");
  } else {
    const lines = result.databases.map((db) => (db.ok ? d("data_update_done", { database: db.id, date: db.fetchedAt ?? "-" }) : d("data_update_failed", { database: db.id, error: db.error ?? "-" })));
    lines.push(failed.length > 0 ? d("data_update_summary_failed", { failed: failed.length }) : d("data_update_summary_ok", { count: result.databases.length }));
    ctx.stdout(lines.join("\n") + "\n");
  }
  return status === "OK" ? 0 : 2;
}

/**
 * `jgates tools prepare-codeql [--accept-terms]`: prepares the CodeQL bundle into the jgates-codeql volume. Without an
 * acceptance of GitHub's CodeQL terms (now, or recorded earlier in the JGates data folder) it refuses and downloads nothing.
 */
async function runPrepareCodeql(ctx: CommandContext): Promise<number> {
  const c = translator("codeql");
  let result: PrepareResult;
  try {
    result = await prepareCodeql({ env: process.env, version: ctx.version, acceptTerms: ctx.options["accept-terms"] === true });
  } catch (error) {
    const message = c("codeql_prepare_engine_error", { error: error instanceof Error ? error.message : String(error) });
    return reportError(ctx, ctx.json, "CODEQL_PREPARE_FAILED", message, message, 2);
  }
  if (result.state === "refused") return reportError(ctx, ctx.json, "TERMS_NOT_ACCEPTED", result.message, result.message, EXIT_USAGE);
  const status = result.state === "prepared" ? "OK" : "INCOMPLETE";
  if (ctx.json) {
    writeJson(ctx, {
      schemaVersion: 1,
      status,
      tool: "jgates",
      version: ctx.version,
      source: result.source,
      termsAcceptedAt: result.acceptance?.acceptedAt ?? null,
      codeql: result.status ? { version: result.status.version, sha256: result.status.sha256, preparedAt: result.status.preparedAt, volume: CODEQL_VOLUME } : null,
      ...(result.state !== "prepared" ? { message: result.message, ...(result.error ? { error: result.error } : {}) } : {}),
    });
  } else {
    if (result.acceptance) ctx.stdout(c("codeql_prepare_accepted", { date: result.acceptance.acceptedAt }) + "\n");
    (result.state === "prepared" ? ctx.stdout : ctx.stderr)(result.message + "\n");
  }
  return status === "OK" ? 0 : 2;
}

/** `jgates tools export <file>` / `import <file>`: the tools image as a tarball plus its record, verified by digest on import. */
async function runTransfer(ctx: CommandContext, direction: "export" | "import"): Promise<number> {
  const l = translator("lifecycle");
  const file = ctx.args[1];
  if (!file) return reportError(ctx, ctx.json, "MISSING_FILE", l(`lifecycle_${direction}_usage`), l(`lifecycle_${direction}_usage`), EXIT_USAGE);
  try {
    if (direction === "export") {
      const record = await exportImage({ version: ctx.version, file });
      if (ctx.json) return ok(ctx, { file: path.resolve(file), record });
      ctx.stdout(l("lifecycle_export_done", { image: record.reference, file: path.resolve(file), sha256: record.sha256, size: formatBytes(record.bytes) }) + "\n");
      return 0;
    }
    const record = await importImage({ version: ctx.version, file });
    if (ctx.json) return ok(ctx, { file: path.resolve(file), verified: true, record, loadedId: record.loadedId });
    ctx.stdout(l("lifecycle_import_done", { image: record.reference, id: record.loadedId }) + "\n");
    return 0;
  } catch (error) {
    if (!(error instanceof TransferError)) throw error;
    const fix = error.code === "IMAGE_MISSING" ? translator("reasons")("reason_IMAGE_MISSING_action") : l("lifecycle_import_fix");
    if (ctx.json) writeJson(ctx, { ...errorPayload(error.code, error.message, fix, 2), ...(error.details ? { details: error.details } : {}) });
    else ctx.stderr(`ERROR ${error.code}\n${error.message}\n${fix}\n${error.details ? `${error.details}\n` : ""}`);
    return 2;
  }
}

const many = (ctx: CommandContext, name: string): string[] => [...(ctx.lists?.[name] ?? [])];

/** `tools add-custom <id> ...`: the tools.yml entry and, with --install, the Dockerfile lines of the user's own image. */
function runAddCustom(ctx: CommandContext, projectDir: string): number {
  const e = translator("extension");
  const usage = (code: string, key: string, params: Record<string, string | number> = {}, fixKey = "extension_add_usage"): number =>
    reportError(ctx, ctx.json, code, e(key, params), e(fixKey, params), EXIT_USAGE);
  const id = ctx.args[1];
  if (!id) return usage("MISSING_ID", "extension_add_missing_id");
  const str = (name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);
  let request: CustomToolRequest;
  try {
    const timeout = str("timeout");
    request = {
      id,
      ...(str("image") !== undefined ? { image: str("image") as string } : {}),
      install: many(ctx, "install"),
      command: str("command") ?? "",
      args: many(ctx, "arg"),
      report: parseReport(str("report") ?? "exit-code"),
      capabilities: many(ctx, "capability").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
      ...(str("component") !== undefined ? { component: str("component") as string } : {}),
      network: ctx.options.network === true,
      ...(timeout !== undefined ? { timeoutSeconds: /^\d+$/.test(timeout) ? Number(timeout) : Number.NaN } : {}),
    };
  } catch (error) {
    if (error instanceof CustomToolError) return usage(error.code, `extension_add_${error.code.toLowerCase()}`, error.params);
    throw error;
  }
  const known = new Set(builtinCatalog().toDocument().capabilities.map((c) => c.id));
  const unknown = request.capabilities.find((c) => !known.has(c));
  if (unknown) return usage("CAPABILITY_UNKNOWN", "extension_add_unknown_capability", { capability: unknown }, "extension_add_unknown_capability");
  if (request.component !== undefined) {
    let components: string[] = [];
    try {
      components = discoverWorkspace(projectDir).inventory.classifications.map((c) => c.id);
    } catch {
      components = [];
    }
    if (!components.includes(request.component)) return usage("COMPONENT_UNKNOWN", "extension_add_unknown_component", { component: request.component }, "extension_add_unknown_component");
  }
  let plan: CustomToolPlan;
  try {
    plan = planCustomTool(projectDir, request);
  } catch (error) {
    if (error instanceof CustomToolError) return usage(error.code, `extension_add_${error.code.toLowerCase()}`, error.params, error.code === "ID_EXISTS" ? "extension_add_id_exists_fix" : "extension_add_usage");
    throw error;
  }
  const dryRun = ctx.options["dry-run"] === true;
  const written = dryRun ? [] : writeCustomTool(projectDir, plan);
  if (ctx.json) {
    return ok(ctx, {
      dryRun,
      id: plan.id,
      image: plan.image,
      needsBuild: plan.needsBuild,
      dockerfileLines: plan.dockerfileLines,
      changes: plan.changes.map((c) => ({ file: c.file, created: c.before === null, diff: c.diff })),
      written,
    });
  }
  if (dryRun) {
    ctx.stdout(`${e("extension_add_dry_run")}\n`);
    for (const change of plan.changes) ctx.stdout(`\n${change.diff}${change.diff.endsWith("\n") ? "" : "\n"}`);
    return 0;
  }
  ctx.stdout(`${e("extension_add_written", { id: plan.id, files: written.join(", ") })}\n${e("extension_add_not_validated")}\n${e(plan.needsBuild ? "extension_add_next_build" : "extension_add_next_test", { id: plan.id })}\n`);
  return 0;
}

/** `tools build-extension [--yes]`: builds the project's own image from .jgates/image/Dockerfile. */
async function runBuildExtension(ctx: CommandContext, projectDir: string): Promise<number> {
  const e = translator("extension");
  if (!hasExtension(projectDir)) return reportError(ctx, ctx.json, "NO_EXTENSION", e("extension_build_none"), e("extension_build_none_fix"), EXIT_USAGE);
  if (!ctx.json) {
    const base = toolsImageTarget(process.env).reference;
    ctx.stdout(`${e("extension_build_plan", { dockerfile: ".jgates/image/Dockerfile", base })}\n`);
  }
  if (ctx.options.yes !== true) {
    if (ctx.options["no-interactive"] === true || ctx.json || !process.stdin.isTTY) return reportError(ctx, ctx.json, "CONFIRMATION_REQUIRED", e("extension_build_yes_required"), e("extension_build_yes_required"), EXIT_USAGE);
    if (!(await confirm(`${e("extension_build_confirm")} [s/N] `))) {
      ctx.stdout(`${e("extension_build_cancelled")}\n`);
      return EXIT_USAGE;
    }
  }
  const outcome = await buildExtension({
    projectDir,
    workspace: workspaceId(projectDir),
    env: process.env,
    version: ctx.version,
    ...(ctx.json ? {} : { onOutput: (chunk: string) => ctx.stderr(chunk) }),
  });
  if (!outcome.ok) {
    const code = outcome.error?.code ?? "BUILD_FAILED";
    const log = outcome.logFile ?? "-";
    const [message, fix] =
      code === "TOOLS_IMAGE_MISSING"
        ? [e("extension_build_no_tools_image"), e("extension_build_no_tools_image_fix")]
        : code === "DOCKERFILE_BASE"
          ? [e("extension_build_base_arg"), e("extension_build_base_arg_fix")]
          : code === "ENGINE_ERROR"
            ? [e("extension_build_engine", { detail: outcome.error?.details ?? outcome.error?.message ?? "-" }), e("extension_build_engine", { detail: outcome.error?.details ?? "-" })]
            : [e("extension_build_failed", { message: outcome.error?.message ?? "-" }), e("extension_build_failed_fix", { log })];
    if (ctx.json) writeJson(ctx, { ...errorPayload(code, message, fix, 2), details: outcome.error?.details ?? "", logFile: outcome.logFile });
    else ctx.stderr(`ERROR ${code}\n${message}\n${fix}\n${outcome.error?.details ? `${outcome.error.details}\n` : ""}`);
    return 2;
  }
  if (ctx.json) return ok(ctx, { built: outcome.built, tag: outcome.tag, key: outcome.key, digest: outcome.digest, base: outcome.base, logFile: outcome.logFile, removed: outcome.removed });
  if (!outcome.built) ctx.stdout(`${e("extension_build_current", { tag: outcome.tag ?? "-" })}\n`);
  else {
    ctx.stdout(`${e("extension_build_done", { tag: outcome.tag ?? "-", digest: outcome.digest ?? "-", log: outcome.logFile ?? "-" })}\n`);
    if (outcome.removed.length > 0) ctx.stdout(`${e("extension_build_removed", { tags: outcome.removed.join(", ") })}\n`);
  }
  return 0;
}

/** `tools test <instance>`: runs one tool once (building the image first when needed) and shows what its report gave. */
async function runTestTool(ctx: CommandContext, projectDir: string): Promise<number> {
  const e = translator("extension");
  const instance = ctx.args[1];
  if (!instance) return reportError(ctx, ctx.json, "MISSING_INSTANCE", e("extension_test_missing_instance"), e("extension_test_missing_instance"), EXIT_USAGE);
  if (!ctx.json) ctx.stderr(`${e("extension_test_building")}\n`);
  const result = await testTool({
    projectDir,
    instance,
    version: ctx.version,
    env: process.env,
    build: ctx.options["no-build"] !== true,
    ...(ctx.json ? {} : { onBuildOutput: (chunk: string) => ctx.stderr(chunk) }),
  });
  const blockers = result.blockers.map((b) => b.message).join(" ");
  if (ctx.json) {
    writeJson(ctx, { schemaVersion: 1, status: result.state === "ok" || result.state === "findings" ? "OK" : "INCOMPLETE", tool: "jgates", version: ctx.version, ...result });
  } else if (result.state === "not-found") ctx.stderr(`ERROR NOT_FOUND\n${e("extension_test_not_found", { instance, reason: result.reason ?? "-" })}\n${e("extension_test_not_found_fix")}\n`);
  else if (result.state === "build-failed") ctx.stderr(`ERROR BUILD_FAILED\n${e("extension_build_failed", { message: result.reason ?? "-" })}\n${result.build?.error?.details ?? ""}\n`);
  else if (result.state === "blocked") ctx.stderr(`ERROR BLOCKED\n${e("extension_test_blocked", { instance, blockers: blockers || (result.reason ?? "-") })}\n`);
  else if (result.state === "unreadable") ctx.stdout(`${e("extension_test_unreadable", { instance, reason: result.reason ?? "-" })}\n${e("extension_test_run", { runId: result.runId ?? "-", runDir: result.runDir ?? "-" })}\n`);
  else {
    ctx.stdout(`${result.state === "ok" ? e("extension_test_ok", { instance }) : e("extension_test_findings", { instance, count: result.findingCount, blocking: result.blockingCount })}\n`);
    for (const f of result.sample) ctx.stdout(`${e("extension_test_sample", { rule: f.rule, where: f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "-", message: f.message })}\n`);
    ctx.stdout(`${e("extension_test_run", { runId: result.runId ?? "-", runDir: result.runDir ?? "-" })}\n`);
  }
  return result.state === "ok" || result.state === "findings" ? 0 : result.state === "not-found" ? EXIT_USAGE : 2;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  "add-custom": { run: (ctx, dir) => runAddCustom(ctx, dir), args: 1 },
  "build-extension": { run: (ctx, dir) => runBuildExtension(ctx, dir), args: 0 },
  test: { run: (ctx, dir) => runTestTool(ctx, dir), args: 1 },
  export: { run: (ctx) => runTransfer(ctx, "export"), args: 1 },
  import: { run: (ctx) => runTransfer(ctx, "import"), args: 1 },
  "update-data": { run: (ctx) => runUpdateData(ctx), args: 0 },
  "prepare-codeql": { run: (ctx) => runPrepareCodeql(ctx), args: 0 },
  prepare: { run: runPrepare, args: 0 },
  list: { run: runList, args: 0 },
  inspect: { run: runInspect, args: 1 },
  matrix: { run: runMatrix, args: 0 },
  distribution: { run: runDistribution, args: 0 },
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
    { name: "units", type: "boolean", description: tr("tools_option_units") },
    { name: "packs", type: "string", description: tr("tools_option_packs") },
    { name: "database", type: "string", description: translator("data")("data_option_database") },
    { name: "accept-terms", type: "boolean", description: translator("codeql")("codeql_option_accept_terms") },
    { name: "image", type: "string", description: translator("extension")("extension_option_image") },
    { name: "install", type: "string", description: translator("extension")("extension_option_install") },
    { name: "command", type: "string", description: translator("extension")("extension_option_command") },
    { name: "arg", type: "string", description: translator("extension")("extension_option_arg") },
    { name: "report", type: "string", description: translator("extension")("extension_option_report") },
    { name: "capability", type: "string", description: translator("extension")("extension_option_capability") },
    { name: "component", type: "string", description: translator("extension")("extension_option_component") },
    { name: "network", type: "boolean", description: translator("extension")("extension_option_network") },
    { name: "timeout", type: "string", description: translator("extension")("extension_option_timeout") },
    { name: "yes", type: "boolean", description: translator("extension")("extension_option_yes") },
    { name: "no-build", type: "boolean", description: translator("extension")("extension_option_no_build") },
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
