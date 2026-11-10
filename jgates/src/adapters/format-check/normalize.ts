// Parsers of the "would reformat" output of the five formatters. Each one lists the files the formatter says it would
// change, fail-closed: an exit code or an output that does not explain itself is a problem (the stage is an error and
// proves nothing), never a clean result.
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import type { ResultFinding } from "../../core/run/types.js";

export const FORMATTERS = ["ruff", "prettier", "gofmt", "rustfmt", "dotnet"] as const;
export type Formatter = (typeof FORMATTERS)[number];

/** The name a formatter has in findings and in the result (the tool, not the setting). */
export const FORMATTER_TOOL: Record<Formatter, string> = { ruff: "ruff", prettier: "prettier", gofmt: "gofmt", rustfmt: "rustfmt", dotnet: "dotnet-format" };

export interface UnformattedFile {
  /** As the formatter printed it (relative to its working folder, or absolute). */
  file: string;
  line?: number;
  column?: number;
  /** Number of separate edits the formatter wants in the file (dotnet and rustfmt report one per hunk). */
  edits: number;
}

export interface FormatParse {
  ok: boolean;
  files: UnformattedFile[];
  /** Why the output cannot be trusted (when not ok). */
  problem?: string;
}

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number.parseInt(v, 10));

/** Merges the hunks of one file into one entry (first location, count of hunks), keeping the order of appearance. */
function byFile(entries: Array<{ file: string; line?: number | undefined; column?: number | undefined }>): UnformattedFile[] {
  const out = new Map<string, UnformattedFile>();
  for (const e of entries) {
    const hit = out.get(e.file);
    if (hit) hit.edits += 1;
    else out.set(e.file, { file: e.file, ...(e.line !== undefined ? { line: e.line } : {}), ...(e.column !== undefined ? { column: e.column } : {}), edits: 1 });
  }
  return [...out.values()];
}

function conclude(files: UnformattedFile[], exitCode: number | null, clean: number[], dirty: number[]): FormatParse {
  if (exitCode !== null && clean.includes(exitCode)) return files.length === 0 ? { ok: true, files } : { ok: false, files: [], problem: `exit ${exitCode} but ${files.length} file(s) are listed` };
  if (exitCode !== null && dirty.includes(exitCode)) return files.length > 0 ? { ok: true, files } : { ok: false, files: [], problem: `exit ${exitCode} but no unformatted file was listed` };
  return { ok: false, files: [], problem: `unexpected exit ${exitCode ?? "-"}` };
}

/** `app.py:1:11: unformatted: File would be reformatted` (ruff format --check --output-format concise). Exit 0 clean, 1 unformatted. */
export function parseRuff(stdout: string, exitCode: number | null): FormatParse {
  const entries: Array<{ file: string; line?: number; column?: number }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(\d+): unformatted: /.exec(raw);
    if (m) entries.push({ file: m[1] as string, ...(num(m[2]) !== undefined ? { line: num(m[2]) as number } : {}), ...(num(m[3]) !== undefined ? { column: num(m[3]) as number } : {}) });
  }
  return conclude(byFile(entries), exitCode, [0], [1]);
}

/** `[warn] src/index.ts` (prettier --check, on stderr). Exit 0 clean, 1 unformatted, 2 error (a syntax error, a bad config). */
export function parsePrettier(output: string, exitCode: number | null): FormatParse {
  const entries: Array<{ file: string }> = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = /^\[warn\] (.+?)\s*$/.exec(raw);
    if (!m) continue;
    const text = m[1] as string;
    // The closing sentence of the check, and the notes about ignored files, are not files.
    if (/^Code style issues (?:found|fixed)/.test(text) || /^Ignored unknown option/.test(text)) continue;
    entries.push({ file: text });
  }
  return conclude(byFile(entries), exitCode, [0], [1]);
}

/** `main.go` (gofmt -l, on stdout). Exit 0 whether or not files are listed; 2 is an error (a syntax error). */
export function parseGofmt(stdout: string, exitCode: number | null): FormatParse {
  const entries = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((file) => ({ file }));
  if (exitCode === 0) return { ok: true, files: byFile(entries) };
  return { ok: false, files: [], problem: `unexpected exit ${exitCode ?? "-"}` };
}

/** `Diff in /workspace/src/main.rs:1:` (cargo fmt --check, on stdout). Exit 0 clean, 1 unformatted or an error. */
export function parseRustfmt(stdout: string, exitCode: number | null): FormatParse {
  const entries: Array<{ file: string; line?: number }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^Diff in (.+):(\d+):?\s*$/.exec(raw);
    if (m) entries.push({ file: m[1] as string, ...(num(m[2]) !== undefined ? { line: num(m[2]) as number } : {}) });
  }
  return conclude(byFile(entries), exitCode, [0], [1]);
}

/** `/workspace/Program.cs(1,14): error WHITESPACE: Fix whitespace formatting. Insert '\n'. [/workspace/]` (dotnet format --verify-no-changes). Exit 0 clean, 2 changes needed. */
export function parseDotnet(output: string, exitCode: number | null): FormatParse {
  const entries: Array<{ file: string; line?: number; column?: number }> = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = /^\s*(.+?)\((\d+),(\d+)\): error ([A-Za-z][A-Za-z0-9]*): /.exec(raw);
    if (m) entries.push({ file: m[1] as string, ...(num(m[2]) !== undefined ? { line: num(m[2]) as number } : {}), ...(num(m[3]) !== undefined ? { column: num(m[3]) as number } : {}) });
  }
  return conclude(byFile(entries), exitCode, [0], [2]);
}

export function parseFormat(formatter: Formatter, stdout: string, stderr: string, exitCode: number | null): FormatParse {
  switch (formatter) {
    case "ruff":
      return parseRuff(stdout, exitCode);
    case "prettier":
      return parsePrettier(`${stderr}\n${stdout}`, exitCode);
    case "gofmt":
      return parseGofmt(stdout, exitCode);
    case "rustfmt":
      return parseRustfmt(stdout, exitCode);
    case "dotnet":
      return parseDotnet(`${stdout}\n${stderr}`, exitCode);
  }
}

/** A path the formatter printed as the workspace-relative POSIX path the result stores. `cwd` is the working folder as the tool sees it. */
export function workspaceRelative(printed: string, workspace: string, cwd: string): string {
  // cargo on Windows prints verbatim paths (\\?\C:\...); the plain spelling is the workspace's.
  const file = printed.replace(/^(?:\\\\\?\\|\/\/\?\/)(?=[A-Za-z]:)/, "");
  const abs =path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? path.resolve(file) : path.resolve(cwd, file);
  const rel = path.relative(path.resolve(workspace), abs).split(path.sep).join("/");
  return rel.startsWith("..") ? abs.split(path.sep).join("/") : rel;
}

export function toFindings(files: UnformattedFile[], opts: { stageId: string; formatter: Formatter; version: string | null; workspace: string; cwd: string; message: (file: UnformattedFile) => string }): ResultFinding[] {
  const tool = FORMATTER_TOOL[opts.formatter];
  return files.map((f) => {
    const file = workspaceRelative(f.file, opts.workspace, opts.cwd);
    return {
      stageId: opts.stageId,
      tool,
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: "format-check.unformatted",
      category: "format-check",
      severity: "low",
      normalizedSeverity: "low" as const,
      message: opts.message(f),
      location: { path: file, ...(f.line !== undefined ? { line: f.line } : {}), ...(f.column !== undefined ? { column: f.column } : {}) },
      fingerprint: contentHash({ tool, rule: "format-check.unformatted", file }),
      origin: "format-check",
      blocking: true,
      blockingReason: "blocking-tool" as const,
      waived: false,
    };
  });
}
