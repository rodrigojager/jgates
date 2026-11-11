// What `jgates clean` and `jgates uninstall` would remove: the JGates labelled objects of the engine (selected by label,
// never by name), the runs retention of `gc`, and the old <home>/tools/python folder. Objects that are in use (a running
// container or run, the image the CLI pins, an image a container was made from) are listed and skipped as "in use".
// Nothing is removed here: applyCleanup does that with the plan.
import fs from "node:fs";
import path from "node:path";
import { planRetention, type RetentionPlan, type RetentionPolicy } from "../artifacts/index.js";
import {
  LABEL_KIND,
  LABEL_RUN,
  LABEL_VERSION,
  LABEL_WORKSPACE,
  engineCommand,
  engineReachable,
  engineRuntime,
  inspectImage,
  listManaged,
  parseEngineSize,
  type EngineContext,
  type ManagedObject,
  type ManagedScope,
} from "../engine/index.js";
import { readRegistry } from "../home/index.js";
import { planPiiFixRetention, type ExpiredBackup } from "../pii-fix/index.js";
import { readToolsImagePin, toolsImageTarget } from "../tools-image/index.js";
import { accountLayers, readEngineDisk, type DiskImage, type EngineDisk, type LayerAccounting } from "./usage.js";
import { effectiveRetention } from "./retention.js";

export type CleanResource = "container" | "volume" | "image" | "network" | "run" | "pii-backup" | "folder";
export type CleanCategory = "containers" | "networks" | "images" | "extensions" | "data" | "toolchains" | "caches" | "workspace" | "other" | "runs" | "legacy";
/** Why an object is listed for removal. */
export type CleanWhy = "scope" | "stopped" | "other-version" | "dangling" | "orphan-workspace" | "retention" | "legacy-folder" | "uninstall";
/** Why an object is skipped. */
export type InUseCode = "RUNNING_CONTAINER" | "RUNNING_RUN" | "PINNED_IMAGE" | "USED_BY_CONTAINER" | "SHARED_VOLUME_IN_USE";

export interface CleanItem {
  resource: CleanResource;
  /** What the engine acts on (container, network and image id, volume name) or the folder path. */
  id: string;
  name: string;
  category: CleanCategory;
  kind: string | null;
  workspace: string | null;
  run: string | null;
  version: string | null;
  /** Size of the object (an image: the whole image, shared layers included). */
  sizeBytes: number;
  /** Images only: the layers only this image holds. */
  uniqueBytes: number;
  /** Images only: the layers shared with other images. */
  sharedBytes: number;
  action: "remove" | "skip";
  why: CleanWhy;
  /** Set when action is skip. */
  inUse: { code: InUseCode; detail: string } | null;
}

export interface CleanScope {
  images?: boolean;
  data?: boolean;
  toolchains?: boolean;
  caches?: boolean;
  /** Only the objects of this workspace id (volumes, images, stopped containers and networks). */
  workspace?: string;
  /** Objects of workspaces whose folder no longer exists. */
  orphans?: boolean;
  /** Only the runs retention of `gc`. */
  runs?: boolean;
}

export interface UnmanagedImage {
  id: string;
  name: string;
  sizeBytes: number;
}

export interface CleanupInput {
  env?: NodeJS.ProcessEnv;
  /** The JGates version of this CLI (images of another version are removable). */
  version: string;
  home: string;
  mode: "clean" | "uninstall";
  scope?: CleanScope;
  /** Uninstall: limits the engine objects to one workspace's (the shared volumes and images are then left alone). */
  onlyWorkspace?: string;
  retention?: RetentionPolicy;
}

export interface CleanupPlan {
  mode: "clean" | "uninstall";
  engine: { state: "ready" | "unavailable"; details: string | null };
  items: CleanItem[];
  /** Images without the JGates labels that look like JGates's (the legacy sidecar): listed, never selected. */
  unmanaged: UnmanagedImage[];
  retention: RetentionPlan | null;
  piiBackups: ExpiredBackup[];
  /** <home>/tools/python, when it exists. */
  legacyTools: { path: string; sizeBytes: number } | null;
  totals: {
    remove: number;
    skipped: number;
    removeBytes: number;
    skippedBytes: number;
    /** The images that would be removed, shared layers counted once. */
    images: LayerAccounting;
  };
}

const RUNNING = new Set(["running", "restarting", "paused"]);
const LEGACY_SIDECAR = "jgates/quality-sidecar";

function dirBytesOf(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.lstatSync(full).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(dir);
  return total;
}
export { dirBytesOf as folderBytes };

/** Workspace ids whose project folder is gone (or that were relinked to another path): their engine objects serve no one. */
export function orphanWorkspaces(home: string): Set<string> {
  const out = new Set<string>();
  for (const w of readRegistry(home).workspaces) if (w.relinkedTo || !fs.existsSync(w.path)) out.add(w.id);
  return out;
}

export function engineContextFor(env: NodeJS.ProcessEnv): EngineContext {
  return { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
}

function volumeCategory(labels: Record<string, string>): CleanCategory {
  if (labels[LABEL_WORKSPACE]) return "workspace";
  const kind = labels[LABEL_KIND];
  if (kind === "data") return "data";
  if (kind === "toolchain") return "toolchains";
  if (kind === "deps") return "caches";
  return "other";
}

/** The unlabelled images of the legacy sidecar (by repository name; nothing else is looked at). */
export async function listLegacySidecar(context: EngineContext): Promise<UnmanagedImage[]> {
  const result = await engineCommand(["image", "ls", "--no-trunc", "--filter", `reference=${LEGACY_SIDECAR}`, "--format", "{{json .}}"], context).catch(() => null);
  if (!result || result.exitCode !== 0) return [];
  const rows = result.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, string>);
  return rows
    .filter((r) => r.Repository === LEGACY_SIDECAR)
    .map((r) => ({ id: r.ID ?? "", name: `${r.Repository}:${r.Tag ?? "latest"}`, sizeBytes: parseEngineSize(r.Size) }));
}

interface Candidates {
  containers: ManagedObject[];
  volumes: ManagedObject[];
  images: ManagedObject[];
  networks: ManagedObject[];
}

/** Builds the plan. A missing or stopped engine is an `unavailable` engine with no engine objects, never an error. */
export async function planCleanup(input: CleanupInput): Promise<CleanupPlan> {
  const env = input.env ?? process.env;
  const scope = input.scope ?? {};
  const uninstall = input.mode === "uninstall";
  const none = !(scope.images || scope.data || scope.toolchains || scope.caches || scope.workspace || scope.orphans || scope.runs);
  const context = engineContextFor(env);
  const items: CleanItem[] = [];
  let unmanaged: UnmanagedImage[] = [];
  let engine: CleanupPlan["engine"] = { state: "unavailable", details: null };

  const onlyRuns = !uninstall && scope.runs === true && !(scope.images || scope.data || scope.toolchains || scope.caches || scope.workspace || scope.orphans);
  if (!onlyRuns && (await engineReachable(context))) {
    const base: ManagedScope = input.onlyWorkspace ? { workspace: input.onlyWorkspace } : {};
    let candidates: Candidates | null = null;
    try {
      candidates = {
        containers: await listManaged("container", base, context),
        volumes: await listManaged("volume", base, context),
        images: await listManaged("image", base, context),
        networks: await listManaged("network", base, context),
      };
      engine = { state: "ready", details: null };
    } catch (error) {
      engine = { state: "unavailable", details: error instanceof Error ? `${error.message}: ${(error as { details?: string }).details ?? ""}`.trim() : String(error) };
    }
    if (candidates) {
      const disk: EngineDisk = (await readEngineDisk(context)) ?? { images: [], volumes: [] };
      const orphans = orphanWorkspaces(input.home);
      const running = candidates.containers.filter((c) => RUNNING.has(c.state ?? ""));
      const runningWorkspaces = new Set(running.map((c) => c.labels[LABEL_WORKSPACE]).filter((v): v is string => Boolean(v)));
      const runningRuns = new Set(running.map((c) => c.labels[LABEL_RUN]).filter((v): v is string => Boolean(v)));
      const pinned = await inspectImage(toolsImageTarget(env, readToolsImagePin()).reference, context).catch(() => null);
      const diskImage = (id: string): DiskImage | undefined => disk.images.find((i) => i.id === id);
      const wsMatches = (ws: string | null): boolean => scope.workspace !== undefined && ws === scope.workspace;
      const orphanSelected = (ws: string | null): boolean => (none || scope.orphans === true) && ws !== null && orphans.has(ws);

      // Containers.
      for (const c of candidates.containers) {
        const ws = c.labels[LABEL_WORKSPACE] ?? null;
        const stoppedSelected = uninstall || none || (scope.orphans === true && orphanSelected(ws)) || wsMatches(ws);
        if (!stoppedSelected) continue;
        const isRunning = RUNNING.has(c.state ?? "");
        items.push({
          resource: "container", id: c.id, name: c.name, category: "containers", kind: c.labels[LABEL_KIND] ?? null, workspace: ws, run: c.labels[LABEL_RUN] ?? null, version: c.labels[LABEL_VERSION] ?? null,
          sizeBytes: 0, uniqueBytes: 0, sharedBytes: 0, action: isRunning ? "skip" : "remove", why: uninstall ? "uninstall" : "stopped",
          inUse: isRunning ? { code: c.labels[LABEL_RUN] ? "RUNNING_RUN" : "RUNNING_CONTAINER", detail: c.labels[LABEL_RUN] ?? c.name } : null,
        });
      }

      // Networks: in use while a container of the same run (or workspace) runs.
      for (const n of candidates.networks) {
        const ws = n.labels[LABEL_WORKSPACE] ?? null;
        const runLabel = n.labels[LABEL_RUN] ?? null;
        if (!(uninstall || none || (scope.orphans === true && orphanSelected(ws)) || wsMatches(ws))) continue;
        const busy = runLabel ? runningRuns.has(runLabel) : ws !== null && runningWorkspaces.has(ws);
        items.push({
          resource: "network", id: n.id, name: n.name, category: "networks", kind: n.labels[LABEL_KIND] ?? null, workspace: ws, run: runLabel, version: n.labels[LABEL_VERSION] ?? null,
          sizeBytes: 0, uniqueBytes: 0, sharedBytes: 0, action: busy ? "skip" : "remove", why: uninstall ? "uninstall" : "stopped",
          inUse: busy ? { code: "RUNNING_RUN", detail: runLabel ?? ws ?? "" } : null,
        });
      }

      // Volumes.
      for (const v of candidates.volumes) {
        const category = volumeCategory(v.labels);
        const ws = v.labels[LABEL_WORKSPACE] ?? null;
        let selected = uninstall;
        let why: CleanWhy = uninstall ? "uninstall" : "scope";
        if (!uninstall) {
          if (category === "data") selected = scope.data === true;
          else if (category === "toolchains") selected = scope.toolchains === true;
          else if (category === "caches") selected = scope.caches === true;
          else if (category === "workspace") {
            selected = wsMatches(ws) || orphanSelected(ws);
            why = wsMatches(ws) ? "scope" : "orphan-workspace";
          }
        }
        if (!selected) continue;
        // A workspace volume is in use while a container of that workspace runs; a shared one while any JGates container runs.
        const busy = category === "workspace" ? ws !== null && runningWorkspaces.has(ws) : running.length > 0;
        const holder = category === "workspace" ? running.find((c) => c.labels[LABEL_WORKSPACE] === ws) : running[0];
        items.push({
          resource: "volume", id: v.id, name: v.name, category, kind: v.labels[LABEL_KIND] ?? null, workspace: ws, run: v.labels[LABEL_RUN] ?? null, version: v.labels[LABEL_VERSION] ?? null,
          sizeBytes: disk.volumes.find((d) => d.name === v.name)?.sizeBytes ?? 0, uniqueBytes: 0, sharedBytes: 0, action: busy ? "skip" : "remove", why,
          inUse: busy ? { code: category === "workspace" ? "RUNNING_RUN" : "SHARED_VOLUME_IN_USE", detail: holder?.labels[LABEL_RUN] ?? holder?.name ?? "" } : null,
        });
      }

      // Images: labels and names come from the image itself (the list does not carry labels on every engine).
      for (const img of candidates.images) {
        const facts = await inspectImage(img.id, context).catch(() => null);
        const labels = { ...img.labels, ...(facts?.labels ?? {}) };
        const fromDisk = diskImage(img.id);
        const name = fromDisk?.name || img.name;
        const kind = labels[LABEL_KIND] ?? null;
        const ws = labels[LABEL_WORKSPACE] ?? null;
        const version = labels[LABEL_VERSION] ?? null;
        const dangling = name === "" || name === "<none>" || name.endsWith(":<none>");
        const otherVersion = version !== null && version !== input.version;
        let selected = uninstall;
        let why: CleanWhy = uninstall ? "uninstall" : "scope";
        if (!uninstall) {
          if (scope.images) selected = scope.workspace === undefined || wsMatches(ws);
          else if (wsMatches(ws) && kind === "extension-image") selected = true;
          else if (none && (otherVersion || dangling)) {
            selected = true;
            why = dangling ? "dangling" : "other-version";
          } else if ((none || scope.orphans) && ws !== null && orphans.has(ws) && kind === "extension-image") {
            selected = true;
            why = "orphan-workspace";
          }
        }
        if (!selected) continue;
        const isPinned = pinned !== null && pinned.id === img.id;
        // Uninstall removes the containers first; the engine still refuses an image a container of someone else was made from.
        const used = !uninstall && (fromDisk?.containers ?? 0) > 0;
        const code: InUseCode | null = isPinned && !uninstall ? "PINNED_IMAGE" : used ? "USED_BY_CONTAINER" : null;
        items.push({
          resource: "image", id: img.id, name: name || img.id, category: kind === "extension-image" ? "extensions" : "images", kind, workspace: ws, run: null, version,
          sizeBytes: fromDisk?.sizeBytes ?? img.sizeBytes ?? facts?.sizeBytes ?? 0, uniqueBytes: fromDisk?.uniqueBytes ?? img.sizeBytes ?? 0, sharedBytes: fromDisk?.sharedBytes ?? 0,
          action: code ? "skip" : "remove", why, inUse: code ? { code, detail: code === "PINNED_IMAGE" ? toolsImageTarget(env, readToolsImagePin()).reference : name } : null,
        });
      }
      unmanaged = await listLegacySidecar(context);
    }
  }

  // Runs retention (`gc`): the part of clean that is about the data folder.
  let retention: RetentionPlan | null = null;
  let piiBackups: ExpiredBackup[] = [];
  if (!uninstall && (none || scope.runs)) {
    retention = planRetention(input.home, input.retention ?? effectiveRetention(env).policy);
    piiBackups = planPiiFixRetention(input.home);
    for (const r of retention.runs) {
      items.push({ resource: "run", id: r.dir, name: `${r.workspaceId}/${r.runId}`, category: "runs", kind: null, workspace: r.workspaceId, run: r.runId, version: null, sizeBytes: r.bytes, uniqueBytes: r.bytes, sharedBytes: 0, action: "remove", why: "retention", inUse: null });
    }
    for (const b of piiBackups) {
      items.push({ resource: "pii-backup", id: b.dir, name: `${b.workspaceId}/${b.fixId}`, category: "runs", kind: null, workspace: b.workspaceId, run: null, version: null, sizeBytes: b.bytes, uniqueBytes: b.bytes, sharedBytes: 0, action: "remove", why: "retention", inUse: null });
    }
  }

  // The old per-user tools folder T12 replaced (<home>/tools/python): offered by a plain clean and by uninstall.
  let legacyTools: CleanupPlan["legacyTools"] = null;
  const legacyDir = path.join(input.home, "tools", "python");
  if ((none || uninstall) && !input.onlyWorkspace && fs.existsSync(legacyDir)) {
    legacyTools = { path: legacyDir, sizeBytes: dirBytesOf(legacyDir) };
    items.push({ resource: "folder", id: legacyDir, name: legacyDir, category: "legacy", kind: null, workspace: null, run: null, version: null, sizeBytes: legacyTools.sizeBytes, uniqueBytes: legacyTools.sizeBytes, sharedBytes: 0, action: "remove", why: "legacy-folder", inUse: null });
  }

  return { mode: input.mode, engine, items, unmanaged, retention, piiBackups, legacyTools, totals: totalsOf(items) };
}

export function totalsOf(items: readonly CleanItem[]): CleanupPlan["totals"] {
  const removing = items.filter((i) => i.action === "remove");
  const skipped = items.filter((i) => i.action === "skip");
  const images = accountLayers(removing.filter((i) => i.resource === "image"));
  const others = (list: readonly CleanItem[]): number => list.filter((i) => i.resource !== "image").reduce((n, i) => n + i.sizeBytes, 0);
  return {
    remove: removing.length,
    skipped: skipped.length,
    removeBytes: others(removing) + images.totalBytes,
    skippedBytes: others(skipped) + skipped.filter((i) => i.resource === "image").reduce((n, i) => n + i.sizeBytes, 0),
    images,
  };
}
