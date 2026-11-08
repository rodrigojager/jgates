// The vendored Cloudflare security-audit material (jgates/vendor/cloudflare-security-audit): the pinned upstream
// revision, the adapted phase prompts and the attack-class files whose blocks are given verbatim to the hunting and
// validation contexts. Nothing here is fetched at run time; the folder travels with the package and passes the
// distribution check (jgates-pack.json, LICENSE, NOTICE.md).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The pinned upstream revision this module adapts. */
export const UPSTREAM = {
  url: "https://github.com/cloudflare/security-audit-skill",
  revision: "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8",
  path: "skills/security-audit",
  spdx: "MIT",
  copyright: "Copyright (c) 2025-2026 Cloudflare, Inc.",
} as const;

export const ORDINARY_FILE = "ATTACK-CLASSES.md";
export const COMPANION_SECTIONS = ["Core discipline", "Universal moves", "Validation rules"] as const;

export interface AttackBlock {
  /** FILE.md#Name: the exact class name in bold or the heading text before any parenthetical qualifier. */
  ref: string;
  file: string;
  name: string;
  /** ordinary: a block of ATTACK-CLASSES.md; section: a "## " section of a companion; class: a bold class in it. */
  kind: "ordinary" | "section" | "class";
  /** The companion section a class belongs to. */
  section?: string;
  text: string;
}

export interface Companion {
  file: string;
  title: string;
  whenToUse: string;
}

export interface VendoredMaterial {
  dir: string;
  prompts: Record<"objective" | "reconnaissance" | "coverage-planning" | "hunting" | "coverage-critic" | "refutation" | "verification", string>;
  blocks: Map<string, AttackBlock>;
  companions: Companion[];
  /** sha256 of every vendored text the contexts receive (prompts and attack classes), in name order. */
  sha256: string;
}

/** The vendored folder: next to the package (dist/core/semantic-modules/cloudflare -> ../../../../vendor/...). */
export function vendorDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "vendor", "cloudflare-security-audit");
}

const read = (file: string): string => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** The text between <!-- block:name --> and <!-- /block --> of an adapted prompt file. */
function promptBlock(text: string, name: string, file: string): string {
  const start = text.indexOf(`<!-- block:${name} -->`);
  const end = start >= 0 ? text.indexOf("<!-- /block -->", start) : -1;
  if (start < 0 || end < 0) throw new Error(`${file} has no ${name} block`);
  return text.slice(start + `<!-- block:${name} -->`.length, end).trim();
}

/** The blocks of ATTACK-CLASSES.md: each "**Name** (subagent_type: ...)" paragraph up to the next one. */
function ordinaryBlocks(text: string): AttackBlock[] {
  const lines = text.split("\n");
  const out: AttackBlock[] = [];
  let current: { name: string; from: number } | null = null;
  const close = (to: number): void => {
    if (!current) return;
    out.push({ ref: `${ORDINARY_FILE}#${current.name}`, file: ORDINARY_FILE, name: current.name, kind: "ordinary", text: lines.slice(current.from, to).join("\n").trim() });
  };
  lines.forEach((line, i) => {
    const m = /^\*\*([^*]+)\*\*\s*\(subagent_type/.exec(line);
    if (m) {
      close(i);
      current = { name: (m[1] ?? "").trim(), from: i };
    }
  });
  close(lines.length);
  return out;
}

/** The blocks of a companion file: its "## " sections and the bold classes inside them, plus its "When to use". */
function companionBlocks(file: string, text: string): { blocks: AttackBlock[]; companion: Companion } {
  const lines = text.split("\n");
  const blocks: AttackBlock[] = [];
  const title = (lines.find((l) => l.startsWith("# ")) ?? file).replace(/^#\s+/, "").trim();
  let whenToUse = "";
  const headings: Array<{ name: string; from: number; level: number }> = [];
  lines.forEach((line, i) => {
    const m = /^(#{2,4})\s+(.*)$/.exec(line);
    if (m) headings.push({ name: (m[2] ?? "").replace(/\s*\(.*$/, "").trim(), from: i, level: (m[1] ?? "").length });
  });
  headings.forEach((h, k) => {
    const to = headings[k + 1]?.from ?? lines.length;
    const body = lines.slice(h.from, to).join("\n").trim();
    if (h.name === "When to use this file") {
      whenToUse = lines.slice(h.from + 1, to).join("\n").trim();
      return;
    }
    if (h.level !== 2) return;
    blocks.push({ ref: `${file}#${h.name}`, file, name: h.name, kind: "section", text: body });
    for (let i = h.from + 1; i < to; i++) {
      const m = /^\*\*([^*]+)\*\*\s*$/.exec(lines[i] ?? "");
      if (!m) continue;
      let j = i + 1;
      while (j < to && (lines[j] ?? "").trim() !== "" && !/^\*\*[^*]+\*\*\s*$/.test(lines[j] ?? "")) j++;
      const name = (m[1] ?? "").trim();
      blocks.push({ ref: `${file}#${name}`, file, name, kind: "class", section: h.name, text: lines.slice(i, j).join("\n").trim() });
    }
  });
  return { blocks, companion: { file, title, whenToUse } };
}

let cached: VendoredMaterial | null = null;

/** Loads (once) the vendored material; throws when the folder is missing or incomplete. */
export function loadVendored(dir: string = vendorDir()): VendoredMaterial {
  if (cached && cached.dir === dir) return cached;
  const prompt = (file: string, name = "instructions"): string => promptBlock(read(path.join(dir, "prompts", file)), name, file);
  const prompts: VendoredMaterial["prompts"] = {
    objective: prompt("core.md", "objective"),
    reconnaissance: prompt("reconnaissance.md"),
    "coverage-planning": prompt("coverage-planning.md"),
    hunting: prompt("hunting.md"),
    "coverage-critic": prompt("coverage-critic.md"),
    refutation: prompt("refutation.md"),
    verification: prompt("verification.md"),
  };
  const classesDir = path.join(dir, "attack-classes");
  const files = fs.readdirSync(classesDir).filter((f) => f.endsWith(".md")).sort();
  if (!files.includes(ORDINARY_FILE)) throw new Error(`${ORDINARY_FILE} is missing from ${classesDir}`);
  const blocks = new Map<string, AttackBlock>();
  const companions: Companion[] = [];
  const hash = crypto.createHash("sha256");
  for (const name of Object.keys(prompts).sort()) hash.update(`${name}\0${prompts[name as keyof typeof prompts]}\0`);
  for (const file of files) {
    const text = read(path.join(classesDir, file));
    hash.update(`${file}\0${text}\0`);
    if (file === ORDINARY_FILE) {
      for (const b of ordinaryBlocks(text)) blocks.set(b.ref, b);
      continue;
    }
    const parsed = companionBlocks(file, text);
    for (const b of parsed.blocks) if (!blocks.has(b.ref)) blocks.set(b.ref, b);
    companions.push(parsed.companion);
  }
  if (![...blocks.values()].some((b) => b.kind === "ordinary")) throw new Error(`${ORDINARY_FILE} has no attack-class block`);
  cached = { dir, prompts, blocks, companions, sha256: hash.digest("hex") };
  return cached;
}

/** The companion section blocks that travel with every selected class of a companion file. */
export function companionCompanions(material: VendoredMaterial, file: string): string[] {
  return COMPANION_SECTIONS.map((s) => `${file}#${s}`).filter((ref) => material.blocks.has(ref));
}
