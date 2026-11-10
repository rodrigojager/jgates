import { testManifest } from "../test-common/manifest.js";

/**
 * dotnet test as its own adapter: the tests of the solution or project of a .NET component with the TRX logger, the
 * line coverage of coverlet's "XPlat Code Coverage" collector (the coverlet.collector package of the test project), the
 * integration selection by the Category trait (`--filter`) and the FsCheck property tests among them. Runs in the step
 * container of the tools image; the NuGet packages come from the dependency volume.
 */
export const dotnetTestManifest = testManifest({
  id: "dotnet-test",
  displayName: "dotnet test (.NET tests, coverlet coverage and FsCheck properties)",
  toolName: "dotnet",
  toolVersionRange: ">=8.0.0",
  languages: ["csharp", "fsharp", "visualbasic"],
  configDiscovery: "the one solution (*.sln, *.slnx) of the component, else its one project; .runsettings and Directory.Build.props as MSBuild reads them",
  configPrecedence: "the command-line options of the plan (--filter, --logger, --collect, --results-directory) win",
  exitCodes: [
    { code: 0, meaning: "all tests passed" },
    { code: 1, meaning: "a test failed, or the build failed (no TRX file then: an error stage)" },
  ],
  redirectionFlags: ["--logger", "--results-directory", "--collect"],
  redirectionEnv: ["DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_NOLOGO"],
  unavoidableWorkspaceWrites: ["bin", "obj"],
  license: "MIT",
  limitations: [
    "the tests and the MSBuild targets of the project execute; the NuGet packages must already be in the dependency volume",
    "coverage needs the coverlet.collector package in the test project (JGates never installs it); lines of every instrumented assembly are summed over the Cobertura reports",
    "the integration selection is the Category trait (xUnit [Trait(\"Category\", ...)], NUnit [Category], MSTest [TestCategory])",
    "property tests are detected statically: FsCheck [Property] methods and methods checking Prop.ForAll",
  ],
  stackSupport: [
    { capability: "unit", stack: "csharp", state: "validated", toolVersions: "dotnet SDK >=8", prerequisites: ["a test project (xUnit, NUnit or MSTest with Microsoft.NET.Test.Sdk) in the solution or project of the component"], limitations: ["validated with the real .NET SDK 10.0.403 of the tools image and xUnit 2"] },
    { capability: "coverage", stack: "csharp", state: "validated", toolVersions: "dotnet SDK >=8, coverlet.collector 6+", prerequisites: ["coverlet.collector referenced by the test project"], limitations: ["line coverage of the Cobertura report"] },
    { capability: "integration", stack: "csharp", state: "validated", toolVersions: "dotnet SDK >=8", prerequisites: ["integration tests marked with the Category trait Integration (or tools.<id>.selection.category)"], limitations: ["services come from the compose section when the tests need them"] },
    { capability: "properties", stack: "csharp", state: "validated", toolVersions: "dotnet SDK >=8, FsCheck 3.x", prerequisites: ["FsCheck (FsCheck.Xunit / FsCheck.NUnit) referenced by the test project"], limitations: ["static detection of [Property] and Prop.ForAll"] },
  ],
  sourceUrl: "https://github.com/dotnet/sdk",
  acquisition: ["https://dotnet.microsoft.com/download"],
  setup: ["https://learn.microsoft.com/dotnet/core/tools/dotnet-test", "https://github.com/coverlet-coverage/coverlet", "https://fscheck.github.io/FsCheck/"],
  mode: "customer-supplied",
});
