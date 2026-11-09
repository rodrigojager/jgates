import type { FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";
import { ALLOWED_CHECKS, DEFAULT_CHECKS } from "../index.js";
import { HTTP_URL, OPENAPI_FILES, RELATIVE_PATH, capabilitiesField } from "./shared.js";

// Form of a Schemathesis instance: its settings live in tools.<id> of .jgates/tools.yml (scope "instance"), with
// exactly the names schemathesisSettings reads (target, spec, checks, maxExamples, requestTimeoutSeconds, seed). The
// authentication header (auth) stays in the YAML: it is listed as "not in the form" and never touched.

const key = (name: string) => `schemathesis:schemathesis_form_${name}`;
function field(name: string, schema: JsonSchema, ui: Partial<FormFieldSpec["ui"]> & Pick<FormFieldSpec["ui"], "widget" | "order">): FormFieldSpec {
  return { path: [name], schema, ui: { label: key(name), help: key(`${name}_help`), group: "common", section: "api", ...ui } };
}

export const schemathesisForm: FormDefinition = {
  id: "schemathesis",
  adapter: "schemathesis",
  title: key("title"),
  scope: "instance",
  documents: [],
  sections: [
    { id: "api", label: key("section_api") },
    { id: "advanced", label: key("section_advanced") },
  ],
  fields: [
    capabilitiesField("schemathesis", ["api-contract"], "api"),
    field("spec", RELATIVE_PATH, { widget: "text", order: 10, format: "relative-path", suggestFiles: OPENAPI_FILES, example: "openapi.yaml" }),
    field("target", HTTP_URL, { widget: "text", order: 20, required: true, format: "http-url", example: "http://localhost:8000" }),
    field(
      "checks",
      { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...ALLOWED_CHECKS] }, default: [...DEFAULT_CHECKS] },
      { widget: "string-list", order: 30, group: "advanced", section: "advanced", options: Object.fromEntries(ALLOWED_CHECKS.map((c) => [c, { label: key(`check_${c}`) }])) },
    ),
    field("maxExamples", { type: "integer", minimum: 1, maximum: 10_000, default: 50 }, { widget: "number", order: 40, group: "advanced", section: "advanced" }),
    field("requestTimeoutSeconds", { type: "integer", minimum: 1, maximum: 300, default: 10 }, { widget: "number", order: 50, group: "advanced", section: "advanced", unit: key("unit_seconds") }),
    field("seed", { type: "integer", minimum: 0, maximum: 2 ** 31 - 1, default: 1 }, { widget: "number", order: 60, group: "advanced", section: "advanced" }),
  ],
};
