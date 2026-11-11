import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The extension image of a project (core/extension): its key, the lines add-custom writes, the diff it shows and the
// images a plan pins. The engine itself is the fake runtime of the acceptance case V2-48 and the real engine of
// tests/docker/extension.test.js.

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (...parts) => import(pathToFileURL(path.join(here, "..", "dist", ...parts)).href);
const ext = await load("core", "extension", "index.js");

const made = [];
const project = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-ext-"));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const DOCKERFILE = "ARG JGATES_TOOLS\nFROM ${JGATES_TOOLS}\nRUN true\n";
const BASE = `sha256:${"1".repeat(64)}`;

test("extension key: no Dockerfile, no key; the key moves with the Dockerfile, a copied file and the base digest, and with nothing else", () => {
  assert.equal(ext.extensionKey(project(), BASE), null);
  const dir = project({ ".jgates/image/Dockerfile": DOCKERFILE, ".jgates/image/tool.sh": "echo 1\n", "app.py": "x = 1\n" });
  const key = ext.extensionKey(dir, BASE);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(ext.extensionKey(dir, BASE), key, "same inputs, same key");
  fs.writeFileSync(path.join(dir, "app.py"), "x = 2\n");
  assert.equal(ext.extensionKey(dir, BASE), key, "a project file outside .jgates/image is not part of the key");
  fs.writeFileSync(path.join(dir, ".jgates", "image", "tool.sh"), "echo 2\n");
  const copied = ext.extensionKey(dir, BASE);
  assert.notEqual(copied, key, "a copied file moves the key");
  fs.appendFileSync(path.join(dir, ".jgates", "image", "Dockerfile"), "RUN true\n");
  const changed = ext.extensionKey(dir, BASE);
  assert.notEqual(changed, copied, "the Dockerfile moves the key");
  assert.notEqual(ext.extensionKey(dir, `sha256:${"2".repeat(64)}`), changed, "a new tools image moves the key");
});

test("extension tag: one fixed tag per workspace and key", () => {
  const tag = ext.extensionTag("ws_0123456789abcdef", "ab".repeat(32));
  assert.equal(tag, "jgates-ext-ws_0123456789abcdef:abababababababab");
  assert.equal(ext.extensionRepository("ws_0123456789abcdef"), "jgates-ext-ws_0123456789abcdef");
});

test("the Dockerfile must read the tools image through the JGATES_TOOLS build argument", async () => {
  const { dockerfileUsesBase } = await load("core", "extension", "build.js");
  assert.equal(dockerfileUsesBase(DOCKERFILE), true);
  assert.equal(dockerfileUsesBase("FROM jgates-tools\n"), false);
  assert.equal(dockerfileUsesBase("ARG JGATES_TOOLS\nFROM python:3\n"), false);
});

test("install lines: pip, npm, apt and a checksummed binary become Dockerfile lines; shell text and unpinned downloads are refused", () => {
  assert.match(ext.installLines("pip:bandit==1.8.0").join("\n"), /uv tool install --no-cache 'bandit==1\.8\.0'$/);
  assert.match(ext.installLines("pip:bandit[sarif]==1.8.6").join("\n"), /'bandit\[sarif\]==1\.8\.6'$/);
  assert.match(ext.installLines("npm:@scope/lint@9").join("\n"), /npm install --global --prefix \/usr\/local '@scope\/lint@9'$/);
  assert.match(ext.installLines("apt:cppcheck").join("\n"), /apt-get install -y --no-install-recommends 'cppcheck'/);
  const sum = "a".repeat(64);
  assert.deepEqual(ext.installLines(`binary:https://example.org/dl/scanner#sha256=${sum}`), [`ADD --checksum=sha256:${sum} https://example.org/dl/scanner /usr/local/bin/scanner`, "RUN chmod 0755 /usr/local/bin/scanner"]);
  for (const bad of ["pip:x; rm -rf /", "pip:$(id)", "pip:a b", "pip:", "gem:x", "binary:https://example.org/x", "binary:http://example.org/x#sha256=" + sum, "npm:`id`", "apt:x&&y"]) {
    assert.throws(() => ext.installLines(bad), (error) => error instanceof ext.CustomToolError && error.code === "INSTALL_INVALID", bad);
  }
});

test("dockerfileAfter: a new Dockerfile gets the base lines, an existing one keeps its text, and a repeated line is not written twice", () => {
  const lines = ext.installLines("pip:bandit==1.8.0");
  const created = ext.dockerfileAfter(null, lines);
  assert.equal(created, `ARG JGATES_TOOLS\nFROM \${JGATES_TOOLS}\nUSER root\n${lines.join("\n")}\nUSER 10001:10001\n`);
  const extended = ext.dockerfileAfter(created, ext.installLines("pip:ruff==0.5.0"));
  assert.ok(extended.startsWith(created), "the existing text is kept as it was");
  assert.match(extended, /ruff==0\.5\.0/);
  assert.equal(ext.dockerfileAfter(created, lines), created, "the same line again changes nothing");
});

test("parseReport: the formats add-custom accepts, with the file name of a report", () => {
  assert.deepEqual(ext.parseReport("sarif:out.sarif"), { format: "sarif", file: "out.sarif" });
  assert.deepEqual(ext.parseReport("exit-code"), { format: "exit-code" });
  for (const bad of ["sarif", "sarif:", "sarif:../x", "pdf:x", "exit-code:x", "junit:a/b.xml"]) {
    assert.throws(() => ext.parseReport(bad), (error) => error instanceof ext.CustomToolError && error.code === "REPORT_INVALID", bad);
  }
});

const REQUEST = { id: "my-lint", install: ["pip:acme-lint==1.0"], command: "acme-lint", args: ["--out={output}/r.sarif", "{component}"], report: { format: "sarif", file: "r.sarif" }, capabilities: ["sast"], network: false };

test("planCustomTool: the entry, the placeholders of the plan's wording and the diff, with nothing written", () => {
  const dir = project({ ".jgates/tools.yml": "schemaVersion: 1\ntools:\n  existing:\n    adapter: ruff\n" });
  const plan = ext.planCustomTool(dir, REQUEST);
  assert.equal(plan.image, "extension");
  assert.equal(plan.needsBuild, true);
  assert.equal(plan.entry.adapter, "generic-command");
  assert.deepEqual(plan.entry.args, ["--out={outputDir}/r.sarif", "{componentRoot}"]);
  assert.deepEqual(plan.entry.config.evidence, { kind: "sarif", file: "r.sarif" });
  assert.equal(plan.entry.config.effects.usesNetwork, false);
  const tools = plan.changes.find((c) => c.file === ".jgates/tools.yml");
  assert.match(tools.diff, /^\+\s+my-lint:/m);
  assert.ok(tools.after.includes("existing:\n    adapter: ruff"), "the existing entry is kept");
  assert.match(plan.changes.find((c) => c.file === ".jgates/image/Dockerfile").diff, /\+USER root/);
  assert.equal(fs.existsSync(path.join(dir, ".jgates", "image")), false, "planning writes nothing");
  assert.equal(fs.readFileSync(path.join(dir, ".jgates", "tools.yml"), "utf8"), "schemaVersion: 1\ntools:\n  existing:\n    adapter: ruff\n");
});

test("planCustomTool: refuses an existing id, a bad id, no capability, no command, --image with --install, and a bad timeout", () => {
  const dir = project({ ".jgates/tools.yml": "schemaVersion: 1\ntools:\n  my-lint:\n    adapter: ruff\n" });
  const code = (request, at = dir) => {
    try {
      ext.planCustomTool(at, request);
    } catch (error) {
      return error.code;
    }
    return null;
  };
  assert.equal(code(REQUEST), "ID_EXISTS");
  assert.equal(code({ ...REQUEST, id: "Bad Id" }), "ID_INVALID");
  assert.equal(code({ ...REQUEST, id: "other", capabilities: [] }), "CAPABILITY_REQUIRED");
  assert.equal(code({ ...REQUEST, id: "other", command: " " }), "COMMAND_REQUIRED");
  assert.equal(code({ ...REQUEST, id: "other", image: "ghcr.io/acme/scanner:2.1" }), "IMAGE_AND_INSTALL");
  assert.equal(code({ ...REQUEST, id: "other", timeoutSeconds: 0 }), "TIMEOUT_INVALID");
  const ready = ext.planCustomTool(dir, { ...REQUEST, id: "other", install: [], image: "ghcr.io/acme/scanner:2.1" });
  assert.equal(ready.entry.image, "ghcr.io/acme/scanner:2.1");
  assert.equal(ready.changes.length, 1, "a ready image needs no Dockerfile");
  assert.equal(ready.needsBuild, false);
});

test("writeCustomTool writes both files, the Dockerfile first", () => {
  const dir = project();
  const written = ext.writeCustomTool(dir, ext.planCustomTool(dir, REQUEST));
  assert.deepEqual(written, [".jgates/image/Dockerfile", ".jgates/tools.yml"]);
  assert.match(fs.readFileSync(path.join(dir, ".jgates", "image", "Dockerfile"), "utf8"), /acme-lint==1\.0/);
  assert.match(fs.readFileSync(path.join(dir, ".jgates", "tools.yml"), "utf8"), /image: extension/);
});

test("stepImageOf: the tools image for a plain tool, the pinned id for the extension and for a ready image", () => {
  const images = [
    { name: "ghcr.io/acme/scanner:2.1", digest: "sha256:r" },
    { name: "jgates-ext-ws_1:abc", digest: "sha256:e" },
  ];
  assert.equal(ext.stepImageOf(undefined, images), null);
  assert.equal(ext.stepImageOf("tools", images), null);
  assert.equal(ext.stepImageOf("extension", images), "sha256:e");
  assert.equal(ext.stepImageOf("ghcr.io/acme/scanner:2.1", images), "sha256:r");
  assert.equal(ext.stepImageOf("extension", []), null, "an image the plan did not pin is not guessed");
});
