import type { FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";

// Form of a playwright instance: its settings live in tools.<id> of .jgates/tools.yml (scope "instance"), with exactly
// the names the adapter reads (e2eRunner, target). Without a target the services target of jgates.yml is used.

const key = (name: string) => `services-checks:form_e2e_${name}`;
function field(name: string, schema: JsonSchema, ui: Partial<FormFieldSpec["ui"]> & Pick<FormFieldSpec["ui"], "widget" | "order">): FormFieldSpec {
  return { path: [name], schema, ui: { label: key(name), help: key(`${name}_help`), group: "common", section: "e2e", ...ui } };
}

export const playwrightForm: FormDefinition = {
  id: "playwright",
  adapter: "playwright",
  title: key("title"),
  scope: "instance",
  documents: [],
  sections: [{ id: "e2e", label: key("section_e2e") }],
  fields: [
    field("e2eRunner", { type: "string", enum: ["playwright-test", "pytest"] }, { widget: "select", order: 10, options: { "playwright-test": { label: key("runner_playwright_test") }, pytest: { label: key("runner_pytest") } } }),
    field("target", { type: "string", pattern: "^(?:https?://[^\\s@?#]+|service:[A-Za-z0-9][A-Za-z0-9_.-]*:[0-9]{1,5}(?:/[^\\s?#]*)?)$" }, { widget: "text", order: 20, example: "service:web:8080" }),
  ],
};
