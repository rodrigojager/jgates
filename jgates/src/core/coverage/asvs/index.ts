// The OWASP ASVS data shipped with JGates (jgates/vendor/owasp-asvs, CC BY-SA 4.0): the official release file of each
// version, read unchanged. The loader checks the file against the pinned hash, groups the flat records into chapters,
// sections and requirements and filters them by level and chapter. The requirement text is read from that file only;
// it is never edited, translated or copied into another file.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AsvsLevel = 1 | 2 | 3;
export const ASVS_LEVELS: readonly AsvsLevel[] = [1, 2, 3];

/** What is pinned about a shipped release of the standard. */
export interface AsvsRelease {
  version: string;
  tag: string;
  commit: string;
  /** File name inside `vendor/owasp-asvs/<version>/`. */
  file: string;
  /** sha256 of the release file (text line endings normalized to LF, as the distribution check does). */
  sha256: string;
}

export const ASVS_RELEASES: Readonly<Record<string, AsvsRelease>> = {
  "5.0.0": {
    version: "5.0.0",
    tag: "v5.0.0_release",
    commit: "5cf9b032440be53ce345ab3c130fda46ba1ce7a2",
    file: "OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json",
    sha256: "8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311",
  },
};

/** The attribution that goes wherever the requirement text is shown or exported. */
export interface AsvsSource {
  name: string;
  version: string;
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
  attribution: string;
}

export interface AsvsRequirement {
  /** `V1.2.4`. */
  id: string;
  chapter: string;
  section: string;
  /** The official text, English. */
  text: string;
  /** The lowest level the requirement belongs to; it is in every map of that level and above. */
  level: AsvsLevel;
}

export interface AsvsSection {
  id: string;
  name: string;
  chapter: string;
  requirements: AsvsRequirement[];
}

export interface AsvsChapter {
  id: string;
  name: string;
  sections: AsvsSection[];
}

export interface AsvsData {
  version: string;
  source: AsvsSource;
  release: AsvsRelease;
  chapters: AsvsChapter[];
  /** Every requirement, in the order of the release file. */
  requirements: AsvsRequirement[];
}

export class AsvsDataError extends Error {}

/** The vendored folder: next to the package (dist/core/coverage/asvs -> ../../../../vendor/owasp-asvs). */
export function asvsVendorDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "vendor", "owasp-asvs");
}

export function asvsSource(version: string): AsvsSource {
  return {
    name: "OWASP Application Security Verification Standard",
    version,
    licence: "CC BY-SA 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    sourceUrl: "https://github.com/OWASP/ASVS",
    attribution: `Requirement text: OWASP ASVS ${version}, © The OWASP Foundation, CC BY-SA 4.0`,
  };
}

/** sha256 of a text file with LF line endings, so a CRLF checkout keeps the identity. */
export function releaseHash(bytes: Buffer): string {
  const normalized = bytes.includes(0) ? bytes : Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** The versions whose release file is shipped (a folder with the pinned file in it), in ascending order. */
export function listAsvsVersions(dir: string = asvsVendorDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ASVS_RELEASES[e.name] !== undefined && fs.existsSync(path.join(dir, e.name, (ASVS_RELEASES[e.name] as AsvsRelease).file)))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

interface FlatRecord {
  chapter_id: string;
  chapter_name: string;
  section_id: string;
  section_name: string;
  req_id: string;
  req_description: string;
  L: string | number;
}

const cache = new Map<string, AsvsData>();

/** Loads one version (once per folder). Throws AsvsDataError for an unknown version, a missing file or a hash that is not the pinned one. */
export function loadAsvs(version: string = "5.0.0", dir: string = asvsVendorDir()): AsvsData {
  const release = ASVS_RELEASES[version];
  if (!release) throw new AsvsDataError(`ASVS version ${version} is not shipped`);
  const key = `${dir}\0${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = path.join(dir, version, release.file);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new AsvsDataError(`ASVS ${version} data file is missing: ${(error as Error).message}`);
  }
  if (releaseHash(bytes) !== release.sha256) throw new AsvsDataError(`ASVS ${version} data file is not the pinned release file`);
  const flat = (JSON.parse(bytes.toString("utf8")) as { requirements?: FlatRecord[] }).requirements;
  if (!Array.isArray(flat)) throw new AsvsDataError(`ASVS ${version} data file has no requirements list`);

  const chapters: AsvsChapter[] = [];
  const requirements: AsvsRequirement[] = [];
  for (const rec of flat) {
    const level = Number(rec.L);
    if (level !== 1 && level !== 2 && level !== 3) throw new AsvsDataError(`${rec.req_id}: level ${String(rec.L)} is not 1, 2 or 3`);
    let chapter = chapters.find((c) => c.id === rec.chapter_id);
    if (!chapter) chapters.push((chapter = { id: rec.chapter_id, name: rec.chapter_name, sections: [] }));
    let section = chapter.sections.find((s) => s.id === rec.section_id);
    if (!section) chapter.sections.push((section = { id: rec.section_id, name: rec.section_name, chapter: chapter.id, requirements: [] }));
    const requirement: AsvsRequirement = { id: rec.req_id, chapter: chapter.id, section: section.id, text: rec.req_description, level };
    section.requirements.push(requirement);
    requirements.push(requirement);
  }
  const data: AsvsData = { version, source: asvsSource(version), release, chapters, requirements };
  cache.set(key, data);
  return data;
}

export interface AsvsFilter {
  /** Keeps the requirements of this level and below (level 2 keeps the rows of levels 1 and 2). */
  level?: AsvsLevel;
  /** A chapter id such as `V6`. */
  chapter?: string;
}

/** The requirements of a filter, in release order. */
export function asvsRequirements(data: AsvsData, filter: AsvsFilter = {}): AsvsRequirement[] {
  return data.requirements.filter((r) => (filter.level === undefined || r.level <= filter.level) && (filter.chapter === undefined || r.chapter === filter.chapter));
}

/** The chapters and sections of a filter: sections and chapters left without a requirement are dropped. */
export function asvsTree(data: AsvsData, filter: AsvsFilter = {}): AsvsChapter[] {
  const out: AsvsChapter[] = [];
  for (const chapter of data.chapters) {
    const sections: AsvsSection[] = [];
    for (const section of chapter.sections) {
      const requirements = asvsRequirements({ ...data, requirements: section.requirements }, filter);
      if (requirements.length > 0) sections.push({ ...section, requirements });
    }
    if (sections.length > 0) out.push({ id: chapter.id, name: chapter.name, sections });
  }
  return out;
}

/** How many requirements each level shows: level 1 shows the rows of level 1, level 2 those up to 2, level 3 all. */
export function asvsLevelCounts(data: AsvsData): Record<AsvsLevel, number> {
  return { 1: asvsRequirements(data, { level: 1 }).length, 2: asvsRequirements(data, { level: 2 }).length, 3: asvsRequirements(data, { level: 3 }).length };
}

export * from "./mapping.js";
export * from "./units.js";
export * from "./decisions.js";
export * from "./resolver.js";
