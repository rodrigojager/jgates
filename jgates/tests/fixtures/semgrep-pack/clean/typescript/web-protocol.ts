import express, { Request, Response } from "express";
import helmet from "helmet";
import { WebSocketServer } from "ws";
import { ApolloServer } from "@apollo/server";
import depthLimit from "graphql-depth-limit";

interface Ctx {
  user: string;
}

export const app = express();
const allowedOrigins: string[] = ["https://app.example.com"];
const publicBaseUrl: string = process.env.PUBLIC_BASE_URL ?? "";

// security-headers-disabled
app.use(helmet({ frameguard: { action: "deny" } }));

// csp-unsafe-directive
app.use((_req: Request, res: Response, next: () => void): void => {
  res.setHeader("Content-Security-Policy", "script-src 'self' https://cdn.example.com; object-src 'none'");
  next();
});

// websocket-without-tls
export function openFeed(): WebSocket {
  return new WebSocket("wss://feed.example.com/live");
}

// websocket-origin-not-checked
export const wss = new WebSocketServer({ port: 8081, verifyClient: (info: { origin: string }): boolean => allowedOrigins.includes(info.origin) });

// graphql-introspection-enabled
export const graph = new ApolloServer<Ctx>({ typeDefs: "type Query { ok: Boolean }", resolvers: {}, introspection: false, validationRules: [depthLimit(8)] });

// graphql-without-depth-limit
export const limitedGraph = new ApolloServer<Ctx>({ typeDefs: "type Query { ok: Boolean }", resolvers: {}, validationRules: [depthLimit(8)] });

// open-redirect
function safeRedirect(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
app.get("/login/done", (req: Request, res: Response): void => {
  res.redirect(safeRedirect(req.query.next));
});

// client-ip-from-forwarded-header
app.set("trust proxy", 1);
app.get("/whoami", (req: Request, res: Response): void => {
  res.send(String(req.ip));
});

// host-header-in-url
app.post("/forgot", (req: Request, res: Response): void => {
  const link: string = `${publicBaseUrl}/reset?token=${encodeURIComponent(req.body.token)}`;
  res.json({ link });
});
