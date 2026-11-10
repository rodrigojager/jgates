import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-54: the build gates of the tools image. The license gate fails on an SBOM that holds an AGPL component (and on an
// unknown license) and names the component; the size gate fails above the budget and lists the five largest layers;
// the forbidden-content gate finds a planted semgrep rule file and a credential-looking file in an image filesystem
// (the walk runs through the same command the build runs inside the image), and says nothing about a clean one. The
// gates are the module the build uses (jgates/scripts/image-gates.mjs) with the policy the build uses.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(root, "jgates", "scripts", "image-gates.mjs");
const gates = await import(pathToFileURL(SCRIPT).href);
const policy = gates.loadPolicy();

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const pkg = (name, version, license, type = "node-pkg") => ({
  name,
  SPDXID: `SPDXRef-Package-${name.replace(/\W/g, "")}`,
  versionInfo: version,
  licenseConcluded: license,
  licenseDeclared: license,
  annotations: [{ annotator: "Tool: trivy-0.76.2", annotationType: "OTHER", comment: `PkgType: ${type}` }],
});
const sbomOf = (...packages) => ({ spdxVersion: "SPDX-2.3", name: "jgates-tools", packages, hasExtractedLicensingInfos: [] });

test("V2-54: the license gate fails on an SBOM with an AGPL component, names it, and passes the same SBOM without it", () => {
  const clean = sbomOf(pkg("left-pad", "1.3.0", "MIT"), pkg("zlib-dep", "2.0.0", "Zlib"), pkg("semgrep-core", "1.0.0", "LGPL-2.1-only", "python-pkg"), pkg("dual", "1.0.0", "Apache-2.0 OR GPL-3.0-only"));
  const ok = gates.checkLicenses({ sbom: clean, policy });
  assert.equal(ok.passed, true, JSON.stringify(ok.violations));
  assert.equal(ok.components, 4);

  const withAgpl = sbomOf(...clean.packages, pkg("some-server", "3.1.4", "AGPL-3.0-or-later"));
  const bad = gates.checkLicenses({ sbom: withAgpl, policy });
  assert.equal(bad.passed, false);
  assert.equal(bad.violations.length, 1, JSON.stringify(bad.violations));
  assert.equal(bad.violations[0].component, "some-server@3.1.4");
  assert.match(bad.violations[0].reasons.join(" "), /AGPL/);

  // AGPL inside a compound expression is still AGPL; so is a Debian package (the OS rule accepts free-form names, not AGPL).
  const compound = gates.checkLicenses({ sbom: sbomOf(pkg("mixed", "1.0.0", "MIT AND AGPL-3.0-only")), policy });
  assert.equal(compound.passed, false);
  const debian = gates.checkLicenses({ sbom: sbomOf(pkg("libfoo", "1.0", "GPL-2.0-or-later AND AGPL-3.0-only", "debian")), policy });
  assert.equal(debian.passed, false);
  assert.equal(gates.checkLicenses({ sbom: sbomOf(pkg("libfree", "1.0", "GPL-2.0-or-later AND MIT", "debian")), policy }).passed, true);
});

test("V2-54: the license gate fails on an unknown license, on no license, and on GPL outside the listed tools", () => {
  const unknown = gates.checkLicenses({ sbom: sbomOf(pkg("mystery", "0.1.0", "SuperCustom-1.0")), policy });
  assert.equal(unknown.passed, false);
  assert.match(unknown.violations[0].reasons.join(" "), /not in the allow-list/);

  const none = gates.checkLicenses({ sbom: sbomOf(pkg("no-license", "0.1.0", "NOASSERTION", "python-pkg")), policy });
  assert.equal(none.passed, false);
  assert.equal(none.violations[0].kind, "unknown");

  const gpl = gates.checkLicenses({ sbom: sbomOf(pkg("some-lib", "1.0.0", "GPL-3.0-only", "python-pkg")), policy });
  assert.equal(gpl.passed, false);
  assert.match(gpl.violations[0].reasons.join(" "), /GPL is allowed only/);
});

const layer = (megabytes, createdBy) => ({ size: megabytes * 1024 ** 2, createdBy });

test("V2-54: the size gate fails above the budget and lists the five largest layers; a smaller image passes", () => {
  const layers = [layer(4000, "RUN install-rust"), layer(1500, "RUN install-go"), layer(900, "RUN install-dotnet"), layer(800, "COPY tools"), layer(700, "RUN apt"), layer(600, "RUN node"), layer(5, "ADD base"), layer(1, "LABEL x")];
  const over = gates.checkSize({ layers, compressedBytes: 2 * 1024 ** 3 });
  assert.equal(over.passed, false);
  assert.match(over.findings[0].message, /uncompressed size .* above the budget of 7\.00 GB/);
  assert.equal(over.largestLayers.length, 5);
  assert.deepEqual(
    over.largestLayers.map((l) => l.createdBy),
    ["RUN install-rust", "RUN install-go", "RUN install-dotnet", "COPY tools", "RUN apt"],
  );
  assert.ok(over.largestLayers[0].sizeBytes >= over.largestLayers[1].sizeBytes);

  const compressedOver = gates.checkSize({ layers: layers.slice(2), compressedBytes: 3.5 * 1024 ** 3 });
  assert.equal(compressedOver.passed, false);
  assert.equal(compressedOver.findings[0].kind, "compressed-over-budget");

  const fits = gates.checkSize({ layers: layers.slice(2), compressedBytes: 1.9 * 1024 ** 3 });
  assert.equal(fits.passed, true, JSON.stringify(fits.findings));
  assert.equal(fits.largestLayers.length, 5);
});

const SEMGREP_RULE = `rules:
  - id: demo.no-eval
    languages: [python]
    severity: ERROR
    message: Do not call eval
    pattern: eval(...)
`;
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n";

function walk(dir, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, "scan-forbidden", dir, ...extra], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function put(base, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(base, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test("V2-54: the forbidden-content gate detects a planted semgrep rules file and a credential-looking file, and nothing in a clean tree", () => {
  const clean = tmp("v2-54-clean-");
  put(clean, {
    "usr/local/bin/tool": "#!/bin/sh\n",
    "opt/app/config.yaml": "name: app\nreplicas: 2\n",
    "opt/app/README.md": "# app\n",
    "etc/hosts": "127.0.0.1 localhost\n",
    "opt/app/.env.example": "TOKEN=\n",
  });
  const none = walk(clean);
  assert.deepEqual(none.findings, []);
  assert.ok(none.scanned >= 5);

  const planted = tmp("v2-54-planted-");
  put(planted, {
    "usr/local/bin/tool": "#!/bin/sh\n",
    "opt/rules/python/security/no-eval.yaml": SEMGREP_RULE,
    "opt/semgrep-rules/p__default.txt": "registry rules live in a folder with this name\n",
    "root/.ssh/id_rsa": PRIVATE_KEY,
    "home/user/.npmrc": "//registry.npmjs.org/:_authToken=npm_0000\n",
    "opt/codeql/codeql": "#!/bin/sh\n",
    "root/.cache/trivy/db/trivy.db": "x",
  });
  const found = walk(planted);
  const byKind = (kind) => found.findings.filter((f) => f.kind === kind).map((f) => f.path);
  assert.ok(byKind("semgrep-rules").includes("/opt/rules/python/security/no-eval.yaml"), JSON.stringify(found.findings));
  assert.ok(byKind("semgrep-rules").includes("/opt/semgrep-rules"), "the semgrep-rules folder is reported");
  assert.ok(byKind("credential").includes("/root/.ssh/id_rsa"), JSON.stringify(found.findings));
  assert.ok(byKind("credential").includes("/home/user/.npmrc"));
  assert.ok(byKind("codeql").includes("/opt/codeql"));
  assert.ok(byKind("vulnerability-database").length >= 1, JSON.stringify(found.findings));

  // A private key under another name is found by its content; a rules file under an allowed prefix (JGates's own pack) is not reported.
  const renamed = tmp("v2-54-renamed-");
  put(renamed, { "srv/deploy/server.key": PRIVATE_KEY, "opt/jgates/packs/jgates-semgrep/rules/own.yaml": SEMGREP_RULE });
  const second = walk(renamed, "--allow", "/opt/jgates");
  assert.deepEqual(second.findings.map((f) => `${f.kind} ${f.path}`), ["credential /srv/deploy/server.key"]);
});
