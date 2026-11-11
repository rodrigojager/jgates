// Carries a cleanup plan out, one object at a time, and reports every removal with the space it freed. Engine objects are
// removed by the id the label selection gave (the plan only holds labelled objects); the engine itself refuses to remove
// what is in use, and that refusal is reported as "in use" too, never as a failure.
import fs from "node:fs";
import path from "node:path";
import { applyRetention } from "../artifacts/index.js";
import { engineCommand, type EngineContext } from "../engine/index.js";
import { applyPiiFixRetention } from "../pii-fix/index.js";
import type { CleanItem, CleanupPlan, UnmanagedImage } from "./plan.js";
import { totalsOf } from "./plan.js";

export interface AppliedLine {
  item: CleanItem;
  outcome: "removed" | "in-use" | "failed";
  /** Bytes the removal freed (an image: its own layers). */
  freedBytes: number;
  /** Raw engine text of a failure. */
  details?: string;
}

export interface CleanupApplied {
  lines: AppliedLine[];
  removed: number;
  inUse: number;
  failed: number;
  freedBytes: number;
}

const ENGINE_REMOVE: Record<string, string[]> = {
  container: ["container", "rm", "--force"],
  network: ["network", "rm"],
  volume: ["volume", "rm"],
  image: ["image", "rm"],
};
const IN_USE_TEXT = /in use|being used|is used|conflict|active endpoints|has active/i;
const ORDER: Record<string, number> = { container: 0, network: 1, volume: 2, image: 3, run: 4, "pii-backup": 5, folder: 6 };

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Removes what the plan marks `remove`, in an order the engine accepts (extension images before the image they are built from). */
export async function applyCleanup(plan: CleanupPlan, home: string, context: EngineContext, onLine?: (line: AppliedLine) => void): Promise<CleanupApplied> {
  const lines: AppliedLine[] = [];
  const emit = (line: AppliedLine): void => {
    lines.push(line);
    onLine?.(line);
  };
  const todo = plan.items
    .filter((i) => i.action === "remove")
    .sort((a, b) => (ORDER[a.resource] ?? 9) - (ORDER[b.resource] ?? 9) || Number(b.kind === "extension-image") - Number(a.kind === "extension-image"));

  for (const item of todo) {
    if (item.resource in ENGINE_REMOVE) {
      const result = await engineCommand([...(ENGINE_REMOVE[item.resource] as string[]), item.id], context, 120_000).catch((e: unknown) => ({ exitCode: 1, spawnError: { code: "SPAWN", message: String(e) }, stderr: String(e), stdout: "" }));
      if (result.exitCode === 0 && !result.spawnError) emit({ item, outcome: "removed", freedBytes: item.resource === "image" ? item.uniqueBytes : item.sizeBytes });
      else {
        const text = (result.stderr || result.stdout || result.spawnError?.message || "").trim();
        emit({ item, outcome: IN_USE_TEXT.test(text) ? "in-use" : "failed", freedBytes: 0, details: text });
      }
    } else if (item.resource === "run") {
      const run = plan.retention?.runs.find((r) => r.dir === item.id);
      if (!run || !plan.retention) continue;
      const done = applyRetention(home, { ...plan.retention, runs: [run], missingWorkspaces: [], freedBytes: run.bytes });
      emit(done.removedRuns.length > 0 ? { item, outcome: "removed", freedBytes: run.bytes } : { item, outcome: "failed", freedBytes: 0, details: done.skipped.map((s) => `${s.path}: ${s.reason}`).join("; ") });
    } else if (item.resource === "pii-backup") {
      const backup = plan.piiBackups.find((b) => b.dir === item.id);
      if (!backup) continue;
      const done = applyPiiFixRetention(home, [backup]);
      emit(done.removed.length > 0 ? { item, outcome: "removed", freedBytes: backup.bytes } : { item, outcome: "failed", freedBytes: 0 });
    } else if (item.resource === "folder") {
      // Only the old tools folder inside the data folder, never through a link.
      const target = item.id;
      try {
        if (fs.lstatSync(target).isSymbolicLink() || !inside(path.resolve(home), path.resolve(target))) throw new Error("outside the data folder");
        fs.rmSync(target, { recursive: true, force: true });
        emit({ item, outcome: "removed", freedBytes: item.sizeBytes });
      } catch (error) {
        emit({ item, outcome: "failed", freedBytes: 0, details: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  // The plan also removes the workspaces whose folder is gone and that keep no marked run (gc did that too).
  if (plan.retention && plan.mode === "clean") {
    const missing = plan.retention.missingWorkspaces.filter((w) => w.removable);
    if (missing.length > 0) applyRetention(home, { ...plan.retention, runs: [], missingWorkspaces: missing, freedBytes: 0 });
  }

  const removedImages = lines.filter((l) => l.outcome === "removed" && l.item.resource === "image").map((l) => l.item);
  // The layers the removed images shared are freed only when no image that may share them stays.
  const imageStays = plan.items.some((i) => i.resource === "image" && i.action === "skip") || lines.some((l) => l.item.resource === "image" && l.outcome !== "removed");
  const shared = imageStays ? 0 : totalsOf(removedImages.map((i) => ({ ...i, action: "remove" as const }))).images.sharedBytes;
  const freedBytes = lines.filter((l) => l.outcome === "removed").reduce((n, l) => n + l.freedBytes, 0) + shared;
  return {
    lines,
    removed: lines.filter((l) => l.outcome === "removed").length,
    inUse: lines.filter((l) => l.outcome === "in-use").length,
    failed: lines.filter((l) => l.outcome === "failed").length,
    freedBytes,
  };
}

/** Removes the legacy sidecar images the person asked to remove (the only unlabelled images JGates ever touches, by id). */
export async function removeLegacySidecar(images: readonly UnmanagedImage[], context: EngineContext): Promise<Array<{ image: UnmanagedImage; removed: boolean; details: string }>> {
  const out: Array<{ image: UnmanagedImage; removed: boolean; details: string }> = [];
  for (const image of images) {
    const result = await engineCommand(["image", "rm", image.id], context, 120_000);
    out.push({ image, removed: result.exitCode === 0, details: (result.stderr || result.stdout).trim() });
  }
  return out;
}
