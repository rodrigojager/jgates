// A controlled local HTTP target for the runtime API checks (Schemathesis, ZAP), with two behaviours:
// "conforming" answers GET /users/{id} exactly as openapi.yaml declares, with nosniff and CORP headers; "violating"
// breaks the contract (an undeclared `password` field in the 200 body, and a 500 for ids divisible by 7) and leaves those
// headers out. Only loopback by default; the port is chosen by the OS.
// Usable as a module (startServer) or as a process: `node server.mjs <mode>` prints `listening <url>` on stdout.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_FILE = path.join(here, "openapi.yaml");

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

// The conforming twin also sends the headers whose absence ZAP's passive rules report (10021, 90004).
const SAFE_HEADERS = { "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };

export function handler(mode, options = {}) {
  return (req, res) => {
    if (mode !== "violating") for (const [name, value] of Object.entries(SAFE_HEADERS)) res.setHeader(name, value);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) return send(res, 401, { error: "unauthorized" });
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!doctype html><html><head><title>fixture</title></head><body><a href=\"/users/1\">user</a></body></html>");
    }
    if (url.pathname === "/openapi.yaml" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/yaml" });
      return res.end(fs.readFileSync(SPEC_FILE));
    }
    const match = /^\/users\/([^/]+)$/.exec(url.pathname);
    if (!match || req.method !== "GET") return send(res, 404, { error: "not found" });
    const raw = decodeURIComponent(match[1]);
    if (!/^\d+$/.test(raw)) return send(res, 400, { error: "id must be a positive integer" });
    const id = Number(raw);
    if (id < 1 || id > 1_000_000) return send(res, 400, { error: "id out of range" });
    if (mode === "violating") {
      if (id % 7 === 0) return send(res, 500, { error: "internal error" });
      return send(res, 200, { id, name: `user ${id}`, password: "hunter2" });
    }
    return send(res, 200, { id, name: `user ${id}` });
  };
}

/** Starts the target on 127.0.0.1 (or `host`) and a free port; resolves with its base URL and a close function. */
export function startServer(mode, options = {}) {
  const server = http.createServer(handler(mode, options));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, options.host ?? "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] === "violating" ? "violating" : "conforming";
  // FIXTURE_TOKEN: every request then needs `Authorization: Bearer <token>` (401 otherwise, undeclared in the spec).
  const started = await startServer(mode, { host: process.argv[3] ?? "127.0.0.1", token: process.env.FIXTURE_TOKEN || undefined });
  process.stdout.write(`listening ${started.url}\n`);
}
