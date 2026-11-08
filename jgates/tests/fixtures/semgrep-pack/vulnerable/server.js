const crypto = require("crypto");
const fs = require("fs");
const express = require("express");

const app = express();

app.get("/file", (req, res) => {
  res.send(fs.readFileSync(req.query.name));
});

app.get("/proxy", async (req, res) => {
  const response = await fetch(req.query.url);
  res.send(await response.text());
});

app.get("/digest", (req, res) => {
  res.send(crypto.createHash("md5").update(req.query.value).digest("hex"));
});
