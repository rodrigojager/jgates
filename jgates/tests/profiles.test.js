import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const codec = await import(pathToFileURL(path.join(dist, "core", "codecs", "yaml", "index.js")).href);

const PROFILES = ".jgates/profiles.yml";
const ROOT = "jgates.yml";

const ROOT_TEXT = ["# Project entry point", "schemaVersion: 1", "", "selection:", "  profile: standard   # the daily profile", ""].join("\n");

const PROFILES_TEXT = [
  "# Profiles of this project",
  "schemaVersion: 1",
  "profiles:",
  "  # starter copy",
  "  standard:",
  "    label: Equilibrado   # keep my label",
  "    extends: builtin:standard",
  "",
  "  completo:",
  "    label: Completo",
  "    extends: standard",
  "    checks:",
  "      capability:mutation: { enabled: true }",
  "",
  "# end of the file",
  "",
].join("\n");

const TOOLS_TEXT = ["schemaVersion: 1", "tools:", "  pytest-api:", "    adapter: pytest", "    capabilities: [unit]", ""].join("\n");

function withProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-prof-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cli(dir, command, ...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-prof-home-"));
  try {
    const r = spawnSync(process.execPath, [MAIN, command, ...args, "--cwd", dir, "--json"], {
      encoding: "utf8",
      env: { ...process.env, JGATES_HOME: home },
      timeout: 30000,
    });
    let doc;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      assert.fail(`stdout is not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
    }
    return { status: r.status, doc, stderr: r.stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

/** The lines `after` has beyond `before`, asserting that every line of `before` is still there, in order. */
function addedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const added = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else added.push(line);
  }
  assert.equal(i, a.length, "a line of the original file changed or went away");
  return added;
}

const BASE = { [ROOT]: ROOT_TEXT, [PROFILES]: PROFILES_TEXT, ".jgates/tools.yml": TOOLS_TEXT };

test("profiles create rapido --from standard --skip capability:unit adds the profile and leaves the rest of the file byte for byte", () => {
  withProject(BASE, (dir) => {
    const r = cli(dir, "profiles", "create", "rapido", "--from", "standard", "--skip", "capability:unit", "--no-interactive");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    assert.equal(r.doc.id, "rapido");
    assert.equal(r.doc.extends, "standard");
    assert.equal(r.doc.strategy, "text");
    const after = read(dir, PROFILES);
    assert.deepEqual(addedLines(PROFILES_TEXT, after), ["  rapido:", "    extends: standard", "    checks:", "      capability:unit:", "        enabled: false"]);
    assert.equal(read(dir, ROOT), ROOT_TEXT, "jgates.yml is untouched");
    // The new file is valid, and the profile resolves.
    const valid = cli(dir, "config", "validate");
    assert.equal(valid.status, 0, JSON.stringify(valid.doc));
    const list = cli(dir, "profiles", "list");
    assert.ok(list.doc.profiles.some((p) => p.id === "rapido" && p.extends === "standard"));
  });
});

test("create writes the file when the project has no profiles.yml yet", () => {
  withProject({ [ROOT]: ROOT_TEXT.replace("profile: standard", "profile: builtin:standard") }, (dir) => {
    const r = cli(dir, "profiles", "create", "rapido", "--from", "standard", "--label", "Rápido");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    assert.equal(r.doc.extends, "builtin:standard");
    assert.equal(read(dir, PROFILES), "schemaVersion: 1\nprofiles:\n  rapido:\n    label: Rápido\n    extends: builtin:standard\n");
  });
});

test("profiles set-default rapido changes only selection.profile in jgates.yml", () => {
  withProject(BASE, (dir) => {
    cli(dir, "profiles", "create", "rapido", "--from", "standard");
    const profilesBefore = read(dir, PROFILES);
    const r = cli(dir, "profiles", "set-default", "rapido", "--no-interactive");
    assert.equal(r.status, 0, JSON.stringify(r.doc));
    assert.equal(read(dir, ROOT), ROOT_TEXT.replace("profile: standard   #", "profile: rapido   #"));
    assert.equal(read(dir, PROFILES), profilesBefore);
    assert.equal(cli(dir, "profiles", "list").doc.default, "rapido");
    const unknown = cli(dir, "profiles", "set-default", "rapdo");
    assert.equal(unknown.status, 3);
    assert.equal(unknown.doc.code, "PROFILE_NOT_FOUND");
    assert.match(unknown.doc.fix, /rapido/);
  });
});

test("a selector that names nothing exits 3 with a suggestion; skipping a locked requirement exits 3 with the reason", () => {
  const policy = ["schemaVersion: 1", "requiredEvidence:", "  - check: capability:secrets", "    locked: true", "    reason: Segredos nunca podem ser pulados.", ""].join("\n");
  withProject({ ...BASE, ".jgates/policy.yml": policy }, (dir) => {
    const typo = cli(dir, "profiles", "create", "x", "--from", "standard", "--skip", "capability:unti");
    assert.equal(typo.status, 3);
    assert.equal(typo.doc.code, "SKIP_REJECTED");
    assert.match(typo.doc.fix, /capability:unit/);
    assert.equal(read(dir, PROFILES), PROFILES_TEXT, "nothing was written");

    const locked = cli(dir, "profiles", "create", "x", "--from", "standard", "--skip", "capability:secrets");
    assert.equal(locked.status, 3);
    assert.equal(locked.doc.errors[0].code, "LOCKED_REQUIREMENT");
    assert.match(locked.doc.message, /Segredos nunca podem ser pulados/);
    assert.equal(read(dir, PROFILES), PROFILES_TEXT);

    const run = cli(dir, "config", "resolve", "--skip", "category:security");
    assert.equal(run.status, 3);
    assert.equal(run.doc.code, "LOCKED_REQUIREMENT");
    assert.match(run.doc.message, /capability:secrets/);
    assert.match(run.doc.message, /--skip/);
  });
});

test("a stale expected hash is a conflict for delete and for recreate, and the file does not change", () => {
  withProject(BASE, (dir) => {
    const first = cli(dir, "profiles", "list").doc.revisions[PROFILES];
    assert.match(first, /^[0-9a-f]{64}$/);
    // Someone else edits the file after the hash was read.
    const edited = PROFILES_TEXT.replace("label: Completo", "label: Completo, antes do merge");
    fs.writeFileSync(path.join(dir, PROFILES), edited);

    const del = cli(dir, "profiles", "delete", "completo", "--if-match", first);
    assert.equal(del.status, 3);
    assert.equal(del.doc.code, "REVISION_CONFLICT");
    assert.equal(del.doc.expectedHash, first);
    assert.equal(read(dir, PROFILES), edited);

    const re = cli(dir, "profiles", "create", "completo", "--from", "standard", "--replace", "--if-match", first);
    assert.equal(re.status, 3);
    assert.equal(re.doc.code, "REVISION_CONFLICT");
    assert.equal(read(dir, PROFILES), edited);

    // With the current hash both work.
    const current = cli(dir, "profiles", "list").doc.revisions[PROFILES];
    const ok = cli(dir, "profiles", "create", "completo", "--from", "standard", "--replace", "--skip", "capability:unit", "--if-match", current);
    assert.equal(ok.status, 0, JSON.stringify(ok.doc));
    const text = read(dir, PROFILES);
    assert.ok(text.includes("  completo:\n    extends: standard\n    checks:\n      capability:unit:\n        enabled: false\n"));
    assert.ok(!text.includes("mutation"));
    assert.ok(text.includes("# starter copy") && text.includes("# end of the file") && text.includes("# keep my label"));
  });
});

test("create refuses an existing id without --replace; delete refuses a profile in use and removes a free one", () => {
  withProject(BASE, (dir) => {
    const exists = cli(dir, "profiles", "create", "completo", "--from", "standard");
    assert.equal(exists.status, 3);
    assert.equal(exists.doc.code, "PROFILE_EXISTS");

    const used = cli(dir, "profiles", "delete", "standard");
    assert.equal(used.status, 3);
    assert.equal(used.doc.code, "PROFILE_IN_USE");
    assert.match(used.doc.message, /completo/);

    const cycle = cli(dir, "profiles", "create", "standard", "--from", "completo", "--replace");
    assert.equal(cycle.status, 3);
    assert.equal(cycle.doc.code, "PROFILE_CYCLE");

    const free = cli(dir, "profiles", "delete", "completo");
    assert.equal(free.status, 0, JSON.stringify(free.doc));
    assert.deepEqual(addedLines(read(dir, PROFILES), PROFILES_TEXT), ["  completo:", "    label: Completo", "    extends: standard", "    checks:", "      capability:mutation: { enabled: true }"]);

    const def = cli(dir, "profiles", "delete", "standard");
    assert.equal(def.status, 3);
    assert.equal(def.doc.code, "PROFILE_IN_USE");
    assert.match(def.doc.message, /padrão/);

    const bad = cli(dir, "profiles", "create", "Bad Id", "--from", "standard");
    assert.equal(bad.status, 3);
    assert.equal(bad.doc.code, "PROFILE_ID_INVALID");
    const nofrom = cli(dir, "profiles", "create", "novo", "--from", "stadard");
    assert.equal(nofrom.status, 3);
    assert.equal(nofrom.doc.code, "PROFILE_FROM_NOT_FOUND");
    assert.match(nofrom.doc.fix, /standard/);
  });
});

test("an invalid project configuration is refused before any write", () => {
  withProject({ ...BASE, [PROFILES]: PROFILES_TEXT.replace("extends: standard", "extends: nope") }, (dir) => {
    const r = cli(dir, "profiles", "create", "rapido", "--from", "standard");
    assert.equal(r.status, 3);
    assert.equal(r.doc.code, "CONFIG_INVALID");
  });
});

// ---- YAML codec ----

test("codec: set and delete keep comments, blank lines and quoting; a missing parent and flow maps go through the document", () => {
  const text = ["# head", "a: 1   # one", "b:", "  c: 'two'  # two", "", "  d: [1,   2]", "# tail", ""].join("\n");
  const set = codec.patchYamlText(text, [{ op: "set", path: ["b", "e"], value: { x: true } }]);
  assert.equal(set.strategy, "text");
  assert.deepEqual(addedLines(text, set.text), ["  e:", "    x: true"]);

  const scalar = codec.patchYamlText(text, [{ op: "set", path: ["a"], value: 2 }]);
  assert.equal(scalar.text, text.replace("a: 1   # one", "a: 2   # one"));

  const del = codec.patchYamlText(text, [{ op: "delete", path: ["b", "c"] }]);
  assert.equal(del.text, text.replace("  c: 'two'  # two\n", ""));

  const missingParent = codec.patchYamlText(text, [{ op: "set", path: ["z", "y"], value: 1 }]);
  assert.equal(missingParent.strategy, "text");
  assert.ok(missingParent.text.startsWith(text.slice(0, text.length - "# tail\n".length)));

  const flow = codec.patchYamlText("m: { a: 1 }\n", [{ op: "set", path: ["m", "b"], value: 2 }]);
  assert.equal(flow.strategy, "document");
  assert.deepEqual(codec.patchYamlText(flow.text, []).text, flow.text);

  const emptied = codec.patchYamlText("m:\n  a: 1\n", [{ op: "delete", path: ["m", "a"] }]);
  assert.equal(emptied.text, "m: {}\n");
});

test("codec: CRLF files stay CRLF and a file without a final newline is appended correctly", () => {
  const crlf = "a: 1\r\nb:\r\n  c: 2\r\n";
  const r = codec.patchYamlText(crlf, [{ op: "set", path: ["b", "d"], value: 3 }]);
  assert.equal(r.text, "a: 1\r\nb:\r\n  c: 2\r\n  d: 3\r\n");
  const bare = codec.patchYamlText("a: 1\nb:\n  c: 2", [{ op: "set", path: ["b", "d"], value: 3 }]);
  assert.equal(bare.text, "a: 1\nb:\n  c: 2\n  d: 3\n");
});

test("codec: patchYamlFile checks the revision, never writes on a conflict and reports the new hash", () => {
  withProject({ "f.yml": "a: 1\n" }, (dir) => {
    const file = path.join(dir, "f.yml");
    const hash = codec.hashBytes(Buffer.from("a: 1\n"));
    assert.equal(codec.readRevision(file).hash, hash);
    assert.throws(() => codec.patchYamlFile(file, [{ op: "set", path: ["a"], value: 2 }], { expectedHash: "0".repeat(64) }), (e) => e.code === "YAML_CONFLICT" && e.details.currentHash === hash);
    assert.equal(fs.readFileSync(file, "utf8"), "a: 1\n");
    const ok = codec.patchYamlFile(file, [{ op: "set", path: ["a"], value: 2 }], { expectedHash: hash });
    assert.equal(ok.previousHash, hash);
    assert.equal(ok.hash, codec.hashBytes(Buffer.from("a: 2\n")));
    assert.throws(() => codec.patchYamlFile(path.join(dir, "none.yml"), [{ op: "set", path: ["a"], value: 1 }]), (e) => e.code === "YAML_MISSING");
    assert.throws(() => codec.patchYamlFile(path.join(dir, "none.yml"), [{ op: "set", path: ["a"], value: 1 }], { expectedHash: hash, createWith: "" }), (e) => e.code === "YAML_CONFLICT");
  });
});
