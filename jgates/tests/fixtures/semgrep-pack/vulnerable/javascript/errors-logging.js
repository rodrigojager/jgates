const express = require("express");
const axios = require("axios");
const Koa = require("koa");

const app = express();
const koa = new Koa();

app.get("/remote-report", async (req, res) => {
  const url = validateUrl(req.query.url);
  const report = await axios.get(url, { timeout: 5000 });
  res.json(report.data);
});

app.post("/login", async (req, res) => {
  const password = loadCredential(req);
  console.info("login attempt with " + password);
  try {
    await axios.get("https://auth.example.com/check");
  } catch (err) {}
  res.json({ ok: true });
});

app.get("/report", (req, res) => {
  try {
    buildReport(req.query.id);
  } catch (err) {
    res.status(500).send(err.stack);
  }
});

app.get("/export", (req, res) => {
  try {
    buildReport(req.query.id);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

koa.use(async (ctx) => {
  try {
    buildReport(ctx.query.id);
  } catch (err) {
    ctx.body = err.stack;
  }
});

function loadCredential(req) {
  return req.session.credential;
}

function buildReport(id) {
  return { id };
}
