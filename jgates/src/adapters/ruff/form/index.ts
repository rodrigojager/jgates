import type { FieldGroup, FieldWidget, FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";

// Form of the Ruff configuration ([tool.ruff] of pyproject.toml, or the root of ruff.toml / .ruff.toml), with lint
// and formatting kept apart. The data schemas follow the Ruff settings reference (0.5 and later); defaults are those
// documented by Ruff and are only shown as the inherited value, never written. Anything else in the section (plugins'
// settings such as lint.isort, deprecated top-level select) is left untouched and listed as "not in the form".

/** A Ruff rule selector: ALL, a linter prefix (E, PLR, ASYNC) or a code (F401, RUF100). */
const RULE = { type: "string", pattern: "^(ALL|[A-Z]{1,6}[0-9]{0,4})$" };
const rules: JsonSchema = { type: "array", items: RULE };
const globs = (extra: JsonSchema = {}): JsonSchema => ({ type: "array", items: { type: "string", minLength: 1 }, ...extra });

const PYTHON_VERSIONS = ["py37", "py38", "py39", "py310", "py311", "py312", "py313", "py314"];

function field(path: string[], schema: JsonSchema, group: FieldGroup, section: string, widget: FieldWidget, order: number, extra: Partial<FormFieldSpec["ui"]> = {}): FormFieldSpec {
  const key = `forms_ruff_${path.join("_").replace(/-/g, "_")}`;
  return { path, schema, ui: { label: key, help: `${key}_help`, group, section, widget, order, ...extra } };
}

export const ruffForm: FormDefinition = {
  id: "ruff",
  adapter: "ruff",
  title: "forms_ruff_title",
  documents: [
    { file: "pyproject.toml", section: ["tool", "ruff"] },
    { file: "ruff.toml", section: [] },
    { file: ".ruff.toml", section: [] },
  ],
  sections: [
    { id: "general", label: "forms_section_general" },
    { id: "lint", label: "forms_section_lint" },
    { id: "format", label: "forms_section_format" },
  ],
  fields: [
    // General (shared by the linter and the formatter).
    field(["line-length"], { type: "integer", minimum: 1, maximum: 320, default: 88 }, "common", "general", "number", 10, { unit: "forms_unit_columns", example: "88" }),
    field(["target-version"], { type: "string", enum: PYTHON_VERSIONS }, "common", "general", "select", 20),
    field(["include"], globs({ default: ["*.py", "*.pyi", "*.ipynb", "**/pyproject.toml"] }), "common", "general", "glob-list", 30, { example: "src/**/*.py" }),
    field(["exclude"], globs(), "common", "general", "glob-list", 40, { example: "build/" }),
    field(["extend-exclude"], globs(), "advanced", "general", "glob-list", 50, { example: "migrations/" }),
    field(["src"], globs({ default: [".", "src"] }), "advanced", "general", "glob-list", 60, { example: "src" }),
    field(["indent-width"], { type: "integer", minimum: 1, maximum: 16, default: 4 }, "advanced", "general", "number", 70, { unit: "forms_unit_spaces" }),
    field(["respect-gitignore"], { type: "boolean", default: true }, "advanced", "general", "boolean", 80),
    field(["preview"], { type: "boolean", default: false }, "advanced", "general", "boolean", 90),
    field(["fix"], { type: "boolean", default: false }, "advanced", "general", "boolean", 100),
    field(["required-version"], { type: "string", minLength: 1 }, "advanced", "general", "text", 110, { example: ">=0.5.0" }),
    // Lint.
    field(["lint", "select"], { ...rules, default: ["E4", "E7", "E9", "F"] }, "common", "lint", "rule-list", 200, { example: "E" }),
    field(["lint", "ignore"], rules, "common", "lint", "rule-list", 210, { example: "F401" }),
    field(["lint", "extend-select"], rules, "advanced", "lint", "rule-list", 220, { example: "B" }),
    field(["lint", "per-file-ignores"], { type: "object", propertyNames: { minLength: 1 }, additionalProperties: rules }, "advanced", "lint", "list-map", 230, { example: "tests/**/*.py" }),
    field(["lint", "fixable"], { ...rules, default: ["ALL"] }, "advanced", "lint", "rule-list", 240),
    field(["lint", "unfixable"], rules, "advanced", "lint", "rule-list", 250),
    field(["lint", "dummy-variable-rgx"], { type: "string", minLength: 1 }, "advanced", "lint", "text", 260, { example: "^_$" }),
    field(["lint", "preview"], { type: "boolean", default: false }, "advanced", "lint", "boolean", 270),
    // Formatting.
    field(["format", "quote-style"], { type: "string", enum: ["double", "single", "preserve"], default: "double" }, "common", "format", "radio", 300),
    field(["format", "indent-style"], { type: "string", enum: ["space", "tab"], default: "space" }, "advanced", "format", "radio", 310),
    field(["format", "line-ending"], { type: "string", enum: ["auto", "lf", "cr-lf", "native"], default: "auto" }, "advanced", "format", "select", 320),
    field(["format", "skip-magic-trailing-comma"], { type: "boolean", default: false }, "advanced", "format", "boolean", 330),
    field(["format", "docstring-code-format"], { type: "boolean", default: false }, "advanced", "format", "boolean", 340),
    field(["format", "exclude"], globs(), "advanced", "format", "glob-list", 350, { example: "generated/" }),
  ],
};
