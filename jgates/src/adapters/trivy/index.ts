// Trivy adapter: one `trivy fs` per tool instance in the container runner, with the scanners its capabilities ask
// for, the project's trivy.yaml and ignore file as two documents, the cache in the run folder's output mount and the
// vulnerability database recorded (source and date) after the run. The database file itself (over a gigabyte) never
// stays in the run folder: it is kept in the data folder (tools/cache/trivy-db) and reused, hard-linked into the
// output mount with --skip-db-update, while it is fresh; only its metadata stays in the run.
import fs from "node:fs";
import path from "node:path";
import { CONTAINER_OUTPUT, toContainerPath } from "../../core/runner/index.js";
import type { ExternalAdapter } from "../../core/plan/adapters.js";
import { OUTPUT_CACHE, planScanner, REPORT_FILE, runScanner, type DatabaseCacheSpec, type ScannerDefinition } from "../container-scanner/index.js";
import { trivyManifest } from "./manifest.js";
import { parseTrivyReport, trivyFacts } from "./normalize.js";

export { trivyManifest } from "./manifest.js";
export { databaseSource, parseTrivyReport, trivyFacts, TRIVY_DEFAULT_DB, TRIVY_SCHEMA_VERSION } from "./normalize.js";

/** Trivy scanner of each capability. */
export const TRIVY_SCANNERS: Record<string, string> = { dependencies: "vuln", iac: "misconfig", secrets: "secret", licenses: "license" };

/** Everything of the cache folder except the metadata files (the database, the checks bundle, the scan cache). */
function removeCacheContent(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      removeCacheContent(p);
      try {
        fs.rmdirSync(p);
      } catch {
        // keeps a folder that still holds a metadata file
      }
    } else if (e.name !== "metadata.json") fs.rmSync(p, { force: true });
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The vulnerability database (db/trivy.db and db/metadata.json under --cache-dir), shared between runs. */
export const TRIVY_DATABASE: DatabaseCacheSpec = {
  name: "trivy-db",
  dir: "cache/db",
  files: ["trivy.db", "metadata.json"],
  metadata: "metadata.json",
  needed: (capabilities) => capabilities.includes("dependencies"),
  skipArgs: ["--skip-db-update"],
  dates(meta) {
    const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
    return { updatedAt: text(m.UpdatedAt), nextUpdate: text(m.NextUpdate), downloadedAt: text(m.DownloadedAt) };
  },
};

export const trivyScanner: ScannerDefinition = {
  manifest: trivyManifest,
  label: "trivy_label",
  capabilities: Object.keys(TRIVY_SCANNERS),
  documents: [
    { binding: "config", native: ["trivy.yaml"] },
    { binding: "ignore", native: [".trivyignore", ".trivyignore.yaml"] },
  ],
  args(input) {
    const config = input.documents.config?.file ?? null;
    const ignore = input.documents.ignore?.file ?? null;
    const scanners = input.capabilities.map((c) => TRIVY_SCANNERS[c]).filter((s): s is string => s !== undefined);
    return [
      ...(config ? ["--config", toContainerPath(config)] : []),
      "fs",
      "--scanners",
      scanners.join(","),
      "--format",
      "json",
      "--output",
      `${CONTAINER_OUTPUT}/${REPORT_FILE}`,
      "--exit-code",
      "0",
      "--cache-dir",
      OUTPUT_CACHE,
      "--skip-version-check",
      "--disable-telemetry",
      "--no-progress",
      ...(ignore ? ["--ignorefile", toContainerPath(ignore)] : []),
      ".",
    ];
  },
  exitCodes: [0],
  network: true,
  conditions(input, t) {
    const scanners = input.capabilities.map((c) => TRIVY_SCANNERS[c]).filter(Boolean).join(", ");
    return [t("trivy_condition_scanners", { scanners }), ...(input.capabilities.includes("dependencies") ? [t("trivy_condition_database")] : [])];
  },
  limitations(_input, t) {
    return [t("trivy_limitation_download"), t("trivy_limitation_exceptions")];
  },
  parse: parseTrivyReport,
  facts: (outputDir, stderr) => trivyFacts(path.join(outputDir, "cache"), stderr),
  cleanup: (outputDir) => removeCacheContent(path.join(outputDir, "cache")),
  database: TRIVY_DATABASE,
};

export const trivyAdapter: ExternalAdapter = {
  manifest: trivyManifest,
  plan: (input) => planScanner(trivyScanner, input),
  run: (context, plan, tool) => runScanner(trivyScanner, context, plan, tool),
};
