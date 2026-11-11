// Disk use of the engine's objects, read once from `system df -v`: sizes of the volumes and, for each image, the part of it
// that only it holds (unique) and the part it shares with other images. Shared layers are counted once.
import { engineCommand, parseEngineSize, type EngineContext } from "../engine/index.js";

export interface DiskImage {
  /** Full image id (sha256:...). */
  id: string;
  /** repository:tag, or the repository alone for an untagged image. */
  name: string;
  /** Size of the whole image, shared layers included. */
  sizeBytes: number;
  /** Layers the image has in common with other local images. */
  sharedBytes: number;
  /** Layers only this image holds. */
  uniqueBytes: number;
  /** Containers (in any state) created from the image. */
  containers: number;
}

export interface DiskVolume {
  name: string;
  sizeBytes: number;
}

export interface EngineDisk {
  images: DiskImage[];
  volumes: DiskVolume[];
}

interface DfDocument {
  Images?: Array<Record<string, string>>;
  Volumes?: Array<Record<string, string>>;
}

/** Sizes of every image and volume of the engine (the caller keeps only the JGates labelled ones); null when the engine does not answer. */
export async function readEngineDisk(context: EngineContext): Promise<EngineDisk | null> {
  const result = await engineCommand(["system", "df", "-v", "--format", "{{json .}}"], context, 120_000).catch(() => null);
  if (!result || result.spawnError || result.exitCode !== 0) return null;
  let doc: DfDocument;
  try {
    doc = JSON.parse(result.stdout.trim().split(/\r?\n/).find((l) => l.trim().startsWith("{")) ?? "{}") as DfDocument;
  } catch {
    return null;
  }
  const images = (doc.Images ?? []).map((row) => {
    const sizeBytes = parseEngineSize(row.Size);
    const sharedBytes = Math.min(parseEngineSize(row.SharedSize), sizeBytes);
    const uniqueBytes = row.UniqueSize && row.UniqueSize !== "N/A" ? parseEngineSize(row.UniqueSize) : Math.max(0, sizeBytes - sharedBytes);
    const repository = row.Repository ?? "";
    const tag = row.Tag ?? "";
    return {
      id: row.ID ?? "",
      name: repository && tag && tag !== "<none>" ? `${repository}:${tag}` : repository,
      sizeBytes,
      sharedBytes,
      uniqueBytes,
      containers: Number(row.Containers ?? 0) || 0,
    };
  });
  const volumes = (doc.Volumes ?? []).map((row) => ({ name: row.Name ?? "", sizeBytes: parseEngineSize(row.Size) }));
  return { images, volumes };
}

export interface LayerAccounting {
  /** Layers only one image holds, added up. */
  uniqueBytes: number;
  /** Layers held by several of the images, counted once (the largest shared part among them: the common base). */
  sharedBytes: number;
  /** What the images occupy together; the plain sum of their sizes would count the shared layers once per image. */
  totalBytes: number;
  /** The plain sum of the image sizes, to show how much counting twice would have inflated it. */
  sumBytes: number;
}

/**
 * What a set of images occupies on the disk with shared layers counted once: the unique part of each image plus the shared
 * part one time. The extension images are built FROM the tools image, so the shared layers are that common base.
 */
export function accountLayers(images: ReadonlyArray<Pick<DiskImage, "sizeBytes" | "sharedBytes" | "uniqueBytes">>): LayerAccounting {
  const uniqueBytes = images.reduce((n, i) => n + i.uniqueBytes, 0);
  const sharedBytes = images.reduce((n, i) => Math.max(n, i.sharedBytes), 0);
  return { uniqueBytes, sharedBytes, totalBytes: uniqueBytes + sharedBytes, sumBytes: images.reduce((n, i) => n + i.sizeBytes, 0) };
}
