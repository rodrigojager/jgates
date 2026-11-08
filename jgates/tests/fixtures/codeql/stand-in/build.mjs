// Builds the CodeQL stand-in (codeql.cjs) into a real executable with Node's single-executable support, so the runner
// (which never uses a shell) can start it on every platform. The real CodeQL is customer-supplied and absent here.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Builds `<dir>/codeql[.exe]` with the recorded SARIFs in `<dir>/recorded`; returns the executable path. */
export function buildStandIn(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(here, "..", "recorded"), path.join(dir, "recorded"), { recursive: true });
  const config = path.join(dir, "sea-config.json");
  const exe = path.join(dir, process.platform === "win32" ? "codeql.exe" : "codeql");
  fs.writeFileSync(config, JSON.stringify({ main: path.join(here, "codeql.cjs"), output: exe, disableExperimentalSEAWarning: true }));
  const built = spawnSync(process.execPath, ["--build-sea", config], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`could not build the CodeQL stand-in executable (Node ${process.version}): ${built.stderr || built.stdout}`);
  return exe;
}
