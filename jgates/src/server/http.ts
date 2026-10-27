import type { IncomingMessage, ServerResponse } from "node:http";
import { translator } from "../i18n/index.js";
import { SECURITY_HEADERS } from "./security.js";

const t = translator("server");

/** A refusal with its HTTP status and a stable code; the message comes from the "server" catalog. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fix: string | null = null,
    readonly details: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** HttpError with the catalog message `server_<code lowercased>` and its `_fix`. */
export function refuse(status: number, code: string, params: Record<string, string | number> = {}, details: Record<string, unknown> = {}, headers: Record<string, string> = {}): HttpError {
  const key = `server_${code.toLowerCase()}`;
  const fix = t(`${key}_fix`, params);
  return new HttpError(status, code, t(key, params), fix === `${key}_fix` ? null : fix, details, headers);
}

function baseHeaders(res: ServerResponse, extra: Record<string, string | string[]> = {}): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string | string[]> = {}): void {
  if (res.headersSent) return;
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  baseHeaders(res, { "Cache-Control": "no-store", ...headers });
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

export function sendBody(res: ServerResponse, status: number, contentType: string, body: Buffer | string, headers: Record<string, string | string[]> = {}, head = false): void {
  if (res.headersSent) return;
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  baseHeaders(res, { "Cache-Control": "no-store", ...headers });
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(bytes.length));
  res.end(head ? undefined : bytes);
}

export function sendError(res: ServerResponse, error: HttpError): void {
  sendJson(res, error.status, { schemaVersion: 1, status: "ERROR", code: error.code, message: error.message, fix: error.fix, ...error.details }, error.headers);
}

/** HTML-escapes text (every message and path shown in a page is text, never markup). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * Reads the request body up to `max` bytes. A declared length above the limit is refused before reading; a stream
 * that grows past it is cut. Returns an empty buffer when there is no body.
 */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > max) return Promise.reject(refuse(413, "PAYLOAD_TOO_LARGE", { max }));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) {
        failed = true;
        reject(refuse(413, "PAYLOAD_TOO_LARGE", { max }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
  });
}
