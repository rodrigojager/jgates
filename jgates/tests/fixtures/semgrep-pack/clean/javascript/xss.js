const express = require("express");

const app = express();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, "");
}

app.get("/hello", (req, res) => {
  res.send("<h1>Hello " + escapeHtml(req.query.name) + "</h1>");
});

function show(el, text) {
  el.textContent = text;
}
