import type { DetectContext } from "./detectors.js";
import { compareStrings } from "./walk.js";

/**
 * Dependency detection: how a component's own dependencies install (PLAN-dependencies.md section 2).
 * It reads files through the detection context only; it never runs a package manager.
 */

export const DEPENDENCY_MANAGERS = ["uv", "poetry", "pdm", "pipenv", "pip", "npm", "pnpm", "yarn", "bun", "go", "cargo", "dotnet"] as const;
export type DependencyManager = (typeof DEPENDENCY_MANAGERS)[number];
export type DependencyEcosystem = "python" | "node" | "go" | "rust" | "dotnet";

/** detected: one manager; ambiguous: several, the user picks; unsupported: a manager JGates cannot install with. */
export type DependencyState = "detected" | "ambiguous" | "unsupported" | "configured";

export const NO_LOCKFILE_NOTE = "sem lockfile";

export interface LanguageVersion {
  /** The version requirement exactly as written in the source file, or null when nothing pins it. */
  version: string | null;
  /** Project-relative file the version came from, with the key when it is inside a manifest. */
  source: string | null;
  /** Kind of source: python-version, requires-python, nvmrc, engines-node, go-mod, rust-toolchain, global-json... */
  sourceKind: string | null;
}

export interface DependencyInfo {
  ecosystem: DependencyEcosystem;
  state: DependencyState;
  /** Chosen or detected manager; null when ambiguous or unsupported without a known id. */
  manager: DependencyManager | null;
  /** "berry" or "classic" for yarn. */
  variant: string | null;
  /** The managers to choose from when ambiguous; empty otherwise. */
  candidates: DependencyManager[];
  /** Project-relative lockfile, null when the component has none. */
  lockfile: string | null;
  /** Project-relative directory where the install runs ("." for the project root). */
  installRoot: string;
  language: LanguageVersion;
  /** Dependency groups or extras the install includes (dev and test included by default). */
  groups: string[];
  /** "sem lockfile" when the install would come from the manifest only; otherwise null. */
  note: string | null;
  /** Reason code of an unsupported or ambiguous state. */
  reasonCode: string | null;
  /** "detected" from files, "workspace-config" when components[].dependencies.manager chose it. */
  chosenBy: "detected" | "workspace-config";
}

export interface DependencyOverride {
  manager?: string;
  groups?: string[];
}

const ECOSYSTEM_OF_LANGUAGE: Readonly<Record<string, DependencyEcosystem>> = {
  python: "python",
  typescript: "node",
  javascript: "node",
  go: "go",
  rust: "rust",
  csharp: "dotnet",
  fsharp: "dotnet",
  vb: "dotnet",
};

const MANAGERS_OF: Readonly<Record<DependencyEcosystem, readonly DependencyManager[]>> = {
  python: ["uv", "poetry", "pdm", "pipenv", "pip"],
  node: ["npm", "pnpm", "yarn", "bun"],
  go: ["go"],
  rust: ["cargo"],
  dotnet: ["dotnet"],
};

const LOCKFILES: Readonly<Record<string, DependencyManager>> = {
  "uv.lock": "uv",
  "poetry.lock": "poetry",
  "pdm.lock": "pdm",
  "Pipfile.lock": "pipenv",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "go.sum": "go",
  "Cargo.lock": "cargo",
  "packages.lock.json": "dotnet",
};

const LOCKFILE_ECOSYSTEM: Readonly<Record<string, DependencyEcosystem>> = {
  "uv.lock": "python",
  "poetry.lock": "python",
  "pdm.lock": "python",
  "Pipfile.lock": "python",
  "package-lock.json": "node",
  "npm-shrinkwrap.json": "node",
  "pnpm-lock.yaml": "node",
  "yarn.lock": "node",
  "bun.lockb": "node",
  "bun.lock": "node",
  "go.sum": "go",
  "Cargo.lock": "rust",
  "packages.lock.json": "dotnet",
};

const join = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);
const parentOf = (dir: string): string | null => (dir === "." ? null : dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".");
const namesIn = (ctx: DetectContext, dir: string): string[] => ctx.byDir.get(dir) ?? [];
const uniqSorted = <T extends string>(xs: T[]): T[] => [...new Set(xs)].sort(compareStrings) as T[];

/** The directory itself, then each ancestor up to the project root. */
function chain(dir: string): string[] {
  const out: string[] = [];
  for (let d: string | null = dir; d !== null; d = parentOf(d)) out.push(d);
  return out;
}

function tableBody(text: string, table: string): string | undefined {
  const header = new RegExp(`^\\s*\\[${table.replace(/\./g, "\\.")}\\]\\s*(?:#.*)?$`, "m").exec(text);
  if (!header) return undefined;
  const rest = text.slice(header.index + header[0].length);
  const next = /^\s*\[/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function tomlString(body: string | undefined, key: string): string | null {
  if (!body) return null;
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m").exec(body);
  return m ? ((m[1] ?? m[2]) as string) : null;
}

function jsonObject(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const NO_VERSION: LanguageVersion = { version: null, source: null, sourceKind: null };

function firstLine(text: string | undefined): string | null {
  if (text === undefined) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line) return line;
  }
  return null;
}

/** First version source found walking from the component root up; within a directory the order is the priority. */
function findVersion(ctx: DetectContext, dir: string, ecosystem: DependencyEcosystem, installRoot: string): LanguageVersion {
  const dirs = uniqSorted([...chain(dir), ...chain(installRoot)]).sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    const names = namesIn(ctx, d);
    const has = (n: string): boolean => names.includes(n);
    const file = (n: string): string => join(d, n);
    const read = (n: string): string | undefined => (has(n) ? ctx.read(file(n)) : undefined);
    const hit = (version: string | null, source: string, sourceKind: string): LanguageVersion | null =>
      version ? { version, source, sourceKind } : null;
    let found: LanguageVersion | null = null;
    switch (ecosystem) {
      case "python": {
        found =
          hit(firstLine(read(".python-version")), file(".python-version"), "python-version") ??
          hit(tomlString(tableBody(read("pyproject.toml") ?? "", "project"), "requires-python"), file("pyproject.toml"), "requires-python") ??
          hit(firstLine(read("runtime.txt"))?.replace(/^python-?/i, "") ?? null, file("runtime.txt"), "runtime-txt");
        break;
      }
      case "node": {
        const pkg = jsonObject(read("package.json"));
        const engines = pkg?.engines as { node?: unknown } | undefined;
        found =
          hit(firstLine(read(".nvmrc")), file(".nvmrc"), "nvmrc") ??
          hit(firstLine(read(".node-version")), file(".node-version"), "node-version") ??
          hit(typeof engines?.node === "string" ? engines.node : null, file("package.json"), "engines-node");
        break;
      }
      case "go": {
        const text = read("go.mod") ?? "";
        const toolchain = /^\s*toolchain\s+(\S+)/m.exec(text)?.[1]?.replace(/^go/, "") ?? null;
        const goLine = /^\s*go\s+(\S+)/m.exec(text)?.[1] ?? null;
        found = hit(toolchain, file("go.mod"), "go-mod-toolchain") ?? hit(goLine, file("go.mod"), "go-mod-go");
        break;
      }
      case "rust": {
        const tomlText = read("rust-toolchain.toml");
        const plain = read("rust-toolchain");
        const channel = tomlString(tableBody(tomlText ?? "", "toolchain"), "channel") ?? (plain !== undefined && !/=/.test(plain) ? firstLine(plain) : tomlString(plain, "channel"));
        const cargo = read("Cargo.toml") ?? "";
        const rv = tomlString(tableBody(cargo, "package"), "rust-version");
        found =
          hit(channel, file(tomlText !== undefined ? "rust-toolchain.toml" : "rust-toolchain"), "rust-toolchain") ??
          hit(rv, file("Cargo.toml"), "rust-version");
        break;
      }
      case "dotnet": {
        const sdk = (jsonObject(read("global.json"))?.sdk as { version?: unknown } | undefined)?.version;
        found = hit(typeof sdk === "string" ? sdk : null, file("global.json"), "global-json");
        break;
      }
    }
    if (found) return found;
  }
  return NO_VERSION;
}

interface Lock {
  name: string;
  dir: string;
  manager: DependencyManager;
}

/** Lockfiles of the ecosystem in the directory itself, or in the nearest ancestor that has any (workspace roots). */
function findLocks(ctx: DetectContext, dir: string, ecosystem: DependencyEcosystem): Lock[] {
  for (const d of chain(dir)) {
    const locks = namesIn(ctx, d)
      .filter((n) => LOCKFILE_ECOSYSTEM[n] === ecosystem)
      .map((n) => ({ name: n, dir: d, manager: LOCKFILES[n] as DependencyManager }));
    if (locks.length > 0) return locks;
  }
  return [];
}

function yarnVariant(ctx: DetectContext, dir: string, pkg: Record<string, unknown> | null): string {
  for (const d of chain(dir)) if (namesIn(ctx, d).includes(".yarnrc.yml")) return "berry";
  const pm = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  const m = /^yarn@(\d+)/.exec(pm);
  return m && Number(m[1]) >= 2 ? "berry" : "classic";
}

function pythonManifestManager(ctx: DetectContext, dir: string): { manager: DependencyManager; file: string } | null {
  const names = namesIn(ctx, dir);
  const req = names.find((n) => /^requirements.*\.txt$/.test(n));
  if (names.includes("Pipfile")) return { manager: "pipenv", file: join(dir, "Pipfile") };
  const text = names.includes("pyproject.toml") ? (ctx.read(join(dir, "pyproject.toml")) ?? "") : undefined;
  if (text !== undefined && tableBody(text, "tool.poetry") !== undefined) return { manager: "poetry", file: join(dir, "pyproject.toml") };
  if (text !== undefined && tableBody(text, "tool.pdm") !== undefined) return { manager: "pdm", file: join(dir, "pyproject.toml") };
  if (req) return { manager: "pip", file: join(dir, req) };
  if (text !== undefined) return { manager: "uv", file: join(dir, "pyproject.toml") };
  return null;
}

function pythonGroups(ctx: DetectContext, dir: string): string[] {
  const text = namesIn(ctx, dir).includes("pyproject.toml") ? (ctx.read(join(dir, "pyproject.toml")) ?? "") : "";
  const groups = new Set<string>(["main"]);
  const keysOf = (body: string | undefined): string[] => (body ? [...body.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1] as string) : []);
  for (const k of keysOf(tableBody(text, "project.optional-dependencies"))) groups.add(k);
  for (const k of keysOf(tableBody(text, "dependency-groups"))) groups.add(k);
  for (const m of text.matchAll(/^\s*\[tool\.poetry\.group\.([A-Za-z0-9_.-]+)\.dependencies\]/gm)) groups.add(m[1] as string);
  if (/^\s*\[tool\.poetry\.dev-dependencies\]/m.test(text)) groups.add("dev");
  return [...groups].sort(compareStrings);
}

function nodeGroups(pkg: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const v = pkg?.[k];
    if (v && typeof v === "object" && Object.keys(v).length > 0) out.push(k);
  }
  return out;
}

function pickManager(ecosystem: DependencyEcosystem, id: string | undefined): DependencyManager | null {
  const lower = id?.toLowerCase();
  return lower && (MANAGERS_OF[ecosystem] as readonly string[]).includes(lower) ? (lower as DependencyManager) : null;
}

/** The dependencies block of one component; null for a language without a supported ecosystem. */
export function detectDependencies(ctx: DetectContext, componentRoot: string, language: string | null, override?: DependencyOverride): DependencyInfo | null {
  const ecosystem = language ? ECOSYSTEM_OF_LANGUAGE[language] : undefined;
  if (!ecosystem) return null;
  const names = namesIn(ctx, componentRoot);
  const pkg = ecosystem === "node" ? jsonObject(names.includes("package.json") ? ctx.read(join(componentRoot, "package.json")) : undefined) : null;
  const locks = findLocks(ctx, componentRoot, ecosystem);
  const lockManagers = uniqSorted(locks.map((l) => l.manager));
  const chosen = pickManager(ecosystem, override?.manager);

  let manager: DependencyManager | null = null;
  let state: DependencyState = "detected";
  let reasonCode: string | null = null;
  let candidates: DependencyManager[] = [];
  let lock: Lock | undefined;
  let installRoot = componentRoot;
  let chosenBy: "detected" | "workspace-config" = "detected";

  if (chosen) {
    manager = chosen;
    chosenBy = "workspace-config";
    state = "configured";
    lock = locks.find((l) => l.manager === chosen);
  } else if (lockManagers.length > 1) {
    state = "ambiguous";
    reasonCode = "CONFLICTING_LOCKFILES";
    candidates = lockManagers;
  } else if (lockManagers.length === 1) {
    manager = lockManagers[0] as DependencyManager;
    lock = locks[0];
  } else {
    // No lockfile: the manager comes from the manifests.
    if (ecosystem === "python") manager = pythonManifestManager(ctx, componentRoot)?.manager ?? null;
    else if (ecosystem === "node") {
      const field = typeof pkg?.packageManager === "string" ? (pkg.packageManager.split("@")[0] as string) : "";
      manager = pickManager("node", field) ?? "npm";
    } else manager = MANAGERS_OF[ecosystem][0] as DependencyManager;
  }
  if (lock) installRoot = lock.dir;
  else if (ecosystem === "python" || ecosystem === "node") installRoot = componentRoot;

  if (manager === "bun" && state !== "configured") {
    state = "unsupported";
    reasonCode = "BUN_UNSUPPORTED";
  } else if (manager === "bun") {
    reasonCode = "BUN_UNSUPPORTED";
  }
  // A lockfile of a manager the user did not choose is not the lockfile of the install.
  const lockfile = lock ? join(lock.dir, lock.name) : null;
  // Go and Cargo always have a manifest; the lockfile can still be missing. .NET and pip also.
  const hasLock = lockfile !== null;
  const note = !hasLock && manager !== null && state !== "ambiguous" ? NO_LOCKFILE_NOTE : null;

  const groups = override?.groups
    ? [...override.groups].sort(compareStrings)
    : ecosystem === "python"
      ? pythonGroups(ctx, componentRoot)
      : ecosystem === "node"
        ? nodeGroups(pkg)
        : [];

  return {
    ecosystem,
    state,
    manager,
    variant: manager === "yarn" ? yarnVariant(ctx, installRoot, pkg) : null,
    candidates,
    lockfile,
    installRoot,
    language: findVersion(ctx, componentRoot, ecosystem, installRoot),
    groups,
    note,
    reasonCode,
    chosenBy,
  };
}
