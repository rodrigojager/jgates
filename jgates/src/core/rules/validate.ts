// Syntax and contract checks of a Semgrep rule file. Parse only: nothing is executed and no alias is expanded into
// the checks. The contract is the part of the Semgrep rule schema the plan depends on (id, message, severity,
// languages and one matcher); the scanner itself still reports anything deeper when the run starts.
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

export type RuleIssueKind = "syntax" | "contract";

export interface RuleIssue {
  kind: RuleIssueKind;
  code: string;
  message: string;
  line: number | null;
  column: number | null;
  /** Id of the rule the issue belongs to, when known. */
  ruleId?: string;
}

export interface RuleSummary {
  id: string;
  line: number | null;
}

export interface RuleFileValidation {
  status: "valid" | "invalid";
  issues: RuleIssue[];
  rules: RuleSummary[];
}

export const SEVERITIES = ["ERROR", "WARNING", "INFO", "INVENTORY", "EXPERIMENT", "CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const MATCHERS = ["pattern", "patterns", "pattern-either", "pattern-regex", "match"] as const;
const MODES = ["search", "taint", "extract", "join"] as const;

function position(lc: LineCounter, node: unknown): { line: number | null; column: number | null } {
  const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
  if (!range) return { line: null, column: null };
  const p = lc.linePos(range[0]);
  return { line: p.line, column: p.col };
}

/** Validates the text of one rule file. */
export function validateRuleText(text: string): RuleFileValidation {
  const issues: RuleIssue[] = [];
  const rules: RuleSummary[] = [];
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  for (const e of [...doc.errors]) {
    issues.push({ kind: "syntax", code: "YAML_SYNTAX", message: e.message.split("\n")[0] ?? e.message, ...(e.pos ? { line: lc.linePos(e.pos[0]).line, column: lc.linePos(e.pos[0]).col } : { line: null, column: null }) });
  }
  if (issues.length > 0) return { status: "invalid", issues, rules };

  const contract = (code: string, message: string, node: unknown, ruleId?: string): void => {
    issues.push({ kind: "contract", code, message, ...position(lc, node), ...(ruleId ? { ruleId } : {}) });
  };
  const root = doc.contents as Node | null;
  if (!isMap(root)) {
    contract("RULES_MISSING", "O arquivo precisa ter a chave rules com a lista de regras.", root ?? doc);
    return { status: "invalid", issues, rules };
  }
  const list = root.get("rules", true);
  if (!isSeq(list)) {
    contract("RULES_MISSING", "O arquivo precisa ter a chave rules com a lista de regras.", root);
    return { status: "invalid", issues, rules };
  }
  if (list.items.length === 0) contract("RULES_EMPTY", "A lista rules está vazia.", list);
  const seen = new Set<string>();
  for (const item of list.items) {
    if (!isMap(item)) {
      contract("RULE_NOT_MAP", "Cada regra precisa ser um mapa com id, message, severity, languages e um padrão.", item);
      continue;
    }
    const idNode = item.get("id", true);
    const id = isScalar(idNode) && typeof idNode.value === "string" ? idNode.value : null;
    const where = id ?? undefined;
    if (!id || id.trim() === "" || /\s/.test(id)) contract("RULE_ID", "A regra precisa de um id em texto, sem espaços.", idNode ?? item, where);
    else {
      if (seen.has(id)) contract("RULE_ID_DUPLICATE", `O id ${id} aparece mais de uma vez neste arquivo.`, idNode, id);
      seen.add(id);
      rules.push({ id, line: position(lc, idNode).line });
    }
    const message = item.get("message", true);
    if (!isScalar(message) || typeof message.value !== "string" || message.value.trim() === "") contract("RULE_MESSAGE", "A regra precisa de uma message em texto.", message ?? item, where);
    const severity = item.get("severity", true);
    if (!isScalar(severity) || typeof severity.value !== "string" || !(SEVERITIES as readonly string[]).includes(severity.value)) {
      contract("RULE_SEVERITY", `A severity precisa ser uma de ${SEVERITIES.join(", ")}.`, severity ?? item, where);
    }
    const mode = item.get("mode", true);
    const modeValue = isScalar(mode) && typeof mode.value === "string" ? mode.value : "search";
    if (mode !== undefined && !(MODES as readonly string[]).includes(modeValue)) contract("RULE_MODE", `O mode precisa ser um de ${MODES.join(", ")}.`, mode, where);
    const languages = item.get("languages", true);
    const languagesOk = isSeq(languages) && languages.items.length > 0 && languages.items.every((l) => isScalar(l) && typeof l.value === "string" && l.value !== "");
    if (modeValue !== "join" && !languagesOk) contract("RULE_LANGUAGES", "A regra precisa de languages: uma lista não vazia de linguagens.", languages ?? item, where);
    if (modeValue === "taint") {
      for (const key of ["pattern-sources", "pattern-sinks"]) {
        const v = item.get(key, true);
        if (!isSeq(v) || v.items.length === 0) contract("RULE_MATCHER", `Uma regra com mode: taint precisa de ${key}.`, v ?? item, where);
      }
    } else if (modeValue === "search" || modeValue === "extract") {
      const found = MATCHERS.filter((m) => item.has(m));
      if (found.length === 0) contract("RULE_MATCHER", `A regra precisa de um padrão: ${MATCHERS.join(", ")}.`, item, where);
      else if (found.length > 1) contract("RULE_MATCHER_MANY", `Use um só padrão de topo por regra (achados: ${found.join(", ")}).`, item, where);
    }
  }
  return { status: issues.length > 0 ? "invalid" : "valid", issues, rules };
}
