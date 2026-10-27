/** Kind of check that produced a diagnostic: syntax, schema or references. */
export type DiagnosticKind = "syntax" | "schema" | "reference";

export interface ConfigDiagnostic {
  kind: DiagnosticKind;
  /** Stable machine code, for example UNKNOWN_KEY or YAML_TAG_FORBIDDEN. */
  code: string;
  /** Path of the file, relative to the configuration directory (the project unless a policy is used), with forward slashes. */
  file: string;
  /** Path of the field inside the document, for example "profiles.rapido.extends"; "" for the whole document. */
  path: string;
  pathSegments: string[];
  /** Message in the catalog language. */
  message: string;
  /** Probable name for an unknown key. */
  suggestion?: string;
  /** 1-based position in the file, when known. */
  line?: number;
  column?: number;
}

/** Documents of the configuration. */
export type DocumentKind = "root" | "workspace" | "tools" | "policy" | "profiles" | "architecture" | "pii";

export const SCHEMA_KINDS: readonly DocumentKind[] = ["root", "workspace", "tools", "policy", "profiles"];

/** File name (inside .jgates/) of each fragment kind. */
export const FRAGMENT_FILES: Readonly<Record<Exclude<DocumentKind, "root">, string>> = {
  workspace: "workspace.yml",
  tools: "tools.yml",
  policy: "policy.yml",
  profiles: "profiles.yml",
  architecture: "architecture.yml",
  pii: "pii.yml",
};

export interface LoadedDocument {
  kind: DocumentKind;
  /** Relative path (forward slashes) from the configuration directory. */
  file: string;
  /** Parsed value; undefined when the file could not be read or parsed. */
  value: unknown;
  /** True when the document kind has no schema yet, so only syntax was checked. */
  schemaPending: boolean;
}

export interface ConfigLoadResult {
  /** The project the configuration applies to (the analyzed files). */
  projectDir: string;
  /**
   * Where jgates.yml and .jgates/ were read from: the project itself, or an external folder (a CI policy) whose
   * configuration replaces the project's own. Document paths are relative to it.
   */
  configDir: string;
  /** True when there is no diagnostic. */
  valid: boolean;
  documents: LoadedDocument[];
  /** Convenience lookup by kind. */
  byKind: Partial<Record<DocumentKind, LoadedDocument>>;
  diagnostics: ConfigDiagnostic[];
}

export interface YamlLimits {
  maxBytes: number;
  maxDepth: number;
  maxAliases: number;
}

export const DEFAULT_LIMITS: YamlLimits = { maxBytes: 1024 * 1024, maxDepth: 64, maxAliases: 50 };
