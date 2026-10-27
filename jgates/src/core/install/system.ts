// The operating system JGates runs on, as far as installing Docker goes: which package manager the official
// instructions use there, and the command lines to install or start Docker. JGates never adds sudo by itself: the
// commands below carry it where the system needs it, are shown before anything runs, and run only after a
// confirmation on the terminal, so sudo asks for the password itself.
import fs from "node:fs";

export interface HostSystem {
  platform: NodeJS.Platform;
  /** Contents of /etc/os-release (Linux), or null. */
  osRelease: string | null;
}

export type PackageManager = "apt" | "dnf" | "brew" | "winget";

export interface SystemCommands {
  manager: PackageManager | null;
  /** Each command as argv (no shell). Empty when the system is not one JGates knows how to install on. */
  commands: string[][];
  /** Hosts the commands reach, as far as JGates can tell. */
  hosts: string[];
  /** Where the official instructions are, for the systems without a command. */
  docs: string;
}

export const DOCKER_DOCS = "https://docs.docker.com/engine/install/";

export function detectSystem(platform: NodeJS.Platform = process.platform): HostSystem {
  let osRelease: string | null = null;
  if (platform === "linux") {
    try {
      osRelease = fs.readFileSync("/etc/os-release", "utf8");
    } catch {
      osRelease = null;
    }
  }
  return { platform, osRelease };
}

/** ID and ID_LIKE of /etc/os-release, lower case. */
function distroIds(osRelease: string | null): string[] {
  if (!osRelease) return [];
  const ids: string[] = [];
  for (const line of osRelease.split(/\r?\n/)) {
    const m = /^(ID|ID_LIKE)=(.*)$/.exec(line.trim());
    if (m) ids.push(...(m[2] ?? "").replace(/["']/g, "").toLowerCase().split(/\s+/).filter(Boolean));
  }
  return ids;
}

/** The package manager of the system: apt (Debian, Ubuntu), dnf (Fedora), brew (macOS), winget (Windows). */
export function packageManagerOf(system: HostSystem): PackageManager | null {
  if (system.platform === "darwin") return "brew";
  if (system.platform === "win32") return "winget";
  if (system.platform !== "linux") return null;
  const ids = distroIds(system.osRelease);
  if (ids.some((id) => id === "debian" || id === "ubuntu")) return "apt";
  if (ids.includes("fedora")) return "dnf";
  return null;
}

/** How Docker is installed on this system (the distribution's packages, Homebrew or winget). */
export function dockerInstallCommands(system: HostSystem): SystemCommands {
  const manager = packageManagerOf(system);
  switch (manager) {
    case "apt":
      return { manager, commands: [["sudo", "apt-get", "update"], ["sudo", "apt-get", "install", "-y", "docker.io"]], hosts: [], docs: DOCKER_DOCS };
    case "dnf":
      return { manager, commands: [["sudo", "dnf", "install", "-y", "moby-engine"], ["sudo", "systemctl", "enable", "--now", "docker"]], hosts: [], docs: DOCKER_DOCS };
    case "brew":
      return { manager, commands: [["brew", "install", "--cask", "docker"]], hosts: ["formulae.brew.sh", "desktop.docker.com"], docs: DOCKER_DOCS };
    case "winget":
      return { manager, commands: [["winget", "install", "--exact", "--id", "Docker.DockerDesktop"]], hosts: ["cdn.winget.microsoft.com", "desktop.docker.com"], docs: DOCKER_DOCS };
    default:
      return { manager: null, commands: [], hosts: [], docs: DOCKER_DOCS };
  }
}

/** How a Docker that is installed but stopped is started on this system. */
export function dockerStartCommands(system: HostSystem): SystemCommands {
  const manager = packageManagerOf(system);
  if (system.platform === "linux") return { manager, commands: [["sudo", "systemctl", "start", "docker"]], hosts: [], docs: DOCKER_DOCS };
  if (system.platform === "darwin") return { manager, commands: [["open", "-a", "Docker"]], hosts: [], docs: DOCKER_DOCS };
  if (system.platform === "win32") {
    return { manager, commands: [["powershell", "-NoProfile", "-Command", "Start-Process -FilePath \"$env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe\""]], hosts: [], docs: DOCKER_DOCS };
  }
  return { manager, commands: [], hosts: [], docs: DOCKER_DOCS };
}

/** A command line as it is shown in the preview (arguments with spaces in quotes). */
export function displayCommand(argv: string[]): string {
  return argv.map((a) => (a === "" || /[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}
