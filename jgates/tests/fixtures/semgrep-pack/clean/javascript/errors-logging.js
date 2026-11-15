const express = require("express");
const axios = require("axios");
const Koa = require("koa");

const app = express();
const koa = new Koa();
const logger = console;

app.post("/login", async (req, res) => {
  const userId = String(req.body.userId);
  logger.info("login attempt for " + userId);
  try {
    await axios.get("https://auth.example.com/check", { timeout: 5000 });
  } catch (err) {
    logger.error(err);
  }
  res.json({ ok: true });
});

app.get("/report", (req, res) => {
  try {
    buildReport(req.query.id);
  } catch (err) {
    logger.error(err.stack);
    res.status(500).send("internal error");
  }
});

app.get("/export", (req, res) => {
  try {
    buildReport(req.query.id);
  } catch (error) {
    logger.error(error.message);
    res.status(500).json({ error: "internal error" });
  }
});

koa.use(async (ctx) => {
  try {
    buildReport(ctx.query.id);
  } catch (err) {
    logger.error(err.stack);
    ctx.body = "internal error";
  }
});

function buildReport(id) {
  return { id };
}
