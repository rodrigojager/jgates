import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// The complete tools image (S2, PLAN-image.md sections 2 and 4) with the real engine (npm run test:docker; never part of
// npm test). Every tool of sections 2.1-2.5 is asked for its version inside one container under the step contract
// (non-root, read-only root, tmpfs /tmp, no network, no capabilities) and must answer the version /etc/jgates/image.json
// records; the image config, labels and size are read from the engine, and the image filesystem is listed to prove
// that nothing forbidden (CodeQL, official Semgrep rules, vulnerability databases) is inside. The image is built by
// `npm --prefix jgates run image:build` when it is missing.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const IMAGE = "jgates-tools:dev";
const VERSION = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
const SIZE_LIMIT = 7e9;
const FIRST_VERSION = /(\d+\.\d+(?:\.\d+)?)/;

// Every tool of PLAN-image.md sections 2.1-2.5, with the command that asks it for its version and, when the version is
// not the first dotted number of the answer, the pattern that finds it. Libraries the image ships for runners (no
// command of their own) answer through their package metadata.
const TOOLS = {
  // 2.1 Base and shared runtime
  git: ["git --version"],
  curl: ["curl --version"],
  rsync: ["rsync --version"],
  tini: ["tini --version"],
  jq: ["jq --version"],
  unzip: ["unzip -v"],
  xz: ["xz --version"],
  gcc: ["gcc --version", /\) (\d+\.\d+\.\d+)/],
  make: ["make --version"],
  "pkg-config": ["pkg-config --version"],
  jgates: ["jgates --version", /^jgates (\S+)$/m],
  "quality-sidecar": ["/opt/tools/python/quality-sidecar/bin/python -c 'import tomllib; print(tomllib.load(open(\"/opt/jgates/quality-gate/pyproject.toml\", \"rb\"))[\"project\"][\"version\"])'"],
  tomlkit: ["/opt/tools/python/quality-sidecar/bin/python -c 'import tomlkit; print(tomlkit.__version__)'"],
  // 2.2 Python
  python: ["python --version"],
  uv: ["uv --version"],
  ruff: ["ruff --version"],
  mypy: ["mypy --version"],
  pytest: ["pytest --version"],
  "pytest-cov": ["/opt/tools/python/pytest/bin/python -c 'import importlib.metadata as m; print(m.version(\"pytest-cov\"))'"],
  coverage: ["coverage --version"],
  hypothesis: ["/opt/tools/python/pytest/bin/python -c 'import hypothesis; print(hypothesis.__version__)'"],
  // mutmut reads its configuration first and needs a project with sources, even for --version.
  mutmut: ["(mkdir -p /tmp/mutmut/src && cd /tmp/mutmut && mutmut --version)"],
  "import-linter": ["lint-imports --version"],
  schemathesis: ["st --version"],
  semgrep: ["semgrep --version"],
  checkov: ["checkov --version"],
  zizmor: ["zizmor --version"],
  // 2.3 TypeScript / JavaScript
  node: ["node --version"],
  npm: ["npm --version"],
  corepack: ["corepack --version"],
  typescript: ["tsc --version"],
  pyright: ["pyright --version"],
  eslint: ["eslint --version"],
  "typescript-eslint": ["node -p 'require(\"/opt/tools/node/eslint/node_modules/typescript-eslint/package.json\").version'"],
  prettier: ["prettier --version"],
  vitest: ["vitest --version"],
  stryker: ["stryker --version"],
  "stryker-vitest-runner": ["node -p 'require(\"/opt/tools/node/stryker/node_modules/@stryker-mutator/vitest-runner/package.json\").version'"],
  "stryker-jest-runner": ["node -p 'require(\"/opt/tools/node/stryker/node_modules/@stryker-mutator/jest-runner/package.json\").version'"],
  jscpd: ["jscpd --version"],
  "dependency-cruiser": ["depcruise --version"],
  "fast-check": ["node -p 'require(\"/opt/tools/node/fast-check/node_modules/fast-check/package.json\").version'"],
  // 2.4 Go, Rust and .NET
  go: ["go version"],
  "golangci-lint": ["golangci-lint --version"],
  govulncheck: ["govulncheck -version", /govulncheck@v(\S+)/],
  rustup: ["rustup --version", /rustup (\d+\.\d+\.\d+)/],
  rustc: ["rustc --version"],
  cargo: ["cargo --version"],
  rustfmt: ["rustfmt --version"],
  clippy: ["cargo clippy --version"],
  "cargo-audit": ["cargo audit --version"],
  "cargo-llvm-cov": ["cargo llvm-cov --version"],
  dotnet: ["dotnet --version"],
  "dotnet-format": ["dotnet format --version"],
  // 2.5 Cross-stack security, API and runtime tools
  gitleaks: ["gitleaks version"],
  trivy: ["trivy --version", /Version: (\S+)/],
  "osv-scanner": ["osv-scanner --version", /osv-scanner version: (\S+)/],
  oasdiff: ["oasdiff --version"],
  java: ["java --version"],
  // ZAP's default home is the image user's passwd home (/tmp/home), which a fresh tmpfs does not have: like the adapter,
  // the home is given with -dir. (Under --network none log4j also logs that it cannot resolve the container's hostname;
  // that line is harmless.)
  zap: ['zap.sh -cmd -dir "$HOME/.ZAP" -version', /^(\d+\.\d+\.\d+)\s*$/m],
  shellcheck: ["shellcheck --version", /version: (\S+)/],
  hadolint: ["hadolint --version"],
  squawk: ["squawk --version"],
};

// The step contract of the runner (PLAN.md shared interfaces), without the volumes.
const STEP = ["run", "--rm", "--init", "--pull", "never", "--network", "none", "--read-only", "--tmpfs", "/tmp:exec", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001", "--env", "HOME=/tmp", "--label", "org.jgates.dev=true", "--label", "org.jgates.test=tools-image"];

let inspect = null;
let imageJson = null;

function inImage(script, { step = true } = {}) {
  // Under the step contract HOME is a folder of the tmpfs, created first (as the runner does).
  const args = step ? [...STEP, IMAGE, "bash", "-c", `mkdir -p "$HOME"\n${script}`] : ["run", "--rm", "--pull", "never", "--network", "none", "--label", "org.jgates.dev=true", "--label", "org.jgates.test=tools-image", IMAGE, "bash", "-c", script];
  return docker(args, { maxBuffer: 512 * 1024 * 1024, timeout: 900_000 });
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  if (docker(["image", "inspect", IMAGE]).code !== 0) {
    const built = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "image-build.mjs")], { stdio: "inherit" });
    assert.equal(built.status, 0, "npm --prefix jgates run image:build failed");
  }
  inspect = JSON.parse(docker(["image", "inspect", IMAGE]).out)[0];
  const shown = inImage("cat /etc/jgates/image.json");
  assert.equal(shown.code, 0, shown.err);
  imageJson = JSON.parse(shown.out);
});

test("S2: every tool of PLAN-image.md 2.1-2.5 answers its version command with the version image.json records", () => {
  const names = Object.keys(TOOLS);
  for (const name of names) assert.equal(typeof imageJson.tools[name], "string", `image.json records ${name}`);
  // One container for every tool: each answer is framed by separators, followed by its exit code.
  const script = names.map((name) => `printf '\\036%s\\037' '${name}'; ${TOOLS[name][0]} 2>&1; printf '\\037%s' "$?"`).join("\n");
  const r = inImage(script);
  assert.equal(r.code, 0, r.err);
  const answers = new Map(
    r.out
      .split("\x1e")
      .filter(Boolean)
      .map((chunk) => {
        const [name, output, code] = chunk.split("\x1f");
        return [name, { output, code: Number(code) }];
      }),
  );
  const wrong = [];
  for (const name of names) {
    const answer = answers.get(name);
    if (!answer || answer.code !== 0) {
      wrong.push(`${name}: exited with ${answer?.code} ${answer?.output?.trim().slice(0, 300)}`);
      continue;
    }
    const match = answer.output.match(TOOLS[name][1] ?? FIRST_VERSION);
    if (match?.[1] !== imageJson.tools[name]) wrong.push(`${name}: answered ${JSON.stringify(match?.[1] ?? answer.output.trim().slice(0, 200))}, image.json records ${imageJson.tools[name]}`);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
  // The pinned tools were checked against their pins at build time: image.json lists which.
  for (const name of ["uv", "node", "go", "rustc", "dotnet", "golangci-lint", "govulncheck", "cargo-audit", "gitleaks", "trivy", "osv-scanner", "oasdiff", "zap", "java", "hadolint", "squawk", "ruff", "semgrep", "checkov", "eslint", "typescript", "jgates"]) {
    assert.ok(imageJson.pinned.includes(name), `${name} is pinned`);
  }
});

test("S2: the base items without a version command, gofmt and go vet, the sidecar helper and the Playwright libraries are present", () => {
  const r = inImage(
    [
      "set -e",
      "test -s /etc/ssl/certs/ca-certificates.crt",
      "test -f /usr/include/openssl/ssl.h",
      "test -f /usr/include/x86_64-linux-gnu/ffi.h -o -f /usr/include/ffi.h",
      "printf 'package main\\n\\nfunc main() {}\\n' > /tmp/main.go",
      "gofmt -l /tmp/main.go",
      "go vet -h 2>&1 | grep -q 'usage: go vet'",
      "quality-sidecar --help > /dev/null",
      "/opt/tools/python/quality-sidecar/bin/python -c 'import quality_sidecar.pii, defusedxml, tomlkit'",
      "for lib in libnss3.so libnspr4.so libgbm.so.1 libasound.so.2 libatk-bridge-2.0.so.0 libxkbcommon.so.0 libcups.so.2 libdrm.so.2 libXcomposite.so.1 libXrandr.so.2 libpango-1.0.so.0 libcairo.so.2; do ldconfig -p | grep -q \"$lib\" || { echo \"missing $lib\"; exit 1; }; done",
      "echo ok",
    ].join("\n"),
  );
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /ok\s*$/);
});

test("S2: /opt/jgates runs jgates --version equal to the package version, as user 10001 and without an entrypoint", () => {
  const r = inImage("readlink -f \"$(command -v jgates)\"; jgates --version; id -u; id -g");
  assert.equal(r.code, 0, r.err);
  const [where, versionLine, ...rest] = r.out.trim().split("\n");
  assert.match(where, /^\/opt\/jgates\//, `jgates resolves into /opt/jgates: ${where}`);
  assert.equal(versionLine, `jgates ${VERSION}`);
  assert.equal(imageJson.jgatesVersion, VERSION);
  assert.deepEqual(rest.slice(-2), ["10001", "10001"]);
  // The image's own user (no --user given) is 10001 too.
  const own = inImage("id -u", { step: false });
  assert.equal(own.out.trim(), "10001");
  assert.equal(inspect.Config.User, "10001:10001");
  assert.ok(!inspect.Config.Entrypoint || inspect.Config.Entrypoint.length === 0, `no ENTRYPOINT: ${JSON.stringify(inspect.Config.Entrypoint)}`);
  assert.equal(inspect.Config.WorkingDir, "/workspace");
});

test("S2: OCI labels, the JGates version label and one org.jgates.tool.<tool>.version label per tool", () => {
  const labels = inspect.Config.Labels ?? {};
  assert.equal(labels["org.opencontainers.image.source"], "https://github.com/rodrigojager/jgates");
  assert.equal(labels["org.opencontainers.image.version"], imageJson.imageVersion);
  assert.equal(labels["org.opencontainers.image.revision"], imageJson.sourceRevision);
  assert.ok(labels["org.opencontainers.image.licenses"], "org.opencontainers.image.licenses");
  assert.equal(labels["org.jgates.version"], VERSION);
  assert.equal(labels["org.jgates.dev"], "true");
  assert.equal(labels["jproject.project"], "jgates");
  const toolLabels = Object.keys(labels).filter((key) => /^org\.jgates\.tool\..+\.version$/.test(key));
  assert.deepEqual(toolLabels.map((key) => key.slice("org.jgates.tool.".length, -".version".length)).sort(), Object.keys(imageJson.tools).sort());
  for (const [tool, version] of Object.entries(imageJson.tools)) assert.equal(labels[`org.jgates.tool.${tool}.version`], version, tool);
});

test("S2: the image is at most 7 GB", () => {
  const layers = docker(["history", "--no-trunc", "--human=false", "--format", "{{.Size}}", IMAGE]).out.split(/\s+/).filter(Boolean);
  const uncompressed = layers.reduce((sum, size) => sum + Number(size), 0);
  console.log(`# ${IMAGE}: engine size ${inspect.Size} bytes, ${uncompressed} bytes uncompressed in ${layers.length} history entries`);
  assert.ok(inspect.Size > 0 && inspect.Size <= SIZE_LIMIT, `docker image inspect size ${inspect.Size} <= ${SIZE_LIMIT}`);
  assert.ok(uncompressed > 0 && uncompressed <= SIZE_LIMIT, `uncompressed size ${uncompressed} <= ${SIZE_LIMIT}`);
});

test("S2: no CodeQL, no official Semgrep rules and no vulnerability database inside the image", () => {
  // As root, so that no folder is hidden from the listing.
  const r = docker(["run", "--rm", "--pull", "never", "--network", "none", "--user", "0", "--label", "org.jgates.dev=true", "--label", "org.jgates.test=tools-image", IMAGE, "find", "/", "-xdev", "(", "-path", "/proc", "-o", "-path", "/sys", "-o", "-path", "/dev", ")", "-prune", "-o", "-print"], { maxBuffer: 512 * 1024 * 1024, timeout: 900_000 });
  assert.equal(r.code, 0, r.err);
  const paths = r.out.split("\n").filter(Boolean);
  // The listing is the whole filesystem: the tools are in it.
  assert.ok(paths.length > 50_000, `listed ${paths.length} paths`);
  for (const expected of ["/usr/local/bin/semgrep", "/usr/local/bin/trivy", "/usr/local/bin/osv-scanner", "/usr/local/bin/cargo-audit", "/usr/local/bin/govulncheck", "/opt/jgates/jgates/package.json"]) {
    assert.ok(paths.includes(expected), `${expected} is listed`);
  }
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  const forbidden = paths.filter((p) => {
    const name = base(p).toLowerCase();
    return (
      // CodeQL: its CLI, bundles and query packs (JGates's own adapter folder, which drives a customer-supplied CodeQL, is not one).
      (name === "codeql" && p !== "/opt/jgates/jgates/dist/adapters/codeql") ||
      name.startsWith("codeql-bundle") ||
      name === ".codeqlmanifest.json" ||
      name === "qlpack.yml" ||
      name === "codeql-pack.lock.yml" ||
      // The official Semgrep rules (registry repository or a downloaded rules cache).
      /(^|\/)semgrep-rules(\/|$)/i.test(p) ||
      /(^|\/)\.semgrep(\/|$)/.test(p) ||
      // Vulnerability databases: Trivy, Grype, the RustSec advisory database, OSV and Go vulnerability downloads.
      name === "trivy.db" ||
      name === "trivy-java.db" ||
      name === "vulnerability.db" ||
      name === "advisory-db" ||
      /(^|\/)osv-scanner\/.+\.zip$/.test(p) ||
      /(^|\/)vuln\.go\.dev(\/|$)/.test(p) ||
      /(^|\/)\.cache\/trivy(\/|$)/.test(p)
    );
  });
  assert.deepEqual(forbidden, []);
  // The build-time smoke leaves nothing behind.
  assert.deepEqual(paths.filter((p) => p.startsWith("/tmp/") || p.startsWith("/root/.ZAP") || p.startsWith("/root/.java")), []);
});
