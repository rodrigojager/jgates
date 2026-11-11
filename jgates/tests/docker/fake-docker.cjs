#!/usr/bin/env node
// A fake container runtime for the default suite: records every invocation (one JSON line per call in
// FAKE_DOCKER_LOG) and behaves like a daemon just enough for the engine module and the container runner.
//   FAKE_DOCKER_MODE=ok    `run` prints FAKE_DOCKER_STDOUT and exits with FAKE_DOCKER_EXIT (default 0)
//   FAKE_DOCKER_MODE=hang  `run` creates a "container" (a file in FAKE_DOCKER_STATE) that lives until `rm` removes it;
//                          the client dies on SIGTERM and leaves the container behind, like a real client does
//   FAKE_DOCKER_LABELS     the labels `image inspect` reports (JSON labels; "none": no such image); with --format it
//                          prints them, without it the JSON array of the runtime (Id, RepoDigests, Config.Labels)
//   FAKE_DOCKER_IMAGE_ID   the image id of that array (default: sha256 of the labels); FAKE_DOCKER_REPO_DIGESTS: JSON list
//   FAKE_DOCKER_STEP_MODE  hang|vanish for step containers only (label org.jgates.kind=step), optionally only those whose name
//                          contains FAKE_DOCKER_STEP_NAME; a hung container is registered in objects.json with its labels so
//                          kill/rm by label finds it; `stop` and `kill` end it. vanish: after FAKE_DOCKER_VANISH_MS (150) the
//                          engine stops answering for good (state/daemon.lost) and the client dies with a connection error.
// Engine facts (`info`, and the `df` of the helper container):
//   FAKE_DOCKER_DAEMON=stopped   every command that needs the daemon fails like "Cannot connect to the Docker daemon"
//   FAKE_DOCKER_MEMORY_MB (default 8192), FAKE_DOCKER_CPUS (4), FAKE_DOCKER_OS (linux), FAKE_DOCKER_ARCH (x86_64),
//   FAKE_DOCKER_DISK_FREE_MB (default 102400): free space the helper `df -Pk /` reports
// Image transfer (`save --output <file> <ref>`, `load --input <file>`): see the save / load section; FAKE_DOCKER_SAVE_FAIL=1,
//   FAKE_DOCKER_LOAD_FAIL=1; a load is recorded in FAKE_DOCKER_STATE/loaded.jsonl
// Pulls (`pull`, `manifest inspect`):
//   FAKE_DOCKER_PULL_LAYERS  JSON [{ "id": "<12 hex>", "size": <bytes> }] (default: three layers)
//   FAKE_DOCKER_PULL_DROPS   how many pull attempts drop mid-way (default 0); FAKE_DOCKER_PULL_DROP_AFTER: layers
//                            completed before a drop (default 1). Completed layers survive in the state folder and print
//                            "Already exists" on the next attempt, like the real engine resuming.
//   FAKE_DOCKER_MANIFEST=none    `manifest inspect` fails (no layer sizes)
// Volume contents (`run` with --mount): a volume is the folder FAKE_DOCKER_STATE/volumes/<name>/.
//   the sync helper (mounts /stage and /dst) deletes the paths of removed.lst and unpacks changes.tar into the volume with an
//   independent tar reader; the modes it unpacked are kept in volumes/<name>.modes.json (a Windows file system has none)
//   FAKE_DOCKER_WORKSPACE_WRITES  JSON list of relative paths a container that mounts a volume at /workspace writes there
//   (plays a test step that writes files)
//   FAKE_DOCKER_DEPS_EXIT  exit code of the dependency install containers (label org.jgates.kind=deps; default 0); on
//   success they write {"key": $JGATES_DEPS_KEY} at $JGATES_DEPS_MARKER in the volume mounted there, like the real script
//   FAKE_DOCKER_DATA_FAIL  comma list of advisory databases whose refresh container (label org.jgates.kind=data, `python3 -c
//   <script> <database>`) fails; a refresh that works writes a marker database and stamps its fetch time (now, or
//   FAKE_DOCKER_DATA_FETCHED) in /data/jgates-data.json of the volume mounted there; `cat /data/jgates-data.json` in a data
//   container prints that file (fails when the volume has none)
// Objects: volumes, containers, networks and images live in FAKE_DOCKER_STATE/objects.json
//   { containers: [{ id, name, state, labels }], volumes: [{ name, labels }], networks: [...], images: [...] };
//   `volume create`, `volume rm`, `ps`/`container ls`, `volume ls`, `network ls`, `image ls`, `kill`, `rm`, `*  prune`
//   and `system df -v` work on it and honour `--filter label=k[=v]` (all filters must match).
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\n");
const state = process.env.FAKE_DOCKER_STATE || process.cwd();
const marker = (name) => path.join(state, `${name}.container`);
const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== "" ? process.env[name] : fallback);

const fail = (message, code = 1) => {
  process.stderr.write(message + "\n");
  process.exit(code);
};
const needDaemon = () => {
  // daemon.lost: a step run in FAKE_DOCKER_STEP_MODE=vanish took the engine away for good.
  if (env("FAKE_DOCKER_DAEMON", "running") === "stopped" || fs.existsSync(path.join(state, "daemon.lost"))) fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
};

// ---- the object registry ---------------------------------------------------------------------------------------
const objectsFile = path.join(state, "objects.json");
const loadObjects = () => {
  const empty = { containers: [], volumes: [], networks: [], images: [] };
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(objectsFile, "utf8")) };
  } catch {
    return empty;
  }
};
const saveObjects = (objects) => fs.writeFileSync(objectsFile, JSON.stringify(objects));
const labelString = (labels) =>
  Object.entries(labels || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
const filtersOf = (args) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--filter" && args[i + 1]) out.push(args[++i]);
  return out;
};
const matches = (labels, filters) =>
  filters.every((f) => {
    const m = /^label=([^=]+)(?:=(.*))?$/.exec(f);
    if (!m) return true;
    return m[2] === undefined ? m[1] in (labels || {}) : (labels || {})[m[1]] === m[2];
  });
const labelsOfFlags = (args) => {
  const labels = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--label" && args[i + 1]) {
      const [k, ...rest] = args[++i].split("=");
      labels[k] = rest.join("=");
    }
  }
  return labels;
};
const lastNonFlags = (args) => args.filter((a) => !a.startsWith("-"));
const printJsonLines = (items) => items.forEach((item) => process.stdout.write(JSON.stringify(item) + "\n"));
const humanSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)}GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)}MB` : `${Math.round(bytes / 1e3)}kB`);

// ---- build ------------------------------------------------------------------------------------------------------
// `build [--build-arg K=V] [--label K=V] --tag <repo:tag> <context>`: the image the engine "built" is registered in objects.json
// (name, tag, labels, a built flag that `image prune` leaves alone) and `image inspect <repo:tag>` answers for it. The Dockerfile
// and the files of the context are recorded in builds.jsonl, with the build arguments. FAKE_DOCKER_BUILD_EXIT makes a build fail
// (FAKE_DOCKER_BUILD_STDERR is its message); the base image of FROM is never pulled, a missing one fails like the real engine.
if (argv[0] === "build") {
  needDaemon();
  const tag = argv[argv.indexOf("--tag") + 1];
  const buildArgs = {};
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--build-arg") buildArgs[argv[i + 1].split("=")[0]] = argv[i + 1].split("=").slice(1).join("=");
  const context = argv[argv.length - 1];
  const dockerfile = path.join(context, "Dockerfile");
  if (!fs.existsSync(dockerfile)) fail(`failed to read dockerfile: open ${dockerfile}: no such file or directory`);
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(context, "");
  process.stdout.write(`#1 [internal] load build definition from Dockerfile\n#1 DONE 0.0s\n`);
  fs.appendFileSync(path.join(state, "builds.jsonl"), JSON.stringify({ tag, buildArgs, labels: labelsOfFlags(argv), dockerfile: fs.readFileSync(dockerfile, "utf8"), files: files.sort() }) + "\n");
  if (process.env.FAKE_DOCKER_BUILD_EXIT && Number(process.env.FAKE_DOCKER_BUILD_EXIT) !== 0) {
    fail(process.env.FAKE_DOCKER_BUILD_STDERR || "ERROR: failed to solve: process \"/bin/sh -c pip install nothing\" did not complete successfully: exit code: 1", Number(process.env.FAKE_DOCKER_BUILD_EXIT));
  }
  const [name, version] = tag.split(":");
  const objects = loadObjects();
  const labels = labelsOfFlags(argv);
  const id = `sha256:${crypto.createHash("sha256").update(JSON.stringify([tag, labels, fs.readFileSync(dockerfile, "utf8"), files])).digest("hex")}`;
  objects.images = objects.images.filter((o) => !(o.name === name && o.tag === version)).concat([{ id, name, tag: version, labels, sizeBytes: 250000000, built: true }]);
  saveObjects(objects);
  process.stdout.write(`#2 exporting to image\n#2 naming to ${tag} done\n`);
  process.exit(0);
}

// ---- image inspect ---------------------------------------------------------------------------------------------
if (argv[0] === "image" && argv[1] === "inspect") {
  needDaemon();
  const asked = argv[argv.length - 1];
  const builtImage = loadObjects().images.find((o) => o.built && (`${o.name}:${o.tag}` === asked || o.id === asked));
  if (builtImage) {
    const object = { Id: builtImage.id, Size: builtImage.sizeBytes || 1000, Config: { Labels: builtImage.labels || {} } };
    process.stdout.write((argv.includes("--format") ? JSON.stringify(object) : JSON.stringify([{ ...object, RepoDigests: [] }])) + "\n");
    process.exit(0);
  }
  const labels = process.env.FAKE_DOCKER_LABELS || '{"org.jgates.tool.version":"0.17.2"}';
  if (labels === "none") {
    process.stderr.write("Error: No such image\n");
    process.exit(1);
  }
  const formatAt = argv.indexOf("--format");
  const asObject = () => ({ Id: process.env.FAKE_DOCKER_IMAGE_ID || `sha256:${crypto.createHash("sha256").update(labels).digest("hex")}`, Size: 1000, Config: { Labels: JSON.parse(labels) } });
  if (formatAt >= 0 && argv[formatAt + 1] === "{{json .}}") process.stdout.write(JSON.stringify(asObject()) + "\n");
  else if (formatAt >= 0) process.stdout.write(labels + "\n");
  else {
    const id = process.env.FAKE_DOCKER_IMAGE_ID || `sha256:${crypto.createHash("sha256").update(labels).digest("hex")}`;
    const repoDigests = JSON.parse(process.env.FAKE_DOCKER_REPO_DIGESTS || "[]");
    process.stdout.write(JSON.stringify([{ Id: id, RepoDigests: repoDigests, Config: { Labels: JSON.parse(labels) } }]) + "\n");
  }
  process.exit(0);
}

// ---- info / version ---------------------------------------------------------------------------------------------
if (argv[0] === "info") {
  needDaemon();
  const info = {
    ServerVersion: "27.0.1-fake",
    OSType: env("FAKE_DOCKER_OS", "linux"),
    Architecture: env("FAKE_DOCKER_ARCH", "x86_64"),
    MemTotal: Number(env("FAKE_DOCKER_MEMORY_MB", "8192")) * 1024 * 1024,
    NCPU: Number(env("FAKE_DOCKER_CPUS", "4")),
    DockerRootDir: "/var/lib/docker",
  };
  process.stdout.write(JSON.stringify(info) + "\n");
  process.exit(0);
}
if (argv[0] === "version") {
  needDaemon();
  process.stdout.write("27.0.1-fake\n");
  process.exit(0);
}

// ---- save / load -----------------------------------------------------------------------------------------------
// `save --output <file> <reference>` writes a small archive naming the image (FAKE_DOCKER_SAVE_FAIL=1: fails); `load --input
// <file>` reads one back, prints "Loaded image: <reference>" and records the load in FAKE_DOCKER_STATE/loaded.jsonl (a wrapper
// that wants the image to exist only after a load looks for that file; FAKE_DOCKER_LOAD_FAIL=1: fails).
const valueOf = (names) => {
  for (const name of names) {
    const at = argv.indexOf(name);
    if (at >= 0 && argv[at + 1]) return argv[at + 1];
  }
  return null;
};
if (argv[0] === "save") {
  needDaemon();
  if (env("FAKE_DOCKER_SAVE_FAIL", "") === "1") fail("Error response from daemon: save failed");
  const out = valueOf(["--output", "-o"]);
  const reference = argv[argv.length - 1];
  const labels = process.env.FAKE_DOCKER_LABELS || '{"org.jgates.tool.version":"0.17.2"}';
  const id = process.env.FAKE_DOCKER_IMAGE_ID || `sha256:${crypto.createHash("sha256").update(labels).digest("hex")}`;
  if (!out) fail("save: --output is required");
  fs.writeFileSync(out, `fake image archive\nreference=${reference}\nid=${id}\npadding=${"x".repeat(4096)}\n`);
  process.exit(0);
}
if (argv[0] === "load") {
  needDaemon();
  if (env("FAKE_DOCKER_LOAD_FAIL", "") === "1") fail("Error processing tar file: unexpected EOF");
  const input = valueOf(["--input", "-i"]);
  if (!input || !fs.existsSync(input)) fail("open: no such file or directory");
  const text = fs.readFileSync(input, "utf8");
  const reference = /^reference=(.*)$/m.exec(text)?.[1] || "image";
  fs.appendFileSync(path.join(state, "loaded.jsonl"), JSON.stringify({ file: input, reference }) + "\n");
  process.stdout.write(`Loaded image: ${reference}\n`);
  process.exit(0);
}

// ---- pull ------------------------------------------------------------------------------------------------------
const pullLayers = () => JSON.parse(env("FAKE_DOCKER_PULL_LAYERS", JSON.stringify([{ id: "aaaaaaaaaaaa", size: 40000000 }, { id: "bbbbbbbbbbbb", size: 120000000 }, { id: "cccccccccccc", size: 60000000 }])));
if (argv[0] === "manifest" && argv[1] === "inspect") {
  needDaemon();
  if (env("FAKE_DOCKER_MANIFEST", "ok") === "none") fail("no such manifest");
  const layers = pullLayers().map((l) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", size: l.size, digest: `sha256:${l.id}${"0".repeat(52)}` }));
  process.stdout.write(JSON.stringify({ schemaVersion: 2, layers }) + "\n");
  process.exit(0);
}
if (argv[0] === "pull") {
  needDaemon();
  const progressFile = path.join(state, "pull-progress.json");
  const attemptsFile = path.join(state, "pull-attempts");
  const attempt = (fs.existsSync(attemptsFile) ? Number(fs.readFileSync(attemptsFile, "utf8")) : 0) + 1;
  fs.writeFileSync(attemptsFile, String(attempt));
  const done = new Set(fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, "utf8")) : []);
  const drops = Number(env("FAKE_DOCKER_PULL_DROPS", "0"));
  const dropAfter = Number(env("FAKE_DOCKER_PULL_DROP_AFTER", "1"));
  const reference = lastNonFlags(argv.slice(1))[0] || "image";
  process.stdout.write(`${reference.split(":")[1] || "latest"}: Pulling from ${reference.split(":")[0]}\n`);
  let completedNow = 0;
  for (const layer of pullLayers()) {
    if (done.has(layer.id)) {
      process.stdout.write(`${layer.id}: Already exists\n`);
      continue;
    }
    process.stdout.write(`${layer.id}: Pulling fs layer\n`);
    if (attempt <= drops && completedNow >= dropAfter) {
      process.stderr.write(`error pulling image configuration: download failed after attempts=1: unexpected EOF\n`);
      process.exit(1);
    }
    process.stdout.write(`${layer.id}: Download complete\n${layer.id}: Pull complete\n`);
    done.add(layer.id);
    completedNow++;
    fs.writeFileSync(progressFile, JSON.stringify([...done]));
  }
  process.stdout.write(`Digest: sha256:${"d".repeat(64)}\nStatus: Downloaded newer image for ${reference}\n`);
  process.exit(0);
}

// ---- volumes ---------------------------------------------------------------------------------------------------
if (argv[0] === "volume") {
  needDaemon();
  const objects = loadObjects();
  const sub = argv[1];
  const rest = argv.slice(2);
  if (sub === "inspect") {
    const name = lastNonFlags(rest.filter((a, i) => rest[i - 1] !== "--format"))[0];
    if (!objects.volumes.some((v) => v.name === name)) fail(`Error response from daemon: get ${name}: no such volume`);
    process.stdout.write(name + "\n");
    process.exit(0);
  }
  if (sub === "create") {
    const name = lastNonFlags(rest.filter((a, i) => rest[i - 1] !== "--label"))[0];
    objects.volumes = objects.volumes.filter((v) => v.name !== name).concat([{ name, labels: labelsOfFlags(rest) }]);
    saveObjects(objects);
    process.stdout.write(name + "\n");
    process.exit(0);
  }
  if (sub === "ls") {
    printJsonLines(objects.volumes.filter((v) => matches(v.labels, filtersOf(rest))).map((v) => ({ Name: v.name, Driver: "local", Labels: labelString(v.labels) })));
    process.exit(0);
  }
  if (sub === "rm") {
    const names = lastNonFlags(rest);
    objects.volumes = objects.volumes.filter((v) => !names.includes(v.name));
    for (const name of names) {
      fs.rmSync(path.join(state, "volumes", name), { recursive: true, force: true });
      fs.rmSync(path.join(state, "volumes", `${name}.modes.json`), { force: true });
    }
    saveObjects(objects);
    process.exit(0);
  }
  if (sub === "prune") {
    const filters = filtersOf(rest);
    objects.volumes = objects.volumes.filter((v) => !matches(v.labels, filters));
    saveObjects(objects);
    process.exit(0);
  }
  process.exit(0);
}

// ---- listing, killing, pruning other objects --------------------------------------------------------------------
const listKind = argv[0] === "ps" || (argv[0] === "container" && argv[1] === "ls") ? "containers" : argv[0] === "network" && argv[1] === "ls" ? "networks" : argv[0] === "image" && argv[1] === "ls" ? "images" : null;
if (listKind) {
  needDaemon();
  const objects = loadObjects();
  const showAll = argv.includes("--all") || argv.includes("-a");
  const items = objects[listKind].filter((o) => matches(o.labels, filtersOf(argv)) && (listKind !== "containers" || showAll || o.state === "running"));
  printJsonLines(
    items.map((o) =>
      listKind === "containers"
        ? { ID: o.id, Names: o.name, State: o.state, Labels: labelString(o.labels) }
        : listKind === "networks"
          ? { ID: o.id, Name: o.name, Labels: labelString(o.labels) }
          : { ID: o.id, Repository: o.name, Tag: o.tag || "dev", Size: humanSize(o.sizeBytes || 0), Labels: labelString(o.labels) },
    ),
  );
  process.exit(0);
}
if (argv[1] === "prune" && ["container", "network", "image"].includes(argv[0])) {
  needDaemon();
  const objects = loadObjects();
  const key = argv[0] + "s";
  const filters = filtersOf(argv);
  // Only dangling images are pruned: an image a `build` made keeps its tag, so it is never dangling.
  objects[key] = objects[key].filter((o) => o.built || !matches(o.labels, filters));
  saveObjects(objects);
  process.exit(0);
}
if (argv[0] === "system" && argv[1] === "df") {
  needDaemon();
  const objects = loadObjects();
  process.stdout.write(
    JSON.stringify({
      Images: objects.images.map((i) => ({ ID: i.id, Repository: i.name, Tag: "dev", Size: humanSize(i.sizeBytes || 0), SharedSize: "0B", UniqueSize: humanSize(i.sizeBytes || 0) })),
      Containers: objects.containers.map((c) => ({ ID: c.id, Names: c.name, Size: "0B", State: c.state, Labels: labelString(c.labels) })),
      Volumes: objects.volumes.map((v) => ({ Name: v.name, Labels: labelString(v.labels), Size: humanSize(v.sizeBytes || 0) })),
    }) + "\n",
  );
  process.exit(0);
}
if ((argv[0] === "image" || argv[0] === "network" || argv[0] === "container") && argv[1] === "rm") {
  needDaemon();
  const objects = loadObjects();
  const key = argv[0] + "s";
  const ids = lastNonFlags(argv.slice(2));
  objects[key] = objects[key].filter((o) => !ids.includes(o.id) && !ids.includes(o.name) && !(o.tag && ids.includes(`${o.name}:${o.tag}`)));
  saveObjects(objects);
  process.exit(0);
}
if (argv[0] === "kill") {
  needDaemon();
  const ids = lastNonFlags(argv.slice(1));
  const objects = loadObjects();
  for (const c of objects.containers) if (ids.includes(c.id) || ids.includes(c.name)) fs.rmSync(marker(c.name), { force: true });
  objects.containers = objects.containers.map((c) => (ids.includes(c.id) || ids.includes(c.name) ? { ...c, state: "exited" } : c));
  saveObjects(objects);
  process.exit(0);
}

// ---- compose ---------------------------------------------------------------------------------------------------
// `compose ... up` exits with FAKE_DOCKER_COMPOSE_UP_EXIT (default FAKE_DOCKER_COMPOSE_EXIT, 0) and prints
// FAKE_DOCKER_COMPOSE_UP_STDERR on stderr (an unhealthy service); `compose ... logs` prints FAKE_DOCKER_COMPOSE_LOGS; `compose ...
// ps` prints FAKE_DOCKER_COMPOSE_PS (JSON lines). Every other compose command exits with FAKE_DOCKER_COMPOSE_EXIT.
if (argv[0] === "compose") {
  needDaemon();
  const sub = argv.find((a, i) => i > 0 && ["up", "down", "logs", "ps"].includes(a) && argv[i - 1] !== "-f" && argv[i - 1] !== "--project-name" && argv[i - 1] !== "--profile");
  if (sub === "up") {
    if (process.env.FAKE_DOCKER_COMPOSE_UP_STDERR) process.stderr.write(process.env.FAKE_DOCKER_COMPOSE_UP_STDERR + "\n");
    process.exit(Number(env("FAKE_DOCKER_COMPOSE_UP_EXIT", env("FAKE_DOCKER_COMPOSE_EXIT", "0"))));
  }
  if (sub === "logs") process.stdout.write(env("FAKE_DOCKER_COMPOSE_LOGS", ""));
  if (sub === "ps") process.stdout.write(env("FAKE_DOCKER_COMPOSE_PS", ""));
  process.exit(Number(env("FAKE_DOCKER_COMPOSE_EXIT", "0")));
}

// An independent tar reader (ustar + GNU long names): the archives the host writes are checked by other code.
const readTarBuffer = (buffer) => {
  const entries = [];
  let offset = 0;
  let longName = null;
  const text = (base, start, width) => {
    const slice = buffer.subarray(base + start, base + start + width);
    const end = slice.indexOf(0);
    return slice.subarray(0, end < 0 ? width : end).toString("utf8");
  };
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const checksum = parseInt(text(offset, 148, 8).trim(), 8);
    const sum = block.reduce((t, b, i) => t + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== sum) fail("tar: bad header checksum");
    const type = text(offset, 156, 1) || "0";
    const size = parseInt(text(offset, 124, 12).trim() || "0", 8);
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    const name = text(offset, 0, 100);
    offset += 512 + size + ((512 - (size % 512)) % 512);
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    entries.push({ path: (longName ?? name).replace(/\/$/, ""), type, data });
    longName = null;
  }
  return entries;
};

// ---- rm / run ---------------------------------------------------------------------------------------------------
if (argv[0] === "stop") {
  needDaemon();
  // `docker stop -t N name`: the container ends; its client (a `run` process polling the marker) exits like a stopped one.
  for (const name of lastNonFlags(argv.slice(1).filter((a, i, all) => all[i - 1] !== "--time" && all[i - 1] !== "-t"))) fs.rmSync(marker(name), { force: true });
  process.exit(0);
}
if (argv[0] === "rm") {
  const name = argv[argv.length - 1];
  fs.rmSync(marker(name), { force: true });
  const objects = loadObjects();
  const names = lastNonFlags(argv.slice(1));
  if (objects.containers.some((c) => names.includes(c.id) || names.includes(c.name))) {
    objects.containers = objects.containers.filter((c) => !names.includes(c.id) && !names.includes(c.name));
    saveObjects(objects);
  }
  process.exit(0);
}
if (argv[0] === "run") {
  needDaemon();
  const name = argv[argv.indexOf("--name") + 1];
  const runLabels = labelsOfFlags(argv);
  // FAKE_DOCKER_STEP_MODE (hang|vanish) applies only to step containers (label org.jgates.kind=step) whose name contains
  // FAKE_DOCKER_STEP_NAME (when set); every other run (the sync helper, other steps) uses FAKE_DOCKER_MODE.
  const stepMode = process.env.FAKE_DOCKER_STEP_MODE;
  const isTarget = runLabels["org.jgates.kind"] === "step" && stepMode && (!process.env.FAKE_DOCKER_STEP_NAME || name.includes(process.env.FAKE_DOCKER_STEP_NAME));
  const mode = isTarget ? stepMode : process.env.FAKE_DOCKER_MODE || "ok";
  if (mode === "vanish") {
    // The engine disappears while the step runs (Docker Desktop quit): from now on the daemon does not answer.
    setTimeout(() => {
      fs.writeFileSync(path.join(state, "daemon.lost"), "lost");
      fail("error during connect: Post \"http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.51/containers/create\": EOF", 1);
    }, Number(env("FAKE_DOCKER_VANISH_MS", "150")));
  } else if (mode === "hang") {
    fs.writeFileSync(marker(name), "running");
    // The container is registered with its labels, like a daemon does, so a kill/rm by label finds it.
    const registry = loadObjects();
    registry.containers = registry.containers.filter((c) => c.name !== name).concat([{ id: crypto.createHash("sha1").update(name).digest("hex").slice(0, 12), name, state: "running", labels: runLabels }]);
    saveObjects(registry);
    process.on("SIGTERM", () => process.exit(143));
    const poll = setInterval(() => {
      if (!fs.existsSync(marker(name))) {
        clearInterval(poll);
        process.exit(137);
      }
    }, 25);
  } else {
    // Mounts of the container: volumes live in FAKE_DOCKER_STATE/volumes/<name>/, bind mounts are their host folders.
    const mounts = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] !== "--mount") continue;
      const fields = Object.fromEntries(argv[i + 1].split(",").map((part) => { const at = part.indexOf("="); return at < 0 ? [part, true] : [part.slice(0, at), part.slice(at + 1)]; }));
      mounts.push({ type: fields.type, source: fields.src, target: fields.dst, readonly: fields.readonly === true });
    }
    const volumeDir = (name) => {
      const dir = path.join(state, "volumes", name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const hostOf = (mount) => (mount.type === "volume" ? volumeDir(mount.source) : mount.source);
    const piiScript = argv.find((a) => a.includes("quality_sidecar bridge"));
    if (piiScript && argv.includes("--interactive")) {
      // The PII helper container (jgates/src/core/pii-fix/helper.ts): standard input is one request line and then a base64 tar
      // of the files to scan. The fake unpacks it with its own reader, "detects" a formatted CPF (nnn.nnn.nnn-nn) and answers like the
      // bridge does: rule, entity, path and line, never the value. It records the request and the paths (never the content) in
      // pii-helper.jsonl, and fails like a crashed helper when FAKE_DOCKER_PII_EXIT is set.
      const input = fs.readFileSync(0, "utf8");
      const at = input.indexOf("\n");
      const request = JSON.parse(input.slice(0, at));
      const files = readTarBuffer(Buffer.from(input.slice(at + 1).trim(), "base64")).filter((e) => e.type === "0");
      fs.appendFileSync(path.join(state, "pii-helper.jsonl"), JSON.stringify({ target: request.target, operation: request.operation, files: files.map((f) => f.path), mounts: mounts.length }) + "\n");
      if (process.env.FAKE_DOCKER_PII_EXIT) fail("helper crashed", Number(process.env.FAKE_DOCKER_PII_EXIT));
      const findings = [];
      for (const file of files) {
        file.data.toString("utf8").split("\n").forEach((line, index) => {
          if (/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(line)) findings.push({ rule: "pii.cpf", entity: "cpf", severity: "medium", path: file.path, line: index + 1, message: "CPF found" });
        });
      }
      process.stdout.write(JSON.stringify({ schemaVersion: 1, operation: "pii", ok: true, status: findings.length ? "FINDINGS" : "OK", exitCode: 0, entities: ["cpf"], findings }) + "\n");
      process.exit(0);
    }
    const stage = mounts.find((m) => m.target === "/stage");
    const dst = mounts.find((m) => m.target === "/dst");
    const workspaceMount = mounts.find((m) => m.target === "/workspace" && m.type === "volume");
    if (stage && dst) {
      // The sync helper (jgates/src/core/sync): removes the listed paths, unpacks changes.tar into the volume, and records
      // the modes in <volume>/../<volume>.modes.json because the host file system may not carry them.
      // An independent tar reader (ustar + GNU long names), so the archive the host writes is checked by other code.
      const readTar = (buffer) => {
        const entries = [];
        let offset = 0;
        let base = 0;
        let longName = null;
        const text = (start, width) => {
          const slice = buffer.subarray(base + start, base + start + width);
          const end = slice.indexOf(0);
          return slice.subarray(0, end < 0 ? width : end).toString("utf8");
        };
        while (offset + 512 <= buffer.length) {
          base = offset;
          const block = buffer.subarray(offset, offset + 512);
          if (block.every((b) => b === 0)) break;
          const checksum = parseInt(text(148, 8).trim(), 8);
          const sum = block.reduce((t, b, i) => t + (i >= 148 && i < 156 ? 32 : b), 0);
          if (checksum !== sum) fail("tar: bad header checksum");
          const type = text(156, 1) || "0";
          const size = parseInt(text(124, 12).trim() || "0", 8);
          const data = buffer.subarray(offset + 512, offset + 512 + size);
          offset += 512 + size + ((512 - (size % 512)) % 512);
          if (type === "L") {
            longName = data.toString("utf8").replace(/\0+$/, "");
            continue;
          }
          entries.push({ path: (longName ?? text(0, 100)).replace(/\/$/, ""), type, mode: parseInt(text(100, 8).trim() || "0", 8), link: text(157, 100), data });
          longName = null;
        }
        return entries;
      };
      const root = hostOf(dst);
      const modesFile = path.join(state, "volumes", `${dst.source}.modes.json`);
      const modes = fs.existsSync(modesFile) ? JSON.parse(fs.readFileSync(modesFile, "utf8")) : {};
      const removedFile = path.join(stage.source, "removed.lst");
      const removed = fs.existsSync(removedFile) ? fs.readFileSync(removedFile, "utf8").split("\0").filter(Boolean) : [];
      for (const rel of removed) {
        fs.rmSync(path.join(root, rel), { recursive: true, force: true });
        for (const key of Object.keys(modes)) if (key === rel || key.startsWith(rel + "/")) delete modes[key];
      }
      const archive = path.join(stage.source, "changes.tar");
      for (const entry of fs.existsSync(archive) ? readTar(fs.readFileSync(archive)) : []) {
        const target = path.join(root, entry.path);
        if (entry.type === "5") fs.mkdirSync(target, { recursive: true });
        else if (entry.type === "2") {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.rmSync(target, { force: true });
          fs.writeFileSync(target, `symlink:${entry.link}`);
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entry.data);
        }
        modes[entry.path] = entry.mode & 0o777;
      }
      fs.writeFileSync(modesFile, JSON.stringify(modes));
      process.exit(0);
    }
    if (workspaceMount && process.env.FAKE_DOCKER_WORKSPACE_WRITES && runLabels["org.jgates.kind"] !== "deps") {
      // A step container whose tests write files: they land in the source volume, never anywhere else.
      for (const rel of JSON.parse(process.env.FAKE_DOCKER_WORKSPACE_WRITES)) {
        const target = path.join(hostOf(workspaceMount), rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "written by the step\n");
      }
    }
    if (process.env.FAKE_DOCKER_OUTPUT_FILES && runLabels["org.jgates.kind"] === "step") {
      // A step container whose tool writes reports: JSON { "<part of the container name>": { "<path under /output>": "<text>" } };
      // the files land in the run folder mounted at /output (a SARIF or JUnit report of a custom tool).
      const outMount = mounts.find((m) => m.target === "/output" && m.type === "bind");
      if (outMount) {
        for (const [part, files] of Object.entries(JSON.parse(process.env.FAKE_DOCKER_OUTPUT_FILES))) {
          if (!name.includes(part)) continue;
          for (const [rel, text] of Object.entries(files)) {
            const target = path.join(outMount.source, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, text);
          }
        }
      }
    }
    if (runLabels["org.jgates.kind"] === "deps") {
      // The deps container (jgates/src/core/deps): FAKE_DOCKER_DEPS_EXIT (default 0) is its exit code. On success it plays
      // the last line of the install script: the key ($JGATES_DEPS_KEY) goes to the marker ($JGATES_DEPS_MARKER) inside the
      // volume mounted there. What it read on stdin is recorded only as a sha256 in deps-stdin.jsonl (never the text).
      const envOf = (name) => {
        for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--env" && argv[i + 1].startsWith(`${name}=`)) return argv[i + 1].slice(name.length + 1);
        return undefined;
      };
      if (argv.includes("--interactive")) {
        const input = fs.readFileSync(0);
        fs.appendFileSync(path.join(state, "deps-stdin.jsonl"), JSON.stringify({ sha256: crypto.createHash("sha256").update(input).digest("hex"), bytes: input.length }) + "\n");
      }
      const code = Number(env("FAKE_DOCKER_DEPS_EXIT", "0"));
      const markerPath = envOf("JGATES_DEPS_MARKER");
      const key = envOf("JGATES_DEPS_KEY");
      if (code === 0 && markerPath && key) {
        const mount = mounts.filter((m) => m.type === "volume" && markerPath.startsWith(m.target + "/")).sort((a, b) => b.target.length - a.target.length)[0];
        if (mount) fs.writeFileSync(path.join(volumeDir(mount.source), markerPath.slice(mount.target.length + 1)), JSON.stringify({ key }) + "\n");
      }
      process.stdout.write(code === 0 ? "jgates-deps: installed\n" : "");
      if (code !== 0) process.stderr.write("fake install: the package index refused the request\n");
      process.exit(code);
    }
    const codeqlMount = mounts.find((m) => m.type === "volume" && m.target === "/codeql");
    if (runLabels["org.jgates.kind"] === "data" && codeqlMount) {
      // The CodeQL containers (jgates/src/core/codeql-prepare). The status read (`cat /codeql/jgates-codeql.json`, volume
      // mounted read-only) prints the file of the volume or fails like a missing file. The preparation (`python3 -c <script>`,
      // volume mounted for writing, with a network, JGATES_CODEQL_URL and JGATES_CODEQL_CHECKSUM_URL in its environment)
      // plays the real script: it fetches the bundle and its checksum file from the (local) release server, refuses a bundle
      // whose SHA-256 differs, and only then writes the bundle (codeql/bundle.fake), a codeql/codeql launcher and the status
      // file into the volume. Every verified preparation is recorded in codeql-prepare.jsonl. FAKE_DOCKER_CODEQL_VERSION
      // (default 2.18.4) is the version the status reports.
      const root = volumeDir(codeqlMount.source);
      const statusFile = path.join(root, "jgates-codeql.json");
      const catAt = argv.indexOf("cat");
      if (catAt > 0 && argv[catAt + 1] === "/codeql/jgates-codeql.json") {
        if (!fs.existsSync(statusFile)) fail("cat: /codeql/jgates-codeql.json: No such file or directory");
        process.stdout.write(fs.readFileSync(statusFile, "utf8"));
        process.exit(0);
      }
      if (argv.indexOf("python3") > 0) {
        const envOf = (name) => {
          for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--env" && argv[i + 1].startsWith(`${name}=`)) return argv[i + 1].slice(name.length + 1);
          return undefined;
        };
        if (codeqlMount.readonly) fail("python3: the CodeQL volume is mounted read-only");
        const url = envOf("JGATES_CODEQL_URL");
        const sumUrl = envOf("JGATES_CODEQL_CHECKSUM_URL");
        if (!url || !sumUrl) fail("jgates-codeql: no release URL");
        const get = (target) => {
          const fetcher =
            "const u=process.argv[1];const m=u.startsWith('https')?require('https'):require('http');" +
            "m.get(u,res=>{if(res.statusCode!==200){process.stderr.write('HTTP '+res.statusCode+' for '+u);process.exit(22)}" +
            "const c=[];res.on('data',d=>c.push(d));res.on('end',()=>process.stdout.write(Buffer.concat(c)))}).on('error',e=>{process.stderr.write(String(e.message));process.exit(1)})";
          const r = require("node:child_process").spawnSync(process.execPath, ["-e", fetcher, target], { maxBuffer: 1 << 28 });
          if (r.status !== 0) fail(`jgates-codeql: could not download ${target}: ${r.stderr.toString("utf8")}`);
          return r.stdout;
        };
        const name = url.slice(url.lastIndexOf("/") + 1);
        const line = get(sumUrl).toString("utf8").split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[0] && p[0].length === 64 && (p.length === 1 || p[p.length - 1].replace(/^\*/, "") === name));
        if (!line) fail(`jgates-codeql: the checksum file of the release has no SHA-256 for ${name}`);
        const bundle = get(url);
        const actual = crypto.createHash("sha256").update(bundle).digest("hex");
        if (actual !== line[0].toLowerCase()) fail(`jgates-codeql: checksum mismatch for ${name} (expected ${line[0]}, got ${actual}); nothing was installed`);
        fs.mkdirSync(path.join(root, "codeql"), { recursive: true });
        fs.writeFileSync(path.join(root, "codeql", "bundle.fake"), bundle);
        fs.writeFileSync(path.join(root, "codeql", "codeql"), "#!/bin/sh\necho fake codeql\n");
        fs.writeFileSync(
          statusFile,
          JSON.stringify({ schemaVersion: 1, version: env("FAKE_DOCKER_CODEQL_VERSION", "2.18.4"), sha256: actual, bytes: bundle.length, source: url, termsAcceptedAt: envOf("JGATES_CODEQL_TERMS_ACCEPTED_AT") || "", preparedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }, null, 2),
        );
        fs.appendFileSync(path.join(state, "codeql-prepare.jsonl"), JSON.stringify({ volume: codeqlMount.source, url, checksumUrl: sumUrl, sha256: actual, bytes: bundle.length, verified: true, network: argv[argv.indexOf("--network") + 1] }) + "\n");
        process.stdout.write(`jgates-codeql: ${name} ${actual} verified and installed\n`);
        process.exit(0);
      }
    }
    if (runLabels["org.jgates.kind"] === "data") {
      // The advisory data containers (jgates/src/core/data). The status read (`cat /data/jgates-data.json`, volume mounted
      // read-only) prints the file of the volume or fails like a missing file. The refresh (`python3 -c <script> <database>`,
      // volume mounted for writing, with a network) writes a small marker database and stamps its fetch time in the status
      // file (now, or FAKE_DOCKER_DATA_FETCHED); FAKE_DOCKER_DATA_FAIL (comma list of databases) makes those refreshes fail.
      const dataMount = mounts.find((m) => m.type === "volume" && m.target === "/data");
      const statusFile = dataMount ? path.join(volumeDir(dataMount.source), "jgates-data.json") : null;
      const catAt = argv.indexOf("cat");
      if (catAt > 0 && argv[catAt + 1] === "/data/jgates-data.json") {
        if (!statusFile || !fs.existsSync(statusFile)) fail("cat: /data/jgates-data.json: No such file or directory");
        process.stdout.write(fs.readFileSync(statusFile, "utf8"));
        process.exit(0);
      }
      const updateAt = argv.indexOf("python3");
      if (updateAt > 0 && statusFile) {
        const database = argv[argv.length - 1];
        if (env("FAKE_DOCKER_DATA_FAIL", "").split(",").includes(database)) fail(`fake refresh: ${database} could not be downloaded`);
        const dir = path.join(path.dirname(statusFile), database);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "marker"), "fake database\n");
        let doc = { schemaVersion: 1, databases: {} };
        try {
          doc = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        } catch {
          // the first refresh
        }
        doc.databases[database] = { fetchedAt: env("FAKE_DOCKER_DATA_FETCHED", new Date().toISOString().replace(/\.\d+Z$/, "Z")), source: `fake://${database}` };
        fs.writeFileSync(statusFile, JSON.stringify(doc, null, 2));
        process.stdout.write(`jgates-data: ${database} updated\n`);
        process.exit(0);
      }
    }
    // The disk probe of the engine module: `df -Pk /` in a helper container prints the free space of the storage.
    const commandAt = argv.findIndex((a, i) => a === "df" && argv[i - 1] !== "--name");
    if (commandAt > 0) {
      const freeKb = Number(env("FAKE_DOCKER_DISK_FREE_MB", "102400")) * 1024;
      process.stdout.write(`Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay ${freeKb * 2} ${freeKb} ${freeKb} 50% /\n`);
      process.exit(0);
    }
    process.stdout.write(process.env.FAKE_DOCKER_STDOUT || "");
    process.exit(Number(process.env.FAKE_DOCKER_EXIT || 0));
  }
} else {
  process.exit(0);
}
