// Normalizes the JSON stream of `govulncheck -format json` (fixtures of govulncheck 1.9.0 in
// tests/fixtures/stack-extensions/recorded). The stream is a sequence of JSON objects (config, SBOM, progress, osv,
// finding). A finding whose trace starts with a function is a vulnerable symbol the code reaches ("called"); a finding
// with a package or only a module is a vulnerability in a dependency the code requires or imports but never calls.
// govulncheck itself reports only the called ones as affecting the program, so only they become findings; the others
// are counted for the stage reason. Fail-closed: no config message, a finding without its OSV entry or a trace without a
// module proves nothing.
import { contentHash } from "../../core/ids/index.js";
import type { ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export interface GovulncheckParse {
  ok: boolean;
  findings: ResultFinding[];
  /** Vulnerabilities in required or imported code that the program never calls (not findings). */
  notCalled: number;
  /** The scanner version the stream announced. */
  scannerVersion: string | null;
  problem?: string;
}

const fail = (problem: string): GovulncheckParse => ({ ok: false, findings: [], notCalled: 0, scannerVersion: null, problem });

/** Splits a stream of concatenated JSON values (govulncheck pretty-prints them one after the other). */
export function splitJsonStream(text: string): unknown[] | null {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          return null;
        }
      }
    } else if (depth === 0 && !/\s/.test(c)) return null;
  }
  return depth === 0 && !inString ? values : null;
}

/** Workspace-relative path of a position govulncheck prints relative to the module root. */
function relativePath(filename: string, root: string): string {
  const value = filename.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  return root && root !== "." ? `${root}/${value}` : value;
}

export function parseGovulncheckOutput(stdout: string, opts: { stageId: string; version: string | null; root: string }): GovulncheckParse {
  const messages = splitJsonStream(stdout);
  if (messages === null || messages.length === 0) return fail("the output is not a stream of JSON messages");
  const config = messages.find((m) => isRec(m) && isRec(m.config));
  if (!isRec(config) || !isRec(config.config) || config.config.scanner_name !== "govulncheck") return fail("the stream has no govulncheck config message");
  const scannerVersion = str(config.config.scanner_version);
  const osvs = new Map<string, Rec>();
  for (const m of messages) if (isRec(m) && isRec(m.osv) && str(m.osv.id)) osvs.set(m.osv.id as string, m.osv);

  const findings: ResultFinding[] = [];
  const seen = new Set<string>();
  let notCalled = 0;
  const notCalledIds = new Set<string>();
  for (const m of messages) {
    if (!isRec(m) || !isRec(m.finding)) continue;
    const f = m.finding;
    const id = str(f.osv);
    const trace = Array.isArray(f.trace) ? f.trace.filter(isRec) : [];
    const head = trace[0];
    if (!id || !head || !str(head.module)) return fail("a finding has no OSV id or no module in its trace");
    const osv = osvs.get(id);
    if (!osv) return fail(`the finding ${id} has no OSV entry in the stream`);
    if (!str(head.function)) {
      // required or imported only: the call graph never reaches it
      if (!notCalledIds.has(id)) {
        notCalledIds.add(id);
        notCalled += 1;
      }
      continue;
    }
    // The first frame is the vulnerable symbol; the last frame with a position is the entry in the analysed module.
    const entry = [...trace].reverse().find((fr) => isRec(fr.position) && str(fr.position.filename)) ?? head;
    const position = isRec(entry.position) ? entry.position : null;
    const file = position && str(position.filename) ? relativePath(position.filename as string, opts.root) : null;
    const line = position && typeof position.line === "number" ? position.line : undefined;
    const column = position && typeof position.column === "number" ? position.column : undefined;
    const module = head.module as string;
    const installed = str(head.version) ?? "?";
    const fixed = str(f.fixed_version);
    const symbol = `${str(head.package) ?? module}.${head.function as string}`;
    const key = `${id}|${symbol}|${file ?? ""}|${line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = str(osv.summary) ?? id;
    const aliases = Array.isArray(osv.aliases) ? osv.aliases.filter((a): a is string => typeof a === "string") : [];
    findings.push({
      stageId: opts.stageId,
      tool: "govulncheck",
      ...(opts.version ? { toolVersion: opts.version } : {}),
      ruleId: id,
      category: "dependencies",
      // The Go vulnerability database carries no severity: a reachable vulnerability blocks, as one nothing can qualify.
      severity: "unknown",
      normalizedSeverity: "unknown",
      message: `${summary} (${module} ${installed}, reached through ${symbol}${fixed ? `; fixed in ${fixed}` : "; no fix released"}${aliases.length > 0 ? `; ${aliases.join(", ")}` : ""})`,
      ...(file ? { location: { path: file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) } } : {}),
      fingerprint: contentHash({ tool: "govulncheck", rule: id, module, symbol, file, line: line ?? null }),
      origin: "govulncheck",
      blocking: true,
      blockingReason: "blocking-tool",
      waived: false,
      docsUrl: `https://pkg.go.dev/vuln/${id}`,
      ...(fixed ? { remediation: `Upgrade ${module} to ${fixed} or later.` } : {}),
    });
  }
  return { ok: true, findings, notCalled, scannerVersion };
}
