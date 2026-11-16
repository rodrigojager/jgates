const _ = require("lodash");
const util = require("util");
const markdownit = require("markdown-it");
const Papa = require("papaparse");
const Memcached = require("memcached");
const crypto = require("crypto");

function exportData(req) {
  const client = new Memcached("localhost:11211");
  client.get(crypto.createHash("sha256").update(req.query.key).digest("hex"), callback);
  Papa.unparse([[req.body.name]], { escapeFormulae: true });
  const decoded = decodeURIComponent(req.query.value);
  const url = "https://example.com/?q=" + encodeURIComponent(req.query.term);
  const json = JSON.stringify({ name: req.body.name });
  return { decoded, url, json };
}

function findUsers(req, res) {
  const matcher = new RegExp(_.escapeRegExp(req.query.term));
  res.json(users.filter((u) => matcher.test(u.name)));
}

const slug = /^[\w\s]+$/;

function audit(req) {
  util.format("%s", req.query.message);
}

const renderer = markdownit({ html: false });

module.exports = { findUsers, audit, renderer, slug };
