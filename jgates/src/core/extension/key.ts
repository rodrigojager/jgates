// The key of an extension image: a hash of the Dockerfile, of every file next to it (the build context is limited to
// `.jgates/image/`, so those are all the files a Dockerfile can copy) and of the digest of the tools image it is built on.
// A changed key means the built image is out of date (EXTENSION_OUTDATED); the same key gives the same tag.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The folder of the extension image, relative to the project. */
export const EXTENSION_DIR = ".jgates/image";
export const EXTENSION_DOCKERFILE = "Dockerfile";
/** The build argument the Dockerfile's FROM line reads; JGates fills it with the tools image. */
export const BASE_ARG = "JGATES_TOOLS";
/** Label of an extension image that holds its key, and the one that holds the tools image it was built on. */
export const LABEL_EXTENSION_KEY = "org.jgates.extension.key";
export const LABEL_EXTENSION_BASE = "org.jgates.extension.base";

const sha = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");

export interface ContextFile {
  /** Path relative to the extension folder, with forward slashes. */
  path: string;
  sha256: string;
}

/** Every file of the build context, sorted; a symbolic link counts by its target text (it is never followed). */
export function contextFiles(extensionDir: string): ContextFile[] {
  const out: ContextFile[] = [];
  const walk = (folder: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        let target = "";
        try {
          target = fs.readlinkSync(abs);
        } catch {
          // an unreadable link still counts, by its name
        }
        out.push({ path: rel, sha256: sha(`link:${target}`) });
      } else if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push({ path: rel, sha256: sha(fs.readFileSync(abs)) });
    }
  };
  walk(extensionDir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Absolute folder and Dockerfile of a project's extension image. */
export function extensionPaths(projectDir: string): { dir: string; dockerfile: string } {
  const dir = path.join(path.resolve(projectDir), ...EXTENSION_DIR.split("/"));
  return { dir, dockerfile: path.join(dir, EXTENSION_DOCKERFILE) };
}

/** Whether the project has an extension image to build. */
export function hasExtension(projectDir: string): boolean {
  try {
    return fs.statSync(extensionPaths(projectDir).dockerfile).isFile();
  } catch {
    return false;
  }
}

/** The key: files of the context plus the digest of the tools image. Null when there is no Dockerfile. */
export function extensionKey(projectDir: string, baseDigest: string): string | null {
  if (!hasExtension(projectDir)) return null;
  return sha(JSON.stringify({ files: contextFiles(extensionPaths(projectDir).dir), base: baseDigest }));
}

/** `jgates-ext-<ws>:<first 16 hex of the key>`: fixed per workspace and key, never one tag per attempt. */
export function extensionTag(workspace: string, key: string): string {
  return `jgates-ext-${workspace.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}:${key.slice(0, 16)}`;
}

/** The repository part of the tag (all the tags of one workspace share it). */
export function extensionRepository(workspace: string): string {
  return extensionTag(workspace, "0".repeat(16)).split(":")[0] as string;
}
