// Prepared rule sets: <JGATES_HOME>/tools/<sha256>/<file>, shared by every workspace, pinned per instance in
// .jgates/lock.json. This is the only place that downloads anything, and only when `tools prepare` calls it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LockDocument, LockedRules } from "../lock/index.js";

export const SEMGREP_RULES_REF = "p/default";
export const SEMGREP_RULES_FILE = "p-default.yml";
const DEFAULT_RULES_URL = "https://semgrep.dev/c/p/default";
export const MAX_RULES_BYTES = 32 * 1024 * 1024;

export const toolsDir = (home: string): string => path.join(home, "tools");
export const preparedDir = (home: string, hash: string): string => path.join(toolsDir(home), hash);

export const sha256 = (bytes: Buffer | string): string => crypto.createHash("sha256").update(bytes).digest("hex");

/** Where the Semgrep registry rules come from; JGATES_SEMGREP_RULES_URL replaces it (tests, mirrors). */
export function semgrepRulesUrl(env: NodeJS.ProcessEnv): string {
  return env.JGATES_SEMGREP_RULES_URL && env.JGATES_SEMGREP_RULES_URL.trim() !== "" ? env.JGATES_SEMGREP_RULES_URL.trim() : DEFAULT_RULES_URL;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type PreparedState = "none" | "ready" | "missing" | "corrupt";

export interface PreparedRules {
  state: PreparedState;
  /** The pinned entry, when the lock has one. */
  entry: LockedRules | null;
  /** Absolute path of the stored rule file (set when the lock has an entry). */
  abs: string | null;
}

/** Looks the pinned Semgrep rules of an instance up and checks the stored bytes against the pinned hash. */
export function preparedRulesOf(lock: LockDocument, instance: string, home: string, ref: string = SEMGREP_RULES_REF): PreparedRules {
  const entry = lock.tools[instance]?.rules?.find((r) => r.ref === ref) ?? null;
  if (!entry) return { state: "none", entry: null, abs: null };
  const abs = path.join(preparedDir(home, entry.hash), path.basename(entry.file));
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(abs);
  } catch {
    return { state: "missing", entry, abs };
  }
  return { state: sha256(bytes) === entry.hash ? "ready" : "corrupt", entry, abs };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

export class DownloadError extends Error {
  constructor(
    readonly code: "NETWORK_UNAVAILABLE" | "BAD_RESPONSE" | "TOO_LARGE" | "INSECURE_URL",
    message: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/** Downloads the bytes of a URL (https, or http on loopback only), with a size cap and a timeout. */
export async function download(url: string, timeoutMs = 120_000): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError("INSECURE_URL", url);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) throw new DownloadError("INSECURE_URL", url);
  let response: Response;
  try {
    response = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/yaml, text/plain, */*" } });
  } catch (error) {
    throw new DownloadError("NETWORK_UNAVAILABLE", (error as Error).message);
  }
  if (!response.ok) throw new DownloadError("BAD_RESPONSE", `HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RULES_BYTES) throw new DownloadError("TOO_LARGE", String(declared));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RULES_BYTES) throw new DownloadError("TOO_LARGE", String(bytes.length));
  return bytes;
}

/** Writes the rules under <home>/tools/<hash>/<file> (0600, atomic) and returns the lock entry. */
export function storeRules(home: string, ref: string, source: string, bytes: Buffer): LockedRules {
  const hash = sha256(bytes);
  const dir = preparedDir(home, hash);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, SEMGREP_RULES_FILE);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { ref, hash, file: SEMGREP_RULES_FILE, source, bytes: bytes.length };
}
