// Helpers of the Docker smoke: the dedicated builder, the labeled image and the cleanup of what the work created.
// Everything is filtered by the label org.jgates.dev=true (or by the builder name); images, containers and volumes of
// other projects are never touched, and there is no `docker system prune`.
import { spawnSync } from "node:child_process";

export const LABEL = "org.jgates.dev=true";
export const BUILDER = "jgates-dev";

export function docker(args, options = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function must(args, what) {
  const r = docker(args);
  if (r.code !== 0) throw new Error(`${what} failed (docker ${args.join(" ")}): ${r.err.trim() || r.out.trim()}`);
  return r.out.trim();
}

export function dockerAvailable() {
  return docker(["version", "--format", "{{.Server.Version}}"]).code === 0;
}

/** Creates the buildx builder jgates-dev when it does not exist (docker-container driver: its cache is its own). */
export function ensureBuilder() {
  if (docker(["buildx", "inspect", BUILDER]).code === 0) return;
  must(["buildx", "create", "--name", BUILDER, "--driver", "docker-container", "--bootstrap"], "creating the builder");
}

/** Builds the image (labeled) and returns its content id (sha256:...), the digest the runner pins. */
export function buildImage({ context, tag, buildArgs = [] }) {
  ensureBuilder();
  must(["buildx", "build", "--builder", BUILDER, "--load", "--label", LABEL, "--tag", tag, ...buildArgs, context], "building the image");
  return must(["image", "inspect", "--format", "{{.Id}}", tag], "inspecting the image");
}

const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** Label that tells one smoke's images, containers and volumes from another's (org.jgates.tool=<tool>). */
export const TOOL_LABEL = "org.jgates.tool";

/** Docker filters of the work: the dev label, and the tool label when the cleanup is scoped to one tool. */
const filters = (tool) => ["--filter", `label=${LABEL}`, ...(tool ? ["--filter", `label=${TOOL_LABEL}=${tool}`] : [])];

export function labeledImages(tool = null) {
  return lines(must(["images", ...filters(tool), "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"], "listing images"));
}

export function labeledContainers(tool = null) {
  return lines(must(["ps", "-a", ...filters(tool), "--format", "{{.ID}} {{.Names}}"], "listing containers"));
}

export function builderCacheEmpty() {
  const r = docker(["buildx", "du", "--builder", BUILDER]);
  // Header, then no record at all: only the "Reclaimable" and "Total" summary lines, both 0B.
  const records = lines(r.out).filter((l) => !/^(ID\s|Reclaimable:|Total:)/.test(l));
  return r.code === 0 && records.length === 0 && /Total:\s+0B/.test(r.out);
}

/**
 * Removes what the work created: containers and volumes with the label, dangling labeled layers, the builder cache
 * and, when `keep` is given, every labeled image except that id (only the last version stays). With `tool`, only what
 * also carries org.jgates.tool=<tool> is touched, so the images of another smoke (the sidecar image of the
 * quality-gate work, for instance) stay.
 */
export function cleanupWork({ keep = null, tool = null } = {}) {
  for (const id of lines(must(["ps", "-aq", ...filters(tool)], "listing containers"))) docker(["rm", "-f", id]);
  for (const name of lines(must(["volume", "ls", "-q", ...filters(tool)], "listing volumes"))) docker(["volume", "rm", "-f", name]);
  for (const id of lines(must(["images", "-q", "--no-trunc", ...filters(tool)], "listing images"))) {
    if (id !== keep) docker(["rmi", "-f", id]);
  }
  docker(["image", "prune", "-f", ...filters(tool)]);
  if (docker(["buildx", "inspect", BUILDER]).code === 0) docker(["buildx", "prune", "--builder", BUILDER, "-af"]);
}
