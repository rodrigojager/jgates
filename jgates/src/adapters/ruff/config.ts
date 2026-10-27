// Which configuration file Ruff reads for an instance: the primary binding of tools.yml when it points to an
// existing file, otherwise the native resolution (nearest directory with ruff.toml, .ruff.toml or a pyproject.toml
// that has a [tool.ruff] table). Nothing is created or written.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveToolBindings } from "../../core/tools/index.js";
import { ruffManifest } from "./manifest.js";

export interface RuffConfigChoice {
  /** Workspace-relative path with forward slashes (absolute for the policy's file), or null when Ruff runs with its defaults. */
  file: string | null;
  source: "binding" | "native" | "policy" | "none";
  sha256: string | null;
}

const NATIVE_ORDER = ["ruff.toml", ".ruff.toml", "pyproject.toml"];
const slash = (p: string): string => p.split(path.sep).join("/");

function sha256File(abs: string): string | null {
  try {
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function hasRuffTable(abs: string): boolean {
  try {
    return /^\s*\[(?:tool\.ruff)[\].]/m.test(fs.readFileSync(abs, "utf8"));
  } catch {
    return false;
  }
}

function nativeConfig(dir: string, componentRoot: string): string | null {
  let current = path.resolve(dir, componentRoot);
  for (;;) {
    for (const name of NATIVE_ORDER) {
      const candidate = path.join(current, name);
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      if (name === "pyproject.toml" && !hasRuffTable(candidate)) continue;
      return slash(path.relative(dir, candidate));
    }
    if (current === path.resolve(dir)) return null;
    const parent = path.dirname(current);
    if (parent === current || path.relative(dir, parent).startsWith("..")) return null;
    current = parent;
  }
}

/**
 * Under a CI policy (`policyDir`) only the policy's binding counts, as an absolute path; without one Ruff runs with its
 * defaults (--isolated): a ruff.toml or [tool.ruff] of the analyzed project is never read.
 */
export function chooseRuffConfig(dir: string, instanceId: string, componentRoot: string | null, policyDir?: string): RuffConfigChoice {
  if (policyDir !== undefined) {
    try {
      const bound = resolveToolBindings(policyDir, { skipInventory: true, manifests: [ruffManifest] }).instances.find((i) => i.id === instanceId);
      const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.exists);
      if (binding) return { file: binding.absPath, source: "policy", sha256: sha256File(binding.absPath) };
    } catch {
      // an unreadable tools.yml of the policy: Ruff's defaults
    }
    return { file: null, source: "none", sha256: null };
  }
  try {
    const bound = resolveToolBindings(dir, { skipInventory: true, manifests: [ruffManifest] }).instances.find((i) => i.id === instanceId);
    const binding = bound?.bindings.find((b) => b.id === "config" && !b.refused && b.kind === "file" && b.relPath !== null && b.exists);
    if (binding?.relPath) return { file: binding.relPath, source: "binding", sha256: sha256File(path.join(dir, binding.relPath)) };
  } catch {
    // an unreadable tools.yml is reported by config validate; the native resolution still applies
  }
  const file = nativeConfig(dir, componentRoot ?? ".");
  return file ? { file, source: "native", sha256: sha256File(path.join(dir, file)) } : { file: null, source: "none", sha256: null };
}
