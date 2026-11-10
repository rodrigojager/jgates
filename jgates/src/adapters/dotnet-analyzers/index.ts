// .NET analyzers adapter (C# lint): runs `dotnet build` with the .NET code analyzers on, in the solution or project of the
// component, in the step container of the tools image, and turns the build diagnostics into located, blocking findings.
// See ../lint-common for the shared plan and run.
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { makeLintAdapter, type LintSpec } from "../lint-common/index.js";
import { dotnetAnalyzersManifest } from "./manifest.js";
import { parseDotnetAnalyzers } from "./normalize.js";

export { dotnetAnalyzersManifest } from "./manifest.js";
export { parseDotnetAnalyzers } from "./normalize.js";

const SOLUTION = /\.(?:sln|slnx)$/i;
const PROJECT = /\.(?:csproj|vbproj)$/i;

/** The one solution of the folder, else its one project; null with the reason when it cannot be named. */
export function dotnetTarget(scanDir: string): { file: string } | { skip: string } {
  const t = translator("lint-stacks");
  let names: string[];
  try {
    names = fs.readdirSync(scanDir).sort();
  } catch {
    names = [];
  }
  const solutions = names.filter((n) => SOLUTION.test(n));
  const projects = names.filter((n) => PROJECT.test(n));
  if (solutions.length === 1) return { file: solutions[0] as string };
  if (solutions.length > 1) return { skip: t("lint_dotnet_many", { files: solutions.join(", ") }) };
  if (projects.length === 1) return { file: projects[0] as string };
  if (projects.length > 1) return { skip: t("lint_dotnet_many", { files: projects.join(", ") }) };
  return { skip: t("lint_no_file", { tool: "dotnet", file: "*.sln, *.slnx, *.csproj" }) };
}

export const dotnetAnalyzersSpec: LintSpec = {
  manifest: dotnetAnalyzersManifest,
  tool: "dotnet-analyzers",
  imageTool: "dotnet",
  commandTool: "dotnet",
  prefix: ["build"],
  overrideEnv: "JGATES_DOTNET",
  scope: "component",
  executesProjectCode: true,
  prepare(scanDir, componentRoot) {
    const target = dotnetTarget(scanDir);
    if ("skip" in target) return target;
    const at = (name: string): string => (componentRoot ? `${componentRoot}/${name}` : name);
    return {
      args: [target.file, "--no-incremental", "-nologo", "-v:q", "-consoleloggerparameters:NoSummary", "-nodeReuse:false", "-p:UseSharedCompilation=false", "-p:EnableNETAnalyzers=true", "-p:AnalysisLevel=latest-recommended"],
      env: { DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_CLI_UI_LANGUAGE: "en", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", MSBUILDDISABLENODEREUSE: "1", VSLANG: "1033", NO_COLOR: "1" },
      // dotnet build writes bin/ and obj/ next to the project and cannot be told otherwise without breaking restore.
      workspaceWrites: [at("bin"), at("obj")],
      contract: { target: target.file },
      configFiles: [".editorconfig", ".globalconfig", "Directory.Build.props"].filter((f) => fs.existsSync(path.join(scanDir, f))),
    };
  },
  parse: (stdout, stderr, exitCode) => parseDotnetAnalyzers(`${stdout}\n${stderr}`, exitCode),
};

export const dotnetAnalyzersAdapter = makeLintAdapter(dotnetAnalyzersSpec);
