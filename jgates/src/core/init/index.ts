import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { builtinProfileBody, getBuiltinProfile, getBuiltinTemplate } from "../../builtin/index.js";
import { CONFIG_DIR, FRAGMENT_FILES, ROOT_FILE, ROOT_SCHEMA_VERSION } from "../config/load/index.js";
import { discoverWorkspace } from "../discovery/index.js";
import { starterProfileText } from "../profiles/index.js";
import { translator } from "../../i18n/index.js";

export const STARTER_PROFILES = ["minimal", "standard", "strict"] as const;
export const DEFAULT_PROFILE = "standard";
export const PROFILES_FILE = `${CONFIG_DIR}/${FRAGMENT_FILES.profiles}`;

export interface InitPlan {
  /** Project-relative path to file text, in the order they are written. */
  files: Array<{ file: string; text: string }>;
  /** Template ids written to jgates.yml. */
  templates: string[];
  profile: string;
  /** Component roots whose languages picked the templates. */
  components: string[];
}

interface TemplateEntry {
  id: string;
  source: string;
  languages?: string[];
  /** Detected by the configuration evidence of the template itself (its match.files): the entry carries no match. */
  evidence?: boolean;
}

const DOTNET_LANGUAGES = ["csharp", "fsharp", "visualbasic"];
const TS_LANGUAGES = ["typescript", "javascript"];

const PYTHON: TemplateEntry[] = [
  { id: "python", source: "builtin:python", languages: ["python"] },
  { id: "python-import-linter", source: "builtin:python-import-linter", evidence: true },
  { id: "python-pytest", source: "builtin:python-pytest", evidence: true },
  { id: "python-mypy", source: "builtin:python-mypy", evidence: true },
  { id: "python-pyright", source: "builtin:python-pyright", evidence: true },
  // Checks the strict profile turns on when available: off in the other profiles unless they switch them on.
  { id: "python-mypy-defaults", source: "builtin:python-mypy-defaults", evidence: true },
  { id: "python-format", source: "builtin:python-format", evidence: true },
  { id: "python-mutmut", source: "builtin:python-mutmut", evidence: true },
  { id: "python-codeql", source: "builtin:python-codeql", evidence: true },
];
const TYPESCRIPT: TemplateEntry[] = [
  { id: "typescript", source: "builtin:typescript", languages: TS_LANGUAGES },
  { id: "typescript-dependency-cruiser", source: "builtin:typescript-dependency-cruiser", evidence: true },
  { id: "typescript-eslint", source: "builtin:typescript-eslint", evidence: true },
  { id: "typescript-vitest", source: "builtin:typescript-vitest", evidence: true },
  { id: "typescript-tsc", source: "builtin:typescript-tsc", evidence: true },
  { id: "typescript-stryker", source: "builtin:typescript-stryker", evidence: true },
  { id: "typescript-prettier", source: "builtin:typescript-prettier", evidence: true },
  { id: "typescript-codeql", source: "builtin:typescript-codeql", evidence: true },
];
const DOTNET: TemplateEntry[] = [
  { id: "dotnet", source: "builtin:dotnet", languages: DOTNET_LANGUAGES },
  { id: "dotnet-build", source: "builtin:dotnet-build", evidence: true },
  { id: "dotnet-format", source: "builtin:dotnet-format", evidence: true },
  { id: "dotnet-analyzers", source: "builtin:dotnet-analyzers", evidence: true },
  { id: "dotnet-codeql", source: "builtin:dotnet-codeql", evidence: true },
];
/** Go and Rust have no stack template in init yet; the build check comes in by the language of the component. */
const GO: TemplateEntry[] = [
  { id: "go-build", source: "builtin:go-build", evidence: true },
  { id: "go-govulncheck", source: "builtin:go-govulncheck", evidence: true },
  { id: "go-gofmt", source: "builtin:go-gofmt", evidence: true },
  { id: "go-golangci-lint", source: "builtin:go-golangci-lint", evidence: true },
  { id: "go-codeql", source: "builtin:go-codeql", evidence: true },
];
const RUST: TemplateEntry[] = [
  { id: "rust-cargo-check", source: "builtin:rust-cargo-check", evidence: true },
  { id: "rust-cargo-audit", source: "builtin:rust-cargo-audit", evidence: true },
  { id: "rust-cargo-test", source: "builtin:rust-cargo-test", evidence: true },
  { id: "rust-rustfmt", source: "builtin:rust-rustfmt", evidence: true },
  { id: "rust-clippy", source: "builtin:rust-clippy", evidence: true },
];

/**
 * Language of a component -> the built-in templates that cover it. The stack template comes by language; ESLint,
 * Import Linter, dependency-cruiser, pytest and Vitest come by the evidence of their configuration (match.files of
 * their template), so a project without an eslint.config or an architecture contract never gets a step it cannot run.
 */
const TEMPLATE_BY_LANGUAGE: Record<string, TemplateEntry[]> = {
  python: PYTHON,
  typescript: TYPESCRIPT,
  javascript: TYPESCRIPT,
  go: GO,
  rust: RUST,
  csharp: DOTNET,
  fsharp: DOTNET,
  visualbasic: DOTNET,
};

/** The configuration files that already exist and would be overwritten (or made ambiguous) by init. */
export function existingConfigFiles(projectDir: string): string[] {
  const candidates = [ROOT_FILE, ...Object.values(FRAGMENT_FILES).map((name) => `${CONFIG_DIR}/${name}`)];
  return candidates.filter((file) => fs.existsSync(path.join(projectDir, file)));
}

function header(text: string): string {
  return text
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");
}

function profilesText(): string {
  const profiles: Record<string, unknown> = {};
  for (const id of STARTER_PROFILES) {
    const item = getBuiltinProfile(`builtin:${id}`);
    if (!item) throw new Error(`Starter profile builtin:${id} is missing`);
    // Same shape as the starter, but inheriting from it by name and with the id of the project.
    // The label and description in the language the configuration is created in (the person's UI or CLI language).
    const body = builtinProfileBody(item);
    const text = starterProfileText(id, body);
    profiles[id] = { ...body, ...(text.label ? { label: text.label } : {}), ...(text.description ? { description: text.description } : {}), extends: `builtin:${id}` };
  }
  const doc = YAML.stringify({ schemaVersion: 1, profiles }, { lineWidth: 0 });
  return `${header(translator("init")("init_file_header_profiles"))}\n${doc}`;
}

function rootText(profile: string, templates: TemplateEntry[]): string {
  const list = templates.map((t) =>
    t.languages
      ? { id: t.id, source: t.source, activation: "detected", match: { languages: t.languages } }
      : t.evidence
        ? { id: t.id, source: t.source, activation: "detected" }
        : { id: t.id, source: t.source, activation: "always" },
  );
  const doc = YAML.stringify(
    { schemaVersion: ROOT_SCHEMA_VERSION, extends: [PROFILES_FILE], selection: { profile }, templates: list },
    { lineWidth: 0 },
  );
  return `${header(translator("init")("init_file_header_root"))}\n${doc}`;
}

/** Whether .github/workflows holds at least one workflow file (.yml or .yaml). */
function hasWorkflows(projectDir: string): boolean {
  try {
    return fs.readdirSync(path.join(projectDir, ".github", "workflows"), { withFileTypes: true }).some((e) => e.isFile() && /\.ya?ml$/i.test(e.name));
  } catch {
    return false;
  }
}

/** Whether one of the evidence files of a built-in template (plain paths, `*` in the name) exists at the root. */
function hasEvidenceOf(projectDir: string, id: string): boolean {
  const match = getBuiltinTemplate(`builtin:${id}`)?.value.match as { files?: unknown[] } | undefined;
  const files = (match?.files ?? []).filter((f): f is string => typeof f === "string");
  return files.some((file) => {
    if (!file.includes("*")) return fs.existsSync(path.join(projectDir, ...file.split("/")));
    const slash = file.lastIndexOf("/");
    const pattern = new RegExp(`^${file.slice(slash + 1).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    try {
      return fs.readdirSync(path.join(projectDir, ...file.slice(0, Math.max(slash, 0)).split("/").filter(Boolean))).some((n) => pattern.test(n));
    } catch {
      return false;
    }
  });
}

/** Builds the files init would create from what discovery finds; touches nothing. */
export function planInit(projectDir: string, profile: string): InitPlan {
  const { inventory } = discoverWorkspace(projectDir);
  const found = inventory.classifications.filter((c) => c.classificationStatus === "detected" || c.classificationStatus === "explicit");
  const templates: TemplateEntry[] = [{ id: "base", source: "builtin:base" }];
  const seen = new Set<string>(["base"]);
  const components: string[] = [];
  for (const c of found) {
    const stack = c.language ? TEMPLATE_BY_LANGUAGE[c.language] : undefined;
    if (!stack) continue;
    components.push(c.componentRoot);
    for (const template of stack) {
      if (seen.has(template.id)) continue;
      seen.add(template.id);
      templates.push(template);
    }
  }
  // GitHub Actions workflows are CI evidence, not a language: the zizmor template comes in when one exists.
  if (hasWorkflows(projectDir)) templates.push({ id: "github-actions-zizmor", source: "builtin:github-actions-zizmor", evidence: true });
  // An OpenAPI specification at the root is API-contract evidence: the oasdiff template comes in when one exists.
  if (["openapi.yaml", "openapi.yml", "openapi.json"].some((f) => fs.existsSync(path.join(projectDir, f)))) templates.push({ id: "openapi-oasdiff", source: "builtin:openapi-oasdiff", evidence: true });
  // A npm or Python lockfile at the root is dependency-provenance evidence: the supply-chain template comes in when one exists.
  if (["package-lock.json", "npm-shrinkwrap.json", "poetry.lock", "Pipfile.lock"].some((f) => fs.existsSync(path.join(projectDir, f)))) templates.push({ id: "supply-chain", source: "builtin:supply-chain", evidence: true });
  // Git history and dependency manifests are evidence of the gitleaks history scan and of the Trivy license scan.
  if (hasEvidenceOf(projectDir, "gitleaks-history")) templates.push({ id: "gitleaks-history", source: "builtin:gitleaks-history", evidence: true });
  if (hasEvidenceOf(projectDir, "trivy-licenses")) templates.push({ id: "trivy-licenses", source: "builtin:trivy-licenses", evidence: true });
  // Shell scripts and Dockerfiles are not a language: their lint templates come in by the files themselves.
  if (hasEvidenceOf(projectDir, "shell-shellcheck")) templates.push({ id: "shell-shellcheck", source: "builtin:shell-shellcheck", evidence: true });
  if (hasEvidenceOf(projectDir, "docker-hadolint")) templates.push({ id: "docker-hadolint", source: "builtin:docker-hadolint", evidence: true });
  return {
    profile,
    templates: templates.map((t) => t.id),
    components,
    files: [
      { file: ROOT_FILE, text: rootText(profile, templates) },
      { file: PROFILES_FILE, text: profilesText() },
    ],
  };
}

/** Writes the plan without overwriting: a file that appeared in the meantime makes it fail. Returns what was written. */
export function writeInit(projectDir: string, plan: InitPlan): string[] {
  const written: string[] = [];
  try {
    for (const { file, text } of plan.files) {
      const absolute = path.join(projectDir, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, text, { encoding: "utf8", flag: "wx" });
      written.push(file);
    }
  } catch (error) {
    for (const file of written) fs.rmSync(path.join(projectDir, file), { force: true });
    throw error;
  }
  return written;
}
