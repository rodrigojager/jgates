// go-test adapter: `go test -json` in the Go module of the component, in the step container of the tools image. The unit
// run leaves the integration build tag out (the tagged files do not compile without it) and measures statement coverage
// with -coverprofile when coverage is selected; the integration run passes the tag and runs only the test functions of
// the tagged files (-run) in their packages. See ../test-common for the shared plan and run.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { makeTestAdapter, readText, RUN_DIR, type TestRunnerSpec } from "../test-common/index.js";
import { goTestManifest } from "./manifest.js";
import { folderOfImport, modulePath, parseCoverProfile, parseGoTestJson } from "./normalize.js";
import { scanGoProperties } from "./properties.js";

export { goTestManifest } from "./manifest.js";
export { parseCoverProfile, parseGoTestJson } from "./normalize.js";
export { goPropertyTests, scanGoProperties } from "./properties.js";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const goTestSpec: TestRunnerSpec = {
  manifest: goTestManifest,
  tool: "go test",
  stack: "go",
  imageTool: "go",
  overrideEnv: "JGATES_GO",
  framework: "rapid / testing/quick",
  prepare({ scanDir, mode, selection, detection, coverage, out }) {
    const t = translator("test-stacks");
    if (!fs.existsSync(path.join(scanDir, "go.mod"))) return { skip: t("test_no_target", { tool: "go test", file: "go.mod" }) };
    // GOTMPDIR: go test executes the test binaries it builds, and the step's /tmp is mounted noexec.
    const env = { GOPROXY: "off", GOTOOLCHAIN: "local", GOTELEMETRY: "off", GOCACHE: `${RUN_DIR}/cache/go-test`, GOTMPDIR: `${RUN_DIR}/cache/go-test/tmp`, NO_COLOR: "1" };
    if (mode === "integration") {
      const run = `^(?:${detection.names.map(escapeRe).join("|")})$`;
      return { args: ["test", "-json", "-count=1", `-tags=${selection.value as string}`, "-run", run, ...(detection.packages.length > 0 ? detection.packages : ["./..."])], env, coverage: { collected: false, problem: null }, contract: { module: "go.mod" } };
    }
    const profile = `${out}/cover.out`;
    return {
      args: ["test", "-json", "-count=1", ...(coverage ? [`-coverprofile=${profile}`, "-covermode=set"] : []), "./..."],
      env,
      coverage: { collected: coverage, problem: null },
      contract: { profile: coverage ? profile : null },
    };
  },
  read({ stdout, contract, workspace, cwd, outDir }) {
    const root = path.relative(workspace, cwd).split(path.sep).join("/");
    const module = modulePath(readText(path.join(cwd, "go.mod")) ?? "");
    const tests = parseGoTestJson(stdout, (importPath) => folderOfImport(importPath, module, root));
    const profile = typeof contract.profile === "string" ? path.join(outDir, "cover.out") : null;
    const text = profile ? readText(profile) : null;
    return { tests, coverage: profile ? (text === null ? { ok: false, problem: `${profile} was not written` } : parseCoverProfile(text)) : null };
  },
  properties(_cases, { cwd }) {
    const scan = scanGoProperties(cwd);
    return { uses: scan.uses, isProperty: (c) => scan.names.has(c.name.slice(c.name.lastIndexOf(".") + 1)) };
  },
};

export const goTestAdapter = makeTestAdapter(goTestSpec);
