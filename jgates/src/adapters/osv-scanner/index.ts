// OSV-Scanner adapter: one `osv-scanner scan source --recursive` per tool instance in the container runner. A bound
// osv-scanner.toml goes with --config (and then applies to every lockfile); without one the tool reads the file next
// to each lockfile, and the plan hashes every one it would read. The report records the source of the
// vulnerabilities (the osv.dev API); the API reports no database date.
import fs from "node:fs";
import path from "node:path";
import { CONTAINER_OUTPUT, toContainerPath } from "../../core/runner/index.js";
import type { ExternalAdapter } from "../../core/plan/adapters.js";
import { planScanner, REPORT_FILE, runScanner, type ArgsInput, type ScannerDefinition } from "../container-scanner/index.js";
import { osvScannerManifest } from "./manifest.js";
import { parseOsvReport } from "./normalize.js";

export { osvScannerManifest } from "./manifest.js";
export { parseOsvReport, severityOfScore } from "./normalize.js";

export const OSV_CONFIG_NAME = "osv-scanner.toml";
export const OSV_API = "https://api.osv.dev";
const SKIPPED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "vendor", ".jgates"]);
const MAX_DEPTH = 12;
const MAX_FILES = 200;

/** The osv-scanner.toml files OSV-Scanner reads by itself under the scan root (one per lockfile directory). */
export function nativeOsvConfigs(dir: string, root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, ...rel.split("/").filter((p) => p !== ".")), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory() && !SKIPPED_DIRS.has(e.name)) walk(child, depth + 1);
      else if (e.isFile() && e.name === OSV_CONFIG_NAME) found.push(child);
    }
  };
  walk(root, 0);
  return found;
}

export const osvScanner: ScannerDefinition = {
  manifest: osvScannerManifest,
  label: "osv_label",
  capabilities: ["dependencies"],
  documents: [{ binding: "config", native: [] }],
  nativeFiles(dir: string, input: ArgsInput) {
    return input.documents.config?.source === "binding" ? [] : nativeOsvConfigs(dir, input.root);
  },
  args(input) {
    const config = input.documents.config?.file ?? null;
    return [
      "scan",
      "source",
      "--recursive",
      "--allow-no-lockfiles",
      "--format",
      "json",
      "--output-file",
      `${CONTAINER_OUTPUT}/${REPORT_FILE}`,
      ...(config ? ["--config", toContainerPath(config)] : []),
      ".",
    ];
  },
  exitCodes: [0, 1],
  network: true,
  conditions(input, t) {
    return [input.documents.config?.source === "binding" ? t("osv_condition_config_flag") : t("osv_condition_per_directory"), t("osv_condition_online")];
  },
  limitations(_input, t) {
    return [t("osv_limitation_no_date")];
  },
  parse: parseOsvReport,
  // The API does not report the date of its data: only the source is recorded.
  facts: () => ({ database: { source: OSV_API, updatedAt: null, reported: false, networkRequired: true } }),
};

export const osvScannerAdapter: ExternalAdapter = {
  manifest: osvScannerManifest,
  plan: (input) => planScanner(osvScanner, input),
  run: (context, plan, tool) => runScanner(osvScanner, context, plan, tool),
};
