import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { matchesExactly, normalizePattern } from "./glob.js";
import { compareStrings } from "./walk.js";
import type { ClassificationStatus } from "./types.js";

/** A component found by one detector, before explicit declarations and filters are applied. */
export interface Candidate {
  root: string;
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  kind: string | null;
  detectedBy: string;
  evidence: string[];
  reasonCode: string;
  status: ClassificationStatus;
}

export interface DetectContext {
  files: string[];
  /** Directory ("." for the root) -> sorted file names inside it. */
  byDir: Map<string, string[]>;
  read(rel: string): string | undefined;
  caseInsensitive: boolean;
}

export function joinPath(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}
export function dirnameOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "." : rel.slice(0, i);
}
export function isUnder(child: string, ancestor: string): boolean {
  return ancestor === "." ? child !== "." : child.startsWith(`${ancestor}/`);
}
function relativeTo(child: string, base: string): string {
  return base === "." ? child : child.slice(base.length + 1);
}
function hasAncestor(dir: string, set: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const a of set) if (isUnder(dir, a) && (best === undefined || a.length > best.length)) best = a;
  return best;
}
function namesIn(ctx: DetectContext, dir: string): string[] {
  return ctx.byDir.get(dir) ?? [];
}
const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort(compareStrings);

export function buildContext(files: string[], root: string, maxBytes: number, caseInsensitive: boolean): DetectContext {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const d = dirnameOf(f);
    const list = byDir.get(d) ?? [];
    list.push(f.slice(d === "." ? 0 : d.length + 1));
    byDir.set(d, list);
  }
  for (const list of byDir.values()) list.sort(compareStrings);
  const read = (rel: string): string | undefined => {
    try {
      const abs = path.join(root, ...rel.split("/"));
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > maxBytes) return undefined;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  };
  return { files, byDir, read, caseInsensitive };
}

function dirsWith(ctx: DetectContext, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const [dir, names] of ctx.byDir) if (names.some(test)) out.push(dir);
  return out.sort(compareStrings);
}

/** Members of a workspace container among `candidates` (directories), by positive and negated patterns. */
function resolveMembers(container: string, candidates: string[], patterns: string[], ci: boolean): string[] {
  const pos = patterns.filter((p) => !p.startsWith("!")).map(normalizePattern);
  const neg = patterns.filter((p) => p.startsWith("!")).map((p) => normalizePattern(p.slice(1)));
  return candidates.filter((d) => {
    if (!isUnder(d, container)) return false;
    const rel = relativeTo(d, container);
    return pos.some((p) => matchesExactly(p, rel, { caseInsensitive: ci })) && !neg.some((p) => matchesExactly(p, rel, { caseInsensitive: ci }));
  });
}

function strings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'/g)) out.push((m[1] ?? m[2]) as string);
  return out;
}

function tableBody(text: string, table: string): string | undefined {
  const header = new RegExp(`^\\s*\\[${table.replace(/\./g, "\\.")}\\]\\s*(?:#.*)?$`, "m").exec(text);
  if (!header) return undefined;
  const rest = text.slice(header.index + header[0].length);
  const next = /^\s*\[/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function arrayValue(body: string | undefined, key: string): string[] {
  if (!body) return [];
  const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body);
  return m ? strings(m[1] as string) : [];
}

function firstWord(text: string, table: ReadonlyArray<readonly [string, string]>): string | null {
  const lower = text.toLowerCase();
  for (const [needle, label] of table) {
    const re = new RegExp(`(?:^|[\\s"'])${needle.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}(?=[\\s"'<>=~!\\[,;:]|$)`, "m");
    if (re.test(lower)) return label;
  }
  return null;
}

// ---------------------------------------------------------------- Node (npm, pnpm, yarn, bun)

const NODE_LOCKFILES: Readonly<Record<string, string>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};
const NODE_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["next", "next"],
  ["@nestjs/core", "nestjs"],
  ["@angular/core", "angular"],
  ["nuxt", "nuxt"],
  ["svelte", "svelte"],
  ["vue", "vue"],
  ["react", "react"],
  ["fastify", "fastify"],
  ["express", "express"],
];

interface NodeManifest {
  dir: string;
  pkg: Record<string, unknown> | null;
  patterns: string[];
}

function workspacePatterns(pkg: Record<string, unknown> | null, pnpmText: string | undefined): string[] {
  const out: string[] = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) out.push(...ws.filter((x): x is string => typeof x === "string"));
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    out.push(...((ws as { packages: unknown[] }).packages.filter((x): x is string => typeof x === "string")));
  }
  if (pnpmText !== undefined) {
    try {
      const doc = parseYaml(pnpmText, { maxAliasCount: 50 }) as { packages?: unknown } | null;
      if (doc && Array.isArray(doc.packages)) out.push(...doc.packages.filter((x): x is string => typeof x === "string"));
    } catch {
      /* an unreadable pnpm-workspace.yaml adds no members */
    }
  }
  return out;
}

export function detectNode(ctx: DetectContext): Candidate[] {
  const dirs = dirsWith(ctx, (n) => n === "package.json");
  const manifests = new Map<string, NodeManifest>();
  for (const dir of dirs) {
    const text = ctx.read(joinPath(dir, "package.json"));
    let pkg: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pkg = parsed as Record<string, unknown>;
    } catch {
      pkg = null;
    }
    const pnpmText = namesIn(ctx, dir).includes("pnpm-workspace.yaml") ? ctx.read(joinPath(dir, "pnpm-workspace.yaml")) : undefined;
    manifests.set(dir, { dir, pkg, patterns: workspacePatterns(pkg, pnpmText) });
  }

  const memberOf = new Map<string, string>();
  const containers = new Set<string>();
  for (const m of manifests.values()) {
    if (m.patterns.length === 0) continue;
    const members = resolveMembers(m.dir, dirs, m.patterns, ctx.caseInsensitive);
    if (members.length === 0) continue;
    containers.add(m.dir);
    for (const member of members) {
      const current = memberOf.get(member);
      if (current === undefined || current.length < m.dir.length) memberOf.set(member, m.dir);
    }
  }

  const out: Candidate[] = [];
  for (const m of manifests.values()) {
    if (containers.has(m.dir)) continue;
    const container = memberOf.get(m.dir);
    const names = namesIn(ctx, m.dir);
    const lockDir = names.some((n) => n in NODE_LOCKFILES) || container === undefined ? m.dir : container;
    const locks = namesIn(ctx, lockDir).filter((n) => n in NODE_LOCKFILES);
    const managers = uniqSorted(locks.map((l) => NODE_LOCKFILES[l] as string));
    const evidence = [joinPath(m.dir, "package.json"), ...locks.map((l) => joinPath(lockDir, l))];
    if (container !== undefined) {
      evidence.push(joinPath(container, "package.json"));
      if (namesIn(ctx, container).includes("pnpm-workspace.yaml")) evidence.push(joinPath(container, "pnpm-workspace.yaml"));
    }
    const tsconfigs = names.filter((n) => /^tsconfig.*\.json$/.test(n));
    const deps = Object.keys({
      ...((m.pkg?.dependencies as object | undefined) ?? {}),
      ...((m.pkg?.devDependencies as object | undefined) ?? {}),
      ...((m.pkg?.peerDependencies as object | undefined) ?? {}),
    });
    const isTs = tsconfigs.length > 0 || deps.includes("typescript");
    evidence.push(...tsconfigs.map((n) => joinPath(m.dir, n)));
    const field = typeof m.pkg?.packageManager === "string" ? (m.pkg.packageManager.split("@")[0] as string) : null;
    let status: ClassificationStatus = "detected";
    let reason = container !== undefined ? "WORKSPACE_MEMBER" : "PACKAGE_JSON";
    const ancestor = container === undefined ? hasAncestor(m.dir, manifests.keys()) : undefined;
    if (m.pkg === null) {
      status = "ambiguous";
      reason = "MANIFEST_UNREADABLE";
    } else if (managers.length > 1) {
      status = "ambiguous";
      reason = "CONFLICTING_LOCKFILES";
    } else if (ancestor !== undefined) {
      status = "ambiguous";
      reason = "NESTED_PROJECT";
      evidence.push(joinPath(ancestor, "package.json"));
    }
    out.push({
      root: m.dir,
      language: isTs ? "typescript" : "javascript",
      framework: firstWord(deps.map((d) => ` ${d} `).join("\n"), NODE_FRAMEWORKS),
      packageManager: managers.length === 1 ? (managers[0] as string) : managers.length === 0 ? field : null,
      kind: null,
      detectedBy: "node-package-json",
      evidence: uniqSorted(evidence),
      reasonCode: reason,
      status,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Python

const PY_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["django", "django"],
  ["fastapi", "fastapi"],
  ["flask", "flask"],
  ["starlette", "starlette"],
  ["tornado", "tornado"],
];
const PY_LOOSE_MANIFESTS = ["setup.py", "setup.cfg", "requirements.txt", "Pipfile"];

export function detectPython(ctx: DetectContext): Candidate[] {
  const pyprojectDirs = dirsWith(ctx, (n) => n === "pyproject.toml");
  const info = new Map<string, { text: string; members: string[]; container: boolean }>();
  for (const dir of pyprojectDirs) {
    const text = ctx.read(joinPath(dir, "pyproject.toml")) ?? "";
    const wsBody = tableBody(text, "tool.uv.workspace");
    info.set(dir, { text, members: arrayValue(wsBody, "members"), container: false });
  }
  const memberOf = new Map<string, string>();
  for (const [dir, i] of info) {
    if (i.members.length === 0) continue;
    const members = resolveMembers(dir, pyprojectDirs, i.members, ctx.caseInsensitive);
    if (members.length === 0) continue;
    if (tableBody(i.text, "project") === undefined && tableBody(i.text, "tool.poetry") === undefined) i.container = true;
    for (const member of members) memberOf.set(member, dir);
  }

  const out: Candidate[] = [];
  for (const [dir, i] of info) {
    if (i.container) continue;
    const container = memberOf.get(dir);
    const evidence = [joinPath(dir, "pyproject.toml")];
    const extra = namesIn(ctx, dir).filter((n) => PY_LOOSE_MANIFESTS.includes(n) || n === "uv.lock" || n === "poetry.lock");
    evidence.push(...extra.map((n) => joinPath(dir, n)));
    if (container !== undefined) evidence.push(joinPath(container, "pyproject.toml"));
    const ancestor = container === undefined ? hasAncestor(dir, info.keys()) : undefined;
    let status: ClassificationStatus = "detected";
    let reason = container !== undefined ? "WORKSPACE_MEMBER" : "PYPROJECT";
    if (ancestor !== undefined) {
      status = "ambiguous";
      reason = "NESTED_PROJECT";
      evidence.push(joinPath(ancestor, "pyproject.toml"));
    }
    const reqText = namesIn(ctx, dir).includes("requirements.txt") ? (ctx.read(joinPath(dir, "requirements.txt")) ?? "") : "";
    out.push({
      root: dir,
      language: "python",
      framework: firstWord(`${i.text}\n${reqText}`, PY_FRAMEWORKS),
      packageManager: extra.includes("uv.lock") ? "uv" : extra.includes("poetry.lock") ? "poetry" : null,
      kind: null,
      detectedBy: "python-pyproject",
      evidence: uniqSorted(evidence),
      reasonCode: reason,
      status,
    });
  }

  const roots = [...info.keys()];
  const looseDirs = dirsWith(ctx, (n) => PY_LOOSE_MANIFESTS.includes(n)).filter((d) => !info.has(d));
  const taken: string[] = [...roots];
  for (const dir of looseDirs.sort((a, b) => a.length - b.length || compareStrings(a, b))) {
    if (hasAncestor(dir, taken) !== undefined) continue;
    taken.push(dir);
    const manifests = namesIn(ctx, dir).filter((n) => PY_LOOSE_MANIFESTS.includes(n));
    const reqText = manifests.includes("requirements.txt") ? (ctx.read(joinPath(dir, "requirements.txt")) ?? "") : "";
    out.push({
      root: dir,
      language: "python",
      framework: firstWord(reqText, PY_FRAMEWORKS),
      packageManager: manifests.includes("Pipfile") ? "pipenv" : null,
      kind: null,
      detectedBy: "python-requirements",
      evidence: uniqSorted(manifests.map((n) => joinPath(dir, n))),
      reasonCode: "PYTHON_REQUIREMENTS",
      status: "detected",
    });
  }

  // Python source directories with no manifest: the highest directory below the root, or a nested one when
  // no parent holds Python. Notebooks and loose files at the project root do not form components.
  const pyFiles = ctx.files.filter((f) => f.endsWith(".py") && f.includes("/") && hasAncestor(dirnameOf(f), taken) === undefined && !taken.includes(dirnameOf(f)));
  const groups = new Map<string, string[]>();
  for (const f of pyFiles) {
    const top = f.slice(0, f.indexOf("/"));
    groups.set(top, [...(groups.get(top) ?? []), f]);
  }
  for (const [top, group] of groups) {
    out.push({
      root: top,
      language: "python",
      framework: null,
      packageManager: null,
      kind: null,
      detectedBy: "python-sources",
      evidence: group.sort(compareStrings).slice(0, 5),
      reasonCode: "PYTHON_SOURCE_DIRECTORY",
      status: "detected",
    });
  }
  return out;
}

// ---------------------------------------------------------------- Go

const GO_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["github.com/gin-gonic/gin", "gin"],
  ["github.com/labstack/echo", "echo"],
  ["github.com/gofiber/fiber", "fiber"],
];

export function detectGo(ctx: DetectContext): Candidate[] {
  const modDirs = dirsWith(ctx, (n) => n === "go.mod");
  const workDirs = dirsWith(ctx, (n) => n === "go.work");
  const workOf = new Map<string, string>();
  for (const wd of workDirs) {
    const text = ctx.read(joinPath(wd, "go.work")) ?? "";
    const uses: string[] = [];
    for (const m of text.matchAll(/^\s*use\s*\(([^)]*)\)/gm)) {
      for (const line of (m[1] as string).split("\n")) {
        const v = line.replace(/\/\/.*$/, "").trim();
        if (v) uses.push(v.replace(/^"|"$/g, ""));
      }
    }
    for (const m of text.matchAll(/^\s*use\s+([^\s(][^\n]*)$/gm)) uses.push((m[1] as string).replace(/\/\/.*$/, "").trim().replace(/^"|"$/g, ""));
    for (const u of uses) {
      const target = normalizePattern(wd === "." ? u : `${wd}/${u}`);
      const rel = path.posix.normalize(target || ".");
      if (modDirs.includes(rel)) workOf.set(rel, wd);
    }
  }
  return modDirs.map((dir) => {
    const text = ctx.read(joinPath(dir, "go.mod")) ?? "";
    const evidence = [joinPath(dir, "go.mod"), ...namesIn(ctx, dir).filter((n) => n === "go.sum").map((n) => joinPath(dir, n))];
    const work = workOf.get(dir);
    if (work !== undefined) evidence.push(joinPath(work, "go.work"));
    return {
      root: dir,
      language: "go",
      framework: firstWord(text, GO_FRAMEWORKS),
      packageManager: null,
      kind: null,
      detectedBy: "go-mod",
      evidence: uniqSorted(evidence),
      reasonCode: work !== undefined ? "WORKSPACE_MEMBER" : "GO_MODULE",
      status: "detected",
    } satisfies Candidate;
  });
}

// ---------------------------------------------------------------- Cargo

const RUST_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["actix-web", "actix-web"],
  ["axum", "axum"],
  ["rocket", "rocket"],
];

export function detectCargo(ctx: DetectContext): Candidate[] {
  const dirs = dirsWith(ctx, (n) => n === "Cargo.toml");
  const info = new Map<string, { text: string; hasPackage: boolean; members: string[] }>();
  for (const dir of dirs) {
    const text = ctx.read(joinPath(dir, "Cargo.toml")) ?? "";
    info.set(dir, { text, hasPackage: tableBody(text, "package") !== undefined, members: arrayValue(tableBody(text, "workspace"), "members") });
  }
  const memberOf = new Map<string, string>();
  const containers = new Set<string>();
  for (const [dir, i] of info) {
    if (i.members.length === 0) continue;
    const members = resolveMembers(dir, dirs, i.members, ctx.caseInsensitive);
    if (members.length === 0) continue;
    if (!i.hasPackage) containers.add(dir);
    for (const member of members) memberOf.set(member, dir);
  }
  const out: Candidate[] = [];
  for (const [dir, i] of info) {
    if (containers.has(dir)) continue;
    const container = memberOf.get(dir);
    const evidence = [joinPath(dir, "Cargo.toml"), ...namesIn(ctx, dir).filter((n) => n === "Cargo.lock").map((n) => joinPath(dir, n))];
    if (container !== undefined) {
      evidence.push(joinPath(container, "Cargo.toml"));
      if (namesIn(ctx, container).includes("Cargo.lock")) evidence.push(joinPath(container, "Cargo.lock"));
    }
    const ancestor = container === undefined ? hasAncestor(dir, info.keys()) : undefined;
    let status: ClassificationStatus = "detected";
    let reason = container !== undefined ? "WORKSPACE_MEMBER" : "CARGO_PACKAGE";
    if (!i.hasPackage && container === undefined) {
      status = "ambiguous";
      reason = "MANIFEST_WITHOUT_PACKAGE";
    } else if (ancestor !== undefined) {
      status = "ambiguous";
      reason = "NESTED_PROJECT";
      evidence.push(joinPath(ancestor, "Cargo.toml"));
    }
    out.push({
      root: dir,
      language: "rust",
      framework: firstWord(tableBody(i.text, "dependencies") ?? "", RUST_FRAMEWORKS),
      packageManager: "cargo",
      kind: null,
      detectedBy: "cargo-manifest",
      evidence: uniqSorted(evidence),
      reasonCode: reason,
      status,
    });
  }
  return out;
}

// ---------------------------------------------------------------- .NET

const DOTNET_LANGUAGES: Readonly<Record<string, string>> = { ".csproj": "csharp", ".fsproj": "fsharp", ".vbproj": "visualbasic" };

export function detectDotnet(ctx: DetectContext): Candidate[] {
  const projects = ctx.files.filter((f) => path.posix.extname(f).toLowerCase() in DOTNET_LANGUAGES);
  const solutions = ctx.files.filter((f) => /\.(sln|slnx)$/i.test(f));
  const solutionOf = new Map<string, string[]>();
  for (const sln of solutions) {
    const text = ctx.read(sln) ?? "";
    const refs: string[] = [];
    if (/\.slnx$/i.test(sln)) for (const m of text.matchAll(/Path\s*=\s*"([^"]+)"/g)) refs.push(m[1] as string);
    else for (const m of text.matchAll(/"([^"]+\.(?:cs|fs|vb)proj)"/gi)) refs.push(m[1] as string);
    const base = dirnameOf(sln);
    for (const ref of refs) {
      const rel = path.posix.normalize(joinPath(base, ref.replace(/\\/g, "/")));
      solutionOf.set(rel, [...(solutionOf.get(rel) ?? []), sln]);
    }
  }
  return projects.map((file) => {
    const dir = dirnameOf(file);
    const text = ctx.read(file) ?? "";
    const evidence = [file, ...(solutionOf.get(file) ?? [])];
    if (namesIn(ctx, dir).includes("global.json")) evidence.push(joinPath(dir, "global.json"));
    return {
      root: dir,
      language: DOTNET_LANGUAGES[path.posix.extname(file).toLowerCase()] as string,
      framework: /Microsoft\.NET\.Sdk\.Web/.test(text) ? "aspnet" : null,
      packageManager: "nuget",
      kind: null,
      detectedBy: "dotnet-project",
      evidence: uniqSorted(evidence),
      reasonCode: solutionOf.has(file) ? "SOLUTION_MEMBER" : "DOTNET_PROJECT",
      status: "detected",
    } satisfies Candidate;
  });
}

// ---------------------------------------------------------------- Unsupported languages

const UNSUPPORTED_MANIFESTS: Readonly<Record<string, string>> = {
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "kotlin",
  Gemfile: "ruby",
  "composer.json": "php",
  "mix.exs": "elixir",
  "pubspec.yaml": "dart",
  "Package.swift": "swift",
  "CMakeLists.txt": "cpp",
};
const UNSUPPORTED_EXTENSIONS: Readonly<Record<string, string>> = {
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".ex": "elixir",
  ".exs": "elixir",
  ".dart": "dart",
  ".swift": "swift",
  ".scala": "scala",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".lua": "lua",
};

export function detectUnsupported(ctx: DetectContext): Candidate[] {
  const out: Candidate[] = [];
  const roots: string[] = [];
  for (const [dir, names] of [...ctx.byDir].sort((a, b) => compareStrings(a[0], b[0]))) {
    const hits = names.filter((n) => n in UNSUPPORTED_MANIFESTS);
    for (const language of uniqSorted(hits.map((n) => UNSUPPORTED_MANIFESTS[n] as string))) {
      const evidence = hits.filter((n) => UNSUPPORTED_MANIFESTS[n] === language).map((n) => joinPath(dir, n));
      roots.push(dir);
      out.push({ root: dir, language, framework: null, packageManager: null, kind: null, detectedBy: "unsupported-manifest", evidence, reasonCode: "UNSUPPORTED_LANGUAGE", status: "unsupported" });
    }
  }
  const groups = new Map<string, { language: string; root: string; files: string[] }>();
  for (const f of ctx.files) {
    const language = UNSUPPORTED_EXTENSIONS[path.posix.extname(f)];
    if (!language) continue;
    const dir = dirnameOf(f);
    if (roots.includes(dir) || hasAncestor(dir, roots) !== undefined) continue;
    const root = dir === "." ? "." : f.slice(0, f.indexOf("/"));
    const key = `${root}\u0000${language}`;
    const g = groups.get(key) ?? { language, root, files: [] };
    g.files.push(f);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    out.push({ root: g.root, language: g.language, framework: null, packageManager: null, kind: null, detectedBy: "unsupported-extension", evidence: g.files.sort(compareStrings).slice(0, 5), reasonCode: "UNSUPPORTED_LANGUAGE", status: "unsupported" });
  }
  return out;
}
