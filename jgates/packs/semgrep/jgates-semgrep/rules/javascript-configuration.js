const express = require("express");
const errorhandler = require("errorhandler");
const swaggerUi = require("swagger-ui-express");
const expressStatusMonitor = require("express-status-monitor");
const serveIndex = require("serve-index");
const helmet = require("helmet");
const _ = require("lodash");
const { ApolloServer } = require("@apollo/server");
const { graphqlHTTP } = require("express-graphql");
const { Schema } = require("mongoose");
const mongoose = require("mongoose");

const app = express();

// ---- debug-mode-enabled
function debugMode(schema, spec) {
  // ruleid: jgates.js.debug-mode-enabled
  app.use(errorhandler());
  // ruleid: jgates.js.debug-mode-enabled
  const server = new ApolloServer({ typeDefs: "", debug: true });
  // ruleid: jgates.js.debug-mode-enabled
  app.use("/graphql", graphqlHTTP({ schema, graphiql: true }));
  // ok: jgates.js.debug-mode-enabled
  const quiet = new ApolloServer({ typeDefs: "", debug: false });
  // ok: jgates.js.debug-mode-enabled
  app.use("/graphql", graphqlHTTP({ schema, graphiql: process.env.NODE_ENV === "development" }));
  if (process.env.NODE_ENV === "development") {
    // ok: jgates.js.debug-mode-enabled
    app.use(errorhandler());
  }
  if (process.env.NODE_ENV !== "production") {
    // ok: jgates.js.debug-mode-enabled
    app.use("/graphql", graphqlHTTP({ schema, graphiql: true }));
  } else {
    app.use((err, req, res, next) => res.status(500).send("Internal error"));
  }
}

// ---- docs-or-monitoring-endpoint-exposed
function docs(spec) {
  // ruleid: jgates.js.docs-or-monitoring-endpoint-exposed
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));
  // ruleid: jgates.js.docs-or-monitoring-endpoint-exposed
  app.use(expressStatusMonitor());
  // ruleid: jgates.js.docs-or-monitoring-endpoint-exposed
  SwaggerModule.setup("docs", app, spec);
  // ok: jgates.js.docs-or-monitoring-endpoint-exposed
  app.use("/api-docs", requireAdmin, swaggerUi.serve, swaggerUi.setup(spec));
  if (process.env.NODE_ENV !== "production") {
    // ok: jgates.js.docs-or-monitoring-endpoint-exposed
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));
  }
}

// ---- directory-listing-enabled
function listing(publicDir) {
  // ruleid: jgates.js.directory-listing-enabled
  app.use("/files", serveIndex(publicDir));
  // ruleid: jgates.js.directory-listing-enabled
  app.use("/files", express.static(publicDir), serveIndex(publicDir, { icons: true }));
  // ok: jgates.js.directory-listing-enabled
  app.use("/files", express.static(publicDir, { index: "index.html" }));
  // ok: jgates.js.directory-listing-enabled
  app.use("/assets", express.static(publicDir));
}

function fastifyListing(fastify, fastifyStatic, root) {
  // ruleid: jgates.js.directory-listing-enabled-fastify
  fastify.register(fastifyStatic, { root, list: true });
  // ruleid: jgates.js.directory-listing-enabled-fastify
  fastify.register(fastifyStatic, { root, list: { format: "html" } });
  // ok: jgates.js.directory-listing-enabled-fastify
  fastify.register(fastifyStatic, { root, list: false });
  // ok: jgates.js.directory-listing-enabled-fastify
  fastify.register(fastifyStatic, { root });
}

// ---- version-header-exposed
function versionHeader(res) {
  // ruleid: jgates.js.version-header-exposed
  res.setHeader("X-Powered-By", "Express 4.18");
  // ruleid: jgates.js.version-header-exposed
  res.set("x-powered-by", "PHP/8.1");
  // ruleid: jgates.js.version-header-exposed
  app.enable("x-powered-by");
  // ruleid: jgates.js.version-header-exposed
  app.use(helmet({ hidePoweredBy: false }));
  // ok: jgates.js.version-header-exposed
  app.disable("x-powered-by");
  // ok: jgates.js.version-header-exposed
  res.removeHeader("X-Powered-By");
  // ok: jgates.js.version-header-exposed
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// ---- mass-assignment
async function massAssignment(req, res, User, Post, account) {
  // ruleid: jgates.js.mass-assignment
  await User.create(req.body);
  // ruleid: jgates.js.mass-assignment
  await User.create({ ...req.body, createdAt: Date.now() });
  // ruleid: jgates.js.mass-assignment
  await User.findByIdAndUpdate(req.params.id, req.body, { new: true });
  // ruleid: jgates.js.mass-assignment
  const post = new Post(req.body);
  // ruleid: jgates.js.mass-assignment
  Object.assign(account, req.body);
  // ok: jgates.js.mass-assignment
  await User.create({ name: req.body.name, email: req.body.email });
  // ok: jgates.js.mass-assignment
  await User.create(_.pick(req.body, ["name", "email"]));
  // ok: jgates.js.mass-assignment
  await User.findByIdAndUpdate(req.params.id, { name: req.body.name });
  // ok: jgates.js.mass-assignment
  const when = new Date(req.body);
  // ok: jgates.js.mass-assignment
  Object.assign({}, defaults);
}

// ---- mass-assignment-schema-open
function schemas() {
  // ruleid: jgates.js.mass-assignment-schema-open
  const a = new Schema({ name: String }, { strict: false });
  // ruleid: jgates.js.mass-assignment-schema-open
  const b = new mongoose.Schema({ name: String }, { timestamps: true, strict: false });
  // ok: jgates.js.mass-assignment-schema-open
  const c = new Schema({ name: String }, { strict: true });
  // ok: jgates.js.mass-assignment-schema-open
  const d = new mongoose.Schema({ name: String });
}

// ---- prototype-pollution
function pollute(req, store) {
  // ruleid: jgates.js.prototype-pollution
  store[req.body.group][req.body.key] = req.body.value;
  const group = req.query.group;
  // ruleid: jgates.js.prototype-pollution
  store[group][req.query.name] = "x";
  // ok: jgates.js.prototype-pollution
  store.settings[req.body.key] = req.body.value;
  // ok: jgates.js.prototype-pollution
  store["settings"]["theme"] = req.body.theme;
}

function pollutesWithKeyCheck(req, store) {
  const group = req.body.group;
  if (group === "__proto__" || group === "constructor") {
    return;
  }
  // ok: jgates.js.prototype-pollution
  store[group][req.body.key] = req.body.value;
}

// ---- prototype-pollution-recursive-merge
function deepMerge(target, source) {
  for (const key in source) {
    if (typeof source[key] === "object") {
      // ruleid: jgates.js.prototype-pollution-recursive-merge
      target[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function deepMergeCall(target, source) {
  for (const key in source) {
    // ruleid: jgates.js.prototype-pollution-recursive-merge
    deepMergeCall(target[key], source[key]);
  }
}

function safeMerge(target, source) {
  for (const key in source) {
    if (key === "__proto__" || key === "constructor") continue;
    // ok: jgates.js.prototype-pollution-recursive-merge
    target[key] = safeMerge(target[key] || {}, source[key]);
  }
  return target;
}

function flatCopy(target, source) {
  // ok: jgates.js.prototype-pollution-recursive-merge
  for (const key in source) {
    target[key] = source[key];
  }
  return target;
}

module.exports = { debugMode, docs, listing, massAssignment, schemas, pollute, deepMerge };
