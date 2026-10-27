// Installs the pinned scanners of dev-tools/requirements.txt with the pip of the repository .venv
// (or of the Python found through JGATES_PYTHON / PATH when there is no .venv).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const requirements = path.join(here, "requirements.txt");
const win = process.platform === "win32";
const venvPython = path.join(repo, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");

const candidates = [fs.existsSync(venvPython) ? venvPython : null, process.env.JGATES_PYTHON ?? null, "python3", "python"].filter(Boolean);
for (const python of candidates) {
  const probe = spawnSync(python, ["-m", "pip", "--version"], { encoding: "utf8" });
  if (probe.status !== 0) continue;
  process.stdout.write(`setup:dev-tools: using ${python}\n`);
  const run = spawnSync(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
process.stderr.write("setup:dev-tools: no Python with pip found. Create the venv first: python3 -m venv .venv\n");
process.exit(1);
