const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();

app.get("/file", (req, res) => {
  res.send(fs.readFileSync(path.join("public", path.basename(req.query.name))));
});

app.get("/proxy", async (req, res) => {
  const response = await fetch("https://api.example.com/status");
  res.send(await response.text());
});

app.get("/digest", (req, res) => {
  res.send(crypto.createHash("sha256").update(req.query.value).digest("hex"));
});
