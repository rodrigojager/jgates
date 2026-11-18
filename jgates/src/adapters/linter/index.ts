// The linter engine (ADR-0021): a simple linter is one descriptor (src/builtin/linters/<id>/linter.json), and the
// engine makes everything else of it: the adapter (plan and run), its manifest, its entries in the registries and the
// hand-kept tables (trust, suppressions, evidence, the bridge's superseded list) and one implicit template per group.
// See descriptor.ts (the scan), census.ts (which files activate a tool), readers.ts (how an output is read),
// adapter.ts (plan and run) and derived.ts (the tables).
import type { AdapterManifest } from "../../core/catalog/index.js";
import type { ExternalAdapter } from "../../core/plan/adapters.js";
import { makeLinterAdapter } from "./adapter.js";
import { loadLinters, type LoadedLinter } from "./descriptor.js";
import { linterManifest } from "./manifest.js";

export { LinterDescriptorError, builtinLintersDir, linterById, linterOverrideEnv, linterTexts, linterTemplateId, linterGroupKey, loadLinters, type LinterDescriptor, type LoadedLinter } from "./descriptor.js";
export { activatedFiles, censusHasEvidence, fileCensus, requiredFilePresent, type FileCensus } from "./census.js";
export { builtinReader, mapLevel, type RawFinding, type ReadResult, type Reader, type ReaderInput } from "./readers.js";
export { BATCH_CHARS, BATCH_FILES, batches, concludeExit, eachFileScript, linterCalls, makeLinterAdapter, probeLinter, splitEachFile, type LinterCall, type LinterContract } from "./adapter.js";
export { LINTERS_TEST_FILE, linterEvidence, linterGroups, linterSuppressionKind, linterSuppressionKinds, linterSupersedingIds, linterTemplates, linterTestTitle, linterTrust, withDerived } from "./derived.js";
export { linterManifest } from "./manifest.js";

let adapters: { from: readonly LoadedLinter[]; byId: Map<string, ExternalAdapter> } | null = null;

/** One adapter per descriptor, by id (made once per scan). */
export function linterAdapters(): ReadonlyMap<string, ExternalAdapter> {
  const linters = loadLinters();
  if (adapters?.from === linters) return adapters.byId;
  adapters = { from: linters, byId: new Map(linters.map((l) => [l.descriptor.id, makeLinterAdapter(l)])) };
  return adapters.byId;
}

/** The manifests of the descriptor tools, in id order. */
export function linterManifests(): AdapterManifest[] {
  return loadLinters().map(linterManifest);
}
