import type { FormDefinition, FormFieldSpec, JsonSchema } from "../../../core/forms/types.js";
import { FRAMEWORKS } from "../index.js";

// Form of a migration-drift instance: its settings live in tools.<id> of .jgates/tools.yml (scope "instance"), with
// exactly the names the adapter reads (framework, databaseUrl, databaseUrlEnv, and the per-framework paths). databaseUrl
// is the setting JGates cannot guess (the services database and its credentials).

const key = (name: string) => `services-checks:form_migration_${name}`;
function field(name: string, schema: JsonSchema, ui: Partial<FormFieldSpec["ui"]> & Pick<FormFieldSpec["ui"], "widget" | "order">): FormFieldSpec {
  return { path: [name], schema, ui: { label: key(name), help: key(`${name}_help`), group: "common", section: "database", ...ui } };
}

export const migrationDriftForm: FormDefinition = {
  id: "migration-drift",
  adapter: "migration-drift",
  title: key("title"),
  scope: "instance",
  documents: [],
  sections: [
    { id: "database", label: key("section_database") },
    { id: "advanced", label: key("section_advanced") },
  ],
  fields: [
    field("framework", { type: "string", enum: [...FRAMEWORKS] }, { widget: "select", order: 10, options: Object.fromEntries(FRAMEWORKS.map((f) => [f, { label: key(`framework_${f}`) }])) }),
    field("databaseUrl", { type: "string", minLength: 1 }, { widget: "text", order: 20, required: true, example: "postgresql://app:app@db:5432/app" }),
    field("databaseUrlEnv", { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", default: "DATABASE_URL" }, { widget: "text", order: 30, group: "advanced", section: "advanced" }),
    field("prismaSchema", { type: "string", minLength: 1 }, { widget: "text", order: 40, group: "advanced", section: "advanced", format: "relative-path", example: "prisma/schema.prisma", showWhen: { field: "framework", equals: "prisma" } }),
    field("dotnetProject", { type: "string", minLength: 1 }, { widget: "text", order: 50, group: "advanced", section: "advanced", format: "relative-path", example: "App.csproj", showWhen: { field: "framework", equals: "efcore" } }),
    field("sql", { type: "array", minItems: 1, items: { type: "string", pattern: "\\.sql$" } }, { widget: "glob-list", order: 60, group: "advanced", section: "advanced", example: "migrations/**/*.sql", showWhen: { field: "framework", equals: "squawk" } }),
  ],
};
