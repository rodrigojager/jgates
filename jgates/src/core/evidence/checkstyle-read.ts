// Checkstyle XML reader (`<checkstyle><file name=".."><error line= column= severity= message= source=/></file>`).
// Fail-closed: a document without a <checkstyle> root is "not ok".
import { attributes, tags } from "./xml.js";

export interface CheckstyleFinding {
  file: string;
  line?: number;
  column?: number;
  /** The severity as the report writes it (error, warning, info, ignore...). */
  severity: string;
  message: string;
  /** The rule: the `source` attribute (a checker class or a rule name). */
  source: string;
}

export interface CheckstyleReport {
  ok: boolean;
  problem?: string;
  findings: CheckstyleFinding[];
}

const posInt = (v: string | undefined): number | undefined => {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export function readCheckstyle(xml: string): CheckstyleReport {
  if (!/<checkstyle[\s/>]/.test(xml)) return { ok: false, problem: "no <checkstyle> element", findings: [] };
  const findings: CheckstyleFinding[] = [];
  let file: string | null = null;
  for (const tag of tags(xml)) {
    if (tag.name === "file") {
      file = tag.closing || tag.selfClosing ? null : (attributes(tag.attrs).name ?? "");
      continue;
    }
    if (tag.name !== "error" || tag.closing || file === null) continue;
    const a = attributes(tag.attrs);
    const line = posInt(a.line);
    const column = posInt(a.column);
    findings.push({
      file,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
      severity: (a.severity ?? "").toLowerCase() || "error",
      message: a.message ?? "",
      source: a.source ?? "checkstyle",
    });
  }
  return { ok: true, findings };
}
