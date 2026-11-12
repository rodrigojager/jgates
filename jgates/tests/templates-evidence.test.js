import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The templates screen states a template activated by a file (docker-hadolint: a Dockerfile at the root) as matching
// when the file is there, and as not matching without it.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const { routes } = await import(pathToFileURL(path.join(dist, "server", "routes", "templates.js")).href);
const list = routes.find((r) => r.method === "GET" && r.path === "/api/config/templates");

const made = [];
// What `jgates init` writes for a template that comes in by evidence.
const ROOT_YAML = [
  "schemaVersion: 1",
  "templates:",
  "  - id: docker-hadolint",
  "    source: builtin:docker-hadolint",
  "    activation: detected",
  "  - id: shell-shellcheck",
  "    source: builtin:shell-shellcheck",
  "    activation: detected",
  "",
].join("\n");
const project = (extra) => {
  const files = { "jgates.yml": ROOT_YAML, ...extra };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jgates-tpl-evidence-")));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const statusOf = (dir, id) => {
  const server = { projectDir: dir, policyMode: false, workspace: { id: "w", path: dir, name: "w" }, home: dir, log() {} };
  const body = list.handler({ params: {}, query: {}, server }).json;
  const row = body.templates.find((t) => t.id === id);
  return `${row?.status}:${row?.components.length > 0 ? "matching" : "none"}`;
};

test("hadolint template matches when a Dockerfile sits at the workspace root", () => {
  const dir = project({ Dockerfile: "FROM alpine:3.20\n", "package.json": '{"name":"x"}\n' });
  assert.equal(statusOf(dir, "docker-hadolint"), "DETECTED:matching");
});

test("hadolint template does not match without a Dockerfile", () => {
  const dir = project({ "package.json": '{"name":"x"}\n' });
  assert.equal(statusOf(dir, "docker-hadolint"), "NOT_DETECTED:none");
});

test("shellcheck template matches by its evidence file only when present", () => {
  const dir = project({ "run.sh": "#!/bin/sh\necho hi\n" });
  const status = statusOf(dir, "shell-shellcheck");
  assert.equal(status, "DETECTED:matching");
});
