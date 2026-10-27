import type { FieldGroup, FieldWidget, FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";

// Form of [tool.pytest.ini_options] in pyproject.toml (pytest 7 and later). List options take TOML arrays here; a
// string where the form expects a list is shown as "not recognized" and left as it is (pytest also splits strings,
// but the form never rewrites a value it did not write). Defaults are pytest's, shown only as the inherited value.

const strings = (extra: JsonSchema = {}): JsonSchema => ({ type: "array", items: { type: "string", minLength: 1 }, ...extra });
const LOG_LEVELS = ["CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"];

function field(name: string, schema: JsonSchema, group: FieldGroup, section: string, widget: FieldWidget, order: number, extra: Partial<FormFieldSpec["ui"]> = {}): FormFieldSpec {
  const key = `forms_pytest_${name}`;
  return { path: [name], schema, ui: { label: key, help: `${key}_help`, group, section, widget, order, ...extra } };
}

export const pytestForm: FormDefinition = {
  id: "pytest",
  adapter: "pytest",
  title: "forms_pytest_title",
  documents: [{ file: "pyproject.toml", section: ["tool", "pytest", "ini_options"] }],
  sections: [
    { id: "collection", label: "forms_section_collection" },
    { id: "execution", label: "forms_section_execution" },
    { id: "output", label: "forms_section_output" },
  ],
  fields: [
    field("testpaths", strings(), "common", "collection", "glob-list", 10, { example: "tests" }),
    field("addopts", { type: "string" }, "common", "execution", "text", 20, { example: "-ra -q" }),
    field("minversion", { type: "string", pattern: "^[0-9]+(\\.[0-9]+)*$" }, "common", "execution", "text", 30, { example: "8.0" }),
    field("markers", strings(), "common", "collection", "string-list", 40, { example: "slow: testes demorados" }),
    field("xfail_strict", { type: "boolean", default: false }, "common", "execution", "boolean", 50),
    field("python_files", strings({ default: ["test_*.py", "*_test.py"] }), "advanced", "collection", "glob-list", 60, { example: "check_*.py" }),
    field("python_classes", strings({ default: ["Test"] }), "advanced", "collection", "string-list", 70),
    field("python_functions", strings({ default: ["test"] }), "advanced", "collection", "string-list", 80),
    field("norecursedirs", strings(), "advanced", "collection", "glob-list", 90, { example: "build" }),
    field("pythonpath", strings(), "advanced", "collection", "glob-list", 100, { example: "src" }),
    field("filterwarnings", strings(), "advanced", "execution", "string-list", 110, { example: "error", ordered: true }),
    field("required_plugins", strings(), "advanced", "execution", "string-list", 120, { example: "pytest-cov>=4" }),
    field("usefixtures", strings(), "advanced", "execution", "string-list", 130),
    field("empty_parameter_set_mark", { type: "string", enum: ["skip", "xfail", "fail_at_collect"], default: "skip" }, "advanced", "execution", "select", 140),
    field("console_output_style", { type: "string", enum: ["classic", "progress", "count", "progress-even-when-capture-no"], default: "progress" }, "advanced", "output", "select", 150),
    field("log_cli", { type: "boolean", default: false }, "advanced", "output", "boolean", 160),
    field("log_cli_level", { type: "string", enum: LOG_LEVELS }, "advanced", "output", "select", 170),
    field("junit_family", { type: "string", enum: ["legacy", "xunit1", "xunit2"], default: "xunit2" }, "advanced", "output", "radio", 180),
  ],
};
