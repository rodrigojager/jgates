// `jgates regressions list|show|validate|incorporate`: the explicit step that turns a test a Semantic method proposed
// (a property test, a validated reproducer) into a deterministic Quality regression of the project. Listing, showing and
// validating write nothing in the project (validate runs the test in a container of the tools image against an
// isolated copy of the working tree, never as a host process); only `incorporate <run>/<id> --approve` writes, after a fresh validation, and a later Quality run
// executes the regression with no model call. Without --approve nothing is executed or written.
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { findProposal, incorporateProposal, listProposals, readManifest, regressionTool, validateProposal, type ValidationRecord } from "../../core/regressions/index.js";

const t = translator("regressions");
const SUBCOMMANDS = ["list", "show", "validate", "incorporate"] as const;
const REF = /^sem_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}\/P[0-9]{1,3}$/;

const str = (ctx: CommandContext, name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The validation without the full output (shown separately in text mode). */
const validationView = (v: ValidationRecord) => ({ executedAt: v.executedAt, runtime: v.runtime, fixtureFiles: v.fixtureFiles, usable: v.usable, detectsDefect: v.detectsDefect, run: v.run });

function validationText(ctx: CommandContext, v: ValidationRecord): void {
  const r = v.run;
  const c = r.container;
  const where = c?.mode === "container" ? t("regressions_text_where_container", { image: c.image.replace(/^sha256:/, "").slice(0, 12), user: c.user }) : c?.mode === "in-image" ? t("regressions_text_where_in_image") : "";
  ctx.stdout(`${t(r.executed ? "regressions_text_validation" : "regressions_text_not_executed", { outcome: r.outcome, pass: r.tests?.pass ?? 0, total: r.tests?.total ?? 0, reason: r.reason ?? "-", where })}\n`);
  if (v.runtime.code) ctx.stdout(`${t("regressions_text_runtime_missing", { code: v.runtime.code })}\n`);
  if (r.dependenciesMissing) ctx.stdout(`${t("regressions_text_dependencies_not_prepared")}\n`);
  if (r.executed) ctx.stdout(`${t(v.detectsDefect ? "regressions_text_detects" : "regressions_text_passes_now")}\n`);
  if (r.output) ctx.stdout(`${r.output.split("\n").slice(0, 40).map((l) => `  | ${l}`).join("\n")}\n`);
}

export const command: CommandModule = {
  name: "regressions",
  description: t("regressions_description"),
  options: [
    { name: "cwd", type: "string", description: t("regressions_option_cwd") },
    { name: "approve", type: "boolean", description: t("regressions_option_approve") },
  ],
  async run(ctx) {
    const usage = (code: string, key: string, params: Record<string, string> = {}): number => reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);
    const sub = ctx.args[0];
    if (sub === undefined) return usage("MISSING_SUBCOMMAND", "regressions_missing_subcommand");
    if (!(SUBCOMMANDS as readonly string[]).includes(sub)) return usage("UNKNOWN_SUBCOMMAND", "regressions_unknown_subcommand", { name: sub });
    const workspacePath = path.resolve(str(ctx, "cwd") ?? process.cwd());
    if (!isDirectory(workspacePath)) return usage("BAD_CWD", "regressions_bad_cwd", { path: workspacePath });
    const home = resolveHome();
    const wsId = workspaceId(workspacePath);
    const base = { schemaVersion: 1 as const, status: "OK" as const, tool: "jgates", version: ctx.version, workspace: { id: wsId, path: workspacePath } };
    const manifest = readManifest(workspacePath);
    const incorporatedTool = (ref: string): string | null => {
      const tool = regressionTool(ref);
      return manifest.regressions.some((r) => r.tool === tool) ? tool : null;
    };

    if (sub === "list") {
      if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "regressions_unexpected_argument", { name: ctx.args[1] });
      const proposals = listProposals(home, wsId).map((p) => ({
        ref: p.ref,
        runId: p.runId,
        method: p.proposal.origin.method,
        file: p.proposal.file,
        title: p.proposal.title,
        candidate: p.proposal.origin.candidate,
        candidateStatus: p.proposal.origin.candidateStatus,
        executedByMethod: p.proposal.execution !== null,
        tampered: p.tampered,
        incorporated: incorporatedTool(p.ref),
      }));
      if (ctx.json) {
        writeJson(ctx, { ...base, proposals, incorporated: manifest.regressions.map((r) => ({ tool: r.tool, file: r.file, title: r.title, origin: r.origin, incorporatedAt: r.incorporatedAt })) });
        return 0;
      }
      if (proposals.length === 0) ctx.stdout(`${t("regressions_text_none")}\n`);
      for (const p of proposals) ctx.stdout(`${p.ref}  ${p.method}  ${p.file}  [${p.incorporated ? t("regressions_text_state_incorporated", { tool: p.incorporated }) : t("regressions_text_state_proposed")}]  ${p.title}\n`);
      if (manifest.regressions.length > 0) ctx.stdout(`${t("regressions_text_incorporated_count", { count: manifest.regressions.length })}\n`);
      return 0;
    }

    const ref = ctx.args[1];
    if (!ref) return usage("MISSING_PROPOSAL", "regressions_missing_proposal");
    if (!REF.test(ref)) return usage("BAD_PROPOSAL", "regressions_bad_proposal", { ref });
    if (ctx.args[2] !== undefined) return usage("UNEXPECTED_ARGUMENT", "regressions_unexpected_argument", { name: ctx.args[2] });

    if (sub === "incorporate") {
      // The approval comes first: without it nothing is looked up, executed or written.
      const result = await incorporateProposal({ workspacePath, home, workspaceId: wsId, ref, approve: ctx.options.approve === true });
      if (!result.ok) {
        const params = { ref, detail: result.detail };
        if (!ctx.json && result.validation) validationText(ctx, result.validation);
        return reportError(ctx, ctx.json, result.code, t(`regressions_refused_${result.code.toLowerCase()}`, params), t(`regressions_refused_${result.code.toLowerCase()}_fix`, params), EXIT_USAGE);
      }
      if (ctx.json) writeJson(ctx, { ...base, incorporated: result.regression, files: result.files, validation: validationView(result.validation) });
      else {
        validationText(ctx, result.validation);
        ctx.stdout(`${t("regressions_text_incorporated", { ref, tool: result.regression.tool })}\n`);
        for (const f of result.files) ctx.stdout(`  ${f}\n`);
        ctx.stdout(`${t("regressions_text_next")}\n`);
      }
      return 0;
    }

    const listed = findProposal(home, wsId, ref);
    if (!listed) return usage("PROPOSAL_NOT_FOUND", "regressions_refused_proposal_not_found", { ref, detail: ref });

    if (sub === "show") {
      if (ctx.json) writeJson(ctx, { ...base, ref, proposal: listed.proposal, tampered: listed.tampered, incorporated: incorporatedTool(ref) });
      else {
        const p = listed.proposal;
        ctx.stdout(`${ref}  ${p.title}\n${t("regressions_text_origin", { method: p.origin.method, run: p.origin.runId, candidate: p.origin.candidate ?? "-", status: p.origin.candidateStatus ?? "-" })}\n`);
        ctx.stdout(`${t(p.execution ? "regressions_text_method_executed" : "regressions_text_method_not_executed")}\n${p.rationale}\n--- ${p.file} (sha256 ${p.sha256}${listed.tampered ? `, ${t("regressions_text_tampered")}` : ""}) ---\n${p.content}\n`);
      }
      return 0;
    }

    // validate: a container of the tools image against an isolated copy of the working tree; nothing is written in the project.
    const validation = await validateProposal(workspacePath, listed, { workDir: path.join(home, "workspaces", wsId, "regressions", "work"), home });
    if (ctx.json) writeJson(ctx, { ...base, ref, validation: validationView(validation) });
    else validationText(ctx, validation);
    return validation.usable ? 0 : 1;
  },
};
