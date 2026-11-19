import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The versions gate of the tools image (PLAN-image.md section 5, gate 1): every tool the image ships has a version that
// the toolVersionRange of its adapter accepts, and the Dockerfile pins are what the image records in image.json.
// Reads the built adapter manifests (dist/adapters/*/manifest.js, and the linter descriptors' through the engine), the
// pins of the assembled Dockerfile and the install entries, and the image.json kept in release/image-tools.json,
// which `npm run image:build` rewrites from the image it just built.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const gates = await import(pathToFileURL(path.join(root, "scripts", "image-gates.mjs")).href);
const { manifests, satisfiesRange } = await gates.loadManifests(path.join(root, "dist"));
const imageJson = JSON.parse(fs.readFileSync(path.join(root, "release", "image-tools.json"), "utf8"));
// The toolchains' build arguments of the assembled Dockerfile and the pins of the install entries (PLAN-image.md section 3).
const pins = gates.imagePins();

test("every shipped version is inside the toolVersionRange of its adapter", () => {
  assert.ok(manifests.length >= 20, `read ${manifests.length} adapter manifests`);
  const result = gates.checkVersions({ imageJson, manifests, satisfiesRange, pins });
  assert.deepEqual(result.findings, [], result.findings.map((f) => f.message).join("\n"));
  assert.equal(result.passed, true);
  const covered = manifests.filter((m) => m.toolName in imageJson.tools).map((m) => m.toolName);
  for (const tool of ["ruff", "pytest", "semgrep", "gitleaks", "trivy", "eslint", "stryker", "zap", "oasdiff"]) assert.ok(covered.includes(tool), `${tool} is checked against its adapter`);
});

test("a version outside an adapter's range fails with the tool, the version and the range", () => {
  const tooOld = structuredClone(imageJson);
  tooOld.tools.gitleaks = "8.18.0";
  const result = gates.checkVersions({ imageJson: tooOld, manifests, satisfiesRange, pins: {} });
  assert.equal(result.passed, false);
  const finding = result.findings.find((f) => f.tool === "gitleaks");
  assert.equal(finding.kind, "outside-range");
  assert.equal(finding.version, "8.18.0");
  assert.match(finding.range, /8\.19\.0/);
  const tooNew = structuredClone(imageJson);
  tooNew.tools.trivy = "1.0.0";
  assert.ok(gates.checkVersions({ imageJson: tooNew, manifests, satisfiesRange, pins: {} }).findings.some((f) => f.tool === "trivy" && f.kind === "outside-range"));
});

test("an adapter whose tool is not in the image fails unless it is one of the documented non-image tools", () => {
  const without = structuredClone(imageJson);
  delete without.tools.zizmor;
  const result = gates.checkVersions({ imageJson: without, manifests, satisfiesRange, pins: {} });
  assert.ok(result.findings.some((f) => f.kind === "tool-missing" && f.tool === "zizmor"));
  for (const name of Object.keys(gates.NOT_IN_IMAGE)) assert.ok(!(name in imageJson.tools), `${name} is documented as not in the image and really is not`);
});

test("a Dockerfile pin that differs from the image fails", () => {
  const drift = gates.checkVersions({ imageJson, manifests, satisfiesRange, pins: { ...pins, ruff: "0.0.1" } });
  assert.ok(drift.findings.some((f) => f.kind === "pin-differs" && f.tool === "ruff" && f.version === imageJson.tools.ruff));
  assert.ok(Object.keys(pins).length >= 15, `read ${Object.keys(pins).length} pins from the Dockerfile and the install entries`);
});
