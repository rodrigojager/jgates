import { spawn } from "node:child_process";

/**
 * Opens a local file (the bootstrap launcher) in the default browser, best effort. The argument is the launcher path,
 * never the secret URL, so the secret does not show up in the process list.
 */
export function openInBrowser(target: string): boolean {
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
