// Reference checks of .jgates/architecture.yml: a rule must point at layers and rules must be unique.
// Used by the project loader (config validate); schema-level problems are reported by architecture.schema.json.
import { suggestName } from "../config/load/schema.js";

export interface ArchitectureReferenceProblem {
  code: "REF_LAYER_UNKNOWN" | "REF_DUPLICATE_ID";
  /** Key of the config catalog. */
  messageKey: "config_ref_layer_unknown" | "config_ref_duplicate_id";
  params: { id: string };
  /** Field of the document, for example ["architecture", "rules", "0", "to", "1"]. */
  segments: string[];
  suggestion?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function architectureReferenceProblems(document: unknown): ArchitectureReferenceProblem[] {
  const problems: ArchitectureReferenceProblem[] = [];
  const architecture = asRecord(asRecord(document)?.architecture);
  if (!architecture) return problems;
  const layers = Array.isArray(architecture.layers) ? architecture.layers : [];
  const layerIds = new Set<string>();
  layers.forEach((entry, index) => {
    const id = asRecord(entry)?.id;
    if (typeof id !== "string") return;
    if (layerIds.has(id)) problems.push({ code: "REF_DUPLICATE_ID", messageKey: "config_ref_duplicate_id", params: { id }, segments: ["architecture", "layers", String(index), "id"] });
    layerIds.add(id);
  });
  const known = [...layerIds];
  const checkLayer = (segments: string[], id: unknown): void => {
    if (typeof id !== "string" || id === "" || layerIds.has(id)) return;
    const suggestion = suggestName(id, known);
    problems.push({ code: "REF_LAYER_UNKNOWN", messageKey: "config_ref_layer_unknown", params: { id }, segments, ...(suggestion ? { suggestion } : {}) });
  };
  const ruleIds = new Set<string>();
  const rules = Array.isArray(architecture.rules) ? architecture.rules : [];
  rules.forEach((entry, index) => {
    const rule = asRecord(entry);
    if (!rule) return;
    const at = ["architecture", "rules", String(index)];
    if (typeof rule.id === "string") {
      if (ruleIds.has(rule.id)) problems.push({ code: "REF_DUPLICATE_ID", messageKey: "config_ref_duplicate_id", params: { id: rule.id }, segments: [...at, "id"] });
      ruleIds.add(rule.id);
    }
    checkLayer([...at, "from"], rule.from);
    if (Array.isArray(rule.to)) rule.to.forEach((id, i) => checkLayer([...at, "to", String(i)], id));
    checkLayer([...at, "within"], rule.within);
    checkLayer([...at, "layer"], rule.layer);
  });
  return problems;
}
