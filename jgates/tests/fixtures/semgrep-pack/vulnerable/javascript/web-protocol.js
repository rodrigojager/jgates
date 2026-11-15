const express = require("express");
const helmet = require("helmet");
const { WebSocketServer } = require("ws");
const { ApolloServer } = require("@apollo/server");

const app = express();

// security-headers-disabled
app.use(helmet({ contentSecurityPolicy: false }));

// csp-unsafe-directive
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'");
  next();
});

// websocket-without-tls
function openFeed() {
  return new WebSocket("ws://feed.example.com/live");
}

// websocket-origin-not-checked
const wss = new WebSocketServer({ port: 8081, verifyClient: () => true });

// graphql-introspection-enabled
const graph = new ApolloServer({ typeDefs: "type Query { ok: Boolean }", resolvers: {}, introspection: true, validationRules: [] });

// graphql-without-depth-limit
const plainGraph = new ApolloServer({ typeDefs: "type Query { ok: Boolean }", resolvers: {} });

// open-redirect
app.get("/login/done", (req, res) => {
  res.redirect(req.query.next);
});

// client-ip-from-forwarded-header
app.get("/whoami", (req, res) => {
  res.send(String(req.headers["x-forwarded-for"]));
});

// host-header-in-url
app.post("/forgot", (req, res) => {
  const link = "https://" + req.headers.host + "/reset?token=" + req.body.token;
  res.json({ link });
});

module.exports = { app, wss, graph, plainGraph, openFeed };
