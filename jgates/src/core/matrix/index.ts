import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterManifest } from "../catalog/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { supportLevelFor } from "../tools/index.js";
import { ADAPTER_EVIDENCE, OS_STATUS, type Bilingual, type TestRef } from "./evidence.js";

export type MatrixLang = "en" | "pt-BR";

export interface MatrixCapability {
  id: string;
  /** "integrated" has at least one test; "declared" is in the manifest but not proven (the reason is in `note`). */
  status: "integrated" | "declared";
  tests: TestRef[];
  note?: Bilingual;
}

export interface MatrixAdapter {
  id: string;
  displayName: string;
  tool: string;
  toolVersionRange: string;
  languages: string[];
  capabilities: MatrixCapability[];
  /** Editing modes the manifest implements (text, partial, structured-read, structured-write...). */
  editing: string[];
  /** Support level of an instance of this adapter on Linux (editable-file, assisted, full...). */
  supportLevel: string;
  runners: Array<"local" | "container">;
  os: { linux: Bilingual; win32: Bilingual; darwin: Bilingual };
  limitation: Bilingual;
  manifestLimitations: string[];
  external: Bilingual;
  otherTests: TestRef[];
}

export interface MatrixStack {
  id: string;
  label: string;
  support: "full" | "partial" | "inventory";
  uncovered: string[];
}

export interface Matrix {
  schemaVersion: 1;
  adapters: MatrixAdapter[];
  stacks: MatrixStack[];
  notes: { macos: Bilingual };
}

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests");
const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin", "templates");

function runnersOf(m: AdapterManifest): Array<"local" | "container"> {
  const out: Array<"local" | "container"> = [];
  const rt = m.runtimes ?? [];
  if (rt.some((r) => r === "native" || r === "node" || r === "python")) out.push("local");
  if (rt.includes("container") || rt.includes("docker")) out.push("container");
  return out.length > 0 ? out : ["local"];
}

function stacks(): MatrixStack[] {
  const out: MatrixStack[] = [];
  for (const name of fs.readdirSync(templatesDir).filter((f) => f.endsWith(".json")).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(templatesDir, name), "utf8")) as { id: string; label: string; support?: { level: "partial" | "inventory"; uncovered?: string[] } };
    out.push({ id: doc.id, label: doc.label, support: doc.support?.level ?? "full", uncovered: doc.support?.uncovered ?? [] });
  }
  return out;
}

/** The matrix, built from the registered manifests and the evidence table. Deterministic: no clock, no machine data. */
export function buildMatrix(manifests: AdapterManifest[] = builtinManifests()): Matrix {
  const adapters: MatrixAdapter[] = manifests.map((m) => {
    const ev = ADAPTER_EVIDENCE[m.id];
    const capabilities: MatrixCapability[] = m.capabilities.map((id) => {
      const c = ev?.capabilities[id];
      if (c && c.tests.length > 0) return { id, status: "integrated", tests: c.tests };
      return { id, status: "declared", tests: [], ...(c?.notIntegrated ? { note: c.notIntegrated } : {}) };
    });
    return {
      id: m.id,
      displayName: m.displayName,
      tool: m.toolName,
      toolVersionRange: m.toolVersionRange,
      languages: m.languages ?? [],
      capabilities,
      editing: [...m.editing.implemented],
      supportLevel: supportLevelFor(m.id, true, manifests, "linux"),
      runners: runnersOf(m),
      os: { linux: OS_STATUS.linux, win32: OS_STATUS.win32, darwin: OS_STATUS.darwin },
      limitation: ev?.limitation ?? { en: "", ptBR: "" },
      manifestLimitations: [...(m.limitations ?? [])],
      external: ev?.external ?? { en: "", ptBR: "" },
      otherTests: ev?.otherTests ?? [],
    };
  });
  return { schemaVersion: 1, adapters, stacks: stacks(), notes: { macos: OS_STATUS.darwin } };
}

/** The marker a test title carries for each capability it proves: `[proves: trivy#licenses, trivy#iac]`. */
export const PROVES_MARKER = /\[proves: ([^\]]+)\]/g;

/** The titles of the `test(...)` calls of a test file (string literal titles). */
export function testTitles(text: string): string[] {
  const out: string[] = [];
  const call = /\btest\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of text.matchAll(call)) out.push((m[2] ?? "").replace(/\\(["'`\\])/g, "$1"));
  return out;
}

/** The capabilities (`adapter#capability`) a title says it proves. */
export function provedBy(title: string): string[] {
  const out: string[] = [];
  for (const m of title.matchAll(PROVES_MARKER)) for (const part of (m[1] ?? "").split(",")) if (part.trim()) out.push(part.trim());
  return out;
}

/**
 * Problems that break the matrix: a capability without a real test, a cited test that does not say it exercises the
 * capability (its title carries no `[proves: <adapter>#<capability>]` marker), or an adapter without a described
 * limitation.
 */
export function verifyMatrix(matrix: Matrix): string[] {
  const problems: string[] = [];
  const cache = new Map<string, string[] | null>();
  const titles = (file: string) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, testTitles(fs.readFileSync(path.join(testsDir, file), "utf8")));
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file) ?? null;
  };
  const checkRef = (where: string, ref: TestRef, capability: string | null) => {
    const list = titles(ref.file);
    if (list === null) {
      problems.push(`${where}: test file ${ref.file} does not exist`);
      return;
    }
    const found = list.filter((title) => title.includes(ref.test));
    if (found.length === 0) problems.push(`${where}: no test titled "${ref.test}" in ${ref.file}`);
    else if (capability !== null && !found.some((title) => provedBy(title).includes(capability))) {
      problems.push(`${where}: the test "${ref.test}" in ${ref.file} does not say it exercises ${capability} (no [proves: ${capability}] in its title)`);
    }
  };
  for (const a of matrix.adapters) {
    if (!ADAPTER_EVIDENCE[a.id]) problems.push(`${a.id}: no evidence entry`);
    if (!a.limitation.en.trim() || !a.limitation.ptBR.trim()) problems.push(`${a.id}: no limitation described`);
    for (const c of a.capabilities) {
      const where = `${a.id}#${c.id}`;
      if (c.status === "integrated") for (const ref of c.tests) checkRef(where, ref, where);
      else if (!c.note) problems.push(`${where}: capability announced without a test reference and without a stated reason`);
    }
    for (const ref of a.otherTests) checkRef(a.id, ref, null);
  }
  return problems;
}

const esc = (s: string) => s.replace(/\|/g, "\\|");

const LABELS = {
  en: {
    adapter: "Adapter",
    tool: "Tool and version",
    languages: "Languages",
    capabilities: "Capabilities (proving test)",
    editing: "Editing",
    support: "Support",
    runner: "Runner",
    os: "OS (Linux / Windows / macOS)",
    limitation: "Limitation",
    external: "External dependencies",
    declared: "declared, not proven",
    stack: "Stack",
    level: "Support",
    uncovered: "Not covered",
    full: "full",
    partial: "partial",
    inventory: "inventory only",
    local: "local",
    container: "container",
  },
  "pt-BR": {
    adapter: "Adaptador",
    tool: "Ferramenta e versão",
    languages: "Linguagens",
    capabilities: "Capacidades (teste que prova)",
    editing: "Edição",
    support: "Suporte",
    runner: "Runner",
    os: "SO (Linux / Windows / macOS)",
    limitation: "Limitação",
    external: "Dependências externas",
    declared: "declarada, sem prova",
    stack: "Stack",
    level: "Suporte",
    uncovered: "Não coberto",
    full: "completo",
    partial: "parcial",
    inventory: "só inventário",
    local: "local",
    container: "container",
  },
} as const;

/** The two tables of the published matrix, as Markdown. The documentation holds exactly this text. */
export function renderMatrixMarkdown(matrix: Matrix, lang: MatrixLang): string {
  const L = LABELS[lang];
  const pick = (b: Bilingual) => (lang === "en" ? b.en : b.ptBR);
  const rows: string[] = [];
  rows.push(`| ${[L.adapter, L.tool, L.languages, L.capabilities, L.editing, L.support, L.runner, L.os, L.limitation, L.external].join(" | ")} |`);
  rows.push(`| ${new Array(10).fill("---").join(" | ")} |`);
  for (const a of matrix.adapters) {
    const caps = a.capabilities.length === 0
      ? "-"
      : a.capabilities.map((c) => (c.status === "integrated" ? `${c.id} (${c.tests.map((x) => x.file).join(", ")})` : `${c.id} (${L.declared})`)).join("; ");
    const os = [pick(a.os.linux), pick(a.os.win32), pick(a.os.darwin)].join(" / ");
    const cells = [
      `${a.displayName} (\`${a.id}\`)`,
      `${a.tool} ${a.toolVersionRange === "*" ? "" : a.toolVersionRange}`.trim(),
      a.languages.join(", ") || "-",
      caps,
      a.editing.join(", ") || "-",
      a.supportLevel,
      a.runners.map((r) => L[r]).join(", "),
      os,
      pick(a.limitation),
      pick(a.external),
    ];
    rows.push(`| ${cells.map(esc).join(" | ")} |`);
  }
  const stackRows = [`| ${[L.stack, L.level, L.uncovered].join(" | ")} |`, "| --- | --- | --- |"];
  for (const s of matrix.stacks) stackRows.push(`| ${esc(`${s.label} (\`${s.id}\`)`)} | ${L[s.support]} | ${esc(s.uncovered.join("; ") || "-")} |`);
  return `${rows.join("\n")}\n\n${stackRows.join("\n")}\n`;
}

export const MATRIX_START = "<!-- matrix:start -->";
export const MATRIX_END = "<!-- matrix:end -->";
