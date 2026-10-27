import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { builtinProfileBody, getBuiltinProfile } from "../../builtin/index.js";
import { CONFIG_DIR, FRAGMENT_FILES, ROOT_FILE } from "../config/load/index.js";
import { discoverWorkspace } from "../discovery/index.js";

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
];
const TYPESCRIPT: TemplateEntry[] = [
  { id: "typescript", source: "builtin:typescript", languages: TS_LANGUAGES },
  { id: "typescript-dependency-cruiser", source: "builtin:typescript-dependency-cruiser", evidence: true },
  { id: "typescript-eslint", source: "builtin:typescript-eslint", evidence: true },
  { id: "typescript-vitest", source: "builtin:typescript-vitest", evidence: true },
];
const DOTNET: TemplateEntry[] = [{ id: "dotnet", source: "builtin:dotnet", languages: DOTNET_LANGUAGES }];

/**
 * Language of a component -> the built-in templates that cover it. The stack template comes by language; ESLint,
 * Import Linter, dependency-cruiser, pytest and Vitest come by the evidence of their configuration (match.files of
 * their template), so a project without an eslint.config or an architecture contract never gets a step it cannot run.
 */
const TEMPLATE_BY_LANGUAGE: Record<string, TemplateEntry[]> = {
  python: PYTHON,
  typescript: TYPESCRIPT,
  javascript: TYPESCRIPT,
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
    profiles[id] = { ...builtinProfileBody(item), extends: `builtin:${id}` };
  }
  const doc = YAML.stringify({ schemaVersion: 1, profiles }, { lineWidth: 0 });
  return `${header("Perfis do projeto (JGates). Cada perfil herda do perfil de partida de mesmo nome\n(builtin:*) e pode ser editado, renomeado ou removido.")}\n${doc}`;
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
    { schemaVersion: 1, extends: [PROFILES_FILE], selection: { profile }, templates: list },
    { lineWidth: 0 },
  );
  return `${header("Configuração do JGates: perfil usado por padrão e templates das stacks do projeto.\nOs perfis ficam em .jgates/profiles.yml.")}\n${doc}`;
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
