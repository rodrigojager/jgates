// Explicit preparation of an instance's data: `previewPrepare` shows the versions and the network first and changes
// nothing; `prepareInstance` downloads the Semgrep registry rules once, stores them by hash under
// <JGATES_HOME>/tools/<hash> and pins the hash (and the tool version) in .jgates/lock.json. Tools are never prepared
// or installed here (container-first, ADR-0004): every tool is in the JGates tools image, read from its image.json.
import { parse as parseYaml } from "yaml";
import { translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { probeSemgrep } from "../../adapters/semgrep/probe.js";
import type { AdapterManifest } from "../catalog/index.js";
import { ensureHome, resolveHome } from "../home/index.js";
import { LOCK_FILE, readLock, writeLock, type LockedRules } from "../lock/index.js";
import { resolveToolBindings } from "../tools/index.js";
import { diagnoseEnvironment, preparationKindOf, type ToolStatus } from "./environment.js";
import { compareVersions, parseVersion } from "./semver.js";
import { DownloadError, SEMGREP_RULES_REF, download, hostOf, preparedRulesOf, semgrepRulesUrl, storeRules, toolsDir } from "./store.js";

export * from "./environment.js";
export * from "./semver.js";
export { SEMGREP_RULES_FILE, SEMGREP_RULES_REF, preparedRulesOf, semgrepRulesUrl, toolsDir, preparedDir } from "./store.js";

export class PrepareError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string | null = null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PrepareError";
  }
}

export interface PrepareOptions {
  env?: NodeJS.ProcessEnv;
  manifests?: AdapterManifest[];
  /** Accept a lower tool version than the one pinned in the lock (never silent). */
  allowVersionChange?: boolean;
}

export interface PreparePreview {
  schemaVersion: 1;
  instance: string;
  adapter: string;
  /** What the preparation pins: a rule set. */
  kind: "rules";
  /** Tool versions: what the tools image has, the adapter range and what the lock pins. */
  versions: { tool: string; installed: string | null; range: string; pinned: string | null; state: ToolStatus["state"] };
  /** The rule set that would be downloaded. */
  rules: { ref: string; url: string; state: ToolStatus["preparation"]["state"]; hash: string | null };
  network: { required: boolean; hosts: string[]; url: string | null };
  /** What the preparation writes. */
  writes: string[];
}

export interface PrepareResult {
  schemaVersion: 1;
  instance: string;
  adapter: string;
  kind: "rules";
  rules: LockedRules;
  /** The previous rule set hash. */
  previousHash: string | null;
  changed: boolean;
  toolVersion: string | null;
  lockFile: string;
}

function locate(projectDir: string, instanceId: string, options: PrepareOptions) {
  const t = translator("prepare");
  const env = options.env ?? process.env;
  const manifests = options.manifests ?? builtinManifests();
  const resolved = resolveToolBindings(projectDir, { manifests, skipInventory: true });
  const instance = resolved.instances.find((i) => i.id === instanceId);
  if (!instance) {
    const available = resolved.instances.map((i) => i.id).join(", ") || "-";
    throw new PrepareError("INSTANCE_NOT_FOUND", t("prepare_instance_not_found", { name: instanceId }), t("prepare_instance_not_found_fix", { available }));
  }
  const manifest = manifests.find((m) => m.id === instance.adapter);
  const kind = manifest ? preparationKindOf(manifest.id) : null;
  if (!manifest || kind === null) {
    throw new PrepareError("PREPARE_NOT_SUPPORTED", t("prepare_not_supported", { name: instanceId, adapter: instance.adapter }), t("prepare_not_supported_fix"));
  }
  return { env, manifests, instance, manifest, kind, t };
}

/** Versions and network, before anything runs. Changes nothing. */
export function previewPrepare(projectDir: string, instanceId: string, options: PrepareOptions = {}): PreparePreview {
  const { env, manifests, manifest, kind } = locate(projectDir, instanceId, options);
  const diagnosis = diagnoseEnvironment(projectDir, { env, manifests });
  const status = diagnosis.tools.find((x) => x.instance === instanceId) as ToolStatus;
  const url = semgrepRulesUrl(env);
  const home = resolveHome({ env });
  return {
    schemaVersion: 1,
    instance: instanceId,
    adapter: manifest.id,
    kind,
    versions: { tool: manifest.toolName, installed: status.version, range: manifest.toolVersionRange, pinned: status.lock.pinned, state: status.state },
    rules: { ref: SEMGREP_RULES_REF, url, state: status.preparation.state, hash: status.preparation.hash },
    network: { required: true, hosts: [hostOf(url)], url },
    writes: [LOCK_FILE, toolsDir(home)],
  };
}

function checkRulesText(text: string): void {
  const t = translator("prepare");
  let doc: unknown;
  try {
    doc = parseYaml(text, { schema: "core" });
  } catch (error) {
    throw new PrepareError("RULES_INVALID", t("prepare_rules_invalid", { detail: (error as Error).message.split("\n")[0] ?? "" }));
  }
  const rules = doc && typeof doc === "object" ? (doc as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(rules) || rules.length === 0 || !rules.every((r) => r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string")) {
    throw new PrepareError("RULES_INVALID", t("prepare_rules_invalid", { detail: "rules" }));
  }
}

/** Downloads, stores and pins. The only function in the product that touches the network. */
export async function prepareInstance(projectDir: string, instanceId: string, options: PrepareOptions = {}): Promise<PrepareResult> {
  const located = locate(projectDir, instanceId, options);
  const { env, manifest, t } = located;
  const lockRead = readLock(projectDir);
  if (lockRead.problem) throw new PrepareError("LOCK_INVALID", t("prepare_lock_invalid", { file: LOCK_FILE, detail: lockRead.problem }), t("prepare_lock_invalid_fix", { file: LOCK_FILE }));
  const probe = probeSemgrep(env);
  const previous = lockRead.lock.tools[instanceId] ?? null;
  // No silent downgrade: a tool older than the pinned one needs an explicit decision.
  const installed = parseVersion(probe.version);
  const pinned = parseVersion(previous?.toolVersion ?? null);
  if (installed && pinned && compareVersions(installed, pinned) < 0 && !options.allowVersionChange) {
    throw new PrepareError("VERSION_DOWNGRADE", t("prepare_downgrade", { tool: manifest.toolName, found: probe.version ?? "?", pinned: previous?.toolVersion ?? "?", file: LOCK_FILE }), t("prepare_downgrade_fix"));
  }
  const url = semgrepRulesUrl(env);
  let bytes: Buffer;
  try {
    bytes = await download(url);
  } catch (error) {
    if (error instanceof DownloadError) {
      throw new PrepareError(error.code, t(`prepare_download_${error.code.toLowerCase()}`, { url, detail: error.message }), t("prepare_download_fix"));
    }
    throw error;
  }
  checkRulesText(bytes.toString("utf8"));
  const home = ensureHome(resolveHome({ env }));
  const rules = storeRules(home, SEMGREP_RULES_REF, url, bytes);
  const previousHash = preparedRulesOf(lockRead.lock, instanceId, home).entry?.hash ?? null;
  const others = (previous?.rules ?? []).filter((r) => r.ref !== SEMGREP_RULES_REF);
  lockRead.lock.tools[instanceId] = {
    adapter: manifest.id,
    adapterVersion: manifest.adapterVersion,
    toolVersion: probe.version,
    preparedAt: new Date().toISOString(),
    rules: [...others, rules],
  };
  writeLock(projectDir, lockRead.lock);
  return { schemaVersion: 1, instance: instanceId, adapter: manifest.id, kind: "rules", rules, previousHash, changed: previousHash !== rules.hash, toolVersion: probe.version, lockFile: LOCK_FILE };
}
