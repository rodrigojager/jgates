// The install entries of the tools image (PLAN-image.md section 3). Every tool that is not a toolchain of the image is
// installed from files of its own under jgates/docker/tools/, one folder per kind of install, and the Dockerfile loops
// over those folders; a tool slice adds files and edits neither the Dockerfile nor a list. This module reads and checks
// the entries and derives what used to be kept by hand:
//   - the index the image carries (/usr/share/jgates/installs.json): per entry its install folder and, per program it
//     provides, the PATH link, the version command or library, and the pin. installers/links.sh makes the links from
//     it and write-image-json.py asks every program for its version from it;
//   - the pins of the versions gate (with the Dockerfile's own build arguments for the toolchains);
//   - the tool list of the Docker test;
//   - the Dockerfile the build uses: docker/tools/Dockerfile with the part files (parts/<name>.Dockerfile) inserted in
//     name order, read by every gate and test through assembledDockerfile().
//
// Kinds (folder under docker/tools/, entry file, where the entry is installed in the image):
//   binaries  binaries/<name>.json              release binary or archive (URL, SHA-256, what to extract)  /opt/tools/binaries/<name>
//   go        go/<name>.json                    Go module at an exact version (go install)                  /opt/tools/go/<name>
//   cargo     cargo/<name>.json                 Rust crate at an exact version (cargo install --locked)     /opt/tools/cargo/<name>
//   dotnet    dotnet/<name>.json                .NET tool package with the SHA-256 of its .nupkg            /opt/dotnet-tools
//   apt       apt/<group>.json                  Debian packages of main (unpinned)                          /
//   python    python/<version>/<tool>.json      beside <tool>.in and its hashed lock <tool>.txt             /opt/tools/python/<tool>
//   node      node/<tool>/install.json          beside package.json and package-lock.json                   /opt/tools/node/<tool>
//   gem       gem/<tool>/install.json           beside Gemfile and Gemfile.lock                             /opt/tools/gem/<tool>
//   parts     parts/<name>.json                 beside parts/<name>.Dockerfile (stage part-<name>)           /opt/tools/parts/<name>
// Every entry has `provides`: the programs and libraries it brings, each with
//   name     its name in /etc/jgates/image.json (omitted for a link-only program)
//   link     the command linked into /usr/local/bin (optional)
//   path     the program, relative to the install folder (or absolute)
//   version  the command that prints its version (argv), with `pattern` when the version is not the first dotted number;
//            without it the program is a library whose version is read from its package (`package`, default its name)
//   package  the package whose locked version is its pin (python, node, gem) or whose metadata gives a library's version
//   pinned   false: never compared with a pin (default: pinned when the kind pins it)
// and an optional `note`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
export const TOOLS_CONTEXT = path.join(packageRoot, "docker", "tools");

export const KINDS = ["binaries", "go", "cargo", "dotnet", "apt", "python", "node", "gem", "parts"];
/** The kinds whose entry file carries its own version (the pin of the program named like the entry). */
const VERSIONED = new Set(["binaries", "go", "cargo", "dotnet", "parts"]);
const ARCHIVES = ["file", "tar.gz", "tgz", "tar.xz", "tar.bz2", "tar", "zip"];
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const SHA = /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/;
const DEBIAN_PACKAGE = /^[a-z0-9][a-z0-9+.-]+$/;

/** The install folder of an entry inside the image. */
export function installDir(kind, name) {
  switch (kind) {
    case "dotnet":
      return "/opt/dotnet-tools";
    case "apt":
      return "/";
    default:
      return `/opt/tools/${kind}/${name}`;
  }
}

const readJson = (file, problems, label) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${label}: not readable JSON (${error.message})`);
    return null;
  }
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);

/** The `name==version` lines of a Python lock input, lower-cased names. */
function pythonLocked(file) {
  const pins = {};
  if (!fs.existsSync(file)) return pins;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)==(\S+)\s*$/.exec(line);
    if (match) pins[match[1].toLowerCase()] = match[2];
  }
  return pins;
}

/** The exact dependencies of a Node prefix. */
function nodeLocked(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return { ...(JSON.parse(fs.readFileSync(file, "utf8")).dependencies ?? {}) };
  } catch {
    return {};
  }
}

/** The resolved gems of a Gemfile.lock (`    name (version)` under specs). */
function gemLocked(file) {
  const pins = {};
  if (!fs.existsSync(file)) return pins;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^ {4}([A-Za-z0-9_.-]+) \(([^)\s]+)\)$/.exec(line);
    if (match) pins[match[1]] = match[2];
  }
  return pins;
}

function checkProvides(label, provides, problems) {
  if (!Array.isArray(provides) || provides.length === 0) {
    problems.push(`${label}: provides must list at least one program or library`);
    return [];
  }
  const out = [];
  for (const [index, provide] of provides.entries()) {
    const at = `${label}: provides[${index}]`;
    if (!isObject(provide)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    const known = new Set(["name", "link", "path", "version", "pattern", "package", "pinned", "note"]);
    for (const key of Object.keys(provide)) if (!known.has(key)) problems.push(`${at}: unknown field ${key}`);
    if (provide.name !== undefined && (typeof provide.name !== "string" || !PROGRAM.test(provide.name))) problems.push(`${at}: name must match ${PROGRAM}`);
    if (provide.link !== undefined && (typeof provide.link !== "string" || !PROGRAM.test(provide.link))) problems.push(`${at}: link must match ${PROGRAM}`);
    if (provide.path !== undefined && (typeof provide.path !== "string" || provide.path === "" || provide.path.split("/").includes(".."))) problems.push(`${at}: path must be a path inside the install folder or absolute`);
    if (provide.version !== undefined && !stringArray(provide.version)) problems.push(`${at}: version must be a command (a non-empty list of words)`);
    if (provide.pattern !== undefined) {
      try {
        new RegExp(provide.pattern, "m");
      } catch {
        problems.push(`${at}: pattern is not a regular expression`);
      }
    }
    if (provide.package !== undefined && (typeof provide.package !== "string" || provide.package === "")) problems.push(`${at}: package must be a package name`);
    if (provide.pinned !== undefined && typeof provide.pinned !== "boolean") problems.push(`${at}: pinned must be true or false`);
    if (provide.name === undefined && provide.link === undefined) problems.push(`${at}: names nothing (give a name, a link or both)`);
    if (provide.link !== undefined && provide.path === undefined) problems.push(`${at}: a link needs the path it points to`);
    out.push(provide);
  }
  return out;
}

/** One entry of a kind, checked; null when its file is not an entry. */
function readEntry(kind, name, file, context, problems) {
  const label = path.relative(context, file).split(path.sep).join("/");
  if (!NAME.test(name)) problems.push(`${label}: the entry name ${name} must match ${NAME}`);
  const meta = readJson(file, problems, label);
  if (!isObject(meta)) {
    if (meta !== null) problems.push(`${label}: not an object`);
    return null;
  }
  const allowed = {
    binaries: ["version", "url", "sha256", "archive", "save", "strip", "extract", "executable"],
    go: ["module", "version", "tags", "ldflags", "cgo"],
    cargo: ["crate", "version", "features"],
    dotnet: ["package", "version", "sha256"],
    apt: ["packages"],
    python: [],
    node: [],
    gem: [],
    parts: ["version", "stage"],
  }[kind];
  for (const key of Object.keys(meta)) if (key !== "provides" && key !== "note" && !allowed.includes(key)) problems.push(`${label}: unknown field ${key}`);
  if (VERSIONED.has(kind) && kind !== "parts" && (typeof meta.version !== "string" || !VERSION.test(meta.version))) problems.push(`${label}: version must be an exact version`);
  if (kind === "parts" && meta.version !== undefined && (typeof meta.version !== "string" || !VERSION.test(meta.version))) problems.push(`${label}: version must be an exact version`);
  const sibling = (suffix) => path.join(path.dirname(file), suffix);
  let locked = {};
  switch (kind) {
    case "binaries":
      if (typeof meta.url !== "string" || !/^https:\/\//.test(meta.url)) problems.push(`${label}: url must be an https URL ({version} is replaced)`);
      if (typeof meta.sha256 !== "string" || !SHA.test(meta.sha256)) problems.push(`${label}: sha256 must be the published SHA-256 (or SHA-512) in hex`);
      if (!ARCHIVES.includes(meta.archive ?? "file")) problems.push(`${label}: archive must be one of ${ARCHIVES.join(", ")}`);
      if (meta.save !== undefined && (typeof meta.save !== "string" || meta.save.includes("/") || meta.save === "")) problems.push(`${label}: save must be a file name`);
      if (meta.save !== undefined && (meta.archive ?? "file") !== "file") problems.push(`${label}: save is for archive "file" only`);
      if (meta.strip !== undefined && (!Number.isInteger(meta.strip) || meta.strip < 0)) problems.push(`${label}: strip must be a whole number`);
      if (meta.extract !== undefined && (!isObject(meta.extract) || Object.keys(meta.extract).length === 0 || Object.values(meta.extract).some((to) => typeof to !== "string" || to === "" || to.split("/").includes("..")))) problems.push(`${label}: extract maps a path in the archive to a path in the install folder`);
      if (meta.executable !== undefined && !stringArray(meta.executable)) problems.push(`${label}: executable lists paths of the install folder`);
      break;
    case "go":
      if (typeof meta.module !== "string" || !/^[a-z0-9.-]+\.[a-z]+\/\S+$/.test(meta.module)) problems.push(`${label}: module must be a Go module path`);
      if (meta.tags !== undefined && !stringArray(meta.tags)) problems.push(`${label}: tags must be a list of build tags`);
      if (meta.ldflags !== undefined && typeof meta.ldflags !== "string") problems.push(`${label}: ldflags must be text`);
      if (meta.cgo !== undefined && typeof meta.cgo !== "boolean") problems.push(`${label}: cgo must be true or false`);
      break;
    case "cargo":
      if (typeof meta.crate !== "string" || !/^[A-Za-z0-9_-]+$/.test(meta.crate)) problems.push(`${label}: crate must be a crate name`);
      if (meta.features !== undefined && !stringArray(meta.features)) problems.push(`${label}: features must be a list`);
      break;
    case "dotnet":
      if (typeof meta.package !== "string" || !/^[A-Za-z0-9_.-]+$/.test(meta.package)) problems.push(`${label}: package must be a NuGet package id`);
      if (typeof meta.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.sha256)) problems.push(`${label}: sha256 must be the SHA-256 of the .nupkg`);
      break;
    case "apt":
      if (!stringArray(meta.packages) || meta.packages.some((p) => !DEBIAN_PACKAGE.test(p))) problems.push(`${label}: packages must list Debian package names`);
      break;
    case "python":
      for (const suffix of [`${name}.in`, `${name}.txt`]) if (!fs.existsSync(sibling(suffix))) problems.push(`${label}: ${suffix} is missing beside it`);
      locked = pythonLocked(sibling(`${name}.in`));
      break;
    case "node":
      for (const suffix of ["package.json", "package-lock.json"]) if (!fs.existsSync(sibling(suffix))) problems.push(`${label}: ${suffix} is missing beside it`);
      locked = nodeLocked(sibling("package.json"));
      break;
    case "gem":
      for (const suffix of ["Gemfile", "Gemfile.lock"]) if (!fs.existsSync(sibling(suffix))) problems.push(`${label}: ${suffix} is missing beside it`);
      locked = gemLocked(sibling("Gemfile.lock"));
      break;
    case "parts": {
      const dockerfile = sibling(`${name}.Dockerfile`);
      const stage = meta.stage ?? `part-${name}`;
      if (!fs.existsSync(dockerfile)) problems.push(`${label}: ${name}.Dockerfile is missing beside it`);
      else if (!new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "mi").test(fs.readFileSync(dockerfile, "utf8"))) problems.push(`${label}: ${name}.Dockerfile must define the stage ${stage} (its result in /opt/tools/parts/${name})`);
      break;
    }
    default:
      break;
  }
  const provides = checkProvides(label, meta.provides, problems);
  const dir = installDir(kind, name);
  const pinOf = (provide) => {
    if (provide.pinned === false || provide.name === undefined) return null;
    if (VERSIONED.has(kind)) return provide.name === name || provide.pinned === true ? (meta.version ?? null) : null;
    if (kind === "python") return locked[(provide.package ?? provide.name).toLowerCase()] ?? null;
    if (kind === "node" || kind === "gem") return locked[provide.package ?? provide.name] ?? null;
    return null;
  };
  return {
    kind,
    name,
    file: label,
    dir,
    version: typeof meta.version === "string" ? meta.version : null,
    meta,
    provides: provides.map((provide) => ({
      ...provide,
      target: provide.path === undefined ? null : provide.path.startsWith("/") ? provide.path : path.posix.join(dir, provide.path),
      pin: pinOf(provide),
    })),
  };
}

/** Every install entry under the tools context, with the problems found (an empty list when all are well formed). */
export function readInstalls(context = TOOLS_CONTEXT) {
  const problems = [];
  const entries = [];
  const json = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);
  for (const kind of KINDS) {
    const base = path.join(context, kind);
    if (!fs.existsSync(base)) continue;
    if (kind === "python") {
      for (const version of fs.readdirSync(base).filter((v) => fs.statSync(path.join(base, v)).isDirectory()).sort()) {
        const dir = path.join(base, version);
        const tools = new Set(fs.readdirSync(dir).filter((f) => /\.(?:in|txt|json)$/.test(f)).map((f) => f.replace(/\.(?:in|txt|json)$/, "")));
        for (const tool of [...tools].sort()) {
          const file = path.join(dir, `${tool}.json`);
          if (!fs.existsSync(file)) {
            problems.push(`python/${version}/${tool}.json is missing: every Python tool names what it provides`);
            continue;
          }
          const entry = readEntry(kind, tool, file, context, problems);
          if (entry) entries.push({ ...entry, python: version });
        }
      }
    } else if (kind === "node" || kind === "gem") {
      for (const tool of fs.readdirSync(base).filter((t) => fs.statSync(path.join(base, t)).isDirectory()).sort()) {
        const file = path.join(base, tool, "install.json");
        if (!fs.existsSync(file)) {
          problems.push(`${kind}/${tool}/install.json is missing: every ${kind === "node" ? "Node" : "Ruby"} tool names what it provides`);
          continue;
        }
        const entry = readEntry(kind, tool, file, context, problems);
        if (entry) entries.push(entry);
      }
    } else {
      for (const file of json(base)) {
        const entry = readEntry(kind, file.slice(0, -".json".length), path.join(base, file), context, problems);
        if (entry) entries.push(entry);
      }
    }
  }
  const byName = new Map();
  const names = new Map();
  const links = new Map();
  for (const entry of entries) {
    if (byName.has(entry.name)) problems.push(`${entry.file}: the entry name ${entry.name} is also ${byName.get(entry.name).file}`);
    else byName.set(entry.name, entry);
    for (const provide of entry.provides) {
      if (provide.name !== undefined) {
        if (names.has(provide.name)) problems.push(`${entry.file}: ${provide.name} is also provided by ${names.get(provide.name)}`);
        else names.set(provide.name, entry.file);
      }
      if (provide.link !== undefined) {
        if (links.has(provide.link)) problems.push(`${entry.file}: the link ${provide.link} is also made by ${links.get(provide.link)}`);
        else links.set(provide.link, entry.file);
      }
    }
  }
  return { entries, problems };
}

/** The entry with this name (the `install` field of a descriptor), or the one that provides this image.json name. */
export function findInstall(entries, name) {
  return entries.find((entry) => entry.name === name) ?? entries.find((entry) => entry.provides.some((p) => p.name === name)) ?? null;
}

/** The pins of the install entries: image.json name -> version. */
export function installPins(entries) {
  const pins = {};
  for (const entry of entries) for (const provide of entry.provides) if (provide.pin) pins[provide.name] = provide.pin;
  return pins;
}

/** The index the image carries at /usr/share/jgates/installs.json (links.sh and write-image-json.py read it). */
export function installIndex(entries) {
  return {
    schemaVersion: 1,
    entries: entries.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      dir: entry.dir,
      version: entry.version,
      provides: entry.provides.map((provide) => {
        const out = {};
        if (provide.name !== undefined) out.name = provide.name;
        if (provide.link !== undefined) out.link = provide.link;
        if (provide.target) out.target = provide.target;
        if (provide.version) {
          out.command = provide.version;
          if (provide.pattern) out.pattern = provide.pattern;
        } else if (provide.name !== undefined) {
          const pkg = provide.package ?? provide.name;
          if (entry.kind === "python") out.library = { python: `${entry.dir}/bin/python`, distribution: pkg };
          else if (entry.kind === "node") out.library = { packageJson: `${entry.dir}/node_modules/${pkg}/package.json` };
          else out.library = { missing: `${entry.kind} entries name a version command for every program` };
        }
        out.pin = provide.pin;
        return out;
      }),
    })),
  };
}

/** The toolchains and base programs of the image (docker/tools/runtimes.json). */
export function readRuntimes(context = TOOLS_CONTEXT) {
  return JSON.parse(fs.readFileSync(path.join(context, "runtimes.json"), "utf8")).runtimes;
}

/**
 * The programs of the image with the command that asks each for its version, for the Docker test: name -> {command
 * (shell text), pattern}. Libraries answer through their package metadata. quality-sidecar is JGates' own and is read
 * from its project file.
 */
export function imagePrograms(context = TOOLS_CONTEXT) {
  const { entries } = readInstalls(context);
  const quote = (word) => (/^[A-Za-z0-9_./=:@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);
  const programs = {};
  for (const runtime of readRuntimes(context)) programs[runtime.name] = { command: runtime.stepCommand ?? runtime.version.map(quote).join(" "), pattern: runtime.pattern ?? null };
  for (const entry of installIndex(entries).entries) {
    for (const provide of entry.provides) {
      if (provide.name === undefined) continue;
      if (provide.command) programs[provide.name] = { command: provide.command.map(quote).join(" "), pattern: provide.pattern ?? null };
      else if (provide.library?.python) programs[provide.name] = { command: `${provide.library.python} -c ${quote(`import importlib.metadata as m; print(m.version(${JSON.stringify(provide.library.distribution)}))`)}`, pattern: null };
      else if (provide.library?.packageJson) programs[provide.name] = { command: `node -p ${quote(`require(${JSON.stringify(provide.library.packageJson)}).version`)}`, pattern: null };
    }
  }
  programs["quality-sidecar"] = { command: `/opt/tools/python/quality-sidecar/bin/python -c ${quote('import tomllib; print(tomllib.load(open("/opt/jgates/quality-gate/pyproject.toml", "rb"))["project"]["version"])')}`, pattern: null };
  return programs;
}

// ---------------------------------------------------------------------------------------------------------------------
// The assembled Dockerfile
// ---------------------------------------------------------------------------------------------------------------------

export const PARTS_STAGES_MARK = "# @jgates:parts-stages";
export const PARTS_COPY_MARK = "# @jgates:parts-copy";

/** The parts (parts/<name>.Dockerfile with parts/<name>.json), in name order. */
export function readParts(context = TOOLS_CONTEXT) {
  const dir = path.join(context, "parts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".Dockerfile"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -".Dockerfile".length);
      const metaFile = path.join(dir, `${name}.json`);
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
      return { name, stage: meta.stage ?? `part-${name}`, text: fs.readFileSync(path.join(dir, f), "utf8") };
    });
}

/** The stages of the given parts and the lines of the final stage that copy their results in. */
export function partsText(parts) {
  const stages = parts.map((part) => `# --- part ${part.name} (parts/${part.name}.Dockerfile) ---\n${part.text.trimEnd()}\n`).join("\n");
  const copies = parts.map((part) => `COPY --from=${part.stage} /opt/tools/parts/${part.name} /opt/tools/parts/${part.name}`).join("\n");
  return { stages, copies };
}

/** docker/tools/Dockerfile with the parts inserted at its two marks; the text every gate and test reads. */
export function assembledDockerfile(context = TOOLS_CONTEXT) {
  const base = fs.readFileSync(path.join(context, "Dockerfile"), "utf8");
  for (const mark of [PARTS_STAGES_MARK, PARTS_COPY_MARK]) if (!base.includes(mark)) throw new Error(`docker/tools/Dockerfile lacks the line ${mark}`);
  const { stages, copies } = partsText(readParts(context));
  return base.replace(PARTS_STAGES_MARK, stages ? `${PARTS_STAGES_MARK}\n${stages}` : PARTS_STAGES_MARK).replace(PARTS_COPY_MARK, copies ? `${PARTS_COPY_MARK}\n${copies}` : PARTS_COPY_MARK);
}

/**
 * Writes what a build needs beside the context: the assembled Dockerfile and the named context `jgates-installs`
 * (installs.json). Returns their paths. Fails on a malformed entry.
 */
export function stageBuildInputs(dir, context = TOOLS_CONTEXT) {
  const { entries, problems } = readInstalls(context);
  if (problems.length > 0) throw new Error(`the install entries have problems:\n  ${problems.join("\n  ")}`);
  const installsDir = path.join(dir, "jgates-installs");
  fs.mkdirSync(installsDir, { recursive: true });
  fs.writeFileSync(path.join(installsDir, "installs.json"), `${JSON.stringify(installIndex(entries), null, 2)}\n`);
  const dockerfile = path.join(dir, "Dockerfile");
  fs.writeFileSync(dockerfile, assembledDockerfile(context));
  return { dockerfile, installsDir, entries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2);
  const { entries, problems } = readInstalls();
  if (command === "check") {
    for (const problem of problems) console.error(`image-installs: ${problem}`);
    console.log(`image-installs: ${entries.length} entries, ${problems.length} problem(s)`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  } else if (command === "index") {
    process.stdout.write(`${JSON.stringify(installIndex(entries), null, 2)}\n`);
  } else if (command === "dockerfile") {
    process.stdout.write(assembledDockerfile());
  } else {
    console.error("usage: image-installs.mjs check | index | dockerfile");
    process.exitCode = 2;
  }
}
