// Dependency-detection fixtures: one file map ({ relPath: content }) per manager, written by fx.writeTree().
// Nothing here is a real project; the files only exist to be read.
const json = (value) => JSON.stringify(value, null, 2) + "\n";

const pyproject = (extra = "") => `[project]\nname = "svc"\nversion = "0.1.0"\n${extra}`;

export const managerTrees = {
  uv: {
    "app/pyproject.toml": pyproject('requires-python = ">=3.11"\n\n[project.optional-dependencies]\ntest = ["pytest"]\n'),
    "app/uv.lock": "version = 1\n",
  },
  poetry: {
    "app/pyproject.toml": '[tool.poetry]\nname = "svc"\n\n[tool.poetry.group.dev.dependencies]\npytest = "*"\n',
    "app/poetry.lock": "# lock\n",
    "app/.python-version": "3.12.4\n",
  },
  pdm: {
    "app/pyproject.toml": pyproject('requires-python = ">=3.10"\n'),
    "app/pdm.lock": "# lock\n",
  },
  pipenv: {
    "app/Pipfile": "[packages]\n",
    "app/Pipfile.lock": "{}\n",
    "app/runtime.txt": "python-3.9.18\n",
  },
  pip: {
    "app/requirements.txt": "requests==2.31.0\n",
    "app/pyproject.toml": pyproject(),
  },
  npm: {
    "web/package.json": json({ name: "web", engines: { node: ">=20" }, devDependencies: { vitest: "^1.0.0" } }),
    "web/package-lock.json": "{}\n",
  },
  pnpm: {
    "web/package.json": json({ name: "web" }),
    "web/pnpm-lock.yaml": "lockfileVersion: 9\n",
    "web/.nvmrc": "v20.11.1\n",
  },
  "yarn-classic": {
    "web/package.json": json({ name: "web" }),
    "web/yarn.lock": "# yarn lockfile v1\n",
    "web/.node-version": "18.19.0\n",
  },
  "yarn-berry": {
    "web/package.json": json({ name: "web", packageManager: "yarn@4.1.0" }),
    "web/yarn.lock": "__metadata:\n  version: 8\n",
    "web/.yarnrc.yml": "nodeLinker: node-modules\n",
  },
  go: {
    "svc/go.mod": "module example.com/svc\n\ngo 1.22\n\ntoolchain go1.22.3\n",
    "svc/go.sum": "\n",
  },
  cargo: {
    "crate/Cargo.toml": '[package]\nname = "crate"\nversion = "0.1.0"\n',
    "crate/Cargo.lock": "# lock\n",
    "crate/rust-toolchain.toml": '[toolchain]\nchannel = "1.75.0"\n',
  },
  dotnet: {
    "svc/Svc.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    "svc/packages.lock.json": '{"version":1}\n',
    "svc/global.json": json({ sdk: { version: "8.0.100" } }),
  },
};

/** Two lockfiles of different managers in one Python root. */
export const ambiguousTree = () => ({
  "app/pyproject.toml": pyproject(),
  "app/uv.lock": "version = 1\n",
  "app/poetry.lock": "# lock\n",
});

export const bunTree = () => ({
  "web/package.json": json({ name: "web" }),
  "web/bun.lockb": "binary\n",
});

export const noLockfileTree = () => ({
  "web/package.json": json({ name: "web" }),
});

/** A pnpm workspace: the lockfile and the install root are the container's. */
export const nodeWorkspaceTree = () => ({
  "package.json": json({ name: "mono", private: true, workspaces: ["packages/*"], engines: { node: "^20" } }),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "packages/a/package.json": json({ name: "a" }),
  "packages/b/package.json": json({ name: "b" }),
});
