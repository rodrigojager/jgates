// Reads what `go test -json` prints (test2json events) and the coverage profile `-coverprofile` writes. Pure functions:
// no process, no file access.
import path from "node:path";
import type { CoverageReading, TestCase, TestReading } from "../test-common/index.js";
import { firstLine } from "../test-common/index.js";

interface GoEvent {
  Action?: string;
  Package?: string;
  ImportPath?: string;
  Test?: string;
  Output?: string;
  FailedBuild?: string;
}

/**
 * The tests of a `go test -json` stream. Top-level tests count (a failing subtest fails its parent); a package that
 * failed without a failing test (it did not build, or panicked outside a test) is a failing suite. `moduleDir` maps an
 * import path to its folder: (import path) -> workspace-relative folder, or null.
 */
export function parseGoTestJson(stdout: string, folderOf: (importPath: string) => string | null): TestReading {
  const tests = new Map<string, { pkg: string; name: string; status: TestCase["status"] | null; output: string[] }>();
  const packages = new Map<string, { failed: boolean; output: string[] }>();
  let events = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(text) as GoEvent;
    } catch {
      continue;
    }
    if (typeof e.Action !== "string") continue;
    events++;
    const pkg = e.Package ?? e.ImportPath ?? "";
    const p = packages.get(pkg) ?? { failed: false, output: [] };
    packages.set(pkg, p);
    if (e.Action === "build-output" && typeof e.Output === "string") p.output.push(e.Output);
    if (!e.Test) {
      if (e.Action === "output" && typeof e.Output === "string") p.output.push(e.Output);
      if (e.Action === "fail" || e.Action === "build-fail") p.failed = true;
      continue;
    }
    const top = e.Test.split("/")[0] as string;
    const key = `${pkg}\u0000${top}`;
    const t = tests.get(key) ?? { pkg, name: top, status: null, output: [] };
    tests.set(key, t);
    if (e.Action === "output" && typeof e.Output === "string") t.output.push(e.Output);
    if (e.Test === top && (e.Action === "pass" || e.Action === "fail" || e.Action === "skip")) t.status = e.Action === "pass" ? "passed" : e.Action === "fail" ? "failed" : "skipped";
  }
  if (events === 0) return { ok: false, problem: "no go test -json event in the output", cases: [] };
  const cases: TestCase[] = [];
  for (const t of tests.values()) {
    // A test that started but never ended (the package panicked or timed out) failed.
    const status = t.status ?? "failed";
    const where = locate(t.output, folderOf(t.pkg));
    cases.push({ name: `${t.pkg}.${t.name}`, file: where.file, line: where.line, status, message: status === "failed" ? failureMessage(t.output) : "" });
  }
  for (const [pkg, p] of packages) {
    if (!p.failed || cases.some((c) => c.status === "failed" && c.name.startsWith(`${pkg}.`))) continue;
    cases.push({ name: pkg || "(package)", file: folderOf(pkg), line: null, status: "failed", message: firstLine(p.output.filter((o) => !/^(?:FAIL|ok|\?)\s/.test(o)).join("")) || "the package failed without a failing test", suite: true });
  }
  return { ok: true, cases };
}

const LOCATION = /^\s+([\w./-]+_test\.go):(\d+):\s?(.*)$/;

function locate(output: string[], folder: string | null): { file: string | null; line: number | null } {
  for (const o of output) {
    const m = LOCATION.exec(o.trimEnd());
    if (m) return { file: folder === null ? null : folder === "" ? (m[1] as string) : `${folder}/${m[1]}`, line: Number(m[2]) };
  }
  return { file: null, line: null };
}

function failureMessage(output: string[]): string {
  for (const o of output) {
    const m = LOCATION.exec(o.trimEnd());
    if (m && (m[3] ?? "").trim() !== "") return firstLine(m[3] as string);
  }
  const useful = output.find((o) => !/^(?:=== |--- |\s*---)/.test(o) && o.trim() !== "" && !/^(?:FAIL|PASS|ok)\b/.test(o.trim()));
  return useful ? firstLine(useful) : "";
}

/** Statement coverage of a `-coverprofile` file (each block counted once, covered when any run hit it). */
export function parseCoverProfile(text: string): CoverageReading {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0 || !/^mode:\s*(set|count|atomic)\s*$/.test(lines[0] as string)) return { ok: false, problem: "not a Go coverage profile (no mode line)" };
  const blocks = new Map<string, { stmts: number; hit: boolean }>();
  for (const line of lines.slice(1)) {
    const m = /^(.+:\d+\.\d+,\d+\.\d+)\s+(\d+)\s+(\d+)$/.exec(line.trim());
    if (!m) return { ok: false, problem: `unreadable coverage line: ${line.slice(0, 120)}` };
    const b = blocks.get(m[1] as string) ?? { stmts: Number(m[2]), hit: false };
    b.hit = b.hit || Number(m[3]) > 0;
    blocks.set(m[1] as string, b);
  }
  let total = 0;
  let covered = 0;
  for (const b of blocks.values()) {
    total += b.stmts;
    if (b.hit) covered += b.stmts;
  }
  return { ok: true, covered, total, basis: "statements", format: "go coverprofile" };
}

/** The module path of a go.mod text. */
export function modulePath(goMod: string): string | null {
  return /^\s*module\s+("?)([^\s"]+)\1\s*$/m.exec(goMod)?.[2] ?? null;
}

/** The folder of an import path, relative to the workspace, when it belongs to the module rooted at `root` (workspace-relative, "" for the root). */
export function folderOfImport(importPath: string, module: string | null, root: string): string | null {
  if (!module) return null;
  if (importPath !== module && !importPath.startsWith(`${module}/`)) return null;
  const rel = importPath === module ? "" : importPath.slice(module.length + 1);
  return path.posix.join(root || ".", rel || ".").replace(/^\.\/?/, "").replace(/^\.$/, "");
}
