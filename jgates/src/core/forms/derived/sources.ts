// Value sources: a field whose values are known somewhere (a file of the project, a git ref, a service, an id of the
// workspace or of the catalogue) names its source, and the UI offers a picker of those values instead of typing. The
// field always stays a free value: the picker is a help, never a restriction the schema does not make.
//
// The table is keyed by kind of document and field pattern (map entries as "*", array items as "[]"), so it applies
// to the schema form and to every concrete key of a file alike.
import type { ConfigKind } from "./schemas.js";

/** The names of the value sources the UI knows how to offer. */
export const VALUE_SOURCES = [
  /** A file of the project, filtered by `pattern` (a regular expression over the relative path). Globs keep a text field. */
  "project-file",
  /** A folder of the project. */
  "project-folder",
  /** A git ref: local branches, tags and recent commits. */
  "git-ref",
  /** A target of a runtime check: a service and port of jgates.yml services, or a URL. */
  "service-target",
  /** A service of the project's compose files. */
  "service",
  /** A component of the workspace. */
  "component",
  /** A language of the inventory or of the catalogue. */
  "language",
  /** A framework of the inventory or of the catalogue. */
  "framework",
  /** A capability of the catalogue (or an x-custom: capability of an own tool). */
  "capability",
  /** A profile (builtin:<id> or a project profile). */
  "profile",
  /** A template (builtin:<id> or a file of .jgates/templates). */
  "template",
  /** A tool instance of the project. */
  "tool-instance",
  /** An adapter of the catalogue. */
  "adapter",
  /** A check selector of a profile (category:, capability:, tool:, rule:, pii:, architecture:, component:). */
  "check-selector",
  /** A layer of .jgates/architecture.yml. */
  "architecture-layer",
] as const;

export type ValueSourceName = (typeof VALUE_SOURCES)[number];

export interface ValueSource {
  name: ValueSourceName;
  /** For project-file: a regular expression (case-insensitive) over the relative path of the files offered. */
  pattern?: string;
  /** The value may be a glob; the UI keeps the text and previews what it matches. */
  glob?: boolean;
}

const file = (pattern?: string, glob = false): ValueSource => ({ name: "project-file", ...(pattern ? { pattern } : {}), ...(glob ? { glob } : {}) });
const folder = (glob = false): ValueSource => ({ name: "project-folder", ...(glob ? { glob } : {}) });
const src = (name: ValueSourceName): ValueSource => ({ name });

const OPENAPI = "(^|/)(openapi|swagger)[^/]*\\.(ya?ml|json)$";

const TOOL_INSTANCE: Record<string, ValueSource> = {
  adapter: src("adapter"),
  component: src("component"),
  capabilities: src("capability"),
  config: file(),
  base: folder(),
  spec: file(OPENAPI),
  baseSpec: file(OPENAPI),
  target: src("service-target"),
  baseRef: src("git-ref"),
  prismaSchema: file("\\.prisma$"),
  prismaMigrations: folder(),
  dotnetProject: file("\\.csproj$"),
  sql: file("\\.sql$", true),
  baseline: file("\\.json$"),
  tsconfig: file("(^|/)tsconfig[^/]*\\.json$"),
  lockfiles: file("(^|/)(package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|poetry\\.lock|uv\\.lock|Pipfile\\.lock|requirements[^/]*\\.txt)$"),
  imageTarball: file("\\.tar$"),
  mutate: file(undefined, true),
  "selection.paths[]": folder(),
  "configFiles.*.path": file(),
  "config.path": file(),
};

function prefixed(prefix: string, table: Record<string, ValueSource>): Record<string, ValueSource> {
  return Object.fromEntries(Object.entries(table).map(([k, v]) => [`${prefix}.${k}`, v]));
}

const TABLE: Partial<Record<string, Record<string, ValueSource>>> = {
  root: {
    "extends[]": file("\\.ya?ml$"),
    "selection.profile": src("profile"),
    "selection.paths[]": folder(true),
    "templates[].source": src("template"),
    "templates[].match.languages[]": src("language"),
    "templates[].match.frameworks[]": src("framework"),
    "templates[].match.files[]": file(),
    "services.compose[]": file("(^|/)(docker-)?compose[^/]*\\.ya?ml$"),
    "services.start[]": src("service"),
    "services.writableBinds[]": src("service"),
    "services.target.service": src("service"),
  },
  workspace: {
    "components[].path": folder(),
    "components[].language": src("language"),
    "components[].framework": src("framework"),
    "components[].include[]": folder(true),
    "components[].exclude[]": folder(true),
    "include[]": folder(true),
    "exclude[]": folder(true),
  },
  tools: {
    ...prefixed("tools.*", TOOL_INSTANCE),
    "bindings[].tool": src("tool-instance"),
    "bindings[].component": src("component"),
    "bindings[].capability": src("capability"),
    "externalRoots[].path": folder(),
  },
  profiles: {
    "profiles.*.extends": src("profile"),
    "profiles.*.checks.*": src("check-selector"),
  },
  policy: {
    "requiredEvidence[].check": src("check-selector"),
    "exceptions[].paths[]": file(undefined, true),
  },
  architecture: {
    "architecture.layers[].component": src("component"),
    "architecture.layers[].language": src("language"),
    "architecture.layers[].paths[]": folder(true),
    "architecture.rules[].from": src("architecture-layer"),
    "architecture.rules[].to[]": src("architecture-layer"),
    "architecture.rules[].within": src("architecture-layer"),
    "architecture.rules[].layer": src("architecture-layer"),
    "architecture.rules[].component": src("component"),
    "architecture.rules[].allowedDependencies[]": src("component"),
  },
  pii: {
    "fix.includes[]": file(undefined, true),
    "fix.excludes[]": file(undefined, true),
  },
  template: {
    "match.languages[]": src("language"),
    "match.frameworks[]": src("framework"),
    "match.files[]": file(),
    "extends[]": src("template"),
    ...prefixed("config.tools.*", TOOL_INSTANCE),
  },
};

/**
 * The value source of a field pattern of a document kind. A list of values (pattern ending in a list) takes the
 * source of its items: `services.start` and `services.start[]` give the same picker.
 */
export function valueSourceOf(kind: ConfigKind, pattern: string): ValueSource | undefined {
  const table = TABLE[kind];
  if (!table) return undefined;
  return table[pattern] ?? table[`${pattern}[]`];
}
