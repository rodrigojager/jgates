import type { AdapterManifest } from "../core/catalog/index.js";
import { qualityBridgeManifest } from "./quality-bridge/manifest.js";
import { ruffManifest } from "./ruff/manifest.js";
import { builtinPiiManifest } from "./builtin-pii/manifest.js";
import { eslintManifest } from "./eslint/manifest.js";
import { vitestManifest } from "./vitest/manifest.js";
import { semgrepManifest } from "./semgrep/manifest.js";
import { pytestManifest } from "./pytest/manifest.js";
import { genericCommandManifest } from "./generic-command/manifest.js";
import { dependencyCruiserManifest } from "./dependency-cruiser/manifest.js";
import { importLinterManifest } from "./import-linter/manifest.js";
import { gitleaksManifest } from "./gitleaks/manifest.js";
import { trivyManifest } from "./trivy/manifest.js";
import { osvScannerManifest } from "./osv-scanner/manifest.js";
import { checkovManifest } from "./checkov/manifest.js";
import { jscpdManifest } from "./jscpd/manifest.js";

/**
 * Manifests of the built-in adapters, in one place that only imports manifests (no adapter code, no cycles), so the
 * catalog (`jgates tools list`) and the support level (`supportLevelFor`) read the same registered set.
 * ESLint, Vitest and jscpd run directly in local mode; the editable-file level of the first two (manifest and
 * binding) is unchanged.
 */
export function builtinManifests(): AdapterManifest[] {
  return [qualityBridgeManifest, ruffManifest, builtinPiiManifest, eslintManifest, vitestManifest, semgrepManifest, pytestManifest, genericCommandManifest, dependencyCruiserManifest, importLinterManifest, gitleaksManifest, trivyManifest, osvScannerManifest, checkovManifest, jscpdManifest];
}
