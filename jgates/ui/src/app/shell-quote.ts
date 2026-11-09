// Quoting of one argument in a command line the UI shows for the person to copy. The server runs on the machine of the
// browser, so the shell is the one of that machine: POSIX shells on Linux and macOS, cmd.exe or PowerShell on Windows.

/** Whether the browser runs on Windows (where the local server and the person's terminal are). */
export function isWindowsBrowser(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const WINDOWS_SAFE = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/** The argument as typed in a terminal, quoted only when it needs it. */
export function quoteArg(value: string, windows: boolean = isWindowsBrowser()): string {
  if (windows) {
    // cmd.exe and PowerShell both read a double-quoted word; a backslash in a path is a path separator, not an escape.
    return WINDOWS_SAFE.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
  }
  return POSIX_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
