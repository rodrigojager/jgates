// Which Import Linter configuration runs for an instance, and the generated one. The native configuration the user
// keeps (a tools.yml binding, .importlinter, setup.cfg, pyproject.toml) runs as it is, in its own dialect; without one
// the contracts come from the forbidden-dependency rules of .jgates/architecture.yml, written as an INI file in the
// run folder (owner "generated": never edited, never in the workspace).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveToolBindings } from "../../core/tools/index.js";
import type { ArchitectureContract, ArchitectureRule, NormalizedGraph } from "../../core/architecture/index.js";
import { importLinterManifest } from "./manifest.js";

export interface NativeChoice {
  /** Workspace-relative path with forward slashes, or null when there is no native configuration. */
  file: string | null;
  source: "binding" | "native" | "none";
  sha256: string | null;
}

const slash = (p: string): string => p.split(path.sep).join("/");

export function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** Does the file carry Import Linter's table (the INI section or the TOML table)? */
function hasImportLinterTable(abs: string): boolean {
  try {
    const text = fs.readFileSync(abs, "utf8");
    return path.basename(abs) === "pyproject.toml" ? /^\s*\[(?:\[)?tool\.importlinter[\].]/m.test(text) : /^\s*\[importlinter\]/m.test(text);
  } catch {
    return false;
  }
}

const NATIVE_ORDER = [".importlinter", "setup.cfg", "pyproject.toml"];

export function chooseNativeConfig(dir: string, instanceId: string, componentRoot: string | null): NativeChoice {
  try {
    const bound = resolveToolBindings(dir, { skipInventory: true, manifests: [importLinterManifest] }).instances.find((i) => i.id === instanceId);
    const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.relPath !== null && b.exists);
    if (binding?.relPath) return { file: binding.relPath, source: "binding", sha256: sha256File(path.join(dir, binding.relPath)) };
  } catch {
    // an unreadable tools.yml is reported by config validate
  }
  const base = path.resolve(dir, componentRoot ?? ".");
  for (const name of NATIVE_ORDER) {
    const candidate = path.join(base, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    if (name !== ".importlinter" && !hasImportLinterTable(candidate)) continue;
    const rel = slash(path.relative(dir, candidate));
    return { file: rel, source: "native", sha256: sha256File(candidate) };
  }
  return { file: null, source: "none", sha256: null };
}

/** The rules the generated configuration can express: enabled forbidden-dependency rules. */
export function translatableRules(contract: ArchitectureContract | undefined): ArchitectureRule[] {
  return (contract?.rules ?? []).filter((r) => r.kind === "forbidden-dependency" && r.enabled !== false && typeof r.from === "string" && (r.to ?? []).length > 0);
}

// --- layers to modules ------------------------------------------------------------------------------------------

/** Same glob as the sidecar evaluator: `**` crosses separators, `*` and `?` do not cross "/". */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  const p = pattern.replace(/\\/g, "/");
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*") {
      if (p[i + 1] === "*") {
        i += 1;
        if (p[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** The modules of the graph that a layer covers, reduced to the outermost ones (a package stands for its submodules). */
export function layerModules(layer: { paths?: string[]; modules?: string[]; language?: string }, graph: NormalizedGraph): string[] {
  const byPath = (layer.paths ?? []).map(globToRegExp);
  const byModule = (layer.modules ?? []).map(globToRegExp);
  const matched = new Set<string>();
  for (const node of graph.nodes) {
    if (layer.language && node.language && node.language !== layer.language) continue;
    const p = (node.path ?? "").replace(/\\/g, "/");
    if ((p && byPath.some((r) => r.test(p))) || byModule.some((r) => r.test(node.id))) matched.add(node.id);
  }
  return [...matched].filter((m) => {
    for (let at = m.lastIndexOf("."); at > 0; at = m.lastIndexOf(".", at - 1)) if (matched.has(m.slice(0, at))) return false;
    return true;
  }).sort();
}

export interface GeneratedContract {
  ruleId: string;
  source: string[];
  forbidden: string[];
}

export interface GeneratedConfig {
  text: string;
  contracts: GeneratedContract[];
  /** Rules that could not become a contract (a layer with no module in the graph), with the reason. */
  skipped: Array<{ ruleId: string; reason: string }>;
}

/** The INI of the generated contracts. A layer that covers no module of the graph skips its rule (the evaluator then reports the gap). */
export function generateConfig(contract: ArchitectureContract, rules: ArchitectureRule[], graph: NormalizedGraph, rootPackages: string[]): GeneratedConfig {
  const layers = new Map((contract.layers ?? []).map((l) => [l.id, l]));
  const contracts: GeneratedContract[] = [];
  const skipped: GeneratedConfig["skipped"] = [];
  for (const rule of rules) {
    const source = layers.has(rule.from as string) ? layerModules(layers.get(rule.from as string) as never, graph) : [];
    const forbidden = [...new Set((rule.to ?? []).flatMap((id) => (layers.has(id) ? layerModules(layers.get(id) as never, graph) : [])))].sort();
    if (source.length === 0 || forbidden.length === 0) {
      skipped.push({ ruleId: rule.id, reason: source.length === 0 ? `layer ${rule.from} covers no Python module` : `the target layers of ${rule.id} cover no Python module` });
      continue;
    }
    contracts.push({ ruleId: rule.id, source, forbidden });
  }
  const list = (values: string[]): string => values.map((v) => `    ${v}`).join("\n");
  const parts = [
    "# Generated by JGates from .jgates/architecture.yml (owner: generated). Do not edit: it is rewritten in every run.",
    "[importlinter]",
    `root_packages =\n${list(rootPackages)}`,
    "",
  ];
  for (const c of contracts) {
    parts.push(
      `[importlinter:contract:${c.ruleId}]`,
      `name = ${c.ruleId}`,
      "type = forbidden",
      `source_modules =\n${list(c.source)}`,
      `forbidden_modules =\n${list(c.forbidden)}`,
      // The declared rule is about the dependency between layers as written in the code (the evaluator reads direct imports).
      "allow_indirect_imports = True",
      "",
    );
  }
  return { text: parts.join("\n"), contracts, skipped };
}
