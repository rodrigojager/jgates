// `jgates update`: finds how this JGates was installed, asks the repository for the newest commit of a branch and,
// when the person agrees, installs it the same way. JGates never checks on its own: the only network access is
// `git ls-remote` (and the npm install) when the person runs the command.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type InstallKind = "dependency" | "global" | "clone";

export interface Installation {
  kind: InstallKind;
  /** The package's folder (with the root package.json named jgates). */
  packageDir: string;
  /** The npm prefix the package was installed into (the folder whose node_modules holds it); null for a clone. */
  prefix: string | null;
  version: string;
  /** The commit this build came from, when known (build-info.json, then the npm lockfile). */
  commit: string | null;
  /** The build came from a working tree with uncommitted changes. */
  dirty: boolean;
  /** Where the package was installed from, as npm recorded it (git URL, file, folder). */
  resolved: string | null;
  /** The repository named in the root package.json. */
  repository: string | null;
}

interface RootPackage {
  name?: string;
  version?: string;
  repository?: string | { url?: string };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The root package folder (package.json named jgates), walking up from a folder. */
export function findPackageDir(from: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    if (readJson<RootPackage>(path.join(dir, "package.json"))?.name === "jgates") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** "git+https://host/x.git" → "https://host/x.git"; accepts a string or npm's { url }. */
export function repositoryUrl(repository: RootPackage["repository"]): string | null {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return null;
  return raw.replace(/^git\+/, "");
}

/** The commit after "#" in a git URL recorded by npm, if it is a full hash. */
export function commitFromResolved(resolved: string | null | undefined): string | null {
  const m = /#([0-9a-f]{40})$/i.exec(resolved ?? "");
  return m?.[1] ? m[1].toLowerCase() : null;
}

function lockEntry(prefix: string): { resolved?: string } | null {
  for (const file of [path.join(prefix, "package-lock.json"), path.join(prefix, "node_modules", ".package-lock.json")]) {
    const lock = readJson<{ packages?: Record<string, { resolved?: string }> }>(file);
    const entry = lock?.packages?.["node_modules/jgates"];
    if (entry) return entry;
  }
  return null;
}

/** Describes the installation that runs this code (or the one at packageDir). */
export function describeInstallation(packageDir: string): Installation {
  const pkg = readJson<RootPackage>(path.join(packageDir, "package.json")) ?? {};
  const info = readJson<{ commit?: string; dirty?: boolean }>(path.join(packageDir, "jgates", "dist", "build-info.json"));
  const parent = path.dirname(packageDir);
  const installed = path.basename(parent) === "node_modules";
  const prefix = installed ? path.dirname(parent) : null;
  let kind: InstallKind = "clone";
  let resolved: string | null = null;
  if (prefix) {
    const owner = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(prefix, "package.json"));
    const spec = owner?.dependencies?.jgates ?? owner?.devDependencies?.jgates;
    kind = spec ? "dependency" : "global";
    resolved = lockEntry(prefix)?.resolved ?? spec ?? null;
  }
  let commit = info?.commit ?? commitFromResolved(resolved);
  let dirty = info?.dirty === true;
  if (!commit && kind === "clone") {
    // A clone has no build-info until `npm run prepare`: its git tells the commit.
    const head = spawnSync("git", ["-C", packageDir, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
    if (head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) {
      commit = head.stdout.trim();
      const st = spawnSync("git", ["-C", packageDir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", windowsHide: true });
      dirty = st.status === 0 && st.stdout.trim() !== "";
    }
  }
  return {
    kind,
    packageDir,
    prefix,
    version: pkg.version ?? "0.0.0",
    commit,
    dirty,
    resolved,
    repository: repositoryUrl(pkg.repository),
  };
}

export class UpdateError extends Error {
  constructor(readonly code: "GIT_MISSING" | "REMOTE_FAILED" | "REF_NOT_FOUND", message: string) {
    super(message);
  }
}

/** The newest commit of a branch or tag in the repository (`git ls-remote`); the only network access of the check. */
export function remoteCommit(repository: string, ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync("git", ["ls-remote", repository, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") throw new UpdateError("GIT_MISSING", "git");
  if (r.status !== 0) throw new UpdateError("REMOTE_FAILED", (r.stderr || String(r.error ?? "")).trim());
  const rows = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((p): p is [string, string] => p.length === 2);
  // A peeled annotated tag (^{}) names the commit; prefer it over the tag object.
  const pick = rows.find((p) => p[1].endsWith("^{}")) ?? rows.find((p) => p[1] === `refs/heads/${ref}`) ?? rows[0];
  if (!pick) throw new UpdateError("REF_NOT_FOUND", ref);
  return pick[0].toLowerCase();
}

export type UpdateState = "up-to-date" | "available" | "unknown";

export function compare(installed: Installation, latest: string): UpdateState {
  if (!installed.commit) return "unknown";
  return installed.commit === latest ? "up-to-date" : "available";
}

/** The npm command that installs a commit the same way this installation was made; null when npm cannot do it. */
export function installCommand(installed: Installation, repository: string, commit: string): string[] | null {
  if (installed.kind !== "dependency" || !installed.prefix) return null;
  const spec = `git+${repository.replace(/^git\+/, "")}#${commit}`;
  return ["npm", "install", "--prefix", installed.prefix, spec, "--no-audit", "--no-fund"];
}

/** Runs the npm install, with its output on the terminal (stderr). Returns the exit status. */
export function runInstall(command: string[]): number {
  const [cmd = "npm", ...args] = command;
  const r = spawnSync(cmd, args.map((a) => (process.platform === "win32" && /\s/.test(a) ? `"${a}"` : a)), {
    stdio: ["inherit", 2, 2],
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return r.status ?? 1;
}
