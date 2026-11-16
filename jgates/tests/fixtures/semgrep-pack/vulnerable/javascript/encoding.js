const util = require("util");
const markdownit = require("markdown-it");
const Papa = require("papaparse");
const Memcached = require("memcached");

function exportData(req) {
  const client = new Memcached("localhost:11211");
  client.get(req.query.key, callback);
  Papa.unparse([[req.body.name]]);
  const decoded = decodeURIComponent(decodeURIComponent(req.query.value));
  const url = "https://example.com/?q=" + req.query.term;
  const json = '{"name":"' + req.body.name + '"}';
  return { decoded, url, json };
}

function findUsers(req, res) {
  const matcher = new RegExp(req.query.term);
  res.json(users.filter((u) => matcher.test(u.name)));
}

const slug = /^(\w+)+$/;

function audit(req) {
  util.format(req.query.message, "audit");
}

const renderer = markdownit({ html: true });

module.exports = { findUsers, audit, renderer, slug };
