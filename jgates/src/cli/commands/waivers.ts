// `jgates waivers list|add|remove`: the waivers of the project (.jgates/waivers.json), from the terminal. It does what the
// screens do, with the same core functions (core/waiver-file). `add` makes one entry per finding of a stored run, with a
// required reason and a required end date; it shows the entry and asks before writing (--yes skips the question, --json
// never asks). `remove` takes entries out. Both change that one file by exactly the entry and nothing else, never write
// outside the project, and are refused in governed (read-only) mode.
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import {
  commitChange,
  entryId,
  findRunResult,
  lastResult,
  listWaivers,
  prepareAdd,
  prepareRemove,
  readWaiverFile,
  type PreparedChange,
  type WaiverFileRefusal,
  type WaiverView,
} from "../../core/waiver-file/index.js";
import { confirmOnTerminal } from "./clean.js";

const t = translator("waivers");
const SUBCOMMANDS = ["list", "add", "remove"] as const;
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
function paramsOf(refusal: WaiverFileRefusal): Record<string, string | number> {
  const d = refusal.details;
  const out: Record<string, string | number> = { detail: refusal.message };
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  const candidates = d.candidates;
  if (Array.isArray(candidates)) {
    out.candidates = candidates
      .map((c) => (c && typeof c === "object" ? `${(c as Record<string, unknown>).fingerprint}  ${(c as Record<string, unknown>).tool}  ${(c as Record<string, unknown>).rule}  ${(c as Record<string, unknown>).path ?? ""}${(c as Record<string, unknown>).line ? `:${(c as Record<string, unknown>).line}` : ""}` : String(c)))
      .join("; ");
  }
  const problem = d.problem as { message?: string; line?: number; column?: number } | undefined;
  if (problem) {
    out.problem = problem.message ?? "";
    out.place = problem.line !== undefined ? t("waivers_place", { line: problem.line, column: problem.column ?? 1 }) : t("waivers_place_unknown");
  }
  return out;
}

const where = (w: WaiverView): string => {
  const file = w.path ?? "";
  const place = w.line !== undefined ? `${file}:${w.line}` : file;
  const rule = w.rule ?? "";
  return [w.tool && w.kind === "occurrence" ? `${w.tool}/${rule}` : rule, place].filter((s) => s !== "").join("  ");
};

function viewText(w: WaiverView): string {
  const matched = w.matched === null ? "" : w.matched ? `  ${t("waivers_text_matched", { count: w.matchedFindings })}` : `  ${t("waivers_text_unmatched")}`;
  const cause = w.cause ? ` (${t(`waivers_text_cause_${w.cause === "line-changed" ? "line_changed" : "count_changed"}`)})` : "";
  const until = w.expires ? t("waivers_text_until", { date: w.expires }) : t("waivers_text_no_date");
  const reviewed = w.reviewed ? `  [${t("waivers_text_reviewed", { count: w.reviewed })}]` : "";
  return `${w.id}  ${t(`waivers_text_state_${w.state}`)}${cause}  ${where(w)}  ${until}  "${w.reason ?? ""}"${matched}${reviewed}`;
}

export const command: CommandModule = {
  name: "waivers",
  description: t("waivers_description"),
  options: [
    { name: "cwd", type: "string", description: t("waivers_option_cwd") },
    { name: "finding", type: "string", description: t("waivers_option_finding") },
    { name: "run", type: "string", description: t("waivers_option_run") },
    { name: "until", type: "string", description: t("waivers_option_until") },
    { name: "reason", type: "string", description: t("waivers_option_reason") },
    { name: "yes", type: "boolean", description: t("waivers_option_yes") },
  ],
  async run(ctx) {
    const usage = (code: string, key: string, params: Record<string, string | number> = {}): number => reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);
    const refused = (r: WaiverFileRefusal): number => reportError(ctx, ctx.json, r.code, t(`waivers_refused_${r.code.toLowerCase()}`, paramsOf(r)), t(`waivers_refused_${r.code.toLowerCase()}_fix`, paramsOf(r)), EXIT_USAGE);
    const sub = ctx.args[0];
    if (sub === undefined) return usage("MISSING_SUBCOMMAND", "waivers_missing_subcommand");
    if (!(SUBCOMMANDS as readonly string[]).includes(sub)) return usage("UNKNOWN_SUBCOMMAND", "waivers_unknown_subcommand", { name: sub });
    const workspacePath = path.resolve(str(ctx, "cwd") ?? process.cwd());
    if (!isDirectory(workspacePath)) return usage("BAD_CWD", "waivers_bad_cwd", { path: workspacePath });
    const home = resolveHome();
    const wsId = workspaceId(workspacePath);
    const now = new Date();
    const base = { schemaVersion: 1 as const, status: "OK" as const, tool: "jgates", version: ctx.version, workspace: { id: wsId, path: workspacePath } };

    if (sub === "list") {
      if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "waivers_unexpected_argument", { name: ctx.args[1] });
      const read = readWaiverFile(workspacePath);
      if (!("target" in read)) return refused(read);
      const last = lastResult(home, wsId);
      const listing = listWaivers(read, last?.result ?? null, last?.runId ?? null, now);
      if (read.problem) {
        // The problem is reported with where it is; the file is never rewritten.
        return refused({ ok: false, code: "WAIVER_FILE_INVALID", message: read.problem.message, details: { file: read.file, problem: read.problem } });
      }
      if (ctx.json) {
        writeJson(ctx, { ...base, ...listing });
        return 0;
      }
      if (listing.waivers.length === 0) ctx.stdout(`${t("waivers_text_none", { file: read.file })}\n`);
      for (const w of listing.waivers) ctx.stdout(`${viewText(w)}\n`);
      if (listing.waivers.length > 0 && listing.runId === null) ctx.stdout(`${t("waivers_text_no_run")}\n`);
      return 0;
    }

    // add and remove write the project: never in governed (read-only) mode.
    const policyDir = process.env[POLICY_DIR_ENV];
    if (policyDir !== undefined && policyDir.trim() !== "") return usage("WAIVERS_READ_ONLY", "waivers_read_only", { env: POLICY_DIR_ENV });

    const finish = (prepared: PreparedChange): number => {
      const outcome = commitChange(prepared);
      if (!outcome.ok) return refused(outcome);
      if (ctx.json) {
        writeJson(ctx, {
          ...base,
          file: prepared.file,
          revision: outcome.revision,
          created: !prepared.existed,
          ...(prepared.kind === "add" ? { added: prepared.entries.map((e) => ({ id: entryId(e as unknown as Record<string, unknown>), ...e })) } : { removed: prepared.removed }),
        });
      } else if (prepared.kind === "add") {
        for (const e of prepared.entries) ctx.stdout(`${t("waivers_text_added", { id: entryId(e as unknown as Record<string, unknown>), rule: e.rule, path: e.path, date: e.expires, file: prepared.file })}\n`);
      } else {
        for (const w of prepared.removed) ctx.stdout(`${t("waivers_text_removed", { id: w.id, file: prepared.file })}\n`);
      }
      return 0;
    };

    if (sub === "remove") {
      const prepared = prepareRemove(workspacePath, { ids: ctx.args.slice(1), now });
      if (!prepared.ok) return refused(prepared);
      return finish(prepared);
    }

    // add
    if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "waivers_unexpected_argument", { name: ctx.args[1] });
    const run = findRunResult(home, wsId, str(ctx, "run"));
    if (!run.ok) return refused(run);
    const prepared = prepareAdd(workspacePath, { result: run.result, findings: ctx.lists.finding ?? [], until: str(ctx, "until"), reason: str(ctx, "reason"), now });
    if (!prepared.ok) return refused(prepared);
    if (!ctx.json) {
      ctx.stdout(`${t("waivers_text_preview", { file: prepared.file, run: run.runId })}\n`);
      for (const e of prepared.entries) ctx.stdout(`${JSON.stringify(e, null, 2)}\n`);
      ctx.stdout(`${prepared.diff}\n`);
      // A waiver never makes a check pass: say so when a finding belongs to a check that did not complete.
      const chosen = new Set(prepared.entries.map((e) => e.fingerprint));
      const incomplete = (run.result.findings ?? []).filter((f) => f.fingerprint && chosen.has(f.fingerprint) && (run.result.stages ?? []).some((s) => s.id === f.stageId && s.state !== "completed"));
      if (incomplete.length > 0) ctx.stdout(`${t("waivers_text_incomplete_check")}\n`);
      if (ctx.options.yes !== true) {
        if (process.stdin.isTTY !== true) return usage("WAIVER_CONFIRMATION_REQUIRED", "waivers_confirmation_required");
        if (!(await confirmOnTerminal(t("waivers_confirm", { file: prepared.file })))) {
          ctx.stdout(`${t("waivers_text_nothing_written")}\n`);
          return 0;
        }
      }
    }
    return finish(prepared);
  },
};
