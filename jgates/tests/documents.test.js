import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const docs = await import(path.resolve(here, "..", "dist", "core", "documents", "index.js"));
const { tomlStructuredAvailable } = await import(path.resolve(here, "..", "dist", "core", "codecs", "toml", "index.js"));
// TOML syntax is checked through the sidecar helper, so the suite needs Python with tomlkit: it fails with the
// install instruction instead of accepting "unavailable" in silence (project convention). The "unavailable" answer
// is exercised on purpose below, with an empty PATH.
const INSTALL_HINT = "Python with tomlkit not found: create the .venv (python3 -m venv .venv && .venv/bin/pip install -e quality-gate) and put .venv/bin on the PATH, or set JGATES_PYTHON";
const TOML_STATUS = "valid";

test("the TOML syntax helper is reachable (the suite does not accept 'unavailable' in silence)", () => {
  assert.ok(tomlStructuredAvailable(), INSTALL_HINT);
});

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function cli(dir, args, input, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-doc-home-"));
  try {
    const r = spawnSync(process.execPath, [MAIN, ...args, "--cwd", dir, "--json"], {
      encoding: "utf8",
      env: { ...process.env, ...env, JGATES_HOME: home },
      input: input ?? "",
      timeout: 20000,
    });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, doc, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const TOOLS = `tools:
  ruff-api:
    adapter: ruff
    component: api
    config: apps/api/pyproject.toml
  pytest-api:
    adapter: pytest
    component: api
    config: apps/api/pyproject.toml
  pii-repo:
    adapter: builtin-pii
    config: .jgates/pii.yml
  data:
    adapter: x
    config: settings/data.json
  locked:
    adapter: x
    config:
      path: locked.toml
      access: read
  rules:
    adapter: semgrep
    configFiles:
      rules:
        path: .jgates/rules
        kind: directory
        role: rules
        include: ["**/*.yml", "*.yml"]
  absent:
    adapter: x
    config: missing/none.toml
  later:
    adapter: x
    config: later.toml
`;

const PYPROJECT = "[tool.ruff]\nline-length = 88\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n";

function withProject(fn, { files = {}, tools = TOOLS, extra } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-doc-")));
  try {
    const all = {
      "jgates.yml": "schemaVersion: 1\nextends:\n  - .jgates/tools.yml\n",
      ".jgates/tools.yml": `schemaVersion: 1\n${tools}`,
      "apps/api/pyproject.toml": PYPROJECT,
      ".jgates/pii.yml": "entities:\n  cpf: true\n",
      "settings/data.json": "{\n  \"a\": 1\n}\n",
      "locked.toml": "x = 1\n",
      ".jgates/rules/a.yml": "rules: []\n",
      ".jgates/rules/sub/b.yml": "rules: []\n",
      ...files,
    };
    for (const [name, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    if (extra) extra(dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const listTree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test("config read returns text and revision; write with it saves and the next read has the new revision", () => {
  withProject((dir) => {
    const read = cli(dir, ["tools", "config", "read", "ruff-api", "--file", "config"]);
    assert.equal(read.status, 0, read.stdout);
    const doc = read.doc.document;
    assert.equal(doc.text, PYPROJECT);
    assert.equal(doc.revision, sha(fs.readFileSync(path.join(dir, "apps/api/pyproject.toml"))));
    assert.equal(doc.state, "editable");
    assert.equal(doc.encoding, "utf-8");
    assert.equal(doc.bom, false);
    assert.equal(doc.eol, "lf");
    assert.equal(doc.format, "toml");
    assert.deepEqual(doc.sharedWith.map((s) => s.tool), ["pytest-api"]);

    const next = PYPROJECT.replace("88", "100");
    const write = cli(dir, ["tools", "config", "write", "ruff-api", "--file", "config", "--if-match", doc.revision, "--no-interactive"], next);
    assert.equal(write.status, 0, write.stdout);
    assert.equal(write.doc.result, "saved");
    assert.equal(write.doc.previousRevision, doc.revision);
    assert.match(write.doc.diff, /^-line-length = 88$/m);
    assert.match(write.doc.diff, /^\+line-length = 100$/m);
    const onDisk = fs.readFileSync(path.join(dir, "apps/api/pyproject.toml"));
    assert.equal(onDisk.toString("utf8"), next);
    assert.equal(write.doc.revision, sha(onDisk));

    const again = cli(dir, ["tools", "config", "read", "ruff-api", "--file", "config"]);
    assert.equal(again.doc.document.revision, write.doc.revision);
    assert.notEqual(again.doc.document.revision, doc.revision);
    // The binding role works as an alias when one binding has it.
    assert.equal(cli(dir, ["tools", "config", "read", "ruff-api", "--file", "primary"]).doc.document.revision, write.doc.revision);
  });
});

test("write with a stale --if-match is a conflict with base, local and current, and the file stays byte for byte", () => {
  withProject((dir) => {
    const file = path.join(dir, "apps/api/pyproject.toml");
    const base = cli(dir, ["tools", "config", "read", "ruff-api", "--file", "config"]).doc.document;
    const external = PYPROJECT.replace("-q", "-vv");
    fs.writeFileSync(file, external);
    const externalBytes = fs.readFileSync(file);
    const local = PYPROJECT.replace("88", "120");
    const r = cli(dir, ["tools", "config", "write", "ruff-api", "--file", "config", "--from", "-", "--if-match", base.revision, "--no-interactive"], local);
    assert.equal(r.status, 3);
    assert.equal(r.doc.code, "REVISION_CONFLICT");
    assert.equal(r.doc.conflict.base.revision, base.revision);
    assert.equal(r.doc.conflict.local.text, local);
    assert.equal(r.doc.conflict.current.text, external);
    assert.equal(r.doc.conflict.current.revision, sha(externalBytes));
    assert.match(r.doc.diff, /^-addopts = "-vv"$/m);
    assert.ok(fs.readFileSync(file).equals(externalBytes));
  });
});

test("reading and writing back unchanged text keeps every byte; CRLF and BOM survive an edit made with LF", () => {
  const crlf = "\uFEFF[tool.ruff]\r\nline-length = 88\r\n\r\n[tool.pytest.ini_options]\r\naddopts = \"-q\"\r\n";
  withProject(
    (dir) => {
      const file = path.join(dir, "apps/api/pyproject.toml");
      fs.chmodSync(file, 0o640);
      const original = fs.readFileSync(file);
      const doc = cli(dir, ["tools", "config", "read", "ruff-api", "--file", "config"]).doc.document;
      assert.equal(doc.bom, true);
      assert.equal(doc.eol, "crlf");
      assert.equal(doc.text, crlf.slice(1));
      const same = cli(dir, ["tools", "config", "write", "ruff-api", "--file", "config", "--if-match", doc.revision, "--no-interactive"], doc.text);
      assert.equal(same.status, 0, same.stdout);
      assert.equal(same.doc.result, "unchanged");
      assert.ok(fs.readFileSync(file).equals(original));

      // An editor that sends LF: the file keeps CRLF and its BOM.
      const edited = doc.text.replace(/\r\n/g, "\n").replace("88", "99");
      const w = cli(dir, ["tools", "config", "write", "ruff-api", "--file", "config", "--if-match", doc.revision, "--no-interactive"], edited);
      assert.equal(w.status, 0, w.stdout);
      const after = fs.readFileSync(file);
      assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.equal(after.subarray(3).toString("utf8"), crlf.slice(1).replace("88", "99"));
      assert.equal(after.toString("utf8").replace(/\r\n/g, "").includes("\n"), false);
      if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    },
    { files: { "apps/api/pyproject.toml": crlf } },
  );
});

test("Latin-1 and UTF-16 files keep their encoding, and a character Latin-1 cannot hold is refused", () => {
  withProject(
    (dir) => {
      const latin = path.join(dir, "later.toml");
      const doc = docs.openDocument(dir, "later", "config");
      assert.equal(doc.encoding, "latin1");
      assert.equal(doc.text, "name = \"ação\"\n");
      const saved = docs.saveDocument(dir, "later", "config", { expectedRevision: doc.revision, text: "name = \"coração\"\n" });
      assert.equal(saved.status, "saved");
      assert.ok(fs.readFileSync(latin).equals(Buffer.from("name = \"coração\"\n", "latin1")));
      const before = fs.readFileSync(latin);
      assert.throws(() => docs.saveDocument(dir, "later", "config", { expectedRevision: saved.revision, text: "name = \"€\"\n" }), (e) => e.code === "DOCUMENT_ENCODING");
      assert.ok(fs.readFileSync(latin).equals(before));

      const utf16 = path.join(dir, "locked.toml");
      fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x = 1\r\n", "utf16le")]));
      const d16 = docs.openDocument(dir, "locked", "config");
      assert.equal(d16.encoding, "utf-16le");
      assert.equal(d16.bom, true);
      assert.equal(d16.text, "x = 1\r\n");
    },
    { files: { "later.toml": Buffer.from("name = \"ação\"\n", "latin1") } },
  );
});

test("--file with a path instead of a binding id is refused with 3 and nothing is written", () => {
  withProject((dir) => {
    const before = fs.readFileSync(path.join(dir, "apps/api/pyproject.toml"));
    const rev = sha(before);
    for (const value of ["apps/api/pyproject.toml", "../outside.toml", "pyproject.toml", "./apps/api/pyproject.toml", "C:\\x.toml"]) {
      const r = cli(dir, ["tools", "config", "write", "ruff-api", "--file", value, "--if-match", rev, "--no-interactive"], "x = 1\n");
      assert.equal(r.status, 3, value);
      assert.equal(r.doc.code, "FILE_NOT_BINDING_ID", value);
      const read = cli(dir, ["tools", "config", "read", "ruff-api", "--file", value]);
      assert.equal(read.status, 3, value);
    }
    assert.ok(fs.readFileSync(path.join(dir, "apps/api/pyproject.toml")).equals(before));
    const unknown = cli(dir, ["tools", "config", "read", "ruff-api", "--file", "nope"]);
    assert.equal(unknown.status, 3);
    assert.equal(unknown.doc.code, "BINDING_NOT_FOUND");
    const noRev = cli(dir, ["tools", "config", "write", "ruff-api", "--file", "config", "--no-interactive"], "x = 1\n");
    assert.equal(noRev.status, 3);
    assert.equal(noRev.doc.code, "REVISION_REQUIRED");
    const misplaced = cli(dir, ["tools", "inspect", "ruff-api", "--file", "config"]);
    assert.equal(misplaced.status, 3);
    assert.equal(misplaced.doc.code, "OPTION_NOT_SUPPORTED");
  });
});

test("a symlink swapped between read and write to point outside the root makes the write fail without writing outside", () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-doc-out-")));
  const tools = "tools:\n  ruff-x:\n    adapter: ruff\n    config: conf/ruff.toml\n";
  try {
    fs.writeFileSync(path.join(outside, "ruff.toml"), "line-length = 88\n");
    const outsideBefore = fs.readFileSync(path.join(outside, "ruff.toml"));
    withProject(
      (dir) => {
        const read = cli(dir, ["tools", "config", "read", "ruff-x", "--file", "config"]);
        assert.equal(read.status, 0, read.stdout);
        assert.equal(read.doc.document.identity, path.join(dir, "real-conf", "ruff.toml"));
        // Same content outside, so only the path check can stop the write.
        fs.unlinkSync(path.join(dir, "conf"));
        fs.symlinkSync(outside, path.join(dir, "conf"));
        const w = cli(dir, ["tools", "config", "write", "ruff-x", "--file", "config", "--if-match", read.doc.document.revision, "--no-interactive"], "line-length = 1\n");
        assert.equal(w.status, 3);
        assert.equal(w.doc.code, "BINDING_REFUSED");
        assert.ok(fs.readFileSync(path.join(outside, "ruff.toml")).equals(outsideBefore));
        assert.deepEqual(fs.readdirSync(outside), ["ruff.toml"]);
        assert.equal(fs.readFileSync(path.join(dir, "real-conf", "ruff.toml"), "utf8"), "line-length = 88\n");
      },
      {
        tools,
        files: { "real-conf/ruff.toml": "line-length = 88\n" },
        extra: (dir) => fs.symlinkSync(path.join(dir, "real-conf"), path.join(dir, "conf")),
      },
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a folder swapped for a symlink after the checks and before the rename is caught and nothing is written outside", () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jg-doc-out-")));
  const tools = "tools:\n  ruff-x:\n    adapter: ruff\n    config: cfg/ruff.toml\n";
  try {
    fs.writeFileSync(path.join(outside, "ruff.toml"), "line-length = 88\n");
    withProject(
      (dir) => {
        const doc = docs.openDocument(dir, "ruff-x", "config");
        const faults = {
          beforeCommit: () => {
            fs.renameSync(path.join(dir, "cfg"), path.join(dir, "cfg-moved"));
            fs.symlinkSync(outside, path.join(dir, "cfg"));
          },
        };
        assert.throws(() => docs.saveDocument(dir, "ruff-x", "config", { expectedRevision: doc.revision, text: "line-length = 1\n" }, { faults }), (e) => e.code === "PATH_CHANGED");
        assert.equal(fs.readFileSync(path.join(outside, "ruff.toml"), "utf8"), "line-length = 88\n");
        assert.deepEqual(fs.readdirSync(outside), ["ruff.toml"]);
        // The moved folder keeps the original file; the temporary file may stay there (it can no longer be reached
        // by its path once the folder moved), never in the outside folder.
        assert.deepEqual(fs.readdirSync(path.join(dir, "cfg-moved")).filter((n) => !/\.jgates-\d+-[0-9a-f]+\.tmp$/.test(n)), ["ruff.toml"]);
        assert.equal(fs.readFileSync(path.join(dir, "cfg-moved", "ruff.toml"), "utf8"), "line-length = 88\n");
      },
      { tools, files: { "cfg/ruff.toml": "line-length = 88\n" } },
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a simulated failure in the middle of the write leaves the file whole and never reports success", () => {
  withProject((dir) => {
    const file = path.join(dir, "apps/api/pyproject.toml");
    const before = fs.readFileSync(file);
    const doc = docs.openDocument(dir, "ruff-api", "config");
    const text = PYPROJECT.replace("88", "100") + "# a much longer tail so the partial write is clearly partial\n";
    for (const faults of [{ failAfterBytes: 7 }, { failBeforeRename: true }]) {
      let result = null;
      assert.throws(
        () => {
          result = docs.saveDocument(dir, "ruff-api", "config", { expectedRevision: doc.revision, text }, { faults });
        },
        (e) => e.code === "WRITE_FAILED",
      );
      assert.equal(result, null);
      assert.ok(fs.readFileSync(file).equals(before));
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ["pyproject.toml"]);
    }
    // A change that lands while the temporary file is written is a conflict, not an overwrite.
    const external = PYPROJECT.replace("-q", "-x");
    const late = docs.saveDocument(dir, "ruff-api", "config", { expectedRevision: doc.revision, text }, { faults: { beforeCommit: () => fs.writeFileSync(file, external) } });
    assert.equal(late.status, "conflict");
    assert.equal(late.conflict.current.text, external);
    assert.equal(fs.readFileSync(file, "utf8"), external);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["pyproject.toml"]);
  });
});

test("validate checks YAML and JSON syntax without executing anything and says when TOML has no parser", () => {
  withProject(
    (dir) => {
      const all = cli(dir, ["tools", "config", "validate", "ruff-api"]);
      assert.equal(all.status, 0, all.stdout);
      assert.equal(all.doc.results[0].status, TOML_STATUS);
      assert.equal(all.doc.results[0].format, "toml");

      // The honest "unavailable" answer when no interpreter is reachable (empty PATH, no JGATES_PYTHON).
      const noPython = cli(dir, ["tools", "config", "validate", "ruff-api"], undefined, { PATH: "", JGATES_PYTHON: "" });
      assert.equal(noPython.doc.results[0].status, "unavailable");
      assert.match(noPython.doc.results[0].reason.message, /Validação de sintaxe indisponível/);

      const yaml = cli(dir, ["tools", "config", "validate", "pii-repo", "--file", "config"]);
      assert.equal(yaml.status, 3);
      assert.equal(yaml.doc.status, "INVALID");
      assert.equal(yaml.doc.results[0].status, "invalid");
      assert.equal(yaml.doc.results[0].errors[0].line, 2);

      const fixed = cli(dir, ["tools", "config", "validate", "pii-repo", "--file", "config", "--from", "-"], "entities:\n  cpf: true\n");
      assert.equal(fixed.status, 0);
      assert.equal(fixed.doc.results[0].status, "valid");
      assert.equal(fixed.doc.results[0].source, "text");

      const json = cli(dir, ["tools", "config", "validate", "data", "--from", "-", "--file", "config"], "{\n  \"a\": 1,\n}\n");
      assert.equal(json.status, 3);
      assert.equal(json.doc.results[0].format, "json");
      assert.equal(json.doc.results[0].errors[0].line, 3);

      const rules = cli(dir, ["tools", "config", "validate", "rules"]);
      assert.equal(rules.status, 0);
      assert.deepEqual(rules.doc.results.map((r) => r.entry).sort(), ["a.yml", "sub/b.yml"]);
    },
    { files: { ".jgates/pii.yml": "entities:\n  cpf: true\n   bad: [\n" } },
  );
});

test("invalid syntax is not saved unless the caller chooses it explicitly", () => {
  withProject((dir) => {
    const file = path.join(dir, ".jgates/pii.yml");
    const before = fs.readFileSync(file);
    const rev = sha(before);
    const bad = "entities:\n  cpf: [\n";
    const r = cli(dir, ["tools", "config", "write", "pii-repo", "--file", "config", "--if-match", rev, "--no-interactive"], bad);
    assert.equal(r.status, 3);
    assert.equal(r.doc.code, "DOCUMENT_INVALID");
    assert.ok(fs.readFileSync(file).equals(before));
    const forced = cli(dir, ["tools", "config", "write", "pii-repo", "--file", "config", "--if-match", rev, "--allow-invalid", "--no-interactive"], bad);
    assert.equal(forced.status, 0, forced.stdout);
    assert.equal(forced.doc.validation.status, "invalid");
    assert.equal(fs.readFileSync(file, "utf8"), bad);
  });
});

test("a missing file is reported absent, reading creates nothing, and --if-match absent creates it", () => {
  withProject((dir) => {
    const before = listTree(dir);
    const r = cli(dir, ["tools", "config", "read", "absent", "--file", "config"]);
    assert.equal(r.status, 0);
    assert.equal(r.doc.document.exists, false);
    assert.equal(r.doc.document.revision, null);
    assert.deepEqual(listTree(dir), before);
    // Parent folder missing: not writable through the editor.
    const w = cli(dir, ["tools", "config", "write", "absent", "--file", "config", "--if-match", "absent", "--no-interactive"], "x = 1\n");
    assert.equal(w.status, 3);
    assert.deepEqual(listTree(dir), before);

    const stale = cli(dir, ["tools", "config", "write", "later", "--file", "config", "--if-match", sha("x"), "--no-interactive"], "x = 1\n");
    assert.equal(stale.status, 3);
    assert.equal(stale.doc.conflict.current.exists, false);
    const created = cli(dir, ["tools", "config", "write", "later", "--file", "config", "--if-match", "absent", "--no-interactive"], "x = 1\n");
    assert.equal(created.status, 0, created.stdout);
    assert.equal(fs.readFileSync(path.join(dir, "later.toml"), "utf8"), "x = 1\n");
    const twice = cli(dir, ["tools", "config", "write", "later", "--file", "config", "--if-match", "absent", "--no-interactive"], "x = 2\n");
    assert.equal(twice.status, 3);
    assert.equal(twice.doc.code, "REVISION_CONFLICT");
  });
});

test("a binding with access: read, and a directory binding without an entry, are not written", () => {
  withProject((dir) => {
    const locked = cli(dir, ["tools", "config", "read", "locked", "--file", "config"]).doc.document;
    assert.equal(locked.state, "read-only");
    assert.equal(locked.reasons[0].code, "ACCESS_READ");
    const w = cli(dir, ["tools", "config", "write", "locked", "--file", "config", "--if-match", locked.revision, "--no-interactive"], "x = 2\n");
    assert.equal(w.status, 3);
    assert.equal(w.doc.code, "DOCUMENT_READ_ONLY");
    assert.equal(fs.readFileSync(path.join(dir, "locked.toml"), "utf8"), "x = 1\n");

    const dirRead = cli(dir, ["tools", "config", "read", "rules", "--file", "rules"]);
    assert.equal(dirRead.status, 3);
    assert.equal(dirRead.doc.code, "BINDING_IS_DIRECTORY");
    const entry = cli(dir, ["tools", "config", "read", "rules", "--file", "rules", "--entry", "sub/b.yml"]);
    assert.equal(entry.status, 0);
    assert.equal(entry.doc.document.text, "rules: []\n");
    const forged = cli(dir, ["tools", "config", "read", "rules", "--file", "rules", "--entry", "../../jgates.yml"]);
    assert.equal(forged.status, 3);
    assert.equal(forged.doc.code, "ENTRY_NOT_FOUND");
  });
});

test("previewEdit returns the diff and the validation without writing", () => {
  withProject((dir) => {
    const file = path.join(dir, "apps/api/pyproject.toml");
    const before = fs.readFileSync(file);
    const p = docs.previewEdit(dir, "ruff-api", "config", { text: PYPROJECT.replace("88", "100") });
    assert.equal(p.changed, true);
    assert.equal(p.revision, sha(before));
    assert.equal(
      p.diff,
      "--- a/apps/api/pyproject.toml\n+++ b/apps/api/pyproject.toml\n@@ -1,5 +1,5 @@\n [tool.ruff]\n-line-length = 88\n+line-length = 100\n \n [tool.pytest.ini_options]\n addopts = \"-q\"\n",
    );
    assert.equal(p.validation.status, TOML_STATUS);
    assert.ok(fs.readFileSync(file).equals(before));
    assert.equal(docs.previewEdit(dir, "ruff-api", "config", { text: PYPROJECT }).diff, "");
  });
});

test("unifiedDiff produces separate hunks and marks a missing final newline", () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const b = a.replace("l2\n", "L2\n").replace("l19\n", "L19\n");
  const d = docs.unifiedDiff(a, b);
  assert.equal((d.match(/^@@/gm) ?? []).length, 2);
  assert.match(d, /^@@ -1,5 \+1,5 @@$/m);
  assert.match(d, /^@@ -16,5 \+16,5 @@$/m);
  assert.equal(docs.unifiedDiff("x\n", "x"), "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+x\n\\ No newline at end of file\n");
  assert.equal(docs.unifiedDiff("", "a\n"), "--- a\n+++ b\n@@ -0,0 +1 @@\n+a\n");
  // Many scattered changes: applying the hunks to the old text gives the new text.
  const apply = (oldText, diff) => {
    const old = oldText.split("\n").slice(0, -1);
    const out = [];
    let at = 0;
    const lines = diff.split("\n").slice(2, -1);
    for (let i = 0; i < lines.length; i++) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(lines[i]);
      if (h) {
        const start = Number(h[2] === "0" ? Number(h[1]) : Number(h[1]) - 1);
        while (at < start) out.push(old[at++]);
        continue;
      }
      const kind = lines[i][0];
      if (kind === " ") out.push(old[at++]);
      else if (kind === "-") at++;
      else if (kind === "+") out.push(lines[i].slice(1));
    }
    while (at < old.length) out.push(old[at++]);
    return out.join("\n") + "\n";
  };
  const long1 = Array.from({ length: 3000 }, (_, i) => `x${i % 7}`).join("\n") + "\n";
  const long2 = Array.from({ length: 2900 }, (_, i) => `x${i % 5}`).join("\n") + "\n";
  for (const context of [0, 3]) assert.equal(apply(long1, docs.unifiedDiff(long1, long2, { context })), long2);
  const edited = long1.replace(/^x3$/gm, (m, off) => (off % 3 === 0 ? "y3" : m));
  assert.equal(apply(long1, docs.unifiedDiff(long1, edited)), edited);
});

test("governed files and files of an installed package are read-only for the editor", () => {
  withProject(
    (dir) => {
      const governed = docs.openDocument(dir, "ruff-api", "config", { governedRoots: [path.join(dir, "apps")] });
      assert.equal(governed.state, "governed");
      assert.throws(
        () => docs.saveDocument(dir, "ruff-api", "config", { expectedRevision: governed.revision, text: "x = 1\n" }, { governedRoots: [path.join(dir, "apps")] }),
        (e) => e.code === "DOCUMENT_READ_ONLY",
      );
      const pkg = docs.openDocument(dir, "later", "config");
      assert.equal(pkg.state, "package");
      assert.equal(fs.readFileSync(path.join(dir, "apps/api/pyproject.toml"), "utf8"), PYPROJECT);
    },
    { tools: "tools:\n  ruff-api:\n    adapter: ruff\n    config: apps/api/pyproject.toml\n  later:\n    adapter: x\n    config: node_modules/pkg/ruff.toml\n", files: { "node_modules/pkg/ruff.toml": "x = 1\n" } },
  );
});

test("config read without --json prints the text itself and the revision on stderr", () => {
  withProject((dir) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jg-doc-home-"));
    try {
      const r = spawnSync(process.execPath, [MAIN, "tools", "config", "read", "ruff-api", "--file", "config", "--cwd", dir], { encoding: "utf8", env: { ...process.env, JGATES_HOME: home } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, PYPROJECT);
      assert.equal(r.stderr, `revision ${sha(Buffer.from(PYPROJECT))}\n`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
