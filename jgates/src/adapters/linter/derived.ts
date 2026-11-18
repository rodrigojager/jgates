// What the engine derives from the descriptors, so a tool slice edits no shared file: the trust entries of jgates ci,
// the suppression kinds, the evidence entries of the support matrix, the adapters that supersede the bridge's
// MegaLinter subcheck, the per-tool test titles and one implicit template per descriptor group. The hand-kept tables
// read these through `withDerived`, which merges a hand table with the derived entries when it is first read.
//
// This module reads descriptors only (no adapter code), so the tables that import it stay free of cycles.
import type { AdapterEvidence, TestRef } from "../../core/matrix/evidence.js";
import { evidencePatterns } from "./census.js";
import { linterGroupKey, linterTemplateId, loadLinters, type LinterDescriptor, type LoadedLinter } from "./descriptor.js";

/** The per-tool test file and the title of a descriptor's test there (the evidence entry cites it). */
export const LINTERS_TEST_FILE = "linters.test.js";

export function linterTestTitle(d: LinterDescriptor): string {
  return `${d.id}: the bad fixture gives the expected findings and the clean twin none [proves: ${d.id}#${d.place.capability}, ${d.id}#${d.place.capability}@any]`;
}

/** The substring of the title the evidence entry cites. */
const testRef = (d: LinterDescriptor): TestRef => ({ file: LINTERS_TEST_FILE, test: `${d.id}: the bad fixture gives the expected findings` });

/**
 * A read-only record that is the hand table plus the derived entries, computed when the record is first read (so a
 * broken descriptor fails where the table is used, as a broken built-in template does, not when a module loads).
 * A hand entry wins over a derived one with the same key (the scan refuses such a descriptor anyway).
 */
export function withDerived<T>(hand: Readonly<Record<string, T>>, derive: () => Record<string, T>): Readonly<Record<string, T>> {
  let merged: Record<string, T> | null = null;
  const get = (): Record<string, T> => (merged ??= { ...derive(), ...hand });
  return new Proxy(hand as Record<string, T>, {
    get: (_t, key) => (typeof key === "string" ? get()[key] : undefined),
    has: (_t, key) => typeof key === "string" && Object.hasOwn(get(), key),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_t, key) => (typeof key === "string" && Object.hasOwn(get(), key) ? { value: get()[key], enumerable: true, configurable: true, writable: false } : undefined),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

/** The trust entries of jgates ci (same shape as ADAPTER_TRUST's). */
export function linterTrust(): Record<string, { treatment: "trusted" | "self-reported" | "excluded"; config: string; suppressions: string }> {
  return Object.fromEntries(loadLinters().map(({ descriptor: d }) => [d.id, { treatment: d.governed.treatment, config: d.governed.config, suppressions: d.governed.suppressions.description }]));
}

/** The reason a descriptor's tool is excluded from jgates ci, in the descriptor's words. */
export function linterExclusionReason(id: string): string | null {
  const l = loadLinters().find((x) => x.descriptor.id === id);
  return l && l.descriptor.governed.treatment === "excluded" ? l.descriptor.governed.config : null;
}

/** The kind id of a descriptor's in-code suppressions (rule suppression.<kind>). */
export const linterSuppressionKind = (id: string): string => `linter-${id}`;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The suppression kinds of the descriptors that honour in-code suppressions; the files are the descriptor's own unless it names them. */
export function linterSuppressionKinds(): Array<{ id: string; tool: string; pattern: RegExp; files?: RegExp; adapter: string }> {
  const out: Array<{ id: string; tool: string; pattern: RegExp; files?: RegExp; adapter: string }> = [];
  for (const { descriptor: d } of loadLinters()) {
    const s = d.governed.suppressions;
    if (!s.honoured || !s.pattern) continue;
    const exts = d.activation.extensions ?? [];
    const files = s.files ? new RegExp(s.files, "i") : exts.length > 0 ? new RegExp(`(?:${exts.map(escape).join("|")})$`, "i") : undefined;
    out.push({ id: linterSuppressionKind(d.id), tool: d.name, pattern: new RegExp(s.pattern), ...(files ? { files } : {}), adapter: d.id });
  }
  return out;
}

/** The evidence entries of the support matrix: the capability, proven on "any" stack by the tool's test in linters.test.js. */
export function linterEvidence(): Record<string, AdapterEvidence> {
  return Object.fromEntries(
    loadLinters().map(({ descriptor: d }) => {
      const ref = testRef(d);
      return [
        d.id,
        {
          capabilities: { [d.place.capability]: { tests: [ref], stacks: { any: [ref] } } },
          limitation: { en: d.text.en.limitation, ptBR: d.text["pt-BR"].limitation },
          external: { en: d.text.en.needs, ptBR: d.text["pt-BR"].needs },
        } satisfies AdapterEvidence,
      ];
    }),
  );
}

/** The descriptor tools that answer for a MegaLinter linter (they supersede the bridge's megalinter subcheck). */
export function linterSupersedingIds(): string[] {
  return loadLinters()
    .filter((l) => l.descriptor.megalinter.length > 0)
    .map((l) => l.descriptor.id);
}

/** The descriptor groups (section/group) with their tools, sorted. */
export function linterGroups(): Array<{ key: string; templateId: string; linters: LoadedLinter[] }> {
  const groups = new Map<string, LoadedLinter[]>();
  for (const l of loadLinters()) {
    const key = linterGroupKey(l.descriptor);
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, linters]) => ({ key, templateId: linterTemplateId((linters[0] as LoadedLinter).descriptor), linters }));
}

/**
 * One implicit template per descriptor group (lint-php, lint-markdown, scan-secrets): the group's tools, detected by a
 * file of the group anywhere in the workspace (the census), always active for a group of whole-project tools. Two
 * groups of different sections that map to one template id are a defect of the descriptors.
 */
export function linterTemplates(): Array<{ id: string; value: Record<string, unknown> }> {
  const out: Array<{ id: string; value: Record<string, unknown> }> = [];
  const seen = new Map<string, string>();
  for (const group of linterGroups()) {
    const clash = seen.get(group.templateId);
    if (clash) throw new Error(`linter descriptors: the groups ${clash} and ${group.key} both make the template ${group.templateId}`);
    seen.set(group.templateId, group.key);
    const ds = group.linters.map((l) => l.descriptor);
    const wholeProject = ds.some((d) => d.activation.project === true && !d.activation.extensions && !d.activation.names && !d.activation.content);
    const patterns = wholeProject ? [] : [...new Set(ds.flatMap((d) => evidencePatterns(d.activation)))].sort();
    const tools = Object.fromEntries(ds.map((d) => [d.id, { adapter: d.id, enabled: true, tier: d.place.tier, capabilities: [d.place.capability] }]));
    out.push({
      id: group.templateId,
      value: {
        schemaVersion: 1,
        id: group.templateId,
        label: `${ds.map((d) => d.name).join(", ")} (${group.key})`,
        description: ds.map((d) => `${d.name}: ${d.text.en.purpose}`).join(" "),
        implicit: true,
        extends: ["builtin:base"],
        ...(patterns.length > 0 ? { match: { files: patterns } } : {}),
        config: { tools },
      },
    });
  }
  return out;
}
