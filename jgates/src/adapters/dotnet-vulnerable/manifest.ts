import type { AdapterManifest } from "../../core/catalog/index.js";

/**
 * The NuGet packages of a .NET component with known vulnerabilities, as the .NET SDK itself reports them: `dotnet list
 * package --vulnerable --include-transitive --format json` over the restored solution or project (the assets of the
 * dependency volume), in the step container of the tools image. The vulnerability data comes from the package sources'
 * own vulnerability resource (nuget.org), so the step has the network.
 */
export const dotnetVulnerableManifest: AdapterManifest = {
  schemaVersion: 1,
  id: "dotnet-vulnerable",
  displayName: "dotnet list package --vulnerable (.NET vulnerable packages)",
  adapterVersion: "0.1.0",
  apiRange: ">=0.3.0 <1.0.0",
  toolName: "dotnet",
  toolVersionRange: ">=8.0.0",
  runtimes: ["native", "container"],
  platforms: ["linux", "darwin", "win32"],
  cpuArchitectures: ["x64", "arm64"],
  categories: ["dependencies"],
  capabilities: ["dependencies"],
  languages: ["csharp", "fsharp", "visualbasic"],
  granularity: ["workspace", "component"],
  minimumContext: ["workspace"],
  configFiles: [
    {
      format: "other",
      discovery: "the one solution (*.sln, *.slnx) of the component, else its one project; nuget.config as NuGet reads it",
      precedence: "the plan's flags (--vulnerable --include-transitive --format json)",
    },
  ],
  editing: { implemented: ["text"], tested: [] },
  exitCodes: {
    codes: [
      { code: 0, meaning: "the packages were listed; the vulnerable ones are in the JSON report" },
      { code: 1, meaning: "the project could not be read (not restored, no project), or the sources did not answer" },
    ],
    reportRequired: true,
  },
  effects: {
    readsCode: true,
    writesOutputs: true,
    mayChangeCode: false,
    // MSBuild evaluates the project files (their properties and imports) to list the packages.
    executesProjectCode: true,
    usesNetwork: true,
    needsService: false,
    usesAi: false,
    needsLicense: false,
  },
  redirection: { flags: ["--format", "--output-version"], env: ["DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_NOLOGO"], unavoidableWorkspaceWrites: [] },
  toggles: { togglable: [], perRunByFlag: false },
  relativeCost: "low",
  origin: "builtin",
  license: "MIT",
  kind: "tool",
  limitations: [
    "needs the network to the package sources (nuget.org) for their vulnerability data, and the component restored by the deps phase",
    "one finding per vulnerable package and advisory, top-level and transitive, with the severity NuGet gives",
  ],
  stackSupport: [
    {
      capability: "dependencies",
      stack: "csharp",
      state: "validated",
      toolVersions: "dotnet SDK >=8 (the tools image's 10.0.403)",
      prerequisites: ["a restorable solution or project (the deps phase restores it)", "network to the package sources"],
      limitations: ["validated with the real .NET SDK of the tools image against nuget.org"],
    },
  ],
  distribution: {
    mode: "customer-supplied",
    sourceUrl: "https://github.com/dotnet/sdk",
    spdx: "MIT",
    acquisition: ["https://dotnet.microsoft.com/download"],
    setup: ["https://learn.microsoft.com/dotnet/core/tools/dotnet-list-package", "https://learn.microsoft.com/nuget/concepts/auditing-packages"],
  },
};
