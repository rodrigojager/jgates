// Reads what `dotnet test` writes: the TRX test results (the trx logger) and the Cobertura coverage report of coverlet's
// "XPlat Code Coverage" data collector. Pure functions over the texts: no process, no file access.
import type { CoverageReading, TestCase, TestReading } from "../test-common/index.js";
import { firstLine } from "../test-common/index.js";

export function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1] as string) : null;
};

/** `in /path/File.cs:line 12` of a .NET stack trace (the first frame with a source file). */
const FRAME = /\bin\s+(\S.*?\.(?:cs|fs|vb)):line\s+(\d+)/;

/**
 * The tests of one or more TRX files. `place` maps the source path a stack trace names to the workspace-relative path
 * (null outside the workspace). A TRX without results, or that is not a TestRun, is not a report.
 */
export function parseTrx(texts: string[], place: (printed: string) => string | null): TestReading {
  if (texts.length === 0) return { ok: false, problem: "no TRX file was written", cases: [] };
  const cases: TestCase[] = [];
  for (const text of texts) {
    if (!/<TestRun\b/.test(text)) return { ok: false, problem: "not a TRX TestRun document", cases: [] };
    for (const m of text.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
      const tag = m[1] as string;
      const body = m[3] ?? "";
      const name = attr(tag, "testName") ?? "(unnamed test)";
      const outcome = (attr(tag, "outcome") ?? "").toLowerCase();
      const status: TestCase["status"] = outcome === "passed" ? "passed" : outcome === "failed" || outcome === "error" || outcome === "timeout" || outcome === "aborted" ? "failed" : "skipped";
      const message = decodeXml(/<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1] ?? "");
      const stack = decodeXml(/<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(body)?.[1] ?? "");
      const frame = FRAME.exec(stack);
      cases.push({ name, file: frame ? place(frame[1] as string) : null, line: frame ? Number(frame[2]) : null, status, message: status === "failed" ? firstLine(message) : "" });
    }
  }
  return { ok: true, cases };
}

/** Line coverage of Cobertura reports (lines-covered / lines-valid of each root element, summed over the reports). */
export function parseCobertura(texts: string[]): CoverageReading {
  if (texts.length === 0) return { ok: false, problem: "no coverage.cobertura.xml was written" };
  let covered = 0;
  let total = 0;
  for (const text of texts) {
    const root = /<coverage\b([^>]*)>/.exec(text);
    const c = root ? attr(root[1] as string, "lines-covered") : null;
    const v = root ? attr(root[1] as string, "lines-valid") : null;
    if (c === null || v === null || !/^\d+$/.test(c) || !/^\d+$/.test(v)) return { ok: false, problem: "no lines-covered / lines-valid on the coverage element" };
    covered += Number(c);
    total += Number(v);
  }
  return { ok: true, covered, total, basis: "lines", format: "cobertura (coverlet)" };
}
