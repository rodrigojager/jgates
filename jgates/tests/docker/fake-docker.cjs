#!/usr/bin/env node
// A fake container runtime for the default suite: records every invocation (one JSON line per call in
// FAKE_DOCKER_LOG) and behaves like a daemon just enough for the engine module and the container runner.
//   FAKE_DOCKER_MODE=ok    `run` prints FAKE_DOCKER_STDOUT and exits with FAKE_DOCKER_EXIT (default 0)
//   FAKE_DOCKER_MODE=hang  `run` creates a "container" (a file in FAKE_DOCKER_STATE) that lives until `rm` removes it;
//                          the client dies on SIGTERM and leaves the container behind, like a real client does
//   FAKE_DOCKER_LABELS     the labels `image inspect` reports (JSON labels; "none": no such image); with --format it
//                          prints them, without it the JSON array of the runtime (Id, RepoDigests, Config.Labels)
//   FAKE_DOCKER_IMAGE_ID   the image id of that array (default: sha256 of the labels); FAKE_DOCKER_REPO_DIGESTS: JSON list
// Engine facts (`info`, and the `df` of the helper container):
//   FAKE_DOCKER_DAEMON=stopped   every command that needs the daemon fails like "Cannot connect to the Docker daemon"
//   FAKE_DOCKER_MEMORY_MB (default 8192), FAKE_DOCKER_CPUS (4), FAKE_DOCKER_OS (linux), FAKE_DOCKER_ARCH (x86_64),
//   FAKE_DOCKER_DISK_FREE_MB (default 102400): free space the helper `df -Pk /` reports
// Pulls (`pull`, `manifest inspect`):
//   FAKE_DOCKER_PULL_LAYERS  JSON [{ "id": "<12 hex>", "size": <bytes> }] (default: three layers)
//   FAKE_DOCKER_PULL_DROPS   how many pull attempts drop mid-way (default 0); FAKE_DOCKER_PULL_DROP_AFTER: layers
//                            completed before a drop (default 1). Completed layers survive in the state folder and print
//                            "Already exists" on the next attempt, like the real engine resuming.
//   FAKE_DOCKER_MANIFEST=none    `manifest inspect` fails (no layer sizes)
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
  if (env("FAKE_DOCKER_DAEMON", "running") === "stopped") fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
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

// ---- image inspect ---------------------------------------------------------------------------------------------
if (argv[0] === "image" && argv[1] === "inspect") {
  needDaemon();
  const labels = process.env.FAKE_DOCKER_LABELS || '{"org.jgates.tool.version":"0.17.2"}';
  if (labels === "none") {
    process.stderr.write("Error: No such image\n");
    process.exit(1);
  }
  if (argv.includes("--format")) process.stdout.write(labels + "\n");
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
          : { ID: o.id, Repository: o.name, Tag: "dev", Size: humanSize(o.sizeBytes || 0), Labels: labelString(o.labels) },
    ),
  );
  process.exit(0);
}
if (argv[1] === "prune" && ["container", "network", "image"].includes(argv[0])) {
  needDaemon();
  const objects = loadObjects();
  const key = argv[0] + "s";
  const filters = filtersOf(argv);
  objects[key] = objects[key].filter((o) => !matches(o.labels, filters));
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
  objects[key] = objects[key].filter((o) => !ids.includes(o.id) && !ids.includes(o.name));
  saveObjects(objects);
  process.exit(0);
}
if (argv[0] === "kill") {
  needDaemon();
  const ids = lastNonFlags(argv.slice(1));
  const objects = loadObjects();
  objects.containers = objects.containers.map((c) => (ids.includes(c.id) || ids.includes(c.name) ? { ...c, state: "exited" } : c));
  saveObjects(objects);
  process.exit(0);
}

// ---- compose ---------------------------------------------------------------------------------------------------
if (argv[0] === "compose") {
  needDaemon();
  process.exit(Number(env("FAKE_DOCKER_COMPOSE_EXIT", "0")));
}

// ---- rm / run ---------------------------------------------------------------------------------------------------
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
  if ((process.env.FAKE_DOCKER_MODE || "ok") === "hang") {
    fs.writeFileSync(marker(name), "running");
    process.on("SIGTERM", () => process.exit(143));
    const poll = setInterval(() => {
      if (!fs.existsSync(marker(name))) {
        clearInterval(poll);
        process.exit(137);
      }
    }, 25);
  } else {
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
