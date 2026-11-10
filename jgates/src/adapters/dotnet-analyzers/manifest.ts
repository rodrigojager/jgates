import type { AdapterManifest } from "../../core/catalog/index.js";
import { lintManifest } from "../lint-common/manifest.js";

/**
 * The .NET analyzers as the C# lint adapter: `dotnet build --no-incremental` with the .NET code analyzers switched on
 * (EnableNETAnalyzers, AnalysisLevel latest-recommended), in the solution or project of the component. The warnings and
 * errors of the compiler and of the analyzers (CA*, IDE*, and the ones the project references) are the findings, with the
 * severities the project's .editorconfig / .globalconfig and rulesets give them. The build is the project's: its MSBuild
 * targets and analyzers run. dotnet is part of the JGates tools image.
 */
export const dotnetAnalyzersManifest: AdapterManifest = lintManifest({
  id: "dotnet-analyzers",
  displayName: ".NET analyzers (C# lint)",
  toolName: "dotnet",
  toolVersionRange: ">=8.0.0",
  configDiscovery: ".editorconfig, .globalconfig, *.ruleset and the analyzer settings of the project and of Directory.Build.props",
  configPrecedence: "the project's analyzer configuration decides each rule's severity; JGates switches the .NET analyzers on at the recommended level and changes no severity",
  exitCodes: [
    { code: 0, meaning: "the build succeeded (warnings do not change the exit code)" },
    { code: 1, meaning: "the build failed (compiler errors, or an analyzer rule the project made an error)" },
  ],
  executesProjectCode: true,
  redirectionFlags: ["-nologo", "-v", "-consoleloggerparameters", "-nodeReuse", "-p:UseSharedCompilation", "-p:EnableNETAnalyzers", "-p:AnalysisLevel", "--no-incremental"],
  redirectionEnv: ["DOTNET_NOLOGO", "DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_CLI_UI_LANGUAGE", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "MSBUILDDISABLENODEREUSE", "VSLANG", "NO_COLOR"],
  unavoidableWorkspaceWrites: ["bin", "obj"],
  relativeCost: "medium",
  license: "MIT",
  limitations: [
    "analyzers run inside dotnet build: the project is restored and compiled, and its MSBuild targets, source generators and analyzers execute, so the result is self-reported",
    "restore is offline: the NuGet packages of the project must be in the dependency volume",
    "with several projects and no solution file in the component the plan names none, so the adapter is not applicable until one solution (.sln or .slnx) exists",
    "a build that fails with compiler or restore errors is an error stage, never a pass; a build that fails only because of analyzer rules the project made errors is a set of findings",
  ],
  stackSupport: [
    {
      capability: "lint",
      stack: "csharp",
      state: "validated",
      prerequisites: ["the .NET SDK in the JGates tools image", "one solution or project file in the component", "the project's NuGet packages in the dependency volume"],
      limitations: ["dotnet build with EnableNETAnalyzers and AnalysisLevel latest-recommended; the project's .editorconfig sets the severities"],
    },
  ],
  sourceUrl: "https://github.com/dotnet/roslyn-analyzers",
  acquisition: ["https://dotnet.microsoft.com/download"],
  setup: ["https://learn.microsoft.com/dotnet/fundamentals/code-analysis/overview", "https://learn.microsoft.com/dotnet/fundamentals/code-analysis/configuration-files"],
});
