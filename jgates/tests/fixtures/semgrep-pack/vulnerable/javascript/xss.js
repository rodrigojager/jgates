const express = require("express");

const app = express();

app.get("/hello", (req, res) => {
  res.send("<h1>Hello " + req.query.name + "</h1>");
});

app.get("/note", (req, res) => {
  res.send(`<p>${req.body.note}</p>`);
});

function show(el, html) {
  el.innerHTML = html;
}
