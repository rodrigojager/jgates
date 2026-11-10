// Regenerates the lock files of the JGates tools image from their inputs (run by hand after changing a pin):
//   node jgates/docker/tools/update-locks.mjs [python|node]
// Python: python/<interpreter>/<tool>.in -> <tool>.txt with every hash (uv pip compile, wheels only, for the image's
// Linux platform and that interpreter). Node: node/<tool>/package.json -> package-lock.json (npm, lock only, no
// scripts). The image installs only from these files, so a build never resolves a version by itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// glibc of the base image (Debian 13) is 2.41: every manylinux wheel up to 2_40 runs on it.
const PLATFORM = "x86_64-manylinux_2_40";
const which = process.argv[2] ?? "all";

function run(executable, args, cwd) {
  // npm is a .cmd script on Windows and needs a shell there; uv is a binary and gets its arguments unsplit.
  const shell = process.platform === "win32" && executable === "npm";
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", shell });
  if (result.status !== 0) {
    console.error(`update-locks: ${executable} ${args.join(" ")} exited with ${result.status}`);
    process.exit(1);
  }
}

if (which === "all" || which === "python") {
  const pythonRoot = path.join(here, "python");
  for (const interpreter of fs.readdirSync(pythonRoot).sort()) {
    const dir = path.join(pythonRoot, interpreter);
    for (const input of fs.readdirSync(dir).filter((name) => name.endsWith(".in")).sort()) {
      const output = input.replace(/\.in$/, ".txt");
      const command = `uv pip compile --generate-hashes --only-binary :all: --python-version ${interpreter} --python-platform ${PLATFORM} ${input} -o ${output}`;
      console.log(`update-locks: python/${interpreter}/${input}`);
      run("uv", ["pip", "compile", "--quiet", "--generate-hashes", "--only-binary", ":all:", "--python-version", interpreter, "--python-platform", PLATFORM, "--custom-compile-command", command, input, "-o", output], dir);
    }
  }
}

if (which === "all" || which === "node") {
  const nodeRoot = path.join(here, "node");
  for (const tool of fs.readdirSync(nodeRoot).sort()) {
    console.log(`update-locks: node/${tool}`);
    run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(nodeRoot, tool));
  }
}
