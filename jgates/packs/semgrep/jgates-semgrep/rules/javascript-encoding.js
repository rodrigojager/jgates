const _ = require("lodash");
const util = require("util");
const { sprintf } = require("sprintf-js");
const markdownit = require("markdown-it");
const MarkdownIt = require("markdown-it");
const { Remarkable } = require("remarkable");
const { marked } = require("marked");
const Papa = require("papaparse");
const Memcached = require("memcached");
const crypto = require("crypto");

function exportCsv(req, ctx) {
  // ruleid: jgates.js.csv-formula-injection
  Papa.unparse([[req.query.name]]);
  // ruleid: jgates.js.csv-formula-injection
  Papa.unparse([{ name: ctx.request.body.name }], { header: true });
  // ok: jgates.js.csv-formula-injection
  Papa.unparse([[req.query.name]], { escapeFormulae: true });
  // ok: jgates.js.csv-formula-injection
  Papa.unparse([["'" + req.body.name]]);
}

function cache(req, ctx) {
  const client = new Memcached("localhost:11211");
  // ruleid: jgates.js.memcache-key-from-request
  client.get(req.query.key, callback);
  // ruleid: jgates.js.memcache-key-from-request
  client.set(ctx.query.key, "value", 60, callback);
  // ok: jgates.js.memcache-key-from-request
  client.get(crypto.createHash("sha256").update(req.query.key).digest("hex"), callback);
  // ok: jgates.js.memcache-key-from-request
  client.set("fixed-key", req.body.value, 60, callback);
}

function decode(value) {
  // ruleid: jgates.js.double-decoding
  const a = decodeURIComponent(decodeURIComponent(value));
  // ruleid: jgates.js.double-decoding
  const b = atob(atob(value));
  // ok: jgates.js.double-decoding
  const c = decodeURIComponent(value);
  // ok: jgates.js.double-decoding
  const d = atob(value);
  return [a, b, c, d];
}

function buildUrls(req, ctx) {
  // ruleid: jgates.js.url-parameter-unencoded
  const a = "https://example.com/?q=" + req.query.term + "&page=1";
  // ruleid: jgates.js.url-parameter-unencoded
  const b = `https://example.com/users/${ctx.query.name}`;
  // ok: jgates.js.url-parameter-unencoded
  const c = "https://example.com/?q=" + encodeURIComponent(req.query.term);
  // ok: jgates.js.url-parameter-unencoded
  const d = `https://example.com/users/${encodeURIComponent(ctx.query.name)}`;
  // ok: jgates.js.url-parameter-unencoded
  const e = "https://example.com/?" + new URLSearchParams({ q: req.query.term }).toString();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  // ok: jgates.js.url-parameter-unencoded
  const f = `${publicBaseUrl}/reset?token=${encodeURIComponent(req.body.token)}`;
  // ok: jgates.js.url-parameter-unencoded
  const g = publicBaseUrl + "/reset?token=" + encodeURIComponent(req.body.token);
  return [a, b, c, d, e, f, g];
}

function buildJson(req, ctx) {
  // ruleid: jgates.js.json-built-by-concatenation
  const a = '{"name":"' + req.body.name + '"}';
  // ruleid: jgates.js.json-built-by-concatenation
  const b = `{"name":"${ctx.query.name}"}`;
  // ok: jgates.js.json-built-by-concatenation
  const c = JSON.stringify({ name: req.body.name });
  // ok: jgates.js.json-built-by-concatenation
  const d = '{"name":' + JSON.stringify(ctx.query.name) + '}';
  return [a, b, c, d];
}

function search(req, res) {
  // ruleid: jgates.js.regex-from-request
  const a = new RegExp(req.query.term);
  // ruleid: jgates.js.regex-from-request
  const b = new RegExp("^" + req.body.prefix + "$", "i");
  // ruleid: jgates.js.regex-from-request
  const c = RegExp(`${req.params.name}-\\d+`);
  // ok: jgates.js.regex-from-request
  const d = new RegExp(_.escapeRegExp(req.query.term));
  // ok: jgates.js.regex-from-request
  const e = new RegExp("^[a-z]+$");
  // ok: jgates.js.regex-from-request
  const f = req.query.term.includes("x");
  res.json([a, b, c, d, e, f]);
}

function patterns() {
  // ruleid: jgates.js.redos-nested-quantifier
  const a = /^(a+)+$/;
  // ruleid: jgates.js.redos-nested-quantifier
  const b = /(\w*)*end/;
  // ruleid: jgates.js.redos-nested-quantifier
  const c = /^(?:[a-z]+)*$/;
  // ok: jgates.js.redos-nested-quantifier
  const d = /^(a|b)+$/;
  // ok: jgates.js.redos-nested-quantifier
  const e = /^[a-z]+$/;
  // ok: jgates.js.redos-nested-quantifier
  const f = /^(\d+\.)+\d+$/;
  return [a, b, c, d, e, f];
}

function logging(req) {
  // ruleid: jgates.js.format-string-from-request
  util.format(req.query.message, "x");
  // ruleid: jgates.js.format-string-from-request
  console.log(req.body.line);
  // ruleid: jgates.js.format-string-from-request
  const s = sprintf(req.params.template, 1);
  // ok: jgates.js.format-string-from-request
  util.format("%s", req.query.message);
  // ok: jgates.js.format-string-from-request
  console.log("query: %s", req.body.line);
  // ok: jgates.js.format-string-from-request
  console.log("started");
  return s;
}

function renderers() {
  // ruleid: jgates.js.markdown-raw-html-enabled
  const a = markdownit({ html: true });
  // ruleid: jgates.js.markdown-raw-html-enabled
  const b = new MarkdownIt({ linkify: true, html: true });
  // ruleid: jgates.js.markdown-raw-html-enabled
  const c = new Remarkable({ html: true });
  // ruleid: jgates.js.markdown-raw-html-enabled
  marked.setOptions({ sanitize: false });
  // ok: jgates.js.markdown-raw-html-enabled
  const d = markdownit({ html: false });
  // ok: jgates.js.markdown-raw-html-enabled
  const e = new MarkdownIt();
  // ok: jgates.js.markdown-raw-html-enabled
  const f = new Remarkable({ html: false });
  return [a, b, c, d, e, f];
}
