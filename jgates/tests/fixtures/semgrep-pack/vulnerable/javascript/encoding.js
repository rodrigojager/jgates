const util = require("util");
const markdownit = require("markdown-it");

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
