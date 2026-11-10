import type { FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";
import { HTTP_URL, OPENAPI_FILES, RELATIVE_PATH, capabilitiesField } from "../../schemathesis/form/shared.js";
import { RISK_LEVELS } from "../normalize.js";

// Form of a ZAP instance: its settings live in tools.<id> of .jgates/tools.yml (scope "instance"), with exactly the
// names zapSettings reads (target, mode, allowActive, spec, blockingRisk, spiderMinutes). The authentication
// header (auth) stays in the YAML: it is listed as "not in the form" and never touched.

const key = (name: string) => `zap:zap_form_${name}`;
function field(name: string, schema: JsonSchema, ui: Partial<FormFieldSpec["ui"]> & Pick<FormFieldSpec["ui"], "widget" | "order">): FormFieldSpec {
  return { path: [name], schema, ui: { label: key(name), help: key(`${name}_help`), group: "common", section: "scan", ...ui } };
}

export const zapForm: FormDefinition = {
  id: "zap",
  adapter: "zap",
  title: key("title"),
  scope: "instance",
  documents: [],
  sections: [
    { id: "scan", label: key("section_scan") },
    { id: "advanced", label: key("section_advanced") },
  ],
  fields: [
    capabilitiesField("zap", ["dast"], "scan"),
    field("target", HTTP_URL, { widget: "text", order: 10, required: true, format: "http-url", example: "http://localhost:8000" }),
    field("mode", { type: "string", enum: ["passive", "active"], default: "passive" }, {
      widget: "radio",
      order: 20,
      options: { passive: { label: key("mode_passive"), help: key("mode_passive_help") }, active: { label: key("mode_active"), help: key("mode_active_help") } },
    }),
    field("allowActive", { type: "boolean", default: false }, { widget: "boolean", order: 30, showWhen: { field: "mode", equals: "active" } }),
    field("spec", RELATIVE_PATH, { widget: "text", order: 40, format: "relative-path", suggestFiles: OPENAPI_FILES, example: "openapi.yaml" }),
    field("blockingRisk", { type: "string", enum: [...RISK_LEVELS], default: "medium" }, {
      widget: "select",
      order: 50,
      options: Object.fromEntries(RISK_LEVELS.map((r) => [r, { label: key(`risk_${r}`) }])),
    }),
    field("spiderMinutes", { type: "integer", minimum: 1, maximum: 60, default: 1 }, { widget: "number", order: 60, group: "advanced", section: "advanced", unit: key("unit_minutes") }),
  ],
  rules: [{ when: { field: "mode", equals: "active" }, require: { field: "allowActive", equals: true }, message: key("rule_active") }],
};
