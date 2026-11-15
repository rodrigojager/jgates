import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-83 (real engine): the Semantic test execution runs in containers of the tools image. A small Node.js project has a
// bug and a patch. The reproducer (a node:test file) is run through the Semantic test-file runner the way
// post-patch-validation and `jgates regressions validate` run it: on the tree "before" the patch it really fails, on the
// tree "after" it really passes, each run inside a container of jgates-tools:dev (the tree read-only at /workspace, no
// network, the step user). A reproducer that opens a network connection fails because there is no network, and one that
// writes outside its temporary folder fails because the tree and the root are read-only. The project folder (it is the
// source of the trees, never mounted) is byte for byte the same afterwards, and no container and no JGates temporary
// file is left. Every object the test creates in the engine carries its workspace id; the cleanup selects by it only.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const IMAGE = "jgates-tools:dev";
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const workspace = `v2-83-${crypto.randomBytes(4).toString("hex")}`;
const workspaceFilter = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];

// The cleanup is a hook of the test itself, not of the file: under the harness, a root `after` hook registered once the
// root has nothing pending (the case run alone with --test-name-pattern, after filtered cases) runs at once, before the
// test made anything.
function cleanup() {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  for (const id of docker(["ps", "-aq", ...workspaceFilter]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
}

/** Hash of the whole tree: relative paths, sizes, mtimes and contents, in a stable order. */
function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        hash.update(`d:${next}\0`);
        walk(full, next);
      } else hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

const tempEntries = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => /^jgates/i.test(n)));

const PAGINATE_BUGGY = [
  "export function paginate(list, size) {",
  "  const pages = [];",
  "  for (let start = 0; start < list.length; start += size) {",
  "    const end = start + size + 1;",
  "    pages.push(list.slice(start, end));",
  "  }",
  "  return pages;",
  "}",
  "",
].join("\n");
const PAGINATE_FIXED = PAGINATE_BUGGY.replace("start + size + 1;", "start + size;");

const REPRODUCER = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { paginate } from "../../src/paginate.js";',
  "",
  'test("every page holds at most size items", () => {',
  "  const pages = paginate([1, 2, 3, 4], 2);",
  "  for (const [i, page] of pages.entries()) assert.ok(page.length <= 2, `page ${i + 1} of size 2 has ${page.length} items`);",
  "});",
  "",
].join("\n");

const NETWORK_REPRODUCER = [
  'import test from "node:test";',
  'import net from "node:net";',
  "",
  'test("the service answers", async () => {',
  "  await new Promise((resolve, reject) => {",
  '    const socket = net.connect({ host: "93.184.216.34", port: 80, timeout: 5000 }, () => { socket.destroy(); resolve(); });',
  '    socket.on("error", reject);',
  '    socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });',
  "  });",
  "});",
  "",
].join("\n");

const WRITE_REPRODUCER = [
  'import test from "node:test";',
  'import fs from "node:fs";',
  "",
  'test("the report is written next to the code", () => {',
  '  fs.writeFileSync("/workspace/report.txt", "leak");',
  "});",
  'test("the report is written outside the tree", () => {',
  '  fs.writeFileSync("/etc/jgates-report.txt", "leak");',
  "});",
  "",
].join("\n");

const REPRODUCER_PATH = ".jgates/regressions/paginate-pages.test.mjs";

test("V2-83 (real engine): the reproducer fails before the patch and passes after it inside the container, the sandbox holds, and nothing is left behind", async (t) => {
  t.after(cleanup);
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const runner = await load("core", "regressions", "runner.js");
  const fixtures = await load("core", "regressions", "fixture.js");

  // The container engine and the image are the real ones (the node test runs name a missing engine by default).
  const env = { ...process.env, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;
  const home = tmp("v2-83-home-");
  const prepared = await runner.testEnvironment({ env, home, workspace, run: "v2-83" });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  const environment = prepared.environment;
  assert.equal(environment.runtime.mode, "container", "the tests run in a container, not natively");

  // The project: a small Node.js package with the bug (the "before" tree); the patch fixes src/paginate.js.
  const project = tmp("v2-83-project-");
  for (const [rel, content] of Object.entries({
    "package.json": JSON.stringify({ name: "v2-83-project", version: "1.0.0", type: "module" }, null, 2) + "\n",
    "src/paginate.js": PAGINATE_BUGGY,
    [REPRODUCER_PATH]: REPRODUCER,
  })) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  }
  const hashBefore = treeHash(project);
  const tempBefore = tempEntries();

  const source = fixtures.workspaceFiles(project, env);
  assert.ok("files" in source, JSON.stringify(source));
  const withPatch = (files) => files.map((f) => (f.path === "src/paginate.js" ? { ...f, content: PAGINATE_FIXED } : f));
  const runIn = async (name, files) => {
    const dir = path.join(tmp(`v2-83-${name}-`), "tree");
    const fixture = fixtures.writeFixture(dir, files, { mountPoints: [] });
    try {
      return await runner.runTestFile(environment, fixture, REPRODUCER_PATH);
    } finally {
      fixtures.removeFixture(dir);
    }
  };

  // 1. Before the patch the reproducer fails, in a container of the tools image; after it, it passes.
  const before = await runIn("before", source.files);
  assert.equal(before.executed, true, before.reason ?? "");
  assert.equal(before.outcome, "failed", `${before.reason ?? ""}\n${before.output}`);
  assert.match(before.output, /page \d of size 2 has [3-9] items/, "it fails for the bug");
  const placement = before.container;
  assert.equal(placement?.mode, "container");
  assert.equal(placement.network, "none");
  assert.equal(placement.readOnlyTree, true);
  assert.equal(placement.readOnlyRoot, true);
  assert.ok(!/^(0|root)(:|$)/.test(placement.user), `the test does not run as root (${placement.user})`);
  assert.match(placement.image, /^sha256:/, "the image is pinned by its id");
  const after = await runIn("after", withPatch(source.files));
  assert.equal(after.executed, true, after.reason ?? "");
  assert.equal(after.outcome, "passed", `${after.reason ?? ""}\n${after.output}`);
  assert.deepEqual(after.tests && { total: after.tests.total, fail: after.tests.fail }, { total: 1, fail: 0 });

  // 2. A reproducer that opens a network connection fails because the container has no network.
  const swap = (content) => source.files.map((f) => (f.path === REPRODUCER_PATH ? { ...f, content } : f));
  const network = await runIn("network", swap(NETWORK_REPRODUCER));
  assert.equal(network.executed, true, network.reason ?? "");
  assert.equal(network.outcome, "failed", `${network.reason ?? ""}\n${network.output}`);
  assert.match(network.output, /ENETUNREACH|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/, `it fails for the missing network: ${network.output}`);
  assert.doesNotMatch(network.output, /timeout/i, "the connection did not hang until a timeout");

  // 3. A reproducer that writes outside its temporary folder fails because the tree and the root are read-only.
  const writes = await runIn("writes", swap(WRITE_REPRODUCER));
  assert.equal(writes.executed, true, writes.reason ?? "");
  assert.equal(writes.outcome, "failed", `${writes.reason ?? ""}\n${writes.output}`);
  assert.equal(writes.tests?.fail, 2, `both writes failed: ${writes.output}`);
  assert.match(writes.output, /EROFS|EACCES|EPERM/, `it fails for the read-only filesystem: ${writes.output}`);

  // 4. The project folder is byte for byte the same, and nothing is left: no container, no JGates temporary file.
  assert.equal(treeHash(project), hashBefore, "the project folder is identical afterwards");
  assert.equal(fs.existsSync(path.join(project, "report.txt")), false);
  assert.equal(docker(["ps", "-aq", ...workspaceFilter]).out.trim(), "", "no test container is left");
  assert.equal(docker(["ps", "-aq", "--filter", "label=org.jgates.managed=true", "--filter", "name=jgates-test-"]).out.trim(), "", "no test container of this suite is left by name");
  // (This case's own folders are named v2-83-*, so any new jgates* entry in the temporary folder is JGates' own.)
  assert.deepEqual([...tempEntries()].filter((n) => !tempBefore.has(n)), [], "no JGates temporary file is left");
});
