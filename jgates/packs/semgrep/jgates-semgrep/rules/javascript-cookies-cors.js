const cookie = require("cookie");
const Cookies = require("js-cookie");
const cors = require("cors");
const session = require("express-session");
const lusca = require("lusca");
const csurf = require("csurf");
const { doubleCsrf } = require("csrf-csrf");

const allowed = ["https://app.example.com"];
const allowedSet = new Set(allowed);

function secureAttribute(res, token, value) {
  // ruleid: jgates.js.cookie-without-secure
  res.cookie("__Host-sid", token, { secure: false, httpOnly: true, sameSite: "lax" });
  // ruleid: jgates.js.cookie-without-secure
  res.cookie("__Host-sid", token, { httpOnly: true, sameSite: "lax" });
  // ruleid: jgates.js.cookie-without-secure
  Cookies.set("__Host-pref", value, { secure: false, sameSite: "lax" });
  // ruleid: jgates.js.cookie-without-secure
  document.cookie = "__Host-pref=1; path=/; SameSite=Lax";
  // ruleid: jgates.js.cookie-without-secure
  session({ secret: "x", cookie: { secure: false, httpOnly: true, sameSite: "lax" } });
  // ok: jgates.js.cookie-without-secure
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  // ok: jgates.js.cookie-without-secure
  Cookies.set("__Host-pref", value, { secure: true, sameSite: "lax" });
  // ok: jgates.js.cookie-without-secure
  document.cookie = "__Host-pref=1; path=/; Secure; SameSite=Lax";
  // ok: jgates.js.cookie-without-secure
  document.cookie = "__Host-pref=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

function httpOnlyAttribute(res, token) {
  // ruleid: jgates.js.cookie-without-httponly
  res.cookie("__Host-sid", token, { secure: true, httpOnly: false, sameSite: "lax" });
  // ruleid: jgates.js.cookie-without-httponly
  res.cookie("__Host-sid", token, { secure: true, sameSite: "lax" });
  // ruleid: jgates.js.cookie-without-httponly
  cookie.serialize("__Host-sid", token, { secure: true, sameSite: "lax" });
  // ruleid: jgates.js.cookie-without-httponly
  session({ secret: "x", cookie: { httpOnly: false, secure: true, sameSite: "lax" } });
  // ok: jgates.js.cookie-without-httponly
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  // ok: jgates.js.cookie-without-httponly
  cookie.serialize("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
}

function sameSiteAttribute(res, token, value) {
  // ruleid: jgates.js.cookie-without-samesite
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "none" });
  // ruleid: jgates.js.cookie-without-samesite
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: false });
  // ruleid: jgates.js.cookie-without-samesite
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true });
  // ruleid: jgates.js.cookie-without-samesite
  Cookies.set("__Host-pref", value, { secure: true });
  // ruleid: jgates.js.cookie-without-samesite
  document.cookie = "__Host-pref=1; path=/; Secure";
  // ruleid: jgates.js.cookie-without-samesite
  session({ secret: "x", cookie: { secure: true, httpOnly: true, sameSite: "none" } });
  // ok: jgates.js.cookie-without-samesite
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "strict" });
  // ok: jgates.js.cookie-without-samesite
  Cookies.set("__Host-pref", value, { secure: true, sameSite: "lax" });
  // ok: jgates.js.cookie-without-samesite
  document.cookie = "__Host-pref=1; path=/; Secure; SameSite=Strict";
}

function cookieNames(res, token, value, name) {
  // ruleid: jgates.js.cookie-name-without-prefix
  res.cookie("sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  // ruleid: jgates.js.cookie-name-without-prefix
  Cookies.set("theme", value, { secure: true, sameSite: "lax" });
  // ruleid: jgates.js.cookie-name-without-prefix
  document.cookie = "lang=en; path=/; Secure; SameSite=Lax";
  // ok: jgates.js.cookie-name-without-prefix
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  // ok: jgates.js.cookie-name-without-prefix
  res.cookie("__Secure-sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  // ok: jgates.js.cookie-name-without-prefix
  res.cookie(name, token, { secure: true, httpOnly: true, sameSite: "lax" });
}

function reflectOrigin(req, res, ctx) {
  // ruleid: jgates.js.cors-origin-reflected
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  const origin = req.get("Origin");
  // ruleid: jgates.js.cors-origin-reflected
  res.header("access-control-allow-origin", origin);
  // ruleid: jgates.js.cors-origin-reflected
  ctx.set("Access-Control-Allow-Origin", ctx.request.header.origin);
  // ruleid: jgates.js.cors-origin-reflected
  res.set({ "Access-Control-Allow-Origin": req.headers.origin });
  // ok: jgates.js.cors-origin-reflected
  res.setHeader("Access-Control-Allow-Origin", "https://app.example.com");
}

function includesGuard(req, res) {
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    // ok: jgates.js.cors-origin-reflected
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
}

function hasGuard(req, res) {
  const origin = req.get("Origin");
  if (allowedSet.has(origin)) {
    // ok: jgates.js.cors-origin-reflected
    res.header("Access-Control-Allow-Origin", origin);
  }
}

function indexOfGuard(req, res) {
  const origin = req.header("Origin");
  if (allowed.indexOf(origin) !== -1) {
    // ok: jgates.js.cors-origin-reflected
    res.set("Access-Control-Allow-Origin", origin);
  }
}

// ruleid: jgates.js.cors-origin-reflected-cors-package
cors({ origin: true });
// ruleid: jgates.js.cors-origin-reflected-cors-package
cors({ origin: (origin, cb) => cb(null, true) });
// ruleid: jgates.js.cors-origin-reflected-cors-package
cors({ origin: function (origin, callback) { callback(null, true); } });
// ok: jgates.js.cors-origin-reflected-cors-package
cors({ origin: ["https://app.example.com"] });
// ok: jgates.js.cors-origin-reflected-cors-package
cors({ origin: (origin, cb) => { if (allowed.includes(origin)) { cb(null, true); } else { cb(new Error("origin not allowed")); } } });

// ruleid: jgates.js.csrf-protection-disabled
lusca({ csrf: false });
// ruleid: jgates.js.csrf-protection-disabled
csurf({ ignoreMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"] });
// ruleid: jgates.js.csrf-protection-disabled
doubleCsrf({ getSecret: () => "x", skipCsrfProtection: () => true });
// ok: jgates.js.csrf-protection-disabled
lusca({ csrf: true });
// ok: jgates.js.csrf-protection-disabled
csurf({ cookie: true, ignoreMethods: ["GET", "HEAD", "OPTIONS"] });
// ok: jgates.js.csrf-protection-disabled
doubleCsrf({ getSecret: () => "x" });

function jsonp(req, res, data) {
  // ruleid: jgates.js.jsonp-enabled
  res.send(req.query.callback + "(" + JSON.stringify(data) + ")");
  const cb = req.query.jsonp;
  // ruleid: jgates.js.jsonp-enabled
  res.end(cb + "(" + JSON.stringify(data) + ");");
  // ruleid: jgates.js.jsonp-enabled
  res.send(`${req.query.cb}(${JSON.stringify(data)})`);
  // ok: jgates.js.jsonp-enabled
  res.json(data);
  // ok: jgates.js.jsonp-enabled
  res.send("(" + JSON.stringify(data) + ")");
  // ruleid: jgates.js.jsonp-enabled-express
  res.jsonp(data);
  // ruleid: jgates.js.jsonp-enabled-express
  return res.status(200).jsonp({ ok: true });
}

function plainJson(res, data) {
  // ok: jgates.js.jsonp-enabled-express
  res.json(data);
  // ok: jgates.js.jsonp-enabled-express
  res.send(data);
}

async function queryParameters(url, http, key, secret) {
  // ruleid: jgates.js.sensitive-query-parameter
  await fetch("https://api.example.com/v1/items?api_key=abc");
  // ruleid: jgates.js.sensitive-query-parameter
  await fetch(`https://api.example.com/login?user=${key}&password=${secret}`);
  // ruleid: jgates.js.sensitive-query-parameter
  url.searchParams.set("client_secret", secret);
  // ruleid: jgates.js.sensitive-query-parameter
  new URLSearchParams({ password: secret });
  // ruleid: jgates.js.sensitive-query-parameter
  await http.get("https://api.example.com/v1/items", { params: { apikey: key } });
  // ok: jgates.js.sensitive-query-parameter
  await fetch("https://api.example.com/v1/items?page=2&sort=name");
  // ok: jgates.js.sensitive-query-parameter
  await fetch("https://api.example.com/v1/items", { headers: { Authorization: "Bearer " + key } });
  // ok: jgates.js.sensitive-query-parameter
  url.searchParams.set("page", "2");
  // ok: jgates.js.sensitive-query-parameter
  new URLSearchParams({ page: "1" });
  // ok: jgates.js.sensitive-query-parameter
  const sql = "UPDATE users SET password=? WHERE id=?";
}

function storage(pw, ssn, card, key, token, refresh) {
  // ruleid: jgates.js.sensitive-data-in-browser-storage
  localStorage.setItem("password", pw);
  // ruleid: jgates.js.sensitive-data-in-browser-storage
  sessionStorage.setItem("user_ssn", ssn);
  // ruleid: jgates.js.sensitive-data-in-browser-storage
  window.localStorage.setItem("cardNumber", card);
  // ruleid: jgates.js.sensitive-data-in-browser-storage
  localStorage["apiKey"] = key;
  // ok: jgates.js.sensitive-data-in-browser-storage
  localStorage.setItem("theme", "dark");
  // ok: jgates.js.sensitive-data-in-browser-storage
  localStorage.setItem("classname", "wide");
  // ok: jgates.js.sensitive-data-in-browser-storage
  localStorage.setItem("session_token", token);
  // ok: jgates.js.sensitive-data-in-browser-storage
  const saved = sessionStorage.getItem("password");

  // ruleid: jgates.js.oauth-token-in-browser-storage
  localStorage.setItem("access_token", token);
  // ruleid: jgates.js.oauth-token-in-browser-storage
  sessionStorage.setItem("refreshToken", refresh);
  // ruleid: jgates.js.oauth-token-in-browser-storage
  localStorage["accessToken"] = token;
  // ok: jgates.js.oauth-token-in-browser-storage
  localStorage.setItem("theme", "dark");
  // ok: jgates.js.oauth-token-in-browser-storage
  localStorage.setItem("csrf_token", token);
  // ok: jgates.js.oauth-token-in-browser-storage
  const stored = localStorage.getItem("access_token");
}
