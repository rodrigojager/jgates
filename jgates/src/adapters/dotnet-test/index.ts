// dotnet-test adapter: `dotnet test` of the one solution or project of a .NET component, in the step container of the
// tools image, with the TRX logger and the results in the run folder. The unit run filters `Category!=<category>` and
// collects coverlet's "XPlat Code Coverage" when coverage is selected (the test project must reference
// coverlet.collector); the integration run filters `Category=<category>`. See ../test-common for the shared plan and run.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { listFiles } from "../../core/selection/tests.js";
import { dotnetTarget } from "../dotnet-analyzers/index.js";
import { makeTestAdapter, readText, workspaceRelative, type TestRunnerSpec } from "../test-common/index.js";
import { dotnetTestManifest } from "./manifest.js";
import { parseCobertura, parseTrx } from "./normalize.js";
import { methodOf, scanDotnetProperties } from "./properties.js";

export { dotnetTestManifest } from "./manifest.js";
export { parseCobertura, parseTrx } from "./normalize.js";
export { fsCheckProperties, scanDotnetProperties } from "./properties.js";

/** Whether a project or props file of the folder references coverlet.collector. */
export function referencesCoverlet(scanDir: string): boolean {
  for (const f of listFiles(scanDir, (_rel, name) => /\.(?:csproj|fsproj|vbproj|props)$/.test(name))) {
    if (/Include\s*=\s*"coverlet\.collector"/i.test(readText(path.join(scanDir, ...f.split("/"))) ?? "")) return true;
  }
  return false;
}

function filesUnder(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && accept(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

export const dotnetTestSpec: TestRunnerSpec = {
  manifest: dotnetTestManifest,
  tool: "dotnet test",
  stack: "dotnet",
  imageTool: "dotnet",
  overrideEnv: "JGATES_DOTNET",
  framework: "FsCheck",
  prepare({ scanDir, root, mode, selection, detection, coverage, out }) {
    const t = translator("test-stacks");
    const target = dotnetTarget(scanDir);
    if ("skip" in target) return target;
    const category = selection.value as string;
    const coverlet = coverage && referencesCoverlet(scanDir);
    const at = (name: string): string => (root ? `${root}/${name}` : name);
    return {
      args: [
        "test",
        target.file,
        "--nologo",
        "--logger",
        "trx;LogFileName=results.trx",
        "--results-directory",
        `${out}/results`,
        // The unit run leaves the category out only when the component has tests in it.
        ...(mode === "integration" ? ["--filter", `Category=${category}`] : detection.present ? ["--filter", `Category!=${category}`] : []),
        ...(coverlet ? ["--collect", "XPlat Code Coverage"] : []),
        "-p:UseSharedCompilation=false",
        "-nodeReuse:false",
      ],
      env: { DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_CLI_UI_LANGUAGE: "en", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", MSBUILDDISABLENODEREUSE: "1", VSLANG: "1033", NO_COLOR: "1" },
      // dotnet test builds the projects: bin/ and obj/ next to them (redirected into the dependency volume in a step).
      workspaceWrites: [at("bin"), at("obj")],
      configFiles: ["Directory.Build.props", "Directory.Packages.props", ".runsettings"].filter((f) => fs.existsSync(path.join(scanDir, f))),
      coverage: { collected: coverlet, problem: coverage && !coverlet ? t("test_cov_no_coverlet") : null },
      contract: { target: target.file },
    };
  },
  read({ outDir, workspaceView, cwdView }) {
    const results = path.join(outDir, "results");
    const trx = filesUnder(results, (n) => n.endsWith(".trx")).map((f) => readText(f) ?? "");
    const tests = parseTrx(trx, (printed) => workspaceRelative(printed, workspaceView, cwdView));
    // The collector writes one report per test project in a GUID folder; the trx logger copies each into <run>/In/: read the first only.
    const cobertura = filesUnder(results, (n) => n === "coverage.cobertura.xml")
      .filter((f) => path.dirname(path.dirname(f)) === results)
      .map((f) => readText(f) ?? "");
    return { tests, coverage: parseCobertura(cobertura) };
  },
  properties(_cases, { cwd }) {
    const scan = scanDotnetProperties(cwd);
    return { uses: scan.uses, isProperty: (c) => scan.names.has(methodOf(c.name)) };
  },
};

export const dotnetTestAdapter = makeTestAdapter(dotnetTestSpec);
