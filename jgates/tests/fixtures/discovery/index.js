// Discovery fixtures: file maps ({ relPath: content }) written to a temp dir by writeTree().
// Nothing here is a real project; the manifests only exist to be read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const json = (value) => JSON.stringify(value, null, 2) + "\n";

export function writeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-disc-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

export function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Unsupported languages: a Java service and Ruby scripts next to a TypeScript package. */
export const unsupportedTree = () => ({
  "web/package.json": json({ name: "web" }),
  "web/tsconfig.json": "{}\n",
  "services/legacy/pom.xml": "<project/>\n",
  "services/legacy/src/Main.java": "class Main {}\n",
  "tools/run.rb": "puts 1\n",
});

/** Vendor and dependency directories: only web/ is a component. */
export const vendorTree = () => ({
  "web/package.json": json({ name: "web" }),
  "vendor/lib/package.json": json({ name: "vendored" }),
  "web/node_modules/dep/package.json": json({ name: "dep" }),
  "web/.cache/x/package.json": json({ name: "cached" }),
});

/** Two lockfiles of different managers in one root. */
export const conflictTree = () => ({
  "web/package.json": json({ name: "web" }),
  "web/package-lock.json": "{}\n",
  "web/pnpm-lock.yaml": "lockfileVersion: 9\n",
});

/** A project nested inside another one of the same family, not declared as a workspace member. */
export const nestedTree = () => ({
  "app/package.json": json({ name: "app" }),
  "app/package-lock.json": "{}\n",
  "app/examples/demo/package.json": json({ name: "demo" }),
});

/** npm-style workspaces with a pnpm lockfile at the root. */
export const workspaceTree = () => ({
  "package.json": json({ name: "mono", private: true, workspaces: ["packages/*"] }),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "packages/a/package.json": json({ name: "a", dependencies: { react: "^18.0.0" } }),
  "packages/a/tsconfig.json": "{}\n",
  "packages/b/package.json": json({ name: "b" }),
});

/** Every family once: Go, Cargo, .NET (project + solution), Python loose manifest. */
export const familiesTree = () => ({
  "go/go.mod": "module example.com/svc\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.0\n",
  "rust/Cargo.toml": '[package]\nname = "tool"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.7"\n',
  "rust/Cargo.lock": "",
  "dotnet/App.sln": 'Project("{FAE04EC0}") = "App", "src\\App\\App.csproj", "{1}"\nEndProject\n',
  "dotnet/src/App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
  "dotnet/src/Lib/Lib.fsproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  "scripts/requirements.txt": "flask==3.0\n",
  "scripts/tool.py": "print(1)\n",
});

/** Manifests whose scripts would create a marker file if anything executed them. */
export function markerTree(markerPath) {
  const cmd = `node -e "require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')"`;
  return {
    "web/package.json": json({ name: "web", scripts: { preinstall: cmd, postinstall: cmd, build: cmd } }),
    "web/jest.config.js": `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
    "api/pyproject.toml": '[project]\nname = "api"\n',
    "api/setup.py": `open(${JSON.stringify(markerPath)}, 'w').write('ran')\n`,
    "api/conftest.py": `open(${JSON.stringify(markerPath)}, 'w').write('ran')\n`,
    "dotnet/App.csproj": `<Project Sdk="Microsoft.NET.Sdk"><Target Name="x" BeforeTargets="Build"><Exec Command="touch ${markerPath}" /></Target></Project>\n`,
  };
}

/** Includes, excludes and declared components over a three-component tree. */
export const filterTree = () => ({
  "web/package.json": json({ name: "web" }),
  "api/pyproject.toml": '[project]\nname = "api"\n',
  "libs/shared/package.json": json({ name: "shared" }),
  "libs/legacy/package.json": json({ name: "legacy" }),
});

export const workspaceYml = (body) => `schemaVersion: 1\n${body}`;
