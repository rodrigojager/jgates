const _ = require("lodash");
const util = require("util");
const { sprintf } = require("sprintf-js");
const markdownit = require("markdown-it");
const MarkdownIt = require("markdown-it");
const { Remarkable } = require("remarkable");
const { marked } = require("marked");

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
