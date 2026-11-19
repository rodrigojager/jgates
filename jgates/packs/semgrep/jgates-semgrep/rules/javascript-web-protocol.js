const express = require("express");
const helmet = require("helmet");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const { Server } = require("socket.io");
const { ApolloServer } = require("@apollo/server");
const { graphqlHTTP } = require("express-graphql");
const depthLimit = require("graphql-depth-limit");

const app = express();

// ---- security-headers-disabled
function headers() {
  // ruleid: jgates.js.security-headers-disabled
  app.use(helmet({ contentSecurityPolicy: false }));
  // ruleid: jgates.js.security-headers-disabled
  app.use(helmet({ hsts: false, frameguard: { action: "deny" } }));
  // ruleid: jgates.js.security-headers-disabled
  app.use(helmet({ hsts: { maxAge: 86400 } }));
  // ruleid: jgates.js.security-headers-disabled
  app.use(helmet.hsts({ maxAge: 3600 }));
  // ok: jgates.js.security-headers-disabled
  app.use(helmet());
  // ok: jgates.js.security-headers-disabled
  app.use(helmet({ hsts: { maxAge: 31536000, includeSubDomains: true } }));
  // ok: jgates.js.security-headers-disabled
  app.use(helmet({ crossOriginEmbedderPolicy: false }));
}

// ---- csp-unsafe-directive
function csp(res) {
  // ruleid: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'");
  // ruleid: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "script-src * ; object-src 'none'");
  // ruleid: jgates.js.csp-unsafe-directive
  app.use(helmet({ contentSecurityPolicy: { directives: { scriptSrc: ["'self'", "'unsafe-eval'"] } } }));
  // ok: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-abc123'");
  // ok: jgates.js.csp-unsafe-directive
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'");
  // ok: jgates.js.csp-unsafe-directive
  app.use(helmet({ contentSecurityPolicy: { directives: { scriptSrc: ["'self'", "https://cdn.example.com"] } } }));
}

// ---- websocket-without-tls
function sockets() {
  // ruleid: jgates.js.websocket-without-tls
  const a = new WebSocket("ws://chat.example.com/live");
  // ruleid: jgates.js.websocket-without-tls
  const b = new WebSocket(`ws://${process.env.CHAT_HOST}/live`);
  // ok: jgates.js.websocket-without-tls
  const c = new WebSocket("wss://chat.example.com/live");
  // ok: jgates.js.websocket-without-tls
  const d = new WebSocket("ws://localhost:8080/live");
  // ok: jgates.js.websocket-without-tls
  const e = new WebSocket("ws://127.0.0.1:8080/live");
  return [a, b, c, d, e];
}

// ---- websocket-origin-not-checked
const allowedOrigins = ["https://app.example.com"];
function servers(httpServer) {
  // ruleid: jgates.js.websocket-origin-not-checked
  const a = new WebSocketServer({ port: 8081, verifyClient: () => true });
  // ruleid: jgates.js.websocket-origin-not-checked
  const b = new WebSocket.Server({ port: 8082, verifyClient: (info, cb) => cb(true) });
  // ruleid: jgates.js.websocket-origin-not-checked
  const c = new Server(httpServer, { cors: { origin: "*" } });
  // ruleid: jgates.js.websocket-origin-not-checked
  const d = new Server(httpServer, { cors: { origin: true } });
  // ok: jgates.js.websocket-origin-not-checked
  const e = new WebSocketServer({ port: 8083, verifyClient: (info) => allowedOrigins.includes(info.origin) });
  // ok: jgates.js.websocket-origin-not-checked
  const f = new Server(httpServer, { cors: { origin: "https://app.example.com" } });
  // ok: jgates.js.websocket-origin-not-checked
  const g = new Server(httpServer, { allowRequest: (req, cb) => cb(null, allowedOrigins.includes(req.headers.origin)) });
  return [a, b, c, d, e, f, g];
}

// ---- graphql-introspection-enabled and graphql-without-depth-limit
function graphql(schema, typeDefs, resolvers) {
  // ruleid: jgates.js.graphql-introspection-enabled
  const a = new ApolloServer({ typeDefs, resolvers, introspection: true, validationRules: [depthLimit(8)] });
  // ruleid: jgates.js.graphql-introspection-enabled
  const b = graphqlHTTP({ schema, introspection: true, validationRules: [depthLimit(8)] });
  // ok: jgates.js.graphql-introspection-enabled
  const c = new ApolloServer({ typeDefs, resolvers, introspection: false, validationRules: [depthLimit(8)] });
  // ok: jgates.js.graphql-introspection-enabled
  const d = new ApolloServer({ typeDefs, resolvers, introspection: process.env.NODE_ENV !== "production", validationRules: [depthLimit(8)] });
  // ruleid: jgates.js.graphql-without-depth-limit
  const e = new ApolloServer({ typeDefs, resolvers });
  // ruleid: jgates.js.graphql-without-depth-limit
  const f = graphqlHTTP({ schema, graphiql: false });
  // ok: jgates.js.graphql-without-depth-limit
  const g = new ApolloServer({ typeDefs, resolvers, validationRules: [depthLimit(8)] });
  // ok: jgates.js.graphql-without-depth-limit
  const h = graphqlHTTP({ schema, validationRules: [depthLimit(8)] });
  return [a, b, c, d, e, f, g, h];
}

// ---- open-redirect
function safeRedirect(next) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

app.get("/login/done", (req, res) => {
  // ruleid: jgates.js.open-redirect
  res.redirect(req.query.next);
});

app.get("/go", (req, res) => {
  const target = req.query.url;
  // ruleid: jgates.js.open-redirect
  res.redirect(302, target);
});

app.get("/out", (req, res) => {
  // ruleid: jgates.js.open-redirect
  res.setHeader("Location", req.body.to);
  res.end();
});

app.get("/safe-1", (req, res) => {
  // ok: jgates.js.open-redirect
  res.redirect(safeRedirect(req.query.next));
});

app.get("/safe-2", (req, res) => {
  // ok: jgates.js.open-redirect
  res.redirect("/users/" + req.params.id);
});

app.get("/safe-3", (req, res) => {
  // ok: jgates.js.open-redirect
  res.redirect("/search?q=" + encodeURIComponent(req.query.q));
});

app.get("/safe-4", (req, res) => {
  // ok: jgates.js.open-redirect
  res.redirect("/dashboard");
});

function browserNavigation() {
  const next = new URLSearchParams(location.search).get("next");
  // ruleid: jgates.js.open-redirect
  window.location.href = next;
  // ok: jgates.js.open-redirect
  window.location.href = "/home";
}

// ---- client-ip-from-forwarded-header
function clientAddress(req) {
  // ruleid: jgates.js.client-ip-from-forwarded-header
  const a = req.headers["x-forwarded-for"];
  // ruleid: jgates.js.client-ip-from-forwarded-header
  const b = req.get("X-Real-IP");
  // ruleid: jgates.js.client-ip-from-forwarded-header
  const c = req.header("x-forwarded-for").split(",")[0];
  // ok: jgates.js.client-ip-from-forwarded-header
  const d = req.ip;
  // ok: jgates.js.client-ip-from-forwarded-header
  const e = req.socket.remoteAddress;
  // ok: jgates.js.client-ip-from-forwarded-header
  const f = req.headers["user-agent"];
  return [a, b, c, d, e, f];
}

// ---- host-header-in-url
function absoluteLinks(req, token) {
  // ruleid: jgates.js.host-header-in-url
  const a = "https://" + req.headers.host + "/reset?token=" + token;
  // ruleid: jgates.js.host-header-in-url
  const b = "https://" + req.get("host") + "/verify";
  // ruleid: jgates.js.host-header-in-url
  const c = `https://${req.headers.host}/reset?token=${token}`;
  // ok: jgates.js.host-header-in-url
  const d = process.env.PUBLIC_BASE_URL + "/reset?token=" + token;
  // ok: jgates.js.host-header-in-url
  const e = `${process.env.PUBLIC_BASE_URL}/verify`;
  return [a, b, c, d, e];
}
