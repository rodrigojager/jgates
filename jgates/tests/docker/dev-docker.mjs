// Helpers of the real-engine suites (npm run test:docker): the engine client and its availability. The suites run the
// local development image jgates-tools:dev (built by `npm run image:build`) and clean up what they create by the
// JGates labels only; images, containers and volumes of other projects are never touched, and there is no
// `docker system prune`.
import { spawnSync } from "node:child_process";

export function docker(args, options = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function dockerAvailable() {
  return docker(["version", "--format", "{{.Server.Version}}"]).code === 0;
}
