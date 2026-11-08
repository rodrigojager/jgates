// Path heuristics that say what a file is for the impact proposal: a shared authorization/tenant guard, a contract or
// schema, configuration, a dependency manifest, code or other. They are deterministic and disclosed as heuristics
// (a reason says "classified by its path"); they widen what is proposed as context, never what is claimed covered.
import path from "node:path";
import type { FileCategory } from "./types.js";

export const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
export const PY_EXTENSIONS = new Set([".py"]);
const CODE_EXTENSIONS = new Set([...JS_EXTENSIONS, ...PY_EXTENSIONS, ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift", ".scala", ".c", ".h", ".cpp", ".hpp", ".vue", ".svelte"]);

const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "uv.lock",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const GUARD = /(^|[/._-])(auth|authz|authn|guard|guards|middleware|middlewares|permission|permissions|policy|policies|acl|rbac|tenant|tenancy|session|access)([/._-]|$)/i;
const CONTRACT = /(^|[/._-])(schema|schemas|contract|contracts|openapi|swagger|dto|dtos|interfaces?)([/._-]|$)|\.(proto|graphql|gql|avsc)$|\.d\.ts$/i;
const CONFIG_EXT = new Set([".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".json", ".env"]);
const CONFIG_NAME = /(^|[/._-])(config|configs|configuration|settings|defaults?)([/._-]|$)|\.config\.[cm]?[jt]s$|^\.env(\.|$)|(^|\/)\.env(\.[\w-]+)?$|(^|\/)dockerfile$/i;

export function isManifest(p: string): boolean {
  const base = path.posix.basename(p).toLowerCase();
  return MANIFESTS.has(base) || /^requirements([._-][\w-]+)?\.(txt|in)$/.test(base);
}

export function isJs(p: string): boolean {
  return JS_EXTENSIONS.has(path.posix.extname(p).toLowerCase());
}

export function isPython(p: string): boolean {
  return PY_EXTENSIONS.has(path.posix.extname(p).toLowerCase());
}

export function isCode(p: string): boolean {
  return CODE_EXTENSIONS.has(path.posix.extname(p).toLowerCase());
}

/** Categories of a path, most specific first; a file can be a guard and code at once. */
export function categoriesOf(p: string): FileCategory[] {
  const out: FileCategory[] = [];
  const lower = p.toLowerCase();
  const ext = path.posix.extname(lower);
  if (isManifest(lower)) return ["dependency-manifest"];
  if (isCode(lower) && GUARD.test(lower)) out.push("shared-guard");
  if (CONTRACT.test(lower)) out.push("contract");
  if ((CONFIG_EXT.has(ext) && !out.includes("contract")) || CONFIG_NAME.test(lower)) out.push("configuration");
  if (isCode(lower)) out.push("code");
  if (out.length === 0) out.push("other");
  return out;
}

/** Configuration that applies to the whole workspace: at the root or under a top-level config folder. */
export function isGlobalConfiguration(p: string): boolean {
  if (isCode(p) && !/\.config\.[cm]?[jt]s$/i.test(p)) return false;
  const cats = categoriesOf(p);
  if (!cats.includes("configuration")) return false;
  const parts = p.split("/");
  return parts.length === 1 || (parts.length === 2 && /^(config|configs|configuration|settings)$/i.test(parts[0] ?? ""));
}
