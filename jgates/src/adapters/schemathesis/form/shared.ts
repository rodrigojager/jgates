import type { FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";

/**
 * The capabilities the instance declares (tools.<id>.capabilities): a profile turns a check on by capability
 * (capability:dast), so an instance without them is never selected. Proposed checked when absent (prefill), so the
 * person sees it and the first save writes it.
 */
export function capabilitiesField(area: string, capabilities: string[], section: string): FormFieldSpec {
  return {
    path: ["capabilities"],
    schema: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: capabilities } },
    ui: {
      label: `${area}:${area}_form_capabilities`,
      help: `${area}:${area}_form_capabilities_help`,
      group: "common",
      section,
      widget: "string-list",
      order: 1,
      required: true,
      prefill: capabilities,
      options: Object.fromEntries(capabilities.map((c) => [c, { label: `${area}:${area}_form_capability_${c.replace(/-/g, "_")}` }])),
    },
  };
}

// Field schemas shared by the forms of the runtime API checks (Schemathesis, ZAP) and of oasdiff: they accept exactly
// what the adapters' own readers accept (checkTarget, safeRelative), so a value the form saves is never refused later.

/** An http(s) base URL with a host, without credentials, query or fragment (what checkTarget accepts). */
export const HTTP_URL: JsonSchema = { type: "string", pattern: "^https?://[^\\s/?#@]+(/[^\\s?#]*)?$" };

/** A relative path that stays inside its root (what safeRelative accepts). */
export const RELATIVE_PATH: JsonSchema = { type: "string", minLength: 1, pattern: "^(?![/\\\\]|[A-Za-z]:)(?!(.*[/\\\\])?\\.\\.([/\\\\]|$))[^\\r\\n]+$" };

/** OpenAPI files offered for a spec setting: the names the adapters look for, then any other openapi or swagger file. */
export const OPENAPI_FILES = {
  candidates: [
    "openapi.yaml",
    "openapi.yml",
    "openapi.json",
    "swagger.yaml",
    "swagger.yml",
    "swagger.json",
    "api/openapi.yaml",
    "api/openapi.yml",
    "api/openapi.json",
    "docs/openapi.yaml",
    "docs/openapi.yml",
    "docs/openapi.json",
    "spec/openapi.yaml",
    "spec/openapi.yml",
    "spec/openapi.json",
  ],
  pattern: "^(openapi|swagger)[^/\\\\]*\\.(ya?ml|json)$",
};
