import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadLinters } from "../../jgates/dist/adapters/linter/index.js";
import { workspaceId } from "../../jgates/dist/core/ids/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const main = path.join(root, "jgates/dist/cli/main.js");
const fixtures = path.join(root, "jgates/tests/fixtures/linters");
const pin = JSON.parse(fs.readFileSync(path.join(root, "jgates/release/tools-image.json"), "utf8"));
const image = pin.reference;
const extendedToggle = "rumdl";

function command(program, args, opts = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8", input: "", timeout: 2_400_000, maxBuffer: 64 * 1024 * 1024, ...opts,
  });
  assert.ifError(result.error);
  return result;
}

function docker(...args) {
  const result = command("docker", args);
  assert.equal(result.status, 0, `docker ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function write(dir, relative, data) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

function tree(dir, relative = "") {
  return fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return [[name, "directory"], ...tree(dir, name)];
    return [[name, createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex")]];
  });
}

function fixturePath(tool, relative) {
  // Keep project-wide configuration at the root and give colliding files their own directories.
  if ((tool === "dustilock" && relative === "package.json") || (tool === "lychee" && relative === "notes.md")) {
    return `${tool}/${relative}`;
  }
  return relative;
}

const adapterStages = [
  ["shellcheck#lint", "shellcheck", "SC2086", ["scripts/deep/deploy.sh"]],
  ["hadolint#lint", "hadolint", "DL3007", ["containers/deep/Containerfile"]],
  ["dotnet-format#format-check", "dotnet-format", "format-check.unformatted", ["dotnet/Program.cs"]],
  ["prettier-data#format-check", "prettier", "format-check.unformatted", ["config/app.json", "config/deep/stack.yaml"]],
  ["mypy#typecheck", "mypy", "arg-type", ["python/app.py"]],
  ["pyright#typecheck", "pyright", "reportArgumentType", ["python/app.py"]],
  ["trivy-sbom#sbom"],
];

function populateAdapters(project, side) {
  const copy = (suite, stack, file, dest = file) => {
    write(project, dest, fs.readFileSync(path.join(fixtures, "..", suite, stack, side, file)));
  };
  copy("lint-stacks", "shell", "deploy.sh", "scripts/deep/deploy.sh");
  copy("lint-stacks", "docker", "Dockerfile", "containers/deep/Containerfile");
  for (const file of ["FormatFixture.csproj", "Program.cs"]) copy("format-check", "csharp", file, `dotnet/${file}`);
  for (const file of ["config/app.json", "config/deep/stack.yaml"]) copy("format-check", "data", file);
  copy("build-check", "python", "app.py", "python/app.py");
  write(project, "python/pyproject.toml", '[project]\nname = "parity-types"\nversion = "0.1.0"\n');
  const templates = ["shell-shellcheck", "docker-hadolint", "dotnet-format", "data-prettier", "python-mypy-defaults"];
  write(project, "jgates.yml", [
    "schemaVersion: 1", "selection:", "  profile: parity-strict", "templates:",
    ...templates.flatMap((id) => [`  - id: ${id}`, `    source: builtin:${id}`]), "",
  ].join("\n"));
  write(project, ".jgates/profiles.yml", [
    "schemaVersion: 1", "profiles:", "  parity-strict:", "    extends: builtin:strict",
    "    checks:", "      capability:unit: { enabled: false }", "      capability:coverage: { enabled: false }", "",
  ].join("\n"));
  write(project, ".jgates/tools.yml", "schemaVersion: 1\ntools:\n  trivy-sbom:\n    adapter: trivy\n    capabilities: [sbom]\n");
}

function populate(project, side, tools, profile, concurrency) {
  for (const { id } of tools) {
    const dir = path.join(fixtures, id, side);
    for (const [relative, kind] of tree(dir)) {
      if (kind === "directory") continue;
      if (id === "helm" && ["Chart.yaml", "values.yaml"].includes(relative)) continue;
      if (id === "syft" && relative === "package-lock.json") continue; // Reuse the Grype lockfile.
      const target = fixturePath(id, relative);
      assert.ok(!fs.existsSync(path.join(project, target)), `fixture collision: ${id}/${relative}`);
      const data = fs.readFileSync(path.join(dir, relative));
      // Helm reports a missing icon, while Kubescape still gets a valid chart and can scan its deployment.
      if (id === "kubescape" && relative === "Chart.yaml" && side === "bad") {
        write(project, target, data.toString("utf8").replace(/^icon:.*\r?\n/m, ""));
      } else {
        write(project, target, data);
      }
    }
  }
  // The v8r fixture deliberately breaks tsconfig.json. Give the TypeScript linter a separate valid project.
  write(project, "tsconfig.eslint.json", JSON.stringify({
    compilerOptions: { target: "ES2022", strict: true, noEmit: true, types: [] },
    include: ["ts-std-sample.ts"],
  }, null, 2) + "\n");
  // PHPStan halts analysis on syntax errors. The standalone syntax checker still receives this file.
  write(project, "phpstan.neon", "parameters:\n  level: 0\n  excludePaths:\n    analyse:\n      - Syntax.php\n");
  const editorConfig = fs.readFileSync(path.join(project, ".editorconfig"), "utf8");
  write(project, ".editorconfig", editorConfig + "\n[*.{sh,go,rst}]\nindent_size = unset\nindent_style = unset\n\n[Makefile]\nindent_style = tab\n");
  const edit = (file, changes) => write(project, file, changes(fs.readFileSync(path.join(project, file), "utf8")));
  write(project, ".csharpierrc.json", "{\"indentSize\":4}\n");
  write(project, ".cspell.json", JSON.stringify({ version: "0.2", words: ["defn", "htmlhint", "jgates", "webchart"], ignorePaths: ["**/jgates.yml"] }) + "\n");
  write(project, ".yamllint.yml", [
    "extends: default", "ignore: |", "  templates/**", "rules:", "  document-start: disable",
    "  line-length:", "    max: 120", "  truthy:", "    check-keys: false", "",
  ].join("\n"));
  edit(".ls-lint.yml", (text) => text + "\nignore:\n  - force-app\n");
  if (side === "clean") {
    // A Lightning Web Component is an HTML fragment and cannot declare a document type.
    edit("force-app/main/default/lwc/accountCard/accountCard.html", (text) => "<!-- htmlhint doctype-first:false -->\n" + text);
    // Schema validation and security scanning see the same hardened Deployment.
    const deployment = fs.readFileSync(path.join(project, "templates/deployment.yaml"), "utf8");
    write(project, "kubeconform_deployment.yaml", deployment.replace("{{ .Values.image }}", "nginx:1.27"));
    const dotenv = fs.readFileSync(path.join(project, "settings.env"), "utf8");
    write(project, "settings.env", dotenv.replace(/^DATABASE_URL=.*$/m, "SERVICE_PORT=8080"));
    edit("Calc.csproj", (text) => text.replace(/^ +/gm, (indent) => indent.repeat(2)));
    edit("readme.md", (text) => text.replace("# Readme", "# README"));
    write(project, "table.md", "# Table\n\n| Item  | Count |\n|-------|-------|\n| Apple | 2     |\n");
    for (const file of [
      "digest.js",
      "bad-name.js",
      "force-app/main/default/aura/accountPanel/accountPanelController.js",
      "force-app/main/default/lwc/accountCard/accountCard.js",
    ]) {
      if (!fs.existsSync(path.join(project, file))) continue;
      edit(file, (text) => text.replace(/^ {4,}/gm, (indent) => " ".repeat(indent.length / 2))
        .replaceAll('"', "'").replace(/;$/gm, "").replace(/\((?=[^)]+\) \{)/g, " (")
        .replace("connectedCallback()", "connectedCallback ()").replace("require('crypto')", "require('node:crypto')"));
    }
  }
  write(project, "jgates.yml", JSON.stringify({
    schemaVersion: 1,
    ...(profile ? { selection: { profile } } : {}),
    ...(concurrency ? { execution: { concurrency } } : {}),
  }, null, 2) + "\n");
  write(project, ".jgates/profiles.yml", JSON.stringify({
    schemaVersion: 1,
    profiles: {
      "parity-strict": { extends: "builtin:strict", checks: {
        "capability:unit": { enabled: false }, "capability:coverage": { enabled: false },
      } },
      parity: { extends: "builtin:standard", checks: { [`tool:${extendedToggle}`]: { enabled: true } } },
    },
  }, null, 2) + "\n");

  // Container sync takes executable bits from Git, including on Windows.
  const git = command("git", ["init", "-q"], { cwd: project });
  assert.equal(git.status, 0, git.stderr);
  // A whitespace problem in repository metadata must not affect the source verdict.
  if (side === "clean") write(project, ".git/info/metadata.txt", "Git metadata  \n");
  const scripts = tree(project).map(([file]) => file).filter((file) =>
    !file.startsWith(".git/") && file.endsWith(".sh") && !(side === "bad" && file === "not-executable.sh"));
  const emptyBlob = command("git", ["hash-object", "-w", "--stdin"], { cwd: project });
  assert.equal(emptyBlob.status, 0, emptyBlob.stderr);
  const modes = command("git", ["update-index", "--index-info"], {
    cwd: project, input: scripts.map((script) => `100755 ${emptyBlob.stdout.trim()}\t${script}\n`).join(""),
  });
  assert.equal(modes.status, 0, modes.stderr);
}

const fileOf = (finding) => (finding.location?.path ?? ".").replaceAll("\\", "/");
const findingKey = (tool, rule, file) => `${tool} ${rule} ${file}`;
const keyOf = (finding) => findingKey(finding.tool, finding.ruleId, fileOf(finding));
const sorted = (items) => [...items].sort();

function parityContext(t) {
  const projects = [];
  let scratch;
  t.after(() => {
    try {
      for (const id of projects) {
        const labels = ["--filter", "label=jproject.project=jgates", "--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${id}`];
        for (const container of docker("ps", "-aq", ...labels)) docker("rm", "-f", container);
        for (const network of docker("network", "ls", "-q", ...labels)) docker("network", "rm", network);
        for (const volume of docker("volume", "ls", "-q", ...labels)) docker("volume", "rm", volume);
      }
    } finally {
      if (scratch) fs.rmSync(scratch, { force: true, recursive: true, maxRetries: 5, retryDelay: 500 });
    }
  });

  assert.deepEqual(docker("image", "inspect", image, "--format", "{{.Id}}"), [pin.digest]);
  const containerScratch = path.join(root, "..", "_work", "00-tmp");
  const scratchBase = process.env.JGATES_E2E_TMP || (fs.existsSync(containerScratch) ? containerScratch : os.tmpdir());
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchBase, "v2-105-")));
  const temp = path.join(scratch, "tmp");
  fs.mkdirSync(temp);
  const env = {
    ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, JGATES_HOME: path.join(scratch, "home"),
    JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: image, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en",
    JGATES_POLICY_DIR: "", JGATES_POLICY_SHA256: "", NO_COLOR: "1",
  };
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;
  function project(name, populateProject) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir);
    const id = workspaceId(dir);
    projects.push(id);
    populateProject(dir);
    const before = tree(dir);
    const cli = (verb, args = []) => {
      const result = command(process.execPath, [main, verb, "--cwd", dir, "--json", ...args], {
        cwd: dir, env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      });
      try {
        return { code: result.status, doc: JSON.parse(result.stdout) };
      } catch {
        assert.fail(`jgates ${verb} exit ${result.status}: ${result.stderr}\n${result.stdout.slice(0, 2000)}`);
      }
    };
    return { cli, verify() {
      assert.deepEqual(tree(dir), before, `${name}: project files changed`);
      assert.deepEqual(docker("ps", "-aq", "--filter", `label=org.jgates.workspace=${id}`), [], `${name}: containers remained after jgates run`);
    } };
  }
  return { env, project };
}

test("V2-105 (real engine): parity findings, clean twin, profile tiers, concurrency and untouched workspaces", { timeout: 14_400_000 }, async (t) => {
  const { env, project } = parityContext(t);
  const tools = loadLinters(env).map(({ descriptor }) => descriptor);
  assert.ok(tools.length > 0, "the image and build must provide the linter catalog");
  const ids = new Set(tools.map(({ id }) => id));
  const strict = sorted(ids);
  const balanced = sorted(tools.filter(({ place }) => place.tier === "main").map(({ id }) => id));
  const expected = new Map(tools.map(({ id }) => {
    const { findings } = JSON.parse(fs.readFileSync(path.join(fixtures, id, "expected.json"), "utf8"));
    assert.ok(findings.length > 0, `${id}: the defective fixture must have an expected finding`);
    return [id, findings.map(({ file, rule }) => findingKey(id, rule, fixturePath(id, file ?? ".")))];
  }));

  function run(name, side, profile, expectedTools, concurrency) {
    const { cli, verify } = project(name, (dir) => populate(dir, side, tools, profile, concurrency));
    const planned = cli("plan");
    assert.equal(planned.code, 0, JSON.stringify(planned.doc.blockers ?? planned.doc));
    const { willRun, notApplicableOrDisabled } = planned.doc.plan.groups;
    const selected = new Set(willRun.filter(({ tool }) => ids.has(tool)).map(({ tool }) => tool));
    assert.deepEqual(sorted(selected), expectedTools, JSON.stringify(notApplicableOrDisabled.filter(({ tool }) => expectedTools.includes(tool) && !selected.has(tool)).map(({ tool, reason }) => [tool, reason])));

    // The parity corpus contains purposefully bad inputs for other adapters too. Restrict the run to the descriptor tools.
    const skip = expectedTools.length === 0 ? [] : [...new Set(willRun.map(({ tool }) => tool))].filter((tool) => !ids.has(tool)).flatMap((tool) => ["--skip", `tool:${tool}`]);
    const start = Date.now();
    const { code, doc } = cli("run", ["--no-interactive", ...skip]);
    assert.ok(Array.isArray(doc.stages), JSON.stringify(doc));
    const duration = (Date.now() - start) / 1000;
    const stages = doc.stages ?? [];
    const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    const stepStarts = events.filter(({ type }) => type === "step-started");
    const limits = new Set(stepStarts.map(({ data }) => data.concurrency));
    assert.equal(limits.size, 1, `${name}: inconsistent concurrency limits`);
    if (concurrency) assert.deepEqual([...limits], [concurrency]);
    t.diagnostic(`${name}: ${duration.toFixed(1)} s, ${stepStarts.length} steps, concurrency ${[...limits][0]}, exit ${code}`);
    const unfinished = stages.filter(({ adapter, state }) => ids.has(adapter) && state !== "completed");
    const stageIds = new Set(stages.map(({ id }) => id));
    const absent = willRun.filter(({ id, tool }) => ids.has(tool) && !stageIds.has(id)).map(({ id }) => id);
    const found = new Set(doc.findings.filter(({ tool }) => ids.has(tool)).map(keyOf));
    const missing = side === "bad" ? expectedTools.filter((tool) => !expected.get(tool).some((key) => found.has(key))) : [];
    verify();
    assert.ok(!(absent.length || unfinished.length || missing.length), JSON.stringify({
      decision: doc.decision, absent, unfinished: unfinished.map(({ id, state, reason }) => [id, state, reason?.slice(0, 300)]),
      missing: missing.map((tool) => ({ expected: expected.get(tool), actual: [...found].filter((key) => key.startsWith(`${tool} `)).slice(0, 12) })),
      ...(side === "clean" ? { cleanFindings: sorted(found) } : {}),
    }));
    assert.deepEqual(sorted(new Set(stages.filter(({ adapter }) => ids.has(adapter)).map(({ adapter }) => adapter))), expectedTools);
    assert.notEqual(doc.partial, true);
    assert.ok([0, 1].includes(code), JSON.stringify(doc.decision));
    if (side === "clean") {
      assert.deepEqual(sorted(found), [], "the clean twin has no findings");
      assert.equal(code, 0, JSON.stringify(doc.decision));
    }
    return { decision: doc.decision, stages: stages.map(({ id, state }) => [id, state]), findings: sorted(doc.findings.map((f) => JSON.stringify([keyOf(f), f.severity, f.location?.line, f.location?.column, f.blocking]))) };
  }

  await t.test("Strict serial and automatic are equivalent", () => {
    const serial = run("strict-serial", "bad", "parity-strict", strict, 1);
    const automatic = run("strict-auto", "bad", "parity-strict", strict);
    assert.deepEqual(automatic, serial, "Strict gives the same result at serial and automatic concurrency");
  });
  await t.test("Strict clean twin", () => run("strict-clean", "clean", "parity-strict", strict));
  await t.test("Balanced main tier", () => run("balanced", "bad", "builtin:standard", balanced));
  await t.test("Essential core tier", () => run("essential", "bad", "builtin:minimal", []));
  await t.test("Balanced project override", () => run("balanced-with-override", "bad", "parity", sorted([...balanced, extendedToggle])));
});

test("V2-105 (adapter parity): Strict findings and CycloneDX artifact", { timeout: 900_000 }, async (t) => {
  const { project } = parityContext(t);
  for (const side of ["bad", "clean"]) {
    await t.test(`Strict parity of completed adapters (${side})`, () => {
      const { cli, verify } = project(`adapters-${side}`, (dir) => populateAdapters(dir, side));
      const planned = cli("plan");
      assert.equal(planned.code, 0, JSON.stringify(planned.doc.blockers ?? planned.doc));
      const selected = new Set(adapterStages.map(([id]) => id));
      const { willRun, notApplicableOrDisabled } = planned.doc.plan.groups;
      assert.deepEqual(sorted(willRun.filter(({ id }) => selected.has(id)).map(({ id }) => id)), sorted(selected),
        JSON.stringify(notApplicableOrDisabled.filter(({ id }) => selected.has(id))));
      const skip = [...new Set(willRun.filter(({ id }) => !selected.has(id)).map(({ tool }) => tool))]
        .flatMap((tool) => ["--skip", `tool:${tool}`]);
      const { code, doc } = cli("run", ["--no-interactive", ...skip]);
      verify();
      assert.equal(code, side === "bad" ? 1 : 0, JSON.stringify({
        findings: doc.findings?.map(keyOf), unfinished: doc.stages?.filter(({ state }) => state !== "completed"),
      }));
      assert.equal(doc.decision, side === "bad" ? "failed" : "passed");
      const completed = (doc.stages ?? []).filter(({ state }) => state === "completed").map(({ id }) => id);
      assert.deepEqual(sorted(completed.filter((id) => selected.has(id))), sorted(selected), JSON.stringify(doc.stages));
      const findings = new Set(doc.findings.map(keyOf));
      if (side === "clean") assert.deepEqual([...findings], []);
      else for (const [, tool, rule, files = []] of adapterStages) {
        for (const file of files) assert.ok(findings.has(findingKey(tool, rule, file)), JSON.stringify([...findings]));
      }
      const stored = JSON.parse(fs.readFileSync(path.join(doc.runDir, "result.json"), "utf8"));
      const artifact = stored.artifacts.outputs.find((file) => file.endsWith("/sbom.cdx.json"));
      assert.ok(artifact, "Trivy outputs an SBOM");
      const sbom = JSON.parse(fs.readFileSync(path.join(doc.runDir, artifact), "utf8"));
      assert.equal(sbom.bomFormat, "CycloneDX");
    });
  }
});
