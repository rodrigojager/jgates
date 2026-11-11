import { DEFAULT_RETENTION, type RetentionPolicy } from "../artifacts/index.js";

const MIB = 1024 * 1024;

/** The retention in force: the defaults, moved by the same environment variables `jgates gc` reads. */
export function effectiveRetention(env: NodeJS.ProcessEnv = process.env): { policy: RetentionPolicy; fromEnvironment: string[] } {
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION };
  const fromEnvironment: string[] = [];
  const read = (name: string, set: (n: number) => void): void => {
    const raw = env[name];
    if (raw === undefined || raw === "") return;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      set(n);
      fromEnvironment.push(name);
    }
  };
  read("JGATES_RETENTION_DAYS", (n) => (policy.maxAgeDays = n));
  read("JGATES_RETENTION_WORKSPACE_MB", (n) => (policy.maxWorkspaceBytes = n * MIB));
  read("JGATES_RETENTION_TOTAL_MB", (n) => (policy.maxTotalBytes = n * MIB));
  return { policy, fromEnvironment };
}
