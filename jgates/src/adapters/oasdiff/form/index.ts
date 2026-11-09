import type { FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";
import { OPENAPI_FILES, RELATIVE_PATH, capabilitiesField } from "../../schemathesis/form/shared.js";
import { FAIL_ON_LEVELS } from "../normalize.js";

// Form of an oasdiff instance: its settings live in tools.<id> of .jgates/tools.yml (scope "instance"), with exactly
// the names oasdiffSettings reads (spec, baseRef, baseSpec, failOn). baseRef and baseSpec exclude each other: the form
// shows them as one choice ("Git ref" or "reference file") and saving one removes the other.

/** A git ref the plan accepts (REF_PATTERN of the adapter): no option-looking value, no whitespace, no range syntax. */
const GIT_REF: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9_][A-Za-z0-9._/~^@-]*$" };

const key = (name: string) => `oasdiff:oasdiff_form_${name}`;
function field(name: string, schema: JsonSchema, ui: Partial<FormFieldSpec["ui"]> & Pick<FormFieldSpec["ui"], "widget" | "order">): FormFieldSpec {
  return { path: [name], schema, ui: { label: key(name), help: key(`${name}_help`), group: "common", section: "compare", ...ui } };
}

export const oasdiffForm: FormDefinition = {
  id: "oasdiff",
  adapter: "oasdiff",
  title: key("title"),
  scope: "instance",
  documents: [],
  sections: [{ id: "compare", label: key("section_compare") }],
  fields: [
    capabilitiesField("oasdiff", ["api-compatibility"], "compare"),
    field("spec", RELATIVE_PATH, { widget: "text", order: 10, format: "relative-path", suggestFiles: OPENAPI_FILES, example: "openapi.yaml" }),
    field("baseRef", GIT_REF, { widget: "text", order: 20, format: "git-ref", example: "origin/main" }),
    field("baseSpec", RELATIVE_PATH, { widget: "text", order: 30, format: "relative-path", suggestFiles: OPENAPI_FILES, example: "api/openapi.base.yaml" }),
    field("failOn", { type: "string", enum: [...FAIL_ON_LEVELS], default: "ERR" }, {
      widget: "select",
      order: 40,
      options: Object.fromEntries(FAIL_ON_LEVELS.map((l) => [l, { label: key(`fail_on_${l}`), help: key(`fail_on_${l}_help`) }])),
    }),
  ],
  choices: [
    {
      id: "base",
      label: key("base"),
      help: key("base_help"),
      required: true,
      options: [
        { field: "baseRef", label: key("base_ref"), help: key("base_ref_help") },
        { field: "baseSpec", label: key("base_spec"), help: key("base_spec_help") },
      ],
    },
  ],
};
