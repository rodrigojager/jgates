// Project dependencies in a Linux volume (S0 prototype, Python with uv): a `deps` container, the only one with network
// (package registries), installs the component's requirements into `jgates-<ws>-deps-<component>`, mounted at
// /workspace/.venv on top of the source volume, with the uv cache in a shared cache volume. The install runs only when
// the key (requirement files, image, Python version, install command) differs from the key stored in the volume.
// Fresh-volume swaps, other ecosystems, governed frozen installs and registry credentials come with the production
// dependency volumes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  IMAGE_USER,
  dependencyVolumeName,
  ensureVolume,
  engineLabels,
  runInEngine,
  sourceVolumeName,
  type EngineContext,
  type EngineRunResult,
} from "../engine/index.js";

export const PYTHON_VENV_TARGET = "/workspace/.venv";
export const CACHE_TARGET = "/cache";
export const DEFAULT_CACHE_VOLUME = "jgates-cache";
/** Where the key of the installed dependencies is stored, inside the dependency volume. */
export const DEPS_KEY_FILE = `${PYTHON_VENV_TARGET}/.jgates-deps.json`;

/** Python manifests read for the key, in the folder of the component. */
export function pythonManifests(componentDir: string): string[] {
  return fs
    .readdirSync(componentDir, { withFileTypes: true })
    .filter((e) => e.isFile() && (/^requirements.*\.txt$/.test(e.name) || e.name === "pyproject.toml" || e.name === "uv.lock" || e.name === ".python-version"))
    .map((e) => e.name)
    .sort();
}

export interface DependencyKeyInput {
  componentDir: string;
  manifests: string[];
  imageId: string;
  pythonVersion: string;
  command: string[];
}

/** sha256 over the manifests' bytes, the image id, the Python version and the install command. */
export function dependencyKey(input: DependencyKeyInput): string {
  const h = crypto.createHash("sha256");
  for (const name of input.manifests) h.update(`file:${name}\0`).update(fs.readFileSync(path.join(input.componentDir, name))).update("\0");
  h.update(`image:${input.imageId}\0python:${input.pythonVersion}\0command:${JSON.stringify(input.command)}`);
  return h.digest("hex");
}

/**
 * The shell of the `deps` container: compare the stored key, otherwise empty the volume, create the venv with the
 * image's Python and install the requirement files (`-r` per file), then store the key.
 */
export function pythonInstallScript(): string {
  return [
    "set -eu",
    `key_file=${DEPS_KEY_FILE}`,
    'if [ -f "$key_file" ] && grep -q "\\"key\\": \\"$JGATES_DEPS_KEY\\"" "$key_file"; then echo "jgates-deps: up to date"; exit 0; fi',
    `find ${PYTHON_VENV_TARGET} -mindepth 1 -delete`,
    `uv venv --allow-existing --python /usr/local/bin/python3 ${PYTHON_VENV_TARGET}`,
    `uv pip install --python ${PYTHON_VENV_TARGET}/bin/python --compile-bytecode "$@"`,
    'printf \'{"key": "%s"}\\n\' "$JGATES_DEPS_KEY" > "$key_file"',
    'echo "jgates-deps: installed"',
  ].join("\n");
}

export interface PythonDepsInput {
  /** Host folder of the component (only read, for the key). */
  componentDir: string;
  /** Requirement files, relative to the component folder, given to `uv pip install -r`. */
  requirementFiles: string[];
  workspace: string;
  component: string;
  image: string;
  imageId: string;
  pythonVersion: string;
  version: string;
  run?: string;
  cacheVolume?: string;
  extraLabels?: Record<string, string>;
  timeoutMs?: number;
  context?: EngineContext;
}

export interface PythonDepsResult {
  status: "installed" | "reused";
  key: string;
  volume: string;
  durationMs: number;
  container: EngineRunResult;
}

export class DependencyInstallError extends Error {
  constructor(
    message: string,
    readonly details: string,
  ) {
    super(message);
    this.name = "DependencyInstallError";
  }
}

/** Installs (or reuses) the Python dependencies of a component; the source volume must be synchronized first. */
export async function preparePythonDependencies(input: PythonDepsInput): Promise<PythonDepsResult> {
  const started = Date.now();
  const context = input.context ?? {};
  const volume = dependencyVolumeName(input.workspace, input.component);
  const cacheVolume = input.cacheVolume ?? DEFAULT_CACHE_VOLUME;
  const labels = (kind: "deps" | "helper", workspace: boolean = true) =>
    engineLabels({
      kind,
      version: input.version,
      ...(workspace ? { workspace: input.workspace } : {}),
      ...(input.run ? { run: input.run } : {}),
      ...(input.extraLabels ? { extra: input.extraLabels } : {}),
    });
  const installArgs = input.requirementFiles.flatMap((file) => ["-r", file]);
  const key = dependencyKey({ componentDir: input.componentDir, manifests: pythonManifests(input.componentDir), imageId: input.imageId, pythonVersion: input.pythonVersion, command: installArgs });
  await ensureVolume(volume, { labels: labels("deps"), helperLabels: labels("helper"), image: input.image }, context);
  await ensureVolume(cacheVolume, { labels: labels("deps", false), helperLabels: labels("helper"), image: input.image }, context);
  const container = await runInEngine(
    {
      image: input.image,
      command: ["sh", "-c", pythonInstallScript(), "jgates-deps", ...installArgs],
      labels: labels("deps"),
      user: IMAGE_USER,
      network: "bridge",
      mounts: [
        { type: "volume", source: sourceVolumeName(input.workspace), target: "/workspace" },
        { type: "volume", source: volume, target: PYTHON_VENV_TARGET },
        { type: "volume", source: cacheVolume, target: CACHE_TARGET },
      ],
      workdir: "/workspace",
      env: { JGATES_DEPS_KEY: key, UV_CACHE_DIR: `${CACHE_TARGET}/uv`, UV_LINK_MODE: "copy", UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1" },
      tmpExec: true,
      timeoutMs: input.timeoutMs ?? 900_000,
    },
    context,
  );
  if (container.exitCode !== 0) throw new DependencyInstallError(`the dependency install of ${input.component} failed (exit ${String(container.exitCode)})`, (container.stderr || container.stdout).trim());
  const status = /jgates-deps: up to date/.test(container.stdout) ? "reused" : "installed";
  return { status, key, volume, durationMs: Date.now() - started, container };
}
