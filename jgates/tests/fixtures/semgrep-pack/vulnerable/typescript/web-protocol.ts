import express, { Request, Response } from "express";
import helmet from "helmet";
import { WebSocketServer } from "ws";
import { ApolloServer } from "@apollo/server";

interface Ctx {
  user: string;
}

export const app = express();

// security-headers-disabled
app.use(helmet({ frameguard: false }));

// csp-unsafe-directive
app.use((_req: Request, res: Response, next: () => void): void => {
  res.setHeader("Content-Security-Policy", "script-src * ; object-src 'none'");
  next();
});

// websocket-without-tls
export function openFeed(): WebSocket {
  return new WebSocket("ws://feed.example.com/live");
}

// websocket-origin-not-checked
export const wss = new WebSocketServer({ port: 8081, verifyClient: (): boolean => true });

// graphql-introspection-enabled
export const graph = new ApolloServer<Ctx>({ typeDefs: "type Query { ok: Boolean }", resolvers: {}, introspection: true, validationRules: [] });

// graphql-without-depth-limit
export const plainGraph = new ApolloServer<Ctx>({ typeDefs: "type Query { ok: Boolean }", resolvers: {} });

// open-redirect
app.get("/login/done", (req: Request, res: Response): void => {
  res.redirect(req.query.next as string);
});

// client-ip-from-forwarded-header
app.get("/whoami", (req: Request, res: Response): void => {
  res.send(String(req.headers["x-forwarded-for"]));
});

// host-header-in-url
app.post("/forgot", (req: Request, res: Response): void => {
  const link: string = `https://${req.get("host")}/reset?token=${encodeURIComponent(req.body.token)}`;
  res.json({ link });
});
