// .jgates/dependencies.yml (optional): private registries per ecosystem (the URL and the NAME of the secret holding the
// token, never the token) and the install command of a manager JGates does not support. Read through the configuration
// loader, so the file is validated against schemas/config/dependencies.schema.json like every other document.
import { loadProjectConfig, type ConfigDiagnostic } from "../config/load/index.js";
import type { DependencyEcosystem } from "../discovery/dependencies.js";

export interface RegistrySettings {
  url: string;
  /** Name of the secret (key store or CI environment) that holds the token; absent: the registry needs none. */
  tokenSecret: string | null;
}

export interface DependencySettings {
  /** Project-relative file the settings came from; null without the file. */
  file: string | null;
  registries: Partial<Record<DependencyEcosystem, RegistrySettings>>;
  /** install.command: the install of an unsupported manager (bun), run with `sh -c` in the install root. */
  installCommand: string | null;
  diagnostics: ConfigDiagnostic[];
}

export const NO_DEPENDENCY_SETTINGS: DependencySettings = { file: null, registries: {}, installCommand: null, diagnostics: [] };

const ECOSYSTEMS: readonly DependencyEcosystem[] = ["python", "node", "go", "rust", "dotnet"];

/**
 * The dependency settings of a configuration folder (the project, or the CI policy in governed runs). An invalid file
 * gives no registry and no command (fail-closed: nothing is sent anywhere), with its diagnostics.
 */
export function loadDependencySettings(configDir: string): DependencySettings {
  const loaded = loadProjectConfig(configDir);
  const doc = loaded.byKind.dependencies;
  if (!doc) return NO_DEPENDENCY_SETTINGS;
  const diagnostics = loaded.diagnostics.filter((d) => d.file === doc.file);
  if (diagnostics.length > 0 || !doc.value || typeof doc.value !== "object") return { ...NO_DEPENDENCY_SETTINGS, file: doc.file, diagnostics };
  const value = doc.value as { registries?: Record<string, { url?: unknown; tokenSecret?: unknown }>; install?: { command?: unknown } };
  const registries: DependencySettings["registries"] = {};
  for (const ecosystem of ECOSYSTEMS) {
    const entry = value.registries?.[ecosystem];
    if (entry && typeof entry.url === "string") registries[ecosystem] = { url: entry.url, tokenSecret: typeof entry.tokenSecret === "string" ? entry.tokenSecret : null };
  }
  return { file: doc.file, registries, installCommand: typeof value.install?.command === "string" ? value.install.command : null, diagnostics: [] };
}
