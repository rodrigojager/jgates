// Normalizes the diagnostics of the project's compilers and type checkers into result findings. Fail-closed: a
// non-zero exit without a located error to explain it, a missing summary or an error without a location proves nothing
// about the project, so the parser says the output could not be interpreted instead of returning "no findings".
import path from "node:path";
import { contentHash } from "../../core/ids/index.js";
import type { ResultFinding } from "../../core/run/types.js";
import type { Checker } from "./probe.js";

export interface Diagnostic {
  /** As the tool printed it: relative to its working folder, or absolute. */
  file: string;
  line?: number | undefined;
  column?: number | undefined;
  severity: "error" | "warning";
  ruleId: string;
  message: string;
}

export interface DiagnosticParse {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Why the output could not be interpreted. */
  problem?: string;
}

const num = (s: string | undefined): number | undefined => (s === undefined || s === "" ? undefined : Number(s));

/** The decision every parser ends with: clean exit, or a non-zero exit that located errors explain. */
function conclude(diagnostics: Diagnostic[], exitCode: number | null, cleanCodes: readonly number[], errorCodes: readonly number[], unlocatedError: string | null): DiagnosticParse {
  if (unlocatedError !== null) return { ok: false, diagnostics: [], problem: unlocatedError };
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (exitCode !== null && cleanCodes.includes(exitCode)) return { ok: true, diagnostics };
  if (exitCode !== null && errorCodes.includes(exitCode)) {
    if (errors.length === 0) return { ok: false, diagnostics: [], problem: `exit ${exitCode} without a located error in the output` };
    return { ok: true, diagnostics };
  }
  return { ok: false, diagnostics: [], problem: `unexpected exit ${exitCode ?? "-"}` };
}

const dedupe = (list: Diagnostic[]): Diagnostic[] => {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.file}\0${d.line ?? ""}\0${d.column ?? ""}\0${d.severity}\0${d.ruleId}\0${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** `src/a.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.` */
export function parseTsc(stdout: string, exitCode: number | null): DiagnosticParse {
  const out: Diagnostic[] = [];
  let unlocated: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const located = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(raw);
    if (located) {
      out.push({ file: located[1] as string, line: num(located[2]), column: num(located[3]), severity: located[4] as "error" | "warning", ruleId: located[5] as string, message: located[6] as string });
      continue;
    }
    const global = /^(error) (TS\d+): (.*)$/.exec(raw);
    if (global) unlocated = unlocated ?? `${global[2]}: ${global[3]}`;
  }
  return conclude(dedupe(out), exitCode, [0], [1, 2], unlocated);
}

/** `app.py:5:22: error: Argument 2 to "add" has incompatible type "str"; expected "int"  [arg-type]` */
export function parseMypy(stdout: string, exitCode: number | null): DiagnosticParse {
  const out: Diagnostic[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(?:(\d+):)? (error|warning): (.*?)(?:  \[([\w-]+)\])?$/.exec(raw);
    if (m) out.push({ file: m[1] as string, line: num(m[2]), column: num(m[3]), severity: m[4] as "error" | "warning", ruleId: m[6] ?? "mypy", message: m[5] as string });
  }
  return conclude(dedupe(out), exitCode, [0], [1], null);
}

/** `pyright --outputjson`: generalDiagnostics with a 0-based range and a summary. */
export function parsePyright(stdout: string, exitCode: number | null): DiagnosticParse {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, diagnostics: [], problem: error instanceof Error ? error.message : String(error) };
  }
  const rec = doc as { generalDiagnostics?: unknown; summary?: unknown } | null;
  if (typeof rec !== "object" || rec === null || !Array.isArray(rec.generalDiagnostics) || typeof rec.summary !== "object" || rec.summary === null) {
    return { ok: false, diagnostics: [], problem: "the document has no generalDiagnostics or summary" };
  }
  const out: Diagnostic[] = [];
  for (const entry of rec.generalDiagnostics as Array<Record<string, unknown>>) {
    const severity = entry.severity === "error" ? "error" : entry.severity === "warning" ? "warning" : null;
    if (severity === null) continue; // information and hints are not diagnostics of the build
    const file = typeof entry.file === "string" ? entry.file : null;
    const start = (entry.range as { start?: { line?: unknown; character?: unknown } } | undefined)?.start;
    if (file === null || typeof entry.message !== "string") return { ok: false, diagnostics: [], problem: "a diagnostic has no file or message" };
    out.push({
      file,
      ...(typeof start?.line === "number" ? { line: start.line + 1 } : {}),
      ...(typeof start?.character === "number" ? { column: start.character + 1 } : {}),
      severity,
      ruleId: typeof entry.rule === "string" ? entry.rule : "pyright",
      message: entry.message,
    });
  }
  return conclude(dedupe(out), exitCode, [0], [1], null);
}

/** `./main.go:4:14: cannot use "text" (untyped string constant) as int value in variable declaration` (also `vet: ...`). */
export function parseGo(text: string, exitCode: number | null, ruleId: string): DiagnosticParse {
  const out: Diagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(?:vet(?:\.exe)?: )?(.+?\.go):(\d+):(?:(\d+):)? (.*)$/.exec(raw);
    if (m) out.push({ file: m[1] as string, line: num(m[2]), column: num(m[3]), severity: "error", ruleId, message: m[4] as string });
  }
  return conclude(dedupe(out), exitCode, [0], [1, 2], null);
}

/** `cargo check --message-format json`: one JSON document per line; compiler-message and build-finished. */
export function parseCargo(stdout: string, exitCode: number | null): DiagnosticParse {
  const out: Diagnostic[] = [];
  let finished: boolean | null = null;
  let unlocated: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, diagnostics: [], problem: "a line of the output is not JSON" };
    }
    if (doc.reason === "build-finished") finished = doc.success === true;
    if (doc.reason !== "compiler-message") continue;
    const message = doc.message as { level?: unknown; message?: unknown; code?: { code?: unknown } | null; spans?: Array<Record<string, unknown>> } | undefined;
    if (!message || (message.level !== "error" && message.level !== "warning") || typeof message.message !== "string") continue;
    const spans = Array.isArray(message.spans) ? message.spans : [];
    const primary = spans.find((s) => s.is_primary === true) ?? spans[0];
    if (!primary) {
      // "aborting due to N previous errors" and "N warnings emitted" summarize the others.
      if (message.level === "error" && !/^aborting due to|previous errors?$/.test(message.message)) unlocated = unlocated ?? message.message;
      continue;
    }
    out.push({
      file: String(primary.file_name),
      line: typeof primary.line_start === "number" ? primary.line_start : undefined,
      column: typeof primary.column_start === "number" ? primary.column_start : undefined,
      severity: message.level,
      ruleId: typeof message.code?.code === "string" ? message.code.code : "rustc",
      message: message.message,
    });
  }
  if (finished === null) return { ok: false, diagnostics: [], problem: "no build-finished message in the output" };
  if (finished) return exitCode === 0 ? { ok: true, diagnostics: dedupe(out) } : { ok: false, diagnostics: [], problem: `build finished but the exit was ${exitCode ?? "-"}` };
  return conclude(dedupe(out), exitCode, [], [101], unlocated);
}

/** `C:\p\Program.cs(1,13): error CS0029: Cannot implicitly convert type 'string' to 'int' [C:\p\BuildCheck.csproj]` */
export function parseDotnet(stdout: string, exitCode: number | null): DiagnosticParse {
  const out: Diagnostic[] = [];
  let unlocated: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const located = /^\s*(.+?)\((\d+),(\d+)(?:,\d+,\d+)?\): (error|warning) ([A-Za-z]+\d+): (.*?)(?: \[[^\]]+\])?\s*$/.exec(raw);
    if (located) {
      out.push({ file: located[1] as string, line: num(located[2]), column: num(located[3]), severity: located[4] as "error" | "warning", ruleId: located[5] as string, message: located[6] as string });
      continue;
    }
    const global = /^(?:[^:]*: )?error ([A-Za-z]+\d+): (.*?)(?: \[[^\]]+\])?\s*$/.exec(raw);
    if (global) unlocated = unlocated ?? `${global[1]}: ${global[2]}`;
  }
  return conclude(dedupe(out), exitCode, [0], [1], unlocated);
}

/** A tool path as the workspace-relative POSIX path the result stores. */
export function workspaceRelative(file: string, workspace: string, unitRoot: string): string {
  const abs = path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? path.resolve(file) : path.resolve(workspace, ...(unitRoot === "." ? [] : unitRoot.split("/")), file);
  const rel = path.relative(path.resolve(workspace), abs).split(path.sep).join("/");
  return rel.startsWith("..") ? abs.split(path.sep).join("/") : rel;
}

export function toFindings(diagnostics: Diagnostic[], opts: { stageId: string; checker: Checker; version: string | null; workspace: string; unitRoot: string; step?: string }): ResultFinding[] {
  return diagnostics.map((d) => {
    const file = workspaceRelative(d.file, opts.workspace, opts.unitRoot);
    const blocking = d.severity === "error";
    return {
      stageId: opts.stageId,
      tool: opts.checker,
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: d.ruleId,
      category: "typecheck",
      severity: d.severity,
      normalizedSeverity: blocking ? ("high" as const) : ("medium" as const),
      message: d.message,
      location: { path: file, ...(d.line !== undefined ? { line: d.line } : {}), ...(d.column !== undefined ? { column: d.column } : {}) },
      fingerprint: contentHash({ tool: opts.checker, step: opts.step ?? null, rule: d.ruleId, file, line: d.line ?? null, message: d.message }),
      origin: "build-check",
      blocking,
      ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
      waived: false,
    };
  });
}
