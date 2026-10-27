// Catalog of the tools a workspace can use: one entry per registered adapter, with what the cards of the Tools tab show
// (languages, categories, runners, support level on this machine). Availability of the tool itself (is it installed?)
// is per instance and comes from the adapter's own probe, in availability().
import { builtinManifests } from "../../adapters/manifests.js";
import { externalAdapter } from "../plan/adapters.js";
import { resolveConfig } from "../config/resolve/index.js";
import { instanceAdapters } from "./instances.js";
import { resolveToolBindings, supportLevelFor, type SupportLevel } from "./index.js";

export interface CatalogEntry {
  adapter: string;
  displayName: string;
  toolName: string;
  languages: string[];
  categories: string[];
  capabilities: string[];
  runtimes: string[];
  /** Runners an instance can use. */
  runners: Array<"local" | "container">;
  supportLevel: SupportLevel;
  /** The adapter supports this platform. */
  platformSupported: boolean;
  /** Instances can be created from this entry. */
  instantiable: boolean;
  executesProjectCode: boolean;
  limitations: string[];
}

/** Adapters that also run on the container runner (runner: container in tools.yml). */
const CONTAINER_ADAPTERS = new Set(["ruff", "gitleaks", "trivy", "osv-scanner", "checkov"]);

export function toolCatalog(): CatalogEntry[] {
  const manifests = builtinManifests();
  const creatable = new Set(instanceAdapters());
  return manifests
    .map((m) => ({
      adapter: m.id,
      displayName: m.displayName,
      toolName: m.toolName,
      languages: m.languages ?? [],
      categories: m.categories,
      capabilities: m.capabilities,
      runtimes: m.runtimes ?? [],
      runners: (CONTAINER_ADAPTERS.has(m.id) ? ["local", "container"] : ["local"]) as Array<"local" | "container">,
      supportLevel: supportLevelFor(m.id, true, manifests),
      platformSupported: m.platforms.includes(process.platform),
      instantiable: creatable.has(m.id),
      executesProjectCode: m.effects.executesProjectCode === true,
      limitations: m.limitations ?? [],
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface InstanceAvailability {
  status: "available" | "unavailable" | "not_executable";
  reason: string | null;
  toolVersion: string | null;
  runtime: string | null;
}

/** Availability and version of every instance, from the adapter's probe (the same one the plan uses). */
export function instanceAvailability(dir: string, env: NodeJS.ProcessEnv = process.env): Record<string, InstanceAvailability> {
  const out: Record<string, InstanceAvailability> = {};
  const { instances } = resolveToolBindings(dir);
  const config = resolveConfig(dir).config as Record<string, unknown>;
  const manifests = builtinManifests();
  for (const instance of instances) {
    const adapter = externalAdapter(instance.adapter);
    const manifest = manifests.find((m) => m.id === instance.adapter);
    if (!adapter || !manifest) {
      out[instance.id] = { status: "not_executable", reason: null, toolVersion: null, runtime: null };
      continue;
    }
    try {
      const planned = adapter.plan({ dir, env, tool: instance.id, capability: manifest.capabilities[0] ?? "", componentRoot: instance.componentRoot, timeoutSeconds: 30 * 60, config });
      out[instance.id] = { status: planned.availability.status, reason: planned.availability.reason, toolVersion: planned.toolVersion, runtime: planned.runtime.name };
    } catch (error) {
      out[instance.id] = { status: "unavailable", reason: (error as Error).message, toolVersion: null, runtime: null };
    }
  }
  return out;
}
