const express = require("express");
const cors = require("cors");
const lusca = require("lusca");

const app = express();

app.use(cors({ origin: true }));
app.use(lusca({ csrf: false }));

app.post("/login", (req, res) => {
  const token = String(req.body.sessionRef);
  res.cookie("__Host-secure-off", token, { secure: false, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-script-readable", token, { secure: true, httpOnly: false, sameSite: "lax" });
  res.cookie("__Host-cross-site", token, { secure: true, httpOnly: true, sameSite: "none" });
  res.cookie("sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  res.json({ ok: true });
});

app.get("/feed", (req, res) => {
  const data = { items: [] };
  res.end(encodeURIComponent(req.query.callback) + "(" + JSON.stringify(data) + ")");
});

app.get("/legacy", (req, res) => {
  res.jsonp({ items: [] });
});

async function loadItems(key) {
  const response = await fetch("https://api.example.com/v1/items?api_key=" + key);
  return response.json();
}

function notifyParent(message) {
  window.parent.postMessage(message, "*");
}

function remember(password, accessToken) {
  localStorage.setItem("password", password);
  sessionStorage.setItem("access_token", accessToken);
}
