// Which checks need the project's dependencies, and where their tool comes from (PLAN-dependencies.md section 7): a tool
// the component declares in its dependencies runs from the dependency volume (the project's version); a tool it does not
// declare runs from the image (the fallback), and the review says so.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import type { Classification } from "../discovery/types.js";

/**
 * Adapters whose checks run with the project's environment (tests, type checks, mutation, lint plugins, and govulncheck,
 * which loads the project's Go modules from the dependency volume because its step has no network).
 */
const DEPENDENT_ADAPTERS = new Set(["pytest", "vitest", "eslint", "mutation", "build-check", "cargo-test", "govulncheck"]);

export interface ToolItem {
  adapter: string | null;
  tool: string;
  components: Array<{ id: string; root: string; language: string | null }>;
  effects: { executesProjectCode: boolean };
}

/** The check runs the project's code or tools, so it needs the component's dependencies installed. */
export function needsDependencies(item: ToolItem): boolean {
  return item.effects.executesProjectCode || (item.adapter !== null && DEPENDENT_ADAPTERS.has(item.adapter));
}

interface ToolPackage {
  ecosystem: "python" | "node";
  /** Package name in the ecosystem's registry. */
  name: string;
  /** How the tool is called in messages. */
  label: string;
}

const PYTHON_LANGUAGES = new Set(["python"]);
const NODE_LANGUAGES = new Set(["typescript", "javascript"]);

/** The package of the tool an item runs, for the component's language; null for tools the project never supplies. */
export function toolPackage(item: ToolItem, language: string | null, contract?: Record<string, unknown>): ToolPackage | null {
  const python = language !== null && PYTHON_LANGUAGES.has(language);
  const node = language !== null && NODE_LANGUAGES.has(language);
  switch (item.adapter) {
    case "pytest":
      return { ecosystem: "python", name: "pytest", label: "pytest" };
    case "vitest":
      return { ecosystem: "node", name: "vitest", label: "vitest" };
    case "eslint":
      return { ecosystem: "node", name: "eslint", label: "eslint" };
    case "mutation":
      return python ? { ecosystem: "python", name: "mutmut", label: "mutmut" } : node ? { ecosystem: "node", name: "@stryker-mutator/core", label: "Stryker" } : null;
    case "build-check": {
      const checker = typeof contract?.checker === "string" ? contract.checker : null;
      if (checker === "mypy") return { ecosystem: "python", name: "mypy", label: "mypy" };
      if (checker === "pyright") return python ? { ecosystem: "python", name: "pyright", label: "pyright" } : { ecosystem: "node", name: "pyright", label: "pyright" };
      if (checker === "tsc") return { ecosystem: "node", name: "typescript", label: "tsc (typescript)" };
      return null;
    }
    default:
      return null;
  }
}

export interface ToolSource {
  /** project: the component declares the tool, the step runs its copy from the dependency volume; image: JGates's copy. */
  origin: "project" | "image";
  tool: string;
  package: string;
  component: string;
  /** Project-relative file that declares it (origin project). */
  declaredIn: string | null;
  /** Human sentence in the current language ("usa o mypy do JGates (o projeto não declara mypy)"). */
  message: string;
}

const PY_SEP = "[-_.]+";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pythonDeclares(text: string, name: string): boolean {
  const pattern = name.split(/[-_.]+/).map(escape).join(PY_SEP);
  return new RegExp(`(^|[\\s"'\\[,(=])${pattern}(?=[\\s"'<>=!~;\\[\\],()@]|$)`, "im").test(text);
}

function nodeDeclares(text: string, name: string): boolean {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((k) => {
      const v = pkg[k];
      return v !== null && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, name);
    });
  } catch {
    return false;
  }
}

const PYTHON_FILES = ["uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock", "pyproject.toml", "Pipfile", "setup.cfg"];

/** The file of the component (or of its install root) that declares the package, or null. */
export function declaringFile(projectDir: string, roots: string[], pkg: ToolPackage): string | null {
  for (const root of [...new Set(roots)]) {
    const dir = path.join(projectDir, ...(root === "." ? [] : root.split("/")));
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const candidates = pkg.ecosystem === "python" ? [...PYTHON_FILES.filter((n) => names.includes(n)), ...names.filter((n) => /^requirements.*\.txt$/.test(n)).sort()] : names.includes("package.json") ? ["package.json"] : [];
    for (const name of candidates) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, name), "utf8");
      } catch {
        continue;
      }
      const found = pkg.ecosystem === "python" ? pythonDeclares(text, pkg.name) : nodeDeclares(text, pkg.name);
      if (found) return root === "." ? name : `${root}/${name}`;
    }
  }
  return null;
}

/**
 * Where the tool of an item comes from, for its first component of a matching language: the project when the component
 * (or its install root) declares the package, the image otherwise. Null for items whose tool the project never supplies.
 */
export function toolSourceOf(projectDir: string, item: ToolItem, classifications: readonly Classification[], contract?: Record<string, unknown>): ToolSource | null {
  const t = translator("deps");
  for (const ref of item.components) {
    const pkg = toolPackage(item, ref.language, contract);
    if (!pkg) continue;
    const c = classifications.find((x) => x.id === ref.id);
    const roots = [ref.root, ...(c?.dependencies ? [c.dependencies.installRoot] : [])];
    const file = declaringFile(projectDir, roots, pkg);
    return {
      origin: file ? "project" : "image",
      tool: pkg.label,
      package: pkg.name,
      component: ref.id,
      declaredIn: file,
      message: file ? t("deps_tool_project", { tool: pkg.label, file }) : t("deps_tool_image", { tool: pkg.label }),
    };
  }
  return null;
}
