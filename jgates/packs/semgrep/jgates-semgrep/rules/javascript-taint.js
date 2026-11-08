const fs = require("fs");
const path = require("path");
const axios = require("axios");

function validateUrl(url) {
  return url;
}

function proxy(req, res) {
  // ruleid: jgates.js.ssrf
  fetch(req.query.url);
  const target = req.body.callback;
  // ruleid: jgates.js.ssrf
  axios.get(target);
  // ok: jgates.js.ssrf
  fetch("https://api.example.com/status");
  // ok: jgates.js.ssrf
  fetch(validateUrl(req.query.url));
}

function download(req, res) {
  const name = req.params.name;
  // ruleid: jgates.js.path-traversal
  fs.readFileSync(name);
  // ruleid: jgates.js.path-traversal
  res.sendFile(req.query.file);
  // ok: jgates.js.path-traversal
  fs.readFileSync(path.basename(name));
  // ok: jgates.js.path-traversal
  fs.readFileSync("static/readme.txt");
}
