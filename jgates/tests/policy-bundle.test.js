import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const policy = await import(pathToFileURL(path.join(dist, "core", "policy", "index.js")).href);
const { loadProjectConfig } = await import(pathToFileURL(path.join(dist, "core", "config", "load", "index.js")).href);
const { resolveConfig } = await import(pathToFileURL(path.join(dist, "core", "config", "resolve", "index.js")).href);
const { buildPlan } = await import(pathToFileURL(path.join(dist, "core", "plan", "index.js")).href);

const VENV_PYTHON = path.resolve(here, "..", "..", ".venv", "bin", process.platform === "win32" ? "python.exe" : "python");
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Writes the files (in the given order) under dir. */
function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

/** Runs fn with fresh temp folders and always removes them. */
function withDirs(count, fn) {
  const dirs = Array.from({ length: count }, () => tmp("jg-policy-"));
  try {
    return fn(...dirs);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

const POLICY_ROOT = "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: gate\n";
const POLICY_PROFILES = "schemaVersion: 1\nprofiles:\n  gate:\n    label: Gate\n    extends: builtin:strict\n";

/** A policy bundle with files JGates reads and files it does not. */
const BUNDLE = {
  "jgates.yml": POLICY_ROOT,
  ".jgates/profiles.yml": POLICY_PROFILES,
  ".jgates/waivers.json": "{\"waivers\": []}\n",
  ".jgates/rules/semgrep.yml": "rules: []\n",
  ".jgates.ignore": "generated/\n",
};
const NOT_READ = {
  "README.md": "# CI policy\n",
  ".github/workflows/ci.yml": "on: push\n",
  ".git/HEAD": "ref: refs/heads/main\n",
  ".git/config": "[core]\n",
  ".jgates/.git/HEAD": "ref: refs/heads/main\n",
  "src/app.js": "console.log(1)\n",
};

test("loadProjectConfig with configDir reads only the configuration folder; the project's files are ignored", () => {
  withDirs(2, (project, policyDir) => {
    // The project's own configuration is broken on purpose: reading it would give diagnostics.
    write(project, { "jgates.yml": "selection: [unclosed\n", ".jgates/profiles.yml": "profiles: 1\n", "package.json": "{}\n" });
    write(policyDir, BUNDLE);
    const own = loadProjectConfig(project);
    assert.equal(own.valid, false);

    const loaded = loadProjectConfig(project, { configDir: policyDir });
    assert.equal(loaded.valid, true, JSON.stringify(loaded.diagnostics));
    assert.equal(loaded.projectDir, path.resolve(project));
    assert.equal(loaded.configDir, path.resolve(policyDir));
    assert.deepEqual(loaded.documents.map((d) => d.file).sort(), [".jgates/profiles.yml", "jgates.yml"]);
    assert.equal(loaded.byKind.root.value.selection.profile, "gate");
    assert.deepEqual(policy.loadPolicyConfig(policyDir, project), loaded);

    // Without configDir nothing changes: the configuration is the project's.
    assert.equal(own.configDir, own.projectDir);

    // The resolver follows the same folder.
    const resolved = resolveConfig(project, { configDir: policyDir, inventory: { classifications: [] } });
    assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
    assert.equal(resolved.profile.id, "gate");
    assert.equal(resolved.configDir, path.resolve(policyDir));
  });
});

test("a plan built with a policy folder uses only the policy: the project's jgates.yml and profiles are ignored", () => {
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jg-policy-home-");
  const policyDir = tmp("jg-policy-dir-");
  try {
    // The project tries to turn every check off with its own profile.
    write(dir, {
      "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/profiles.yml\nselection:\n  profile: relaxed\n",
      ".jgates/profiles.yml":
        "schemaVersion: 1\nprofiles:\n  relaxed:\n    extends: builtin:minimal\n    checks:\n" +
        ["file-size", "lint", "secrets", "sast", "dependencies", "duplication", "iac", "unit", "coverage"].map((c) => `      capability:${c}:\n        enabled: false\n`).join(""),
    });
    write(policyDir, { "jgates.yml": POLICY_ROOT, ".jgates/profiles.yml": POLICY_PROFILES });
    const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON };
    const options = { home, env, compare: false, now: new Date("2026-01-01T00:00:00Z") };

    const own = buildPlan(dir, options);
    assert.equal(own.ok, true, JSON.stringify(own.errors));
    assert.equal(own.plan.profile.id, "relaxed");

    const governed = buildPlan(dir, { ...options, configDir: policyDir });
    assert.equal(governed.ok, true, JSON.stringify(governed.errors));
    const p = governed.plan;
    assert.equal(p.profile.id, "gate");
    assert.ok(p.profile.chain.some((c) => c.id === "builtin:strict"));
    // The configuration files of the plan are the policy's, with the policy's bytes.
    const configFiles = Object.fromEntries(p.inputs.configFiles.filter((f) => !f.file.startsWith("builtin:")).map((f) => [f.file, f.sha256]));
    assert.deepEqual(Object.keys(configFiles).sort(), [".jgates/profiles.yml", "jgates.yml"]);
    assert.equal(configFiles["jgates.yml"], "sha256:" + sha(fs.readFileSync(path.join(policyDir, "jgates.yml"))));
    assert.equal(configFiles[".jgates/profiles.yml"], "sha256:" + sha(fs.readFileSync(path.join(policyDir, ".jgates/profiles.yml"))));
    // The checks the project turned off run under the policy.
    const secrets = (plan) => plan.groups.willRun.filter((i) => i.capabilities.includes("secrets"));
    assert.equal(secrets(own.plan).length, 0);
    assert.ok(secrets(p).length > 0, "the policy keeps the secrets check");
    // The analyzed files are still the project's: the components come from it.
    assert.deepEqual(p.components.map((c) => c.id).sort(), ["api", "libs-shared", "web"]);

    // A broken project configuration does not matter under a policy.
    write(dir, { "jgates.yml": "selection: [unclosed\n" });
    assert.equal(buildPlan(dir, options).ok, false);
    const again = buildPlan(dir, { ...options, configDir: policyDir });
    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal(again.plan.planHash, p.planHash);
  } finally {
    mainFixture.removeFixture(dir);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(policyDir, { recursive: true, force: true });
  }
});

test("the bundle hash follows the documented manifest and lists only the files JGates reads", () => {
  withDirs(1, (dir) => {
    write(dir, { ...BUNDLE, ...NOT_READ });
    const r = policy.readPolicyBundle(dir);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const { bundle } = r;
    assert.deepEqual(
      bundle.files.map((f) => f.path),
      [".jgates.ignore", ".jgates/profiles.yml", ".jgates/rules/semgrep.yml", ".jgates/waivers.json", "jgates.yml"],
    );
    for (const f of bundle.files) {
      const bytes = fs.readFileSync(path.join(dir, f.path));
      assert.equal(f.sha256, sha(bytes), f.path);
      assert.equal(f.size, bytes.length, f.path);
    }
    const manifest = bundle.files.map((f) => `${sha(fs.readFileSync(path.join(dir, f.path)))}  ${f.path}\n`).join("");
    assert.equal(bundle.manifest, manifest);
    assert.equal(bundle.sha256, sha(Buffer.from(manifest, "utf8")));
    assert.match(bundle.sha256, /^[0-9a-f]{64}$/);
    assert.equal(bundle.dir, path.resolve(dir));
  });
});

test("the bundle hash is stable: same content written in another order gives the same hash and list", () => {
  withDirs(2, (a, b) => {
    write(a, { ...BUNDLE, ...NOT_READ });
    const reversed = Object.fromEntries(Object.entries({ ...NOT_READ, ...BUNDLE }).reverse());
    write(b, reversed);
    const ra = policy.readPolicyBundle(a);
    const rb = policy.readPolicyBundle(b);
    assert.equal(ra.ok && rb.ok, true);
    assert.equal(ra.bundle.sha256, rb.bundle.sha256);
    assert.deepEqual(ra.bundle.files, rb.bundle.files);
    // Reading twice gives the same result.
    assert.equal(policy.readPolicyBundle(a).bundle.sha256, ra.bundle.sha256);
  });
});

test("the bundle hash changes when any file JGates reads changes, and not for files it does not read", () => {
  withDirs(1, (dir) => {
    const files = {
      ...BUNDLE,
      // A template outside .jgates/ named by jgates.yml, with a parent: both are read.
      "jgates.yml": POLICY_ROOT + "templates:\n  - id: house\n    source: shared/house.yml\n    activation: always\n",
      "shared/house.yml": "schemaVersion: 1\nid: house\nextends:\n  - shared/base.yml\n",
      "shared/base.yml": "schemaVersion: 1\nid: base\n",
      // A scanner configuration bound in tools.yml, outside .jgates/: read too.
      ".jgates/tools.yml": "schemaVersion: 1\ntools:\n  quality-bridge:\n    adapter: quality-bridge\n    configFiles:\n      gitleaks:\n        path: scanners/gitleaks.toml\n",
      "scanners/gitleaks.toml": "title = \"policy\"\n",
      ...NOT_READ,
    };
    write(dir, files);
    const first = policy.readPolicyBundle(dir);
    assert.equal(first.ok, true, JSON.stringify(first.error));
    const listed = first.bundle.files.map((f) => f.path);
    for (const f of ["shared/house.yml", "shared/base.yml", ".jgates/tools.yml", "scanners/gitleaks.toml"]) assert.ok(listed.includes(f), `${f} in ${listed.join(", ")}`);

    let current = first.bundle.sha256;
    for (const name of [...first.bundle.files.map((f) => f.path)]) {
      fs.appendFileSync(path.join(dir, name), name.endsWith(".json") ? " " : "\n# changed\n");
      const next = policy.readPolicyBundle(dir);
      assert.equal(next.ok, true, `${name}: ${JSON.stringify(next.error)}`);
      assert.notEqual(next.bundle.sha256, current, `changing ${name} must change the hash`);
      current = next.bundle.sha256;
    }
    // A new file under .jgates/ enters the bundle.
    write(dir, { ".jgates/templates/extra.yml": "schemaVersion: 1\n" });
    const added = policy.readPolicyBundle(dir);
    assert.notEqual(added.bundle.sha256, current);
    current = added.bundle.sha256;

    // Files outside the bundle (.git, README, CI files, sources, .jgates/.git) never change it.
    for (const name of Object.keys(NOT_READ)) fs.appendFileSync(path.join(dir, name), "changed\n");
    write(dir, { ".git/objects/ab/cdef": "x", "docs/notes.md": "x\n" });
    const after = policy.readPolicyBundle(dir);
    assert.equal(after.bundle.sha256, current);
    assert.ok(after.bundle.files.every((f) => !f.path.split("/").includes(".git")));
  });
});

test("the bundle hash keeps CRLF byte for byte: the same bytes give the same hash, and no line ending is normalized", () => {
  withDirs(3, (crlf, crlfAgain, lf) => {
    const toCrlf = (text) => text.replace(/\n/g, "\r\n");
    const crlfFiles = { "jgates.yml": toCrlf(POLICY_ROOT), ".jgates/profiles.yml": toCrlf(POLICY_PROFILES) };
    write(crlf, crlfFiles);
    write(crlfAgain, Object.fromEntries(Object.entries(crlfFiles).reverse()));
    write(lf, { "jgates.yml": POLICY_ROOT, ".jgates/profiles.yml": POLICY_PROFILES });
    const a = policy.readPolicyBundle(crlf).bundle;
    const b = policy.readPolicyBundle(crlfAgain).bundle;
    const c = policy.readPolicyBundle(lf).bundle;
    assert.equal(a.sha256, b.sha256);
    assert.notEqual(a.sha256, c.sha256);
    assert.equal(a.files.find((f) => f.path === "jgates.yml").sha256, sha(Buffer.from(toCrlf(POLICY_ROOT), "utf8")));
    // Pinned values: the format never depends on the system (same bytes, "/" separators, byte order).
    assert.equal(c.manifest, `${sha(POLICY_PROFILES)}  .jgates/profiles.yml\n${sha(POLICY_ROOT)}  jgates.yml\n`);
    assert.equal(c.sha256, sha(c.manifest));
    // A CRLF policy still loads as configuration.
    assert.equal(loadProjectConfig(crlf).valid, true);
  });
});

test("bundle errors: missing folder, missing jgates.yml, references outside the folder, links", () => {
  withDirs(2, (dir, outside) => {
    assert.equal(policy.readPolicyBundle(path.join(dir, "nope")).error.code, "POLICY_DIR_MISSING");
    assert.equal(policy.readPolicyBundle(dir).error.code, "POLICY_ROOT_MISSING");

    write(outside, { "evil.yml": "schemaVersion: 1\nid: evil\n" });
    write(dir, { "jgates.yml": POLICY_ROOT + `templates:\n  - id: evil\n    source: ../${path.basename(outside)}/evil.yml\n` });
    write(dir, { ".jgates/profiles.yml": POLICY_PROFILES });
    assert.equal(policy.readPolicyBundle(dir).error.code, "POLICY_REF_OUTSIDE");

    write(dir, { "jgates.yml": POLICY_ROOT });
    assert.equal(policy.readPolicyBundle(dir).ok, true);
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(outside, "evil.yml"), path.join(dir, ".jgates", "linked.yml"));
      const linked = policy.readPolicyBundle(dir);
      assert.equal(linked.ok, false);
      assert.equal(linked.error.code, "POLICY_SYMLINK");
      assert.equal(linked.error.path, ".jgates/linked.yml");
    }
  });
});

test("normalizePolicyHash and policyHashMatches accept the hex hash with or without the sha256: prefix", () => {
  withDirs(1, (dir) => {
    write(dir, BUNDLE);
    const { bundle } = policy.readPolicyBundle(dir);
    assert.equal(policy.policyHashMatches(bundle, bundle.sha256), true);
    assert.equal(policy.policyHashMatches(bundle, ` sha256:${bundle.sha256.toUpperCase()}\n`), true);
    assert.equal(policy.policyHashMatches(bundle, undefined), false);
    assert.equal(policy.policyHashMatches(bundle, ""), false);
    assert.equal(policy.policyHashMatches(bundle, "0".repeat(64)), false);
    assert.equal(policy.normalizePolicyHash("abc"), null);
  });
});

test("a policy folder inside the analyzed project is refused with its own code", () => {
  withDirs(2, (project, elsewhere) => {
    write(project, { "jgates.yml": POLICY_ROOT, "ci-policy/jgates.yml": POLICY_ROOT, "package.json": "{}\n" });
    write(elsewhere, { "jgates.yml": POLICY_ROOT });

    const same = policy.checkPolicyLocation(project, project);
    assert.equal(same.code, "POLICY_INSIDE_PROJECT");
    const inside = policy.checkPolicyLocation(path.join(project, "ci-policy"), project);
    assert.equal(inside.code, "POLICY_INSIDE_PROJECT");
    assert.equal(policy.checkPolicyLocation(path.join(project, "ci-policy", "..", "ci-policy"), project).code, "POLICY_INSIDE_PROJECT");
    assert.equal(policy.checkPolicyLocation(elsewhere, project), null);
    // A project inside the policy folder is fine: the analyzed commit cannot change the policy files.
    assert.equal(policy.checkPolicyLocation(project, path.join(project, "ci-policy")), null);
    assert.equal(policy.checkPolicyLocation(path.join(elsewhere, "missing"), project).code, "POLICY_DIR_MISSING");

    if (process.platform !== "win32") {
      // A link outside the project that points into it is still inside.
      const link = path.join(elsewhere, "policy-link");
      fs.symlinkSync(path.join(project, "ci-policy"), link);
      assert.equal(policy.checkPolicyLocation(link, project).code, "POLICY_INSIDE_PROJECT");
    }
  });
});
