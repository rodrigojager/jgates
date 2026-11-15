const _ = require("lodash");
const util = require("util");
const markdownit = require("markdown-it");

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
