const express = require("express");
const cors = require("cors");
const lusca = require("lusca");

const app = express();
const allowedOrigins = ["https://app.example.com"];

app.use(cors({ origin: allowedOrigins }));
app.use(lusca({ csrf: true }));

app.post("/login", (req, res) => {
  const token = String(req.body.sessionRef);
  res.cookie("__Host-secure-on", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-script-hidden", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-secure-default", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-script-default", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-same-site", token, { secure: true, httpOnly: true, sameSite: "strict" });
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.json({ ok: true });
});

app.get("/feed", (req, res) => {
  const data = { items: [] };
  res.json(data);
});

app.get("/legacy", (req, res) => {
  res.json({ items: [] });
});

async function loadItems(key) {
  const response = await fetch("https://api.example.com/v1/items?page=1", { headers: { Authorization: "Bearer " + key } });
  return response.json();
}

function remember(theme) {
  localStorage.setItem("theme", theme);
  sessionStorage.setItem("last_view", "feed");
}
