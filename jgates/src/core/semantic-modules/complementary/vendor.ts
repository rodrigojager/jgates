// The vendored Trail of Bits material (jgates/vendor/trailofbits-skills, CC BY-SA 4.0, pinned commit): the adapted
// method files of differential review, variant analysis and insecure defaults, and the unchanged insecure-defaults
// category corpora with their seed patterns. Nothing is fetched at run time; the folder travels with the package and
// passes the distribution check (jgates-pack.json with its ShareAlike obligations, LICENSE, NOTICE.md).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRAILOFBITS = {
  url: "https://github.com/trailofbits/skills",
  revision: "e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff",
  spdx: "CC-BY-SA-4.0",
  attribution: "Trail of Bits (https://www.trailofbits.com/), adapted by JGates; see vendor/trailofbits-skills/NOTICE.md",
} as const;

export type TobMethod = "differential-review" | "variant-analysis" | "insecure-defaults";

/** The upstream files each adapted method file comes from (also listed in NOTICE.md and jgates-pack.json). */
export const UPSTREAM_FILES: Readonly<Record<TobMethod, readonly string[]>> = {
  "differential-review": ["plugins/differential-review/skills/differential-review/SKILL.md", "plugins/differential-review/skills/differential-review/methodology.md"],
  "variant-analysis": [
    "plugins/variant-analysis/skills/variant-analysis/SKILL.md",
    "plugins/variant-analysis/skills/variant-analysis/references/root-cause.md",
    "plugins/variant-analysis/skills/variant-analysis/references/searching.md",
    "plugins/variant-analysis/skills/variant-analysis/references/triage.md",
    "plugins/variant-analysis/skills/variant-analysis/references/reporting.md",
  ],
  "insecure-defaults": ["plugins/insecure-defaults/README.md", "plugins/insecure-defaults/commands/audit.md", "plugins/insecure-defaults/workflows/audit.js", "plugins/insecure-defaults/references/<category>.md|json"],
};

export interface TobMethodMaterial {
  method: TobMethod;
  /** The text blocks of the adapted method file, by name (objective and one per stage). */
  blocks: Record<string, string>;
  sha256: string;
}

export interface InsecureCategory {
  id: string;
  title: string;
  /** The upstream corpus (Report when / Skip when, worked pairs), unchanged. */
  corpus: string;
  /** The first "**Report when:**" and "**Skip when:**" lines. */
  reportWhen: string;
  skipWhen: string;
  /** Seed patterns translated from POSIX ERE to JavaScript; a pattern that does not compile is dropped (listed). */
  seeds: RegExp[];
  droppedSeeds: string[];
}

/** jgates/vendor/trailofbits-skills next to the package (dist/core/semantic-modules/complementary -> ../../../../vendor). */
export function tobVendorDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "vendor", "trailofbits-skills");
}

const read = (file: string): string => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

function blocksOf(text: string, file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<!-- block:([a-z0-9-]+) -->([\s\S]*?)<!-- \/block -->/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out[m[1] as string] = (m[2] ?? "").trim();
  if (!out.objective) throw new Error(`${file} has no objective block`);
  return out;
}

const methodCache = new Map<string, TobMethodMaterial>();

/** Loads one adapted method file; throws when it is missing or lacks a required block. */
export function loadTobMethod(method: TobMethod, required: readonly string[], dir: string = tobVendorDir()): TobMethodMaterial {
  const key = `${dir}\0${method}`;
  const cached = methodCache.get(key);
  if (cached) return cached;
  if (!fs.existsSync(path.join(dir, "LICENSE")) || !fs.existsSync(path.join(dir, "NOTICE.md"))) throw new Error(`the Trail of Bits material at ${dir} is missing its LICENSE or NOTICE.md`);
  const file = path.join(dir, method, "method.md");
  const text = read(file);
  const blocks = blocksOf(text, file);
  for (const name of required) if (!blocks[name]) throw new Error(`${file} has no ${name} block`);
  const material = { method, blocks, sha256: sha(text) };
  methodCache.set(key, material);
  return material;
}

/** POSIX bracket classes and ERE as used by the upstream seeds, in JavaScript syntax. */
export function posixToJs(pattern: string): string {
  return pattern.replace(/\[:space:\]/g, "\\s").replace(/\[:alnum:\]/g, "A-Za-z0-9").replace(/\[:alpha:\]/g, "A-Za-z").replace(/\[:digit:\]/g, "0-9").replace(/\[:upper:\]/g, "A-Z").replace(/\[:lower:\]/g, "a-z");
}

/** The insecure-defaults categories this build adapts (weak-crypto is consolidated with the baseline; see NOTICE.md). */
export const INSECURE_CATEGORY_IDS = ["fallback-secrets", "default-credentials", "fail-open-security", "permissive-access", "debug-features"] as const;

let categoryCache: { dir: string; categories: InsecureCategory[]; sha256: string } | null = null;

export function loadInsecureCategories(dir: string = tobVendorDir()): { categories: InsecureCategory[]; sha256: string } {
  if (categoryCache && categoryCache.dir === dir) return categoryCache;
  const hash = crypto.createHash("sha256");
  const categories = INSECURE_CATEGORY_IDS.map((id) => {
    const corpus = read(path.join(dir, "insecure-defaults", "categories", `${id}.md`));
    const doc = JSON.parse(read(path.join(dir, "insecure-defaults", "categories", `${id}.json`))) as { id?: string; title?: string; seeds?: unknown };
    if (doc.id !== id || !Array.isArray(doc.seeds)) throw new Error(`the seed file of ${id} is not usable`);
    hash.update(`${id}\0${corpus}\0${JSON.stringify(doc)}\0`);
    const seeds: RegExp[] = [];
    const droppedSeeds: string[] = [];
    for (const s of doc.seeds) {
      try {
        seeds.push(new RegExp(posixToJs(String(s))));
      } catch {
        droppedSeeds.push(String(s));
      }
    }
    const line = (label: string): string => (new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`).exec(corpus)?.[1] ?? "").trim();
    return { id, title: String(doc.title ?? id), corpus, reportWhen: line("Report when"), skipWhen: line("Skip when"), seeds, droppedSeeds };
  });
  categoryCache = { dir, categories, sha256: hash.digest("hex") };
  return categoryCache;
}

/** The provenance kept in an investigation record of a module built from this material. */
export function tobProvenance(method: TobMethod, sha256: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { upstream: TRAILOFBITS.url, revision: TRAILOFBITS.revision, spdx: TRAILOFBITS.spdx, attribution: TRAILOFBITS.attribution, files: UPSTREAM_FILES[method], vendoredSha256: sha256, ...extra };
}
