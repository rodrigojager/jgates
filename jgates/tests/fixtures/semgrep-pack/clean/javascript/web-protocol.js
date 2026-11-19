const express = require("express");
const helmet = require("helmet");
const { WebSocketServer } = require("ws");
const { ApolloServer } = require("@apollo/server");
const depthLimit = require("graphql-depth-limit");

const app = express();
const allowedOrigins = ["https://app.example.com"];
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

// security-headers-disabled
app.use(helmet({ hsts: { maxAge: 31536000, includeSubDomains: true } }));

// csp-unsafe-directive
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-r4nd0m'");
  next();
});

// websocket-without-tls
function openFeed() {
  return new WebSocket("wss://feed.example.com/live");
}

// websocket-origin-not-checked
const wss = new WebSocketServer({ port: 8081, verifyClient: (info) => allowedOrigins.includes(info.origin) });

// graphql-introspection-enabled
const graph = new ApolloServer({ typeDefs: "type Query { ok: Boolean }", resolvers: {}, introspection: false, validationRules: [depthLimit(8)] });

// graphql-without-depth-limit
const limitedGraph = new ApolloServer({ typeDefs: "type Query { ok: Boolean }", resolvers: {}, validationRules: [depthLimit(8)] });

// open-redirect
function safeRedirect(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
app.get("/login/done", (req, res) => {
  res.redirect(safeRedirect(req.query.next));
});

// client-ip-from-forwarded-header
app.set("trust proxy", 1);
app.get("/whoami", (req, res) => {
  res.send(String(req.ip));
});

// host-header-in-url
app.post("/forgot", (req, res) => {
  const link = publicBaseUrl + "/reset?token=" + encodeURIComponent(req.body.token);
  res.json({ link });
});

module.exports = { app, wss, graph, limitedGraph, openFeed };
