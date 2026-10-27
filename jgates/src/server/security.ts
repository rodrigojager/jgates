// Session, bootstrap and request-origin rules of the local server, so no frontend reads or
// writes outside the workspace.
// Secrets live only in memory (sessions) or as hashes (bootstrap); none of them is ever logged.
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

/** 32 random bytes in base64url (43 characters). */
export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export const TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of two strings (compares their hashes, so lengths leak nothing either). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export interface Session {
  id: string;
  csrfToken: string;
  createdAt: number;
  lastSeen: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly idleMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(): Session {
    const at = this.now();
    const session: Session = { id: randomToken(), csrfToken: randomToken(), createdAt: at, lastSeen: at };
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.max) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
    return session;
  }

  /** The live session of a cookie value, refreshed; null when unknown or idle for too long. */
  find(id: string | null): Session | null {
    if (!id) return null;
    let hit: Session | null = null;
    for (const s of this.sessions.values()) if (safeEqual(s.id, id)) hit = s;
    if (!hit) return null;
    const at = this.now();
    if (at - hit.lastSeen > this.idleMs) {
      this.sessions.delete(hit.id);
      return null;
    }
    hit.lastSeen = at;
    return hit;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}

interface PendingBootstrap {
  expiresAt: number;
  onConsumed: () => void;
}

/** One-time bootstrap secrets, stored only as sha256 hashes. */
export class BootstrapStore {
  private readonly pending = new Map<string, PendingBootstrap>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates a secret; `onDone` runs once when it is consumed or expires (the launcher file is removed there). */
  issue(onDone: () => void): { secret: string; expiresAt: number } {
    const secret = randomToken();
    const expiresAt = this.now() + this.ttlMs;
    const key = digest(secret).toString("hex");
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      onDone();
    };
    this.pending.set(key, { expiresAt, onConsumed: once });
    const timer = setTimeout(() => {
      if (this.pending.delete(key)) once();
    }, this.ttlMs);
    timer.unref();
    return { secret, expiresAt };
  }

  /** True exactly once per valid, unexpired secret. */
  consume(secret: string): boolean {
    const key = digest(secret).toString("hex");
    const hit = this.pending.get(key);
    if (!hit) return false;
    this.pending.delete(key);
    hit.onConsumed();
    return hit.expiresAt >= this.now();
  }

  /** Drops every pending secret (server shutdown). */
  clear(): void {
    for (const p of this.pending.values()) p.onConsumed();
    this.pending.clear();
  }
}

export function cookieName(port: number): string {
  // Cookies are not isolated by port: the name carries it so two local servers never overwrite each other's session.
  return `jgates_session_${port}`;
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) found = part.slice(eq + 1).trim();
  }
  return found;
}

export function sessionCookie(port: number, id: string): string {
  return `${cookieName(port)}=${id}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Host values accepted for a server bound to `host:port`: the literal loopback address and localhost. */
export function allowedHosts(host: string, port: number): Set<string> {
  const literal = host.includes(":") ? `[${host}]` : host;
  return new Set([`${literal}:${port}`, `localhost:${port}`]);
}

export function allowedOrigins(host: string, port: number): Set<string> {
  return new Set([...allowedHosts(host, port)].map((h) => `http://${h}`));
}

/** Content Security Policy of every response: nothing external, no inline script, no framing. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export const CSRF_HEADER = "x-jgates-csrf";
export const CONTROL_HEADER = "x-jgates-control";
