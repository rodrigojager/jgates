import express, { Request, Response } from "express";
import helmet from "helmet";
import { WebSocketServer } from "ws";
import { Server } from "socket.io";
import { ApolloServer } from "@apollo/server";
import depthLimit from "graphql-depth-limit";
import { createServer } from "node:http";

interface Ctx {
  user: string;
}

const app = express();
const httpServer = createServer(app);

export function typedHeaders(): void {
  // ruleid: jgates.js.security-headers-disabled
  app.use(helmet({ frameguard: false }));
  // ruleid: jgates.js.security-headers-disabled
  app.use(helmet({ xContentTypeOptions: false }));
  // ok: jgates.js.security-headers-disabled
  app.use(helmet({ frameguard: { action: "sameorigin" } }));
  // ok: jgates.js.security-headers-disabled
  app.use(helmet({ strictTransportSecurity: { maxAge: 63072000 } }));
}

export function typedCsp(res: Response): void {
  // ruleid: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "script-src 'self' 'unsafe-eval'; img-src 'self'");
  // ruleid: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "default-src 'self' *");
  // ok: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "script-src 'self' *.example.com");
  // ok: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "img-src * data:");
}

export function typedSockets(): void {
  const url: string = "ws://metrics.example.com/feed";
  // ruleid: jgates.js.websocket-without-tls
  const a: WebSocket = new WebSocket("ws://metrics.example.com/feed");
  // ruleid: jgates.js.websocket-without-tls
  const b: WebSocket = new WebSocket("ws://10.0.0.5:9000/feed", ["v1"]);
  // ok: jgates.js.websocket-without-tls
  const c: WebSocket = new WebSocket("wss://metrics.example.com/feed");
  // ok: jgates.js.websocket-without-tls
  const d: WebSocket = new WebSocket("ws://[::1]:9000/feed");
  void [a, b, c, d, url];
}

const trusted: string[] = ["https://app.example.com"];

export function typedServers(): void {
  // ruleid: jgates.js.websocket-origin-not-checked
  const a = new WebSocketServer({ server: httpServer, verifyClient: function () { return true; } });
  // ruleid: jgates.js.websocket-origin-not-checked
  const b = new Server(httpServer, { cors: { origin: "*", credentials: true } });
  // ruleid: jgates.js.websocket-origin-not-checked
  const c = new Server(httpServer, { allowRequest: (req, cb) => cb(null, true) });
  // ok: jgates.js.websocket-origin-not-checked
  const d = new WebSocketServer({ server: httpServer, verifyClient: (info: { origin: string }) => trusted.includes(info.origin) });
  // ok: jgates.js.websocket-origin-not-checked
  const e = new Server(httpServer, { cors: { origin: trusted } });
  void [a, b, c, d, e];
}

export function typedGraphql(typeDefs: string, resolvers: object): void {
  // ruleid: jgates.js.graphql-introspection-enabled
  const a = new ApolloServer<Ctx>({ typeDefs, resolvers, introspection: true, validationRules: [depthLimit(6)] });
  // ok: jgates.js.graphql-introspection-enabled
  const b = new ApolloServer<Ctx>({ typeDefs, resolvers, introspection: false, validationRules: [depthLimit(6)] });
  // ruleid: jgates.js.graphql-without-depth-limit
  const c = new ApolloServer<Ctx>({ typeDefs, resolvers });
  // ok: jgates.js.graphql-without-depth-limit
  const d = new ApolloServer<Ctx>({ typeDefs, resolvers, validationRules: [depthLimit(6)] });
  void [a, b, c, d];
}

export function typedRedirects(): void {
  app.get("/after-login", (req: Request, res: Response) => {
    const next = req.query.next as string;
    // ruleid: jgates.js.open-redirect
    res.redirect(next);
  });
  app.get("/bounce", (req: Request, res: Response) => {
    // ruleid: jgates.js.open-redirect
    res.redirect(301, req.query.to as string);
  });
  app.get("/profile/:name", (req: Request, res: Response) => {
    // ok: jgates.js.open-redirect
    res.redirect("/people/" + req.params.name);
  });
  app.get("/home", (_req: Request, res: Response) => {
    // ok: jgates.js.open-redirect
    res.redirect("/");
  });
}

export function typedAddresses(req: Request): string[] {
  // ruleid: jgates.js.client-ip-from-forwarded-header
  const a = String(req.headers["x-forwarded-for"]);
  // ruleid: jgates.js.client-ip-from-forwarded-header
  const b = req.get("x-real-ip") ?? "";
  // ok: jgates.js.client-ip-from-forwarded-header
  const c = req.ip ?? "";
  // ok: jgates.js.client-ip-from-forwarded-header
  const d = req.get("accept-language") ?? "";
  return [a, b, c, d];
}

export function typedLinks(req: Request, token: string): string[] {
  // ruleid: jgates.js.host-header-in-url
  const a: string = "https://" + req.headers.host + "/invite/" + token;
  // ruleid: jgates.js.host-header-in-url
  const b: string = `https://${req.get("host")}/invite/${token}`;
  // ok: jgates.js.host-header-in-url
  const c: string = `${process.env.PUBLIC_BASE_URL}/invite/${token}`;
  // ok: jgates.js.host-header-in-url
  const d: string = "/invite/" + token;
  return [a, b, c, d];
}
