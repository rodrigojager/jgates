// `jgates coverage asvs`: the ASVS coverage map of the project from the terminal. For the project's ASVS version and a
// level, every requirement in one of five states (examined, unexamined, unsupported, not applicable, awaiting evidence),
// each with its reason and the checks behind it, built from the stored runs by the same core function the server route
// calls (core/coverage/asvs, buildAsvsMap). It never says the project complies and always exits 0 when the map was built.
//
//   jgates coverage asvs [--level 1|2|3] [--run <id>] [--semantic-run <id>]... [--state <state>] [--chapter <id>]
//                        [--subdimension <id>] [--with-suggestion] [--deterministic-only] [--json]
//   jgates coverage asvs level <1|2|3>                       records the project's level
//   jgates coverage asvs not-applicable <id> --reason "..."  records that a requirement, section or chapter does not apply
//   jgates coverage asvs not-applicable <id> --from-suggestion
//                                                            the same, with the reason of the suggestion the map carries
//   jgates coverage asvs not-applicable <id> --remove        takes that decision out
//   jgates coverage asvs undo <token>                        puts .jgates/asvs.json back as it was before a write
//
// The text prints the suggestions of "not applicable" after the totals (a section or chapter whose requirements all
// carry the same suggestion once); JGates only suggests, and nothing is recorded until the user confirms.
// A write shows the entry and the change of the file and asks first (--yes writes without asking, --json never asks,
// --preview shows and writes nothing); it changes .jgates/asvs.json by that entry and nothing else and is refused in
// governed (read-only) mode.
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import {
  buildAsvsMap,
  commitDecision,
  loadAsvs,
  parseUndoToken,
  prepareLevel,
  prepareNotApplicable,
  prepareRemoveNotApplicable,
  readAsvsDecisions,
  suggestionOfTarget,
  undoDecision,
  undoToken,
  AsvsDataError,
  DEFAULT_ASVS_VERSION,
  type AsvsDecisionRefusal,
  type AsvsMapAnswer,
  type AsvsMapRefusal,
  type AsvsMapRequest,
  type AsvsRequirementRow,
  type PreparedDecision,
} from "../../core/coverage/asvs/index.js";
import { confirmOnTerminal } from "./clean.js";

const t = translator("coverage");
const MAPS = ["asvs"] as const;
const SUBCOMMANDS = ["level", "not-applicable", "undo"] as const;
/** The environment variable of the governed (read-only) mode: the CI policy lives outside the project. */
const POLICY_DIR_ENV = "JGATES_POLICY_DIR";

const str = (ctx: CommandContext, name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The parameters a refusal's message names, as text. */
function paramsOf(refusal: AsvsDecisionRefusal | AsvsMapRefusal): Record<string, string | number> {
  const out: Record<string, string | number> = { detail: refusal.message };
  for (const [k, v] of Object.entries(refusal.details)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  const problem = (refusal.details as Record<string, unknown>).problem as { message?: string; line?: number; column?: number } | undefined;
  if (problem && typeof problem === "object") {
    out.problem = problem.message ?? "";
    out.place = problem.line !== undefined ? t("coverage_place", { line: problem.line, column: problem.column ?? 1 }) : t("coverage_place_unknown");
  }
  return out;
}

const stateKey = (state: string): string => `coverage_state_${state.replace(/-/g, "_")}`;

function mapText(ctx: CommandContext, map: AsvsMapAnswer): void {
  const out = (line = ""): void => ctx.stdout(`${line}\n`);
  out(t("coverage_text_title", { version: map.asvsVersion, level: map.level }) + ` (${t(`coverage_text_level_${map.levelSource}`)})`);
  out(map.statement);
  if (map.deterministicOnly) out(t("coverage_text_deterministic_only"));
  const q = map.runs.quality;
  out(q ? t("coverage_text_runs_quality", { run: q.runId, revision: q.revision ?? t("coverage_text_revision_unknown") }) : t("coverage_text_runs_no_quality"));
  if (map.runs.semantic.length === 0) out(t("coverage_text_runs_no_semantic"));
  for (const s of map.runs.semantic) out(t("coverage_text_runs_semantic", { run: s.runId, methods: s.methods.join(", ") || "-", revision: s.revision ?? t("coverage_text_revision_unknown") }));
  for (const w of map.warnings) out(t("coverage_text_warning", { message: w.message }));
  out(t("coverage_text_totals", { ...map.totals }));
  suggestionsText(out, map);
  if (map.filters.withSuggestion) out(t("coverage_text_with_suggestion"));
  const shown = new Set(map.requirements.map((r) => r.id));
  if (shown.size === 0) out(t("coverage_text_no_rows"));
  for (const chapter of map.chapters) {
    const rows = map.requirements.filter((r) => r.chapter === chapter.id);
    if (rows.length === 0) continue;
    out();
    out(`${chapter.id} ${chapter.name}`);
    for (const row of rows) rowText(out, row);
  }
  out();
  out(t("coverage_text_attribution", { version: map.source.version, licence: map.source.licence, sourceUrl: map.source.sourceUrl, licenceUrl: map.source.licenceUrl }));
}

/**
 * The suggestions of "not applicable", after the totals: a chapter whose requirements all carry the same suggestion
 * once, then a section the same way, then each requirement left. Nothing when there is none.
 */
function suggestionsText(out: (line?: string) => void, map: AsvsMapAnswer): void {
  const lines: string[] = [];
  const offeredChapters = new Set<string>();
  const offeredSections = new Set<string>();
  for (const chapter of map.chapters) {
    if (chapter.suggestion) {
      offeredChapters.add(chapter.id);
      lines.push(t("coverage_text_suggestion_chapter", { id: chapter.id, reason: chapter.suggestion.reason }));
      continue;
    }
    for (const section of chapter.sections) {
      if (!section.suggestion) continue;
      offeredSections.add(section.id);
      lines.push(t("coverage_text_suggestion_section", { id: section.id, reason: section.suggestion.reason }));
    }
  }
  for (const row of map.requirements) {
    if (!row.suggestion || offeredChapters.has(row.chapter) || offeredSections.has(row.section)) continue;
    lines.push(t("coverage_text_suggestion_requirement", { id: row.id, reason: row.suggestion.reason }));
  }
  if (lines.length === 0) return;
  out(t("coverage_text_suggestions_title", { count: lines.length }));
  for (const line of lines) out(line);
  out(t("coverage_text_suggestion_accept"));
}

function rowText(out: (line?: string) => void, row: AsvsRequirementRow): void {
  out(`  ${row.id}  L${row.level}  ${t(stateKey(row.state))}: ${row.reason}`);
  out(`      ${row.text}`);
  if (row.suggestion) out(`      ${t("coverage_text_row_suggestion", { reason: row.suggestion.reason })}`);
  // A check of a language the project lacks bears on nothing here: it stays in the JSON only.
  for (const c of row.checks.filter((check) => check.relevant)) {
    const name = c.category ? `${c.id} (${c.category})` : c.id;
    out(`      - ${name}: ${c.reason}`);
    if (c.ran) {
      out(`        ${t("coverage_text_check_covers", { covers: c.covers, misses: c.misses, depth: t(`coverage_text_depth_${c.depth}`), basis: t(`coverage_basis_${c.basis.replace(/-/g, "_")}`) })}`);
      if (c.openFindings !== null) out(`        ${t("coverage_text_open_findings", { count: c.openFindings })}`);
    }
  }
}

export const command: CommandModule = {
  name: "coverage",
  description: t("coverage_description"),
  options: [
    { name: "cwd", type: "string", description: t("coverage_option_cwd") },
    { name: "level", type: "string", description: t("coverage_option_level") },
    { name: "run", type: "string", description: t("coverage_option_run") },
    { name: "semantic-run", type: "string", description: t("coverage_option_semantic_run") },
    { name: "state", type: "string", description: t("coverage_option_state") },
    { name: "chapter", type: "string", description: t("coverage_option_chapter") },
    { name: "subdimension", type: "string", description: t("coverage_option_subdimension") },
    { name: "deterministic-only", type: "boolean", description: t("coverage_option_deterministic_only") },
    { name: "with-suggestion", type: "boolean", description: t("coverage_option_with_suggestion") },
    { name: "reason", type: "string", description: t("coverage_option_reason") },
    { name: "from-suggestion", type: "boolean", description: t("coverage_option_from_suggestion") },
    { name: "remove", type: "boolean", description: t("coverage_option_remove") },
    { name: "preview", type: "boolean", description: t("coverage_option_preview") },
    { name: "yes", type: "boolean", description: t("coverage_option_yes") },
  ],
  async run(ctx) {
    const usage = (code: string, key: string, params: Record<string, string | number> = {}): number => reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);
    const refused = (r: AsvsDecisionRefusal | AsvsMapRefusal): number => {
      const params = paramsOf(r);
      return reportError(ctx, ctx.json, r.code, t(`coverage_refused_${r.code.toLowerCase()}`, params), t(`coverage_refused_${r.code.toLowerCase()}_fix`, params), EXIT_USAGE);
    };
    const map = ctx.args[0];
    if (map === undefined) return usage("MISSING_MAP", "coverage_missing_map");
    if (!(MAPS as readonly string[]).includes(map)) return usage("UNKNOWN_MAP", "coverage_unknown_map", { name: map });
    const sub = ctx.args[1];
    if (sub !== undefined && !(SUBCOMMANDS as readonly string[]).includes(sub)) return usage("UNKNOWN_SUBCOMMAND", "coverage_unknown_subcommand", { name: sub });
    const workspacePath = path.resolve(str(ctx, "cwd") ?? process.cwd());
    if (!isDirectory(workspacePath)) return usage("BAD_CWD", "coverage_bad_cwd", { path: workspacePath });
    const home = resolveHome();
    const wsId = workspaceId(workspacePath);
    const base = { schemaVersion: 1 as const, status: "OK" as const, tool: "jgates", version: ctx.version, workspace: { id: wsId, path: workspacePath } };

    if (sub === undefined) {
      const request: AsvsMapRequest = { home, workspaceId: wsId, projectDir: workspacePath, deterministicOnly: ctx.options["deterministic-only"] === true };
      const level = str(ctx, "level");
      const runId = str(ctx, "run");
      const state = str(ctx, "state");
      const chapter = str(ctx, "chapter");
      const subdimension = str(ctx, "subdimension");
      const semanticRunIds = ctx.lists["semantic-run"] ?? [];
      if (level !== undefined) request.level = level;
      if (runId) request.runId = runId;
      if (semanticRunIds.length > 0) request.semanticRunIds = semanticRunIds;
      if (state !== undefined) request.state = state;
      if (chapter) request.chapter = chapter;
      if (subdimension) request.subdimension = subdimension;
      if (ctx.options["with-suggestion"] === true) request.withSuggestion = true;
      const answer = buildAsvsMap(request);
      if ("ok" in answer) return refused(answer);
      if (ctx.json) writeJson(ctx, { ...base, ...answer });
      else mapText(ctx, answer);
      return 0;
    }

    // level, not-applicable and undo write the project: never in governed (read-only) mode.
    const policyDir = process.env[POLICY_DIR_ENV];
    if (policyDir !== undefined && policyDir.trim() !== "") return usage("ASVS_READ_ONLY", "coverage_read_only", { env: POLICY_DIR_ENV });
    if (ctx.args[3] !== undefined) return usage("UNEXPECTED_ARGUMENT", "coverage_unexpected_argument", { name: ctx.args[3] });

    if (sub === "undo") {
      const token = ctx.args[2];
      if (token === undefined) return usage("ASVS_UNDO_TOKEN_REQUIRED", "coverage_undo_token_required");
      const undo = parseUndoToken(token);
      if (!undo) return refused({ ok: false, code: "ASVS_UNDO_INVALID", message: "the undo token is not valid", details: {} });
      const outcome = undoDecision(workspacePath, undo);
      if (!outcome.ok) return refused(outcome);
      if (ctx.json) writeJson(ctx, { ...base, file: undo.file, revision: outcome.revision, undone: true });
      else ctx.stdout(`${t("coverage_text_undone", { file: undo.file })}\n`);
      return 0;
    }

    const read = readAsvsDecisions(workspacePath);
    if ("code" in read) return refused(read);
    let prepared: PreparedDecision | AsvsDecisionRefusal;
    if (sub === "level") {
      prepared = prepareLevel(workspacePath, { level: ctx.args[2], version: read.problem ? DEFAULT_ASVS_VERSION : read.version });
    } else if (ctx.options.remove === true) {
      prepared = prepareRemoveNotApplicable(workspacePath, { id: ctx.args[2] });
    } else {
      let data;
      try {
        data = loadAsvs(read.problem ? DEFAULT_ASVS_VERSION : read.version);
      } catch (error) {
        if (!(error instanceof AsvsDataError)) throw error;
        data = loadAsvs(DEFAULT_ASVS_VERSION);
      }
      let reason = str(ctx, "reason");
      // Confirming a suggestion: the reason is the suggestion's own (an explicit --reason edits it); the write is the same.
      if (ctx.options["from-suggestion"] === true && reason === undefined && ctx.args[2] !== undefined) {
        const map = buildAsvsMap({ home, workspaceId: wsId, projectDir: workspacePath, level: 3, version: data.version });
        if ("ok" in map) return refused(map);
        const suggestion = suggestionOfTarget(map, ctx.args[2]);
        if (!suggestion) return refused({ ok: false, code: "ASVS_NO_SUGGESTION", message: `the map carries no suggestion for ${ctx.args[2]}`, details: { id: ctx.args[2] } });
        reason = suggestion.reason;
      }
      prepared = prepareNotApplicable(workspacePath, { data, id: ctx.args[2], reason, now: new Date() });
    }
    if (!prepared.ok) return refused(prepared);
    const change = prepared;
    const what = { kind: change.kind, file: change.file, entry: change.entry, level: change.level, diff: change.diff };

    const preview = ctx.options.preview === true;
    if (!ctx.json || preview) {
      if (!ctx.json) {
        ctx.stdout(`${t("coverage_text_preview", { file: change.file })}\n`);
        if (change.entry) ctx.stdout(`${JSON.stringify(change.entry, null, 2)}\n`);
        ctx.stdout(`${change.diff}\n`);
      }
      if (preview) {
        if (ctx.json) writeJson(ctx, { ...base, ...what, preview: true, written: false });
        else ctx.stdout(`${t("coverage_text_nothing_written")}\n`);
        return 0;
      }
      if (ctx.options.yes !== true) {
        if (process.stdin.isTTY !== true) return usage("ASVS_CONFIRMATION_REQUIRED", "coverage_confirmation_required");
        if (!(await confirmOnTerminal(t("coverage_confirm", { file: change.file })))) {
          ctx.stdout(`${t("coverage_text_nothing_written")}\n`);
          return 0;
        }
      }
    }
    const outcome = commitDecision(change);
    if (!outcome.ok) return refused(outcome);
    const token = undoToken(outcome.undo);
    if (ctx.json) {
      writeJson(ctx, { ...base, ...what, preview: false, written: true, created: !change.existed, revision: outcome.revision, undo: { token, ...outcome.undo } });
      return 0;
    }
    if (change.kind === "level") ctx.stdout(`${t("coverage_text_written_level", { level: change.level ?? "", file: change.file })}\n`);
    else if (change.kind === "remove") ctx.stdout(`${t("coverage_text_removed_not_applicable", { id: change.entry?.id ?? "", file: change.file })}\n`);
    else ctx.stdout(`${t("coverage_text_written_not_applicable", { id: change.entry?.id ?? "", file: change.file })}\n`);
    ctx.stdout(`${t("coverage_text_undo_hint", { token })}\n`);
    return 0;
  },
};
