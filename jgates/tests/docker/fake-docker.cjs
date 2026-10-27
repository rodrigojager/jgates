#!/usr/bin/env node
// A fake container runtime for the default suite: records every invocation (one JSON line per call in
// FAKE_DOCKER_LOG) and behaves like a daemon just enough for the container runner.
//   FAKE_DOCKER_MODE=ok    `run` prints FAKE_DOCKER_STDOUT and exits with FAKE_DOCKER_EXIT (default 0)
//   FAKE_DOCKER_MODE=hang  `run` creates a "container" (a file in FAKE_DOCKER_STATE) that lives until `rm` removes it;
//                          the client dies on SIGTERM and leaves the container behind, like a real client does
//   FAKE_DOCKER_LABELS     the labels `image inspect` reports (JSON labels; "none": no such image); with --format it
//                          prints them, without it the JSON array of the runtime (Id, RepoDigests, Config.Labels)
//   FAKE_DOCKER_IMAGE_ID   the image id of that array (default: sha256 of the labels); FAKE_DOCKER_REPO_DIGESTS: JSON list
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\n");
const state = process.env.FAKE_DOCKER_STATE || process.cwd();
const marker = (name) => path.join(state, `${name}.container`);

// `image inspect` prints FAKE_DOCKER_LABELS (the labels of an image as JSON) or exits 1 when it is "none".
if (argv[0] === "image" && argv[1] === "inspect") {
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
if (argv[0] === "rm") {
  const name = argv[argv.length - 1];
  fs.rmSync(marker(name), { force: true });
  process.exit(0);
}
if (argv[0] === "run") {
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
    process.stdout.write(process.env.FAKE_DOCKER_STDOUT || "");
    process.exit(Number(process.env.FAKE_DOCKER_EXIT || 0));
  }
} else {
  process.exit(0);
}
