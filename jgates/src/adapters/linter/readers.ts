// The closed set of readers of the linter engine. A reader turns one chunk of a tool's output (a batch, a file of the
// each-file mode, the whole project) into raw findings; the engine then maps the levels and checks the exit code.
// Every reader is fail-closed: an output it cannot read is a problem (the stage is an error), never an empty list.
// A tool that no reader fits gets a reader of its own, readers/<id>.ts, exporting `read` with the same signature.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCheckstyle, readJunit, readSarif } from "../../core/evidence/index.js";
import { CUSTOM_READER_EXT, customReadersDir, type LinterDescriptor, type LinterLevel } from "./descriptor.js";

export interface ReaderInput {
  /** The output the descriptor reads (stdout, stderr or the report file). */
  text: string;
  /** The other stream, for the status reader's message. */
  other: string;
  exitCode: number | null;
  /** each-file mode: the file this chunk is about (workspace-relative). */
  file?: string;
}

export interface RawFinding {
  /** As the tool printed it; null: no location (the workspace). */
  file: string | null;
  line?: number;
  column?: number;
  rule: string;
  /** The tool's own level, lowercase. */
  level: string;
  message: string;
}

export interface ReadResult {
  ok: boolean;
  findings: RawFinding[];
  problem?: string;
}

export type Reader = (input: ReaderInput, output: LinterDescriptor["output"]) => ReadResult;

const fail = (problem: string): ReadResult => ({ ok: false, findings: [], problem });
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const tail = (text: string, lines = 3): string => text.trim().split(/\r?\n/).slice(-lines).join(" ").trim();

const sarif: Reader = (input, output) => {
  const read = readSarif(input.text, { requireLocation: output.locationOptional !== true });
  if (!read.ok) return fail(read.problem ?? "the SARIF cannot be read");
  return {
    ok: true,
    findings: read.findings.map((f) => ({ file: f.path, ...(f.line !== undefined ? { line: f.line } : {}), ...(f.column !== undefined ? { column: f.column } : {}), rule: f.ruleId, level: f.level, message: f.message })),
  };
};

const checkstyle: Reader = (input) => {
  const read = readCheckstyle(input.text);
  if (!read.ok) return fail(read.problem ?? "the Checkstyle report cannot be read");
  return { ok: true, findings: read.findings.map((f) => ({ file: f.file, ...(f.line !== undefined ? { line: f.line } : {}), ...(f.column !== undefined ? { column: f.column } : {}), rule: f.source, level: f.severity, message: f.message || f.source })) };
};

const junit: Reader = (input, output) => {
  const read = readJunit(input.text);
  if (!read.ok) return fail(read.problem ?? "the JUnit report cannot be read");
  const findings: RawFinding[] = [];
  for (const c of read.cases) {
    if (c.outcome !== "failed" && c.outcome !== "error") continue;
    findings.push({ file: c.file ?? (c.classname || null), ...(c.line !== undefined ? { line: c.line } : {}), rule: output.rule ?? c.name, level: c.outcome === "error" ? "error" : (output.level ?? "error"), message: c.message || c.text.split(/\r?\n/)[0] || c.name });
  }
  return { ok: true, findings };
};

interface Node {
  value: unknown;
  parents: unknown[];
}

/** Walks a path like `[].messages[]` from the document; null when a step does not exist. */
function walkItems(doc: unknown, items: string | undefined): Node[] | null {
  let nodes: Node[] = [{ value: doc, parents: [] }];
  const segments = (items ?? "").split(".").filter((s) => s !== "");
  if (segments.length === 0) {
    if (!Array.isArray(doc)) return null;
    return doc.map((value) => ({ value, parents: [doc] }));
  }
  for (const segment of segments) {
    const expand = segment.endsWith("[]");
    const name = expand ? segment.slice(0, -2) : segment;
    const next: Node[] = [];
    for (const node of nodes) {
      let holder: unknown = node.value;
      const parents = [...node.parents];
      if (name !== "") {
        if (!isRec(holder) || !(name in holder)) return null;
        parents.push(holder);
        holder = holder[name];
      }
      if (expand) {
        if (!Array.isArray(holder)) return null;
        if (name === "") parents.push(holder);
        for (const value of holder) next.push({ value, parents });
      } else next.push({ value: holder, parents });
    }
    nodes = next;
  }
  return nodes;
}

/** A field path from a node: `a.b`, `^.a` (the parent's a), `^.^.a`. */
function field(node: Node, spec: string | undefined): unknown {
  if (spec === undefined) return undefined;
  const parts = spec.split(".").filter((p) => p !== "");
  let up = 0;
  while (parts[0] === "^") {
    up += 1;
    parts.shift();
  }
  let value: unknown = up === 0 ? node.value : node.parents[node.parents.length - up];
  for (const p of parts) {
    if (!isRec(value)) return undefined;
    value = value[p];
  }
  return value;
}

const json: Reader = (input, output) => {
  const fields = output.fields;
  if (!fields) return fail("the descriptor has no json fields");
  const docs: unknown[] = [];
  if (output.jsonLines) {
    for (const [index, line] of input.text.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;
      try {
        docs.push(JSON.parse(line));
      } catch {
        return fail(`line ${index + 1} is not JSON`);
      }
    }
  } else {
    try {
      docs.push(JSON.parse(input.text));
    } catch {
      return fail("the report is not JSON");
    }
  }
  const findings: RawFinding[] = [];
  for (const doc of docs) {
    // With JSON lines and no items path, each line is one finding.
    const nodes = output.jsonLines && !output.items ? [{ value: doc, parents: [] }] : walkItems(doc, output.items);
    if (nodes === null) return fail(`the report has no list at ${output.items ?? "its root"}`);
    for (const node of nodes) {
      const file = field(node, fields.file);
      const message = field(node, fields.message);
      const ruleValue = field(node, fields.rule);
      const rule = typeof ruleValue === "string" && ruleValue !== "" ? ruleValue : typeof ruleValue === "number" ? String(ruleValue) : output.rule;
      if (typeof file !== "string" || file === "") return fail("a finding of the report has no file");
      if (typeof message !== "string") return fail(`a finding of the report (${file}) has no message`);
      if (!rule) return fail(`a finding of the report (${file}) has no rule`);
      const levelValue = field(node, fields.level);
      const line = posInt(field(node, fields.line));
      const column = posInt(field(node, fields.column));
      findings.push({ file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}), rule, level: typeof levelValue === "string" || typeof levelValue === "number" ? String(levelValue).toLowerCase() : (output.level ?? "warning"), message });
    }
  }
  return { ok: true, findings };
};

const lines: Reader = (input, output) => {
  if (!output.pattern) return fail("the descriptor has no lines pattern");
  const pattern = new RegExp(output.pattern);
  const findings: RawFinding[] = [];
  for (const line of input.text.split(/\r?\n/)) {
    const m = pattern.exec(line);
    if (!m?.groups) continue;
    const g = m.groups;
    const file = g.file ?? input.file;
    const rule = g.rule || output.rule;
    if (!file || !rule) return fail(`a line fits the pattern but has no ${file ? "rule" : "file"}: ${line.slice(0, 200)}`);
    const lineNo = posInt(g.line);
    const column = posInt(g.column);
    findings.push({ file, ...(lineNo !== undefined ? { line: lineNo } : {}), ...(column !== undefined ? { column } : {}), rule, level: (g.level ?? output.level ?? "warning").toLowerCase(), message: (g.message ?? "").trim() || rule });
  }
  return { ok: true, findings };
};

const files: Reader = (input, output) => {
  const pattern = output.pattern ? new RegExp(output.pattern) : null;
  const rule = output.rule as string;
  const findings: RawFinding[] = [];
  for (const line of input.text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let file: string | undefined;
    if (pattern) {
      const m = pattern.exec(line);
      if (!m) continue;
      file = (m.groups?.file ?? m[1] ?? m[0]).trim();
    } else file = line.trim();
    if (file) findings.push({ file, rule, level: output.level ?? "warning", message: rule });
  }
  return { ok: true, findings };
};

/** No location in the output: the exit code says whether the check failed, and the last lines say why. */
const status: Reader = (input) => {
  if (input.exitCode === null) return fail("the tool did not exit");
  return { ok: true, findings: [] };
};

const READERS: Record<Exclude<LinterDescriptor["output"]["reader"], "custom">, Reader> = { sarif, checkstyle, junit, json, lines, files, status };

/** The status reader's finding, made by the engine once it knows the exit code means "findings". */
export function statusFinding(input: ReaderInput, output: LinterDescriptor["output"]): RawFinding {
  const why = tail(input.text) || tail(input.other) || `exit ${input.exitCode ?? "-"}`;
  return { file: input.file ?? null, rule: output.rule as string, level: output.level ?? "error", message: why.length > 500 ? `${why.slice(0, 499)}…` : why };
}

/** The reader of a descriptor: one of the closed set, or its own module readers/<id>.js. */
export async function readerOf(descriptor: LinterDescriptor): Promise<Reader> {
  if (descriptor.output.reader !== "custom") return READERS[descriptor.output.reader];
  const file = path.join(customReadersDir(), `${descriptor.id}${CUSTOM_READER_EXT}`);
  const mod = (await import(pathToFileURL(file).href)) as { read?: Reader };
  if (typeof mod.read !== "function") throw new Error(`readers/${descriptor.id}${CUSTOM_READER_EXT} exports no read function`);
  return mod.read;
}

/** The built-in readers, for the engine's tests. */
export function builtinReader(name: Exclude<LinterDescriptor["output"]["reader"], "custom">): Reader {
  return READERS[name];
}

const DEFAULT_LEVELS: Record<string, LinterLevel> = { error: "error", fatal: "error", failure: "error", warning: "warning", warn: "warning", info: "info", information: "info", note: "info", none: "info", style: "info", hint: "info", suggestion: "info", convention: "info", refactor: "info" };

/** The tool's level as error, warning or info: the descriptor's map first, then the common names; unknown is a warning. */
export function mapLevel(level: string, descriptor: LinterDescriptor): LinterLevel {
  const key = level.toLowerCase();
  return descriptor.severity?.[key] ?? DEFAULT_LEVELS[key] ?? "warning";
}
