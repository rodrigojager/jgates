import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const spawnSpec = commandForSpawn(command, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGTERM");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 1000).unref();
          child.unref();
          resolve({ code: 124, stdout, stderr: `${stderr}\nCommand timed out.`.trim() });
        }
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function commandForSpawn(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args };
  }
  const resolved = resolveWindowsCommand(command);
  const finalCommand = resolved ?? command;
  if (/\.(cmd|bat)$/i.test(finalCommand)) {
    const nodeShimTarget = npmCmdShimTarget(finalCommand);
    if (nodeShimTarget) {
      return {
        command: process.execPath,
        args: [nodeShimTarget, ...args],
      };
    }
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        powershellCommandLine(finalCommand, args),
      ],
    };
  }
  return { command: finalCommand, args };
}

function npmCmdShimTarget(commandPath: string): string | undefined {
  if (!/\.cmd$/i.test(commandPath) || !fs.existsSync(commandPath)) {
    return undefined;
  }
  const text = fs.readFileSync(commandPath, "utf8");
  const match = text.match(/%dp0%\\([^"\r\n]+?\.js)"/i);
  if (!match?.[1]) {
    return undefined;
  }
  const target = path.join(path.dirname(commandPath), match[1].replace(/\\/g, path.sep));
  return fs.existsSync(target) ? target : undefined;
}

function resolveWindowsCommand(command: string): string | undefined {
  if (/[\\/]/.test(command)) {
    return fs.existsSync(command) ? command : undefined;
  }
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const upperCandidate = path.join(directory, `${command}${extension.toUpperCase()}`);
      if (fs.existsSync(upperCandidate)) {
        return upperCandidate;
      }
    }
  }
  return undefined;
}

function windowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function powershellCommandLine(command: string, args: string[]): string {
  return ["&", quotePowerShellArg(command), ...args.map(quotePowerShellArg)].join(" ");
}

function quotePowerShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}
