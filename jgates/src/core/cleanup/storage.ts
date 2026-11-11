// Disk accounting by category for the Storage screen: the tools image by version, the advisory data, the toolchains, the
// caches, the extension images and each workspace's volumes. Every size comes from the engine, filtered by the JGates
// labels; shared image layers are counted once in the totals.
import { LABEL_KIND, LABEL_VERSION, LABEL_WORKSPACE, engineReachable, inspectImage, listManaged, type EngineContext } from "../engine/index.js";
import { readToolsImagePin, toolsImageTarget } from "../tools-image/index.js";
import { accountLayers, readEngineDisk, type LayerAccounting } from "./usage.js";

export interface StorageImage {
  name: string;
  id: string;
  sizeBytes: number;
  uniqueBytes: number;
  sharedBytes: number;
  /** The image this CLI uses. */
  pinned: boolean;
  /** Carries org.jgates.managed=true (the development image does not). */
  managed: boolean;
}

export interface StorageVolume {
  name: string;
  sizeBytes: number;
  kind: string | null;
}

export interface StorageReport {
  engine: { state: "ready" | "unavailable" };
  /** The tools images, one entry per JGates version. */
  tools: Array<{ version: string; bytes: number; images: StorageImage[] }>;
  extensions: { bytes: number; images: Array<StorageImage & { workspace: string | null }> };
  data: { bytes: number; volumes: StorageVolume[] };
  toolchains: { bytes: number; volumes: StorageVolume[] };
  caches: { bytes: number; volumes: StorageVolume[] };
  /** Volumes of each workspace (the synchronized copy and the dependencies). */
  workspaces: Array<{ workspace: string; bytes: number; volumes: StorageVolume[] }>;
  other: { bytes: number; volumes: StorageVolume[] };
  /** All the images above together, shared layers counted once. */
  images: LayerAccounting;
  volumesBytes: number;
  totalBytes: number;
}

const EMPTY: StorageReport = {
  engine: { state: "unavailable" },
  tools: [],
  extensions: { bytes: 0, images: [] },
  data: { bytes: 0, volumes: [] },
  toolchains: { bytes: 0, volumes: [] },
  caches: { bytes: 0, volumes: [] },
  workspaces: [],
  other: { bytes: 0, volumes: [] },
  images: { uniqueBytes: 0, sharedBytes: 0, totalBytes: 0, sumBytes: 0 },
  volumesBytes: 0,
  totalBytes: 0,
};

const sum = (list: ReadonlyArray<{ sizeBytes: number }>): number => list.reduce((n, v) => n + v.sizeBytes, 0);

/** Reads the sizes; an engine that does not answer gives the empty report with `engine.state` unavailable. */
export async function storageReport(env: NodeJS.ProcessEnv, context: EngineContext): Promise<StorageReport> {
  if (!(await engineReachable(context))) return EMPTY;
  const disk = await readEngineDisk(context);
  if (!disk) return EMPTY;
  const target = toolsImageTarget(env, readToolsImagePin());
  const pinned = await inspectImage(target.reference, context).catch(() => null);

  const images: Array<StorageImage & { workspace: string | null; kind: string | null; version: string }> = [];
  let managedImages: Awaited<ReturnType<typeof listManaged>> = [];
  try {
    managedImages = await listManaged("image", {}, context);
  } catch {
    managedImages = [];
  }
  const describe = async (id: string, managed: boolean) => {
    const facts = await inspectImage(id, context).catch(() => null);
    const row = disk.images.find((i) => i.id === (facts?.id ?? id));
    if (!row) return;
    if (images.some((i) => i.id === row.id)) return;
    images.push({
      name: row.name || row.id,
      id: row.id,
      sizeBytes: row.sizeBytes,
      uniqueBytes: row.uniqueBytes,
      sharedBytes: row.sharedBytes,
      pinned: pinned !== null && pinned.id === row.id,
      managed,
      workspace: facts?.labels[LABEL_WORKSPACE] ?? null,
      kind: facts?.labels[LABEL_KIND] ?? null,
      version: facts?.labels[LABEL_VERSION] ?? "unknown",
    });
  };
  for (const img of managedImages) await describe(img.id, true);
  // The image this CLI runs is a tools image even when it is a development build without the managed label.
  if (pinned) await describe(pinned.id, false);

  const toolImages = images.filter((i) => i.kind !== "extension-image");
  const versions = [...new Set(toolImages.map((i) => i.version))].sort();
  const volumes = (await listManaged("volume", {}, context).catch(() => [])).map((v) => ({
    name: v.name,
    sizeBytes: disk.volumes.find((d) => d.name === v.name)?.sizeBytes ?? 0,
    kind: v.labels[LABEL_KIND] ?? null,
    workspace: v.labels[LABEL_WORKSPACE] ?? null,
  }));
  const plain = ({ name, sizeBytes, kind }: (typeof volumes)[number]): StorageVolume => ({ name, sizeBytes, kind });
  const shared = volumes.filter((v) => v.workspace === null);
  const byWorkspace = new Map<string, typeof volumes>();
  for (const v of volumes) if (v.workspace) byWorkspace.set(v.workspace, [...(byWorkspace.get(v.workspace) ?? []), v]);
  const pick = (kind: string) => shared.filter((v) => v.kind === kind).map(plain);
  const data = pick("data");
  const toolchains = pick("toolchain");
  const caches = pick("deps");
  const other = shared.filter((v) => !["data", "toolchain", "deps"].includes(v.kind ?? "")).map(plain);
  const extensionImages = images.filter((i) => i.kind === "extension-image");
  const accounting = accountLayers(images);
  const volumesBytes = sum(volumes);

  return {
    engine: { state: "ready" },
    tools: versions.map((version) => {
      const list = toolImages.filter((i) => i.version === version);
      return { version, bytes: accountLayers(list).totalBytes, images: list.map(({ workspace: _w, kind: _k, version: _v, ...rest }) => rest) };
    }),
    extensions: { bytes: accountLayers(extensionImages).uniqueBytes, images: extensionImages.map(({ kind: _k, version: _v, ...rest }) => rest) },
    data: { bytes: sum(data), volumes: data },
    toolchains: { bytes: sum(toolchains), volumes: toolchains },
    caches: { bytes: sum(caches), volumes: caches },
    workspaces: [...byWorkspace.entries()].map(([workspace, list]) => ({ workspace, bytes: sum(list), volumes: list.map(plain) })).sort((a, b) => b.bytes - a.bytes),
    other: { bytes: sum(other), volumes: other },
    images: accounting,
    volumesBytes,
    totalBytes: accounting.totalBytes + volumesBytes,
  };
}
