import path from "node:path";
import { translator } from "../../i18n/index.js";
import { builtinProfileBody, getBuiltinProfile, listBuiltinProfiles } from "../../builtin/index.js";
import { CONFIG_DIR, loadProjectConfig, ROOT_FILE, suggestName, validateDocument, type ConfigLoadResult } from "../config/load/index.js";
import { DEFAULT_PROFILE, resolveConfig } from "../config/resolve/index.js";
import { hashBytes, patchYamlText, patchYamlFile, readRevision, YamlPatchError, type YamlEdit } from "../codecs/yaml/index.js";
import { parseYamlText } from "../config/load/yaml.js";
import { knownSelectors, parseSelector, parseSkipList, resolveSelection, skipOverrides } from "../selection/index.js";

/** Project profiles: list, create, set the default and delete, by patch on .jgates/profiles.yml and jgates.yml. */

export const PROFILES_FILE = `${CONFIG_DIR}/profiles.yml`;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type ProfileErrorCode =
  | "CONFIG_INVALID"
  | "PROFILE_ID_INVALID"
  | "PROFILE_EXISTS"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_FROM_NOT_FOUND"
  | "PROFILE_CYCLE"
  | "PROFILE_IN_USE"
  | "SKIP_REJECTED"
  | "REVISION_CONFLICT"
  | "ROOT_MISSING"
  | "PATCH_FAILED"
  | "PROFILE_READONLY"
  | "SELECTION_REJECTED"
  | "POLICY_REJECTED";

export class ProfileError extends Error {
  constructor(
    readonly code: ProfileErrorCode,
    message: string,
    readonly fix: string | null = null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

export interface ProfileInfo {
  id: string;
  /** "project": defined in profiles.yml; "builtin": a starter profile (builtin:<id>). */
  origin: "project" | "builtin";
  ref: string;
  label: string | null;
  description: string | null;
  extends: string | null;
  /** The selectors the profile itself sets, with their value. */
  checks: Record<string, { enabled?: boolean; intensity?: string }>;
  isDefault: boolean;
  /** Profiles that extend this one. */
  usedBy: string[];
  file: string;
}

export interface ProfileList {
  profiles: ProfileInfo[];
  /** selection.profile as the project resolves it. */
  default: string;
  /** Revisions (sha256) to pass back as the expected hash of a write; null when the file does not exist. */
  revisions: Record<string, string | null>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function loadValid(dir: string): ConfigLoadResult {
  const t = translator("profiles");
  const load = loadProjectConfig(dir);
  if (!load.valid) {
    const first = load.diagnostics[0];
    throw new ProfileError("CONFIG_INVALID", t("profiles_config_invalid", { count: load.diagnostics.length, first: first ? `${first.file}${first.path ? ` (${first.path})` : ""}: ${first.message}` : "" }), t("profiles_config_invalid_fix"), {
      diagnostics: load.diagnostics,
    });
  }
  return load;
}

function projectProfiles(load: ConfigLoadResult): { file: string | null; map: Record<string, Record<string, unknown>> } {
  const doc = load.documents.find((d) => d.kind === "profiles");
  return { file: doc?.file ?? null, map: asRecord(asRecord(doc?.value).profiles) as Record<string, Record<string, unknown>> };
}

function defaultOf(load: ConfigLoadResult): string {
  const root = load.documents.find((d) => d.kind === "root");
  const selection = asRecord(asRecord(root?.value).selection);
  return typeof selection.profile === "string" ? selection.profile : DEFAULT_PROFILE;
}

/** Lists the project profiles, then the starter profiles, with the default and the revisions of the files. */
export function listProfiles(dir: string): ProfileList {
  const load = loadValid(path.resolve(dir));
  const { file, map } = projectProfiles(load);
  const def = defaultOf(load);
  const info = (ref: string, origin: ProfileInfo["origin"], body: Record<string, unknown>, where: string): ProfileInfo => ({
    id: origin === "builtin" ? ref.replace(/^builtin:/, "") : ref,
    origin,
    ref,
    label: typeof body.label === "string" ? body.label : null,
    description: typeof body.description === "string" ? body.description : null,
    extends: typeof body.extends === "string" ? body.extends : null,
    checks: asRecord(body.checks) as ProfileInfo["checks"],
    isDefault: def === ref,
    usedBy: [],
    file: where,
  });
  const profiles: ProfileInfo[] = Object.entries(map).map(([id, body]) => info(id, "project", body, file ?? PROFILES_FILE));
  for (const item of listBuiltinProfiles()) {
    profiles.push(info(item.ref, "builtin", builtinProfileBody(item), item.file));
  }
  for (const p of profiles) {
    for (const parent of profiles) if (parent.extends === p.ref) p.usedBy.push(parent.ref);
  }
  const abs = (f: string) => path.join(load.projectDir, f);
  return {
    profiles,
    default: def,
    revisions: { [ROOT_FILE]: readRevision(abs(ROOT_FILE)).hash, [file ?? PROFILES_FILE]: readRevision(abs(file ?? PROFILES_FILE)).hash },
  };
}

function builtinRef(id: string): string | undefined {
  const ref = id.startsWith("builtin:") ? id : `builtin:${id}`;
  return getBuiltinProfile(ref) ? ref : undefined;
}

function allRefs(map: Record<string, unknown>): string[] {
  return [...Object.keys(map), ...listBuiltinProfiles().map((p) => `builtin:${p.id}`)];
}

/** Applies the edits to a YAML file of the project, validating the result against its schema before any write. */
export function applyEdits(dir: string, file: string, kind: "profiles" | "root" | "policy", edits: YamlEdit[], options: { expectedHash: string | undefined; createWith?: string }): { hash: string; previousHash: string | null; changed: boolean; strategy: string } {
  const t = translator("profiles");
  const absolute = path.join(dir, file);
  const rev = readRevision(absolute);
  if (options.expectedHash !== undefined && options.expectedHash !== rev.hash) {
    throw conflict(file, options.expectedHash, rev.hash);
  }
  try {
    const base = rev.exists ? rev.text : (options.createWith ?? "");
    const preview = patchYamlText(base, edits);
    const parsed = parseYamlText(preview.text.charCodeAt(0) === 0xfeff ? preview.text.slice(1) : preview.text, file);
    const diagnostics = [...parsed.diagnostics, ...(parsed.diagnostics.length === 0 ? validateDocument(kind, parsed.value, file, { doc: parsed.doc, lineCounter: parsed.lineCounter }) : [])];
    if (diagnostics.length > 0) {
      const d = diagnostics[0]!;
      throw new ProfileError("PATCH_FAILED", t("profiles_patch_invalid", { file, detail: d.message }), t("profiles_patch_invalid_fix"), { diagnostics });
    }
    const result = patchYamlFile(absolute, edits, { expectedHash: rev.hash, ...(options.createWith !== undefined ? { createWith: options.createWith } : {}) });
    return { hash: result.hash, previousHash: result.previousHash, changed: result.changed, strategy: result.strategy };
  } catch (error) {
    if (error instanceof YamlPatchError) {
      if (error.code === "YAML_CONFLICT") throw conflict(file, options.expectedHash ?? rev.hash, error.details.currentHash ?? null);
      throw new ProfileError("PATCH_FAILED", t("profiles_patch_failed", { file, detail: error.message }), t("profiles_patch_invalid_fix"));
    }
    throw error;
  }
}

function conflict(file: string, expected: string | null, current: string | null): ProfileError {
  const t = translator("profiles");
  return new ProfileError("REVISION_CONFLICT", t("profiles_conflict", { file }), t("profiles_conflict_fix"), { file, expectedHash: expected, currentHash: current });
}

export interface WriteOptions {
  /** Revision (sha256) of the file being written, as `profiles list` showed it; a different one is a conflict. */
  expectedHash?: string;
}

export interface WriteResult {
  file: string;
  hash: string;
  previousHash: string | null;
  changed: boolean;
  strategy: string;
}

export interface CreateOptions extends WriteOptions {
  from: string;
  skip?: string[];
  label?: string;
  description?: string;
  /** Replace an existing profile with the same id (recreate). */
  replace?: boolean;
}

export interface CreateResult extends WriteResult {
  id: string;
  extends: string;
  checks: Record<string, { enabled: boolean }>;
}

function chainOf(start: string, map: Record<string, Record<string, unknown>>): string[] {
  const seen: string[] = [];
  let cur: string | undefined = start;
  while (cur !== undefined && !seen.includes(cur)) {
    seen.push(cur);
    const next: unknown = map[cur]?.extends;
    cur = typeof next === "string" ? next : undefined;
  }
  return seen;
}

/** Creates a profile that extends `from` and turns off the `skip` selectors; the rest of the file stays as it is. */
export function createProfile(dir: string, id: string, options: CreateOptions): CreateResult {
  const t = translator("profiles");
  const projectDir = path.resolve(dir);
  if (!ID_PATTERN.test(id)) throw new ProfileError("PROFILE_ID_INVALID", t("profiles_id_invalid", { id }), t("profiles_id_invalid_fix"));
  const load = loadValid(projectDir);
  const { file: existingFile, map } = projectProfiles(load);
  const exists = Object.hasOwn(map, id);
  if (exists && !options.replace) throw new ProfileError("PROFILE_EXISTS", t("profiles_exists", { id }), t("profiles_exists_fix", { id }));

  const from = Object.hasOwn(map, options.from) ? options.from : builtinRef(options.from);
  if (!from) {
    const suggestion = suggestName(options.from, allRefs(map));
    throw new ProfileError("PROFILE_FROM_NOT_FOUND", t("profiles_from_not_found", { from: options.from }), suggestion ? t("profiles_suggest", { suggestion }) : t("profiles_from_not_found_fix"), suggestion ? { suggestion } : {});
  }
  if (chainOf(from, map).includes(id)) {
    throw new ProfileError("PROFILE_CYCLE", t("profiles_cycle", { id, from }), t("profiles_cycle_fix"));
  }

  const skip = parseSkipList(options.skip ?? []);
  if (skip.length > 0) rejectBadSkips(projectDir, from, skip);

  const checks: Record<string, { enabled: boolean }> = {};
  for (const selector of skip) checks[selector] = { enabled: false };
  const body: Record<string, unknown> = {};
  if (options.label) body.label = options.label;
  if (options.description) body.description = options.description;
  body.extends = from;
  if (skip.length > 0) body.checks = checks;

  const file = existingFile ?? PROFILES_FILE;
  const result = applyEdits(projectDir, file, "profiles", [{ op: "set", path: ["profiles", id], value: body }], {
    expectedHash: options.expectedHash,
    createWith: "schemaVersion: 1\n",
  });
  return { id, extends: from, checks, file, ...result };
}

/** Selectors the new profile would turn off must exist and must not touch a locked requirement. */
function rejectBadSkips(projectDir: string, from: string, skip: string[]): void {
  const t = translator("profiles");
  const resolved = resolveConfig(projectDir, { profile: from, overrides: skipOverrides(skip) });
  if (!resolved.ok) {
    const first = resolved.errors[0];
    throw new ProfileError("CONFIG_INVALID", t("profiles_config_invalid", { count: resolved.errors.length, first: first?.message ?? "" }), t("profiles_config_invalid_fix"), { errors: resolved.errors });
  }
  const selection = resolveSelection(resolved);
  const mine = selection.errors.filter((e) => e.source === "--skip");
  if (mine.length > 0) {
    const first = mine[0]!;
    throw new ProfileError("SKIP_REJECTED", first.message, first.fix ?? null, { errors: mine });
  }
}

/** Sets selection.profile in jgates.yml (and nothing else). */
export function setDefaultProfile(dir: string, id: string, options: WriteOptions = {}): WriteResult & { default: string } {
  const t = translator("profiles");
  const projectDir = path.resolve(dir);
  const load = loadValid(projectDir);
  const { map } = projectProfiles(load);
  const ref = Object.hasOwn(map, id) ? id : builtinRef(id);
  if (!ref) {
    const suggestion = suggestName(id, allRefs(map));
    throw new ProfileError("PROFILE_NOT_FOUND", t("profiles_not_found", { id }), suggestion ? t("profiles_suggest", { suggestion }) : t("profiles_not_found_fix"), suggestion ? { suggestion } : {});
  }
  const result = applyEdits(projectDir, ROOT_FILE, "root", [{ op: "set", path: ["selection", "profile"], value: ref }], { expectedHash: options.expectedHash });
  return { default: ref, file: ROOT_FILE, ...result };
}

/** Deletes a profile; one that another profile extends, or that is the default, is refused with the reason. */
export function deleteProfile(dir: string, id: string, options: WriteOptions = {}): WriteResult & { id: string } {
  const t = translator("profiles");
  const projectDir = path.resolve(dir);
  const load = loadValid(projectDir);
  const { file, map } = projectProfiles(load);
  if (!Object.hasOwn(map, id) || file === null) {
    const suggestion = suggestName(id, Object.keys(map));
    throw new ProfileError("PROFILE_NOT_FOUND", t("profiles_not_found", { id }), suggestion ? t("profiles_suggest", { suggestion }) : t("profiles_not_found_fix"), suggestion ? { suggestion } : {});
  }
  const users = Object.entries(map).filter(([other, body]) => other !== id && body.extends === id).map(([other]) => other);
  if (users.length > 0) throw new ProfileError("PROFILE_IN_USE", t("profiles_in_use_extends", { id, users: users.join(", ") }), t("profiles_in_use_fix"), { usedBy: users });
  if (defaultOf(load) === id) throw new ProfileError("PROFILE_IN_USE", t("profiles_in_use_default", { id }), t("profiles_in_use_fix"), { default: true });
  const result = applyEdits(projectDir, file, "profiles", [{ op: "delete", path: ["profiles", id] }], { expectedHash: options.expectedHash });
  return { id, file, ...result };
}

export { hashBytes };


export interface SelectionChange {
  selector: string;
  enabled: boolean;
}

function configTranslator() {
  return translator("config-profiles");
}

/**
 * Writes `checks.<selector>.enabled` into a project profile (by patch, one write for all the changes). A selector no
 * one can name, a builtin profile and a requirement locked by the policy are refused with the reason, and the file
 * stays as it is.
 */
export function setProfileChecks(dir: string, id: string, changes: SelectionChange[], options: WriteOptions = {}): WriteResult & { id: string; changes: SelectionChange[] } {
  const t = configTranslator();
  const projectDir = path.resolve(dir);
  const load = loadValid(projectDir);
  const { file, map } = projectProfiles(load);
  if (!Object.hasOwn(map, id) || file === null) {
    if (builtinRef(id) !== undefined) throw new ProfileError("PROFILE_READONLY", t("cfgp_profile_readonly", { id }), t("cfgp_profile_readonly_fix", { id }));
    const suggestion = suggestName(id, Object.keys(map));
    throw new ProfileError("PROFILE_NOT_FOUND", t("cfgp_not_found", { id }), suggestion ? t("cfgp_suggest", { suggestion }) : null, suggestion ? { suggestion } : {});
  }
  if (changes.length === 0) throw new ProfileError("SELECTION_REJECTED", t("cfgp_no_changes"), t("cfgp_no_changes_fix"));
  const resolved = resolveConfig(projectDir, { profile: id });
  if (!resolved.ok) {
    const first = resolved.errors[0];
    throw new ProfileError("CONFIG_INVALID", t("cfgp_resolve_failed", { first: first?.message ?? "" }), t("profiles_config_invalid_fix"), { errors: resolved.errors });
  }
  const selection = resolveSelection(resolved);
  const known = new Set(knownSelectors(selection.universe));
  const seen = new Set<string>();
  for (const change of changes) {
    if (!parseSelector(change.selector)) throw new ProfileError("SELECTION_REJECTED", t("cfgp_selector_invalid", { selector: change.selector }), t("cfgp_selector_invalid_fix"));
    if (!known.has(change.selector)) {
      const suggestion = suggestName(change.selector, [...known]);
      throw new ProfileError("SELECTION_REJECTED", t("cfgp_selector_unknown", { selector: change.selector }), suggestion ? t("cfgp_suggest", { suggestion }) : null, suggestion ? { suggestion } : {});
    }
    if (seen.has(change.selector)) throw new ProfileError("SELECTION_REJECTED", t("cfgp_selector_repeated", { selector: change.selector }), null);
    seen.add(change.selector);
    if (!change.enabled) {
      const item = selection.items.find((i) => i.selector === change.selector);
      const lock = item?.locked?.[0];
      if (lock) {
        throw new ProfileError("SELECTION_REJECTED", t("cfgp_locked", { selector: change.selector, reason: lock.reason }), t("cfgp_locked_fix", { file: lock.file ?? "policy.yml" }), { locked: item?.locked });
      }
    }
  }
  const edits: YamlEdit[] = changes.map((c) => ({ op: "set", path: ["profiles", id, "checks", c.selector, "enabled"], value: c.enabled }));
  const result = applyEdits(projectDir, file, "profiles", edits, { expectedHash: options.expectedHash });
  return { id, file, changes, ...result };
}

/** Renames a project profile: the entry moves, the profiles that extend it and selection.profile follow. */
export function renameProfile(dir: string, id: string, to: string, options: WriteOptions = {}): WriteResult & { id: string; to: string } {
  const t = translator("profiles");
  const projectDir = path.resolve(dir);
  if (!ID_PATTERN.test(to)) throw new ProfileError("PROFILE_ID_INVALID", t("profiles_id_invalid", { id: to }), t("profiles_id_invalid_fix"));
  const load = loadValid(projectDir);
  const { file, map } = projectProfiles(load);
  if (!Object.hasOwn(map, id) || file === null) {
    const suggestion = suggestName(id, Object.keys(map));
    throw new ProfileError("PROFILE_NOT_FOUND", t("profiles_not_found", { id }), suggestion ? t("profiles_suggest", { suggestion }) : t("profiles_not_found_fix"), suggestion ? { suggestion } : {});
  }
  if (Object.hasOwn(map, to) && to !== id) throw new ProfileError("PROFILE_EXISTS", t("profiles_exists", { id: to }), t("profiles_exists_fix", { id: to }));
  if (to === id) throw new ProfileError("PROFILE_EXISTS", t("profiles_exists", { id: to }), t("profiles_exists_fix", { id: to }));
  const edits: YamlEdit[] = [{ op: "set", path: ["profiles", to], value: map[id] }, { op: "delete", path: ["profiles", id] }];
  for (const [other, body] of Object.entries(map)) if (other !== id && body.extends === id) edits.push({ op: "set", path: ["profiles", other, "extends"], value: to });
  const wasDefault = defaultOf(load) === id;
  const result = applyEdits(projectDir, file, "profiles", edits, { expectedHash: options.expectedHash });
  if (wasDefault) applyEdits(projectDir, ROOT_FILE, "root", [{ op: "set", path: ["selection", "profile"], value: to }], { expectedHash: undefined });
  return { id, to, file, ...result };
}

export interface PolicyChange {
  /** Key under `rules` in policy.yml. */
  key: string;
  field: "enabled" | "severity" | "threshold";
  value: boolean | string | number;
}

/** Writes `rules.<key>.<field>` into policy.yml (created when absent), validated against the policy schema before the write. */
export function setPolicyRules(dir: string, changes: PolicyChange[], options: WriteOptions = {}): WriteResult {
  const t = configTranslator();
  const projectDir = path.resolve(dir);
  const load = loadValid(projectDir);
  if (changes.length === 0) throw new ProfileError("POLICY_REJECTED", t("cfgp_no_changes"), t("cfgp_no_changes_fix"));
  const file = load.documents.find((d) => d.kind === "policy")?.file ?? `${CONFIG_DIR}/policy.yml`;
  const edits: YamlEdit[] = changes.map((c) => ({ op: "set", path: ["rules", c.key, c.field], value: c.value }));
  const result = applyEdits(projectDir, file, "policy", edits, { expectedHash: options.expectedHash, createWith: "schemaVersion: 1\n" });
  return { file, ...result };
}
