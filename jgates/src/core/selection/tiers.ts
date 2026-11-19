/**
 * Tiers (ADR-0022). A tool instance has a tier: `core` (every instance JGates had before the linter engine: it runs as
 * it always did), `main` (the main tool of a language or format that had no linter: on from Balanced up) or `extended`
 * (every other tool of the engine: on under Strict). A profile has a tier too: its entries that name a capability, a
 * category or a component switch on the instances up to that tier, and nothing above it. Above the profile's tier an
 * instance stays in the plan's universe, off, with the reason; the user switches it on by its own selector
 * (`tool:<id>`) from the profile editor, the tools file or `--only`.
 *
 * Where the tiers live: `tools.<id>.tier` of an instance (absent: `core`), written by the templates the engine
 * derives from its descriptors; `tier` of a profile body, which the resolver writes to `selection.tier` (absent in the
 * whole chain: `core`, so a project's own profile that names no tier runs what it ran before).
 */

export const TIERS = ["core", "main", "extended"] as const;
export type Tier = (typeof TIERS)[number];

/** The tier of a profile that says none, and of an instance that says none. */
export const DEFAULT_TIER: Tier = "core";

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** True when an instance of tier `tool` is above what a profile of tier `profile` switches on. */
export function aboveTier(tool: Tier, profile: Tier): boolean {
  return tierRank(tool) > tierRank(profile);
}

/** The tier of a tool instance from its body in the resolved configuration (`tools.<id>`). */
export function toolTierOf(body: unknown): Tier {
  const tier = body !== null && typeof body === "object" ? (body as { tier?: unknown }).tier : undefined;
  return isTier(tier) ? tier : DEFAULT_TIER;
}

/** The tier of the selected profile, from the resolved configuration (`selection.tier`). */
export function profileTierOf(config: Record<string, unknown>): Tier {
  const selection = config.selection;
  const tier = selection !== null && typeof selection === "object" ? (selection as { tier?: unknown }).tier : undefined;
  return isTier(tier) ? tier : DEFAULT_TIER;
}

/** The built-in profile that first runs an instance of each tier by default. */
export const TIER_PROFILE: Readonly<Record<Tier, string>> = {
  core: "builtin:minimal",
  main: "builtin:standard",
  extended: "builtin:strict",
};
