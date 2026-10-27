import { translator } from "../../../i18n/index.js";
import { builtinProfileBody, getBuiltinProfile, isBuiltinRef, listBuiltinProfiles } from "../../../builtin/index.js";
import { suggestName } from "../load/schema.js";
import type { LoadedDocument } from "../load/types.js";
import { formatFilePath, isPlainObject } from "./pointer.js";
import type { IssueSink } from "./store.js";

/** One profile definition: a project profile (profiles.yml) or a starter profile (builtin:<id>). */
export interface ProfileDef {
  /** As referenced: "rapido" or "builtin:standard". */
  ref: string;
  file: string;
  /** Path of the profile inside its file, for example ["profiles", "rapido"]. */
  fileSegments: string[];
  body: Record<string, unknown>;
}

/** The project's profiles by id. The same id in two profiles documents is an error (no order would decide). */
export function collectProjectProfiles(documents: readonly LoadedDocument[], sink: IssueSink): Map<string, ProfileDef> {
  const t = translator("config");
  const out = new Map<string, ProfileDef>();
  for (const doc of documents) {
    if (doc.kind !== "profiles" || !isPlainObject(doc.value) || !isPlainObject(doc.value.profiles)) continue;
    for (const [id, body] of Object.entries(doc.value.profiles)) {
      if (!isPlainObject(body)) continue;
      const existing = out.get(id);
      if (existing) {
        sink.error({ code: "PROFILE_DUPLICATE", message: t("resolve_profile_duplicate", { id, a: existing.file, b: doc.file }), file: doc.file });
        continue;
      }
      out.set(id, { ref: id, file: doc.file, fileSegments: ["profiles", id], body });
    }
  }
  return out;
}

function lookup(ref: string, project: Map<string, ProfileDef>): ProfileDef | undefined {
  if (isBuiltinRef(ref)) {
    const item = getBuiltinProfile(ref);
    return item ? { ref, file: item.file, fileSegments: ["profiles", item.id], body: builtinProfileBody(item) } : undefined;
  }
  return project.get(ref);
}

/**
 * The chain of a profile, the selected one first and then each parent (`extends`). Undefined when a profile is
 * unknown or the chain has a cycle; the cycle is reported with the exact chain, in traversal order.
 */
export function profileChain(selected: string, project: Map<string, ProfileDef>, sink: IssueSink, referencedFrom?: { file: string | null; path: string | null }): ProfileDef[] | undefined {
  const t = translator("config");
  const chain: ProfileDef[] = [];
  let current: string | undefined = selected;
  let from: { file: string | null; path: string | null } = referencedFrom ?? { file: null, path: null };
  while (current !== undefined) {
    const ref: string = current;
    if (chain.some((d) => d.ref === ref)) {
      const ids = [...chain.map((d) => d.ref), ref];
      sink.error({
        code: "EXTENDS_CYCLE",
        message: t("resolve_profile_cycle", { chain: ids.join(" -> ") }),
        fix: t("resolve_cycle_fix"),
        file: chain[chain.length - 1]?.file ?? "",
        chain: ids,
      });
      return undefined;
    }
    const def = lookup(ref, project);
    if (!def) {
      const available = [...listBuiltinProfiles().map((i) => i.ref), ...[...project.keys()].sort()];
      const suggestion = suggestName(ref, available);
      sink.error({
        code: "PROFILE_UNKNOWN",
        message: t("resolve_profile_unknown", { id: ref }),
        fix: t("resolve_profile_unknown_fix", { available: available.join(", ") }),
        ...(from.file ? { file: from.file } : {}),
        details: { ...(from.path ? { path: from.path } : {}), ...(suggestion ? { suggestion } : {}) },
      });
      return undefined;
    }
    chain.push(def);
    current = typeof def.body.extends === "string" ? def.body.extends : undefined;
    from = { file: def.file, path: formatFilePath([...def.fileSegments, "extends"]) };
  }
  return chain;
}

/** Checks the chains of every project profile, so a cycle is an error even in a profile that is not selected. */
export function checkProfileChains(project: Map<string, ProfileDef>, sink: IssueSink, skip: ReadonlySet<string>): void {
  const reported = new Set<string>();
  for (const id of [...project.keys()].sort()) {
    if (skip.has(id)) continue;
    const errors: Parameters<IssueSink["error"]>[0][] = [];
    profileChain(id, project, { error: (e) => errors.push(e), warning: () => undefined });
    for (const e of errors) {
      // One report per cycle (by its members) and per unknown reference.
      const key = e.chain ? [...new Set(e.chain)].sort().join("\u0000") : `${e.code}\u0000${e.message}`;
      if (reported.has(key) || [...skip].some((s) => e.chain?.includes(s))) continue;
      reported.add(key);
      sink.error(e);
    }
  }
}
