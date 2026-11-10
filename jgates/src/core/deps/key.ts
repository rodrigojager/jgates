// The key of a dependency volume (PLAN-dependencies.md section 4): a hash of the lockfile and manifests, the manager
// and its version, the language version, the tools image digest and the install options. The managers the image carries
// (uv, npm, corepack, go, cargo, dotnet) are versioned by the image digest; the managers run through uvx are versioned by
// their requirement in the recipe; pnpm and yarn by the packageManager field of package.json (a manifest).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RECIPE_VERSION, type InstallRecipe } from "./recipes.js";
import type { InstallUnit } from "./units.js";

export interface KeyInput {
  /** The analyzed tree (project folder or snapshot); key files are read from it. */
  projectDir: string;
  unit: InstallUnit;
  recipe: InstallRecipe;
  /** Image id (sha256:...) of the tools image; null when the engine does not have it. */
  imageId: string | null;
  governed: boolean;
  /** Registry URL of the ecosystem (never the token). */
  registryUrl: string | null;
}

/** sha256 (hex) of everything that decides what the install puts in the volume. */
export function dependencyKey(input: KeyInput): string {
  const h = crypto.createHash("sha256");
  const { unit, recipe } = input;
  h.update(
    JSON.stringify({
      recipe: RECIPE_VERSION,
      ecosystem: unit.info.ecosystem,
      manager: recipe.manager,
      variant: unit.info.variant,
      installRoot: unit.installRoot,
      language: unit.info.language.version,
      image: input.imageId,
      governed: input.governed,
      groups: unit.info.groups,
      commands: recipe.commands,
      env: recipe.installEnv,
      target: recipe.target,
      registry: input.registryUrl,
    }),
  );
  for (const file of recipe.keyFiles) {
    h.update(`\0file:${file}\0`);
    try {
      h.update(fs.readFileSync(path.join(input.projectDir, ...file.split("/"))));
    } catch {
      h.update("<missing>");
    }
  }
  return h.digest("hex");
}

/** The short form of a key used in volume names. */
export const shortKey = (key: string): string => key.slice(0, 12);
