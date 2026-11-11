import type { FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";
import { HARNESSES } from "../index.js";

// Form of a performance instance: its settings live in tools.<id> of .jgates/tools.yml (scope "instance"), with exactly
// the names the adapter reads (harness, baseline, maxRegressionPercent). The budgets map (benchmark -> milliseconds)
// stays in the YAML.

const key = (name: string) => `services-checks:form_perf_${name}`;
function field(name: string, schema: JsonSchema, ui: Partial<FormFieldSpec["ui"]> & Pick<FormFieldSpec["ui"], "widget" | "order">): FormFieldSpec {
  return { path: [name], schema, ui: { label: key(name), help: key(`${name}_help`), group: "common", section: "budgets", ...ui } };
}

export const performanceForm: FormDefinition = {
  id: "performance",
  adapter: "performance",
  title: key("title"),
  scope: "instance",
  documents: [],
  sections: [{ id: "budgets", label: key("section_budgets") }],
  fields: [
    field("harness", { type: "string", enum: [...HARNESSES] }, { widget: "select", order: 10, options: Object.fromEntries(HARNESSES.map((h) => [h, { label: key(`harness_${h.replace(/-/g, "_")}`) }])) }),
    field("baseline", { type: "string", minLength: 1 }, { widget: "text", order: 20, format: "relative-path", example: "performance-baseline.json" }),
    field("maxRegressionPercent", { type: "number", minimum: 0, default: 20 }, { widget: "number", order: 30, unit: key("unit_percent") }),
  ],
};
