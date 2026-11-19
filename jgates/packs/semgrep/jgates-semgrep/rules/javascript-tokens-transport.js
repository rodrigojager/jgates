const jwt = require("jsonwebtoken");
const jose = require("jose");
const tls = require("tls");
const https = require("https");
const http = require("http");
const axios = require("axios");
const got = require("got");
const fs = require("fs");

function keyFromHeader(token, client) {
  // ruleid: jgates.js.jwt-key-from-token-header
  jwt.verify(token, function (header, cb) { fetchKey(header.jku, cb); }, { audience: "api" }, done);
  // ruleid: jgates.js.jwt-key-from-token-header
  jwt.verify(token, (header, cb) => cb(null, header.x5u), { audience: "api" }, done);
  // ok: jgates.js.jwt-key-from-token-header
  jwt.verify(token, function (header, cb) { client.getSigningKey(header.kid, cb); }, { audience: "api" }, done);
  // ok: jgates.js.jwt-key-from-token-header
  jwt.verify(token, (header, cb) => cb(null, keys[header.kid]), { audience: "api" }, done);
}

async function keyFromHeaderJose(token) {
  // ruleid: jgates.js.jwt-key-from-token-header-jose
  const url = decodeProtectedHeader(token).jku;
  // ruleid: jgates.js.jwt-key-from-token-header-jose
  const other = jose.decodeProtectedHeader(token).x5u;
  // ok: jgates.js.jwt-key-from-token-header-jose
  const kid = jose.decodeProtectedHeader(token).kid;
}

function expiry(token, secret) {
  // ruleid: jgates.js.jwt-expiry-not-validated
  jwt.verify(token, secret, { audience: "api", ignoreExpiration: true });
  // ruleid: jgates.js.jwt-expiry-not-validated
  const strategyOptions = { secretOrKey: secret, ignoreExpiration: true };
  // ok: jgates.js.jwt-expiry-not-validated
  jwt.verify(token, secret, { audience: "api", ignoreExpiration: false });
  // ok: jgates.js.jwt-expiry-not-validated
  const safeOptions = { secretOrKey: secret, ignoreExpiration: false };
}

async function audience(token, secret) {
  // ruleid: jgates.js.jwt-audience-not-validated
  jwt.verify(token, secret);
  // ruleid: jgates.js.jwt-audience-not-validated
  jwt.verify(token, secret, { algorithms: ["HS256"] });
  // ruleid: jgates.js.jwt-audience-not-validated
  await jose.jwtVerify(token, secret, { issuer: "https://issuer.example.com" });
  // ok: jgates.js.jwt-audience-not-validated
  jwt.verify(token, secret, { algorithms: ["HS256"], audience: "api" });
  // ok: jgates.js.jwt-audience-not-validated
  await jose.jwtVerify(token, secret, { audience: "api" });
}

function oauth(client, state, challenge) {
  // ruleid: jgates.js.oauth-request-without-state
  const q = new URLSearchParams({ response_type: "code", client_id: "abc", redirect_uri: "https://app.example.com/cb" });
  // ruleid: jgates.js.oauth-request-without-state
  const url = client.generateAuthUrl({ scope: "openid" });
  // ruleid: jgates.js.oauth-request-without-state
  const raw = "https://idp.example.com/authorize?response_type=code&client_id=abc";
  // ok: jgates.js.oauth-request-without-state
  const q2 = new URLSearchParams({ response_type: "code", client_id: "abc", state: state });
  // ok: jgates.js.oauth-request-without-state
  const url2 = client.authorizationUrl({ scope: "openid", code_challenge: challenge });
  // ok: jgates.js.oauth-request-without-state
  const raw2 = "https://idp.example.com/authorize?response_type=code&state=" + state;
}

function protocol() {
  // ruleid: jgates.js.tls-old-protocol-version
  https.createServer({ minVersion: "TLSv1", cert: "c" });
  // ruleid: jgates.js.tls-old-protocol-version
  tls.connect({ host: "h", secureProtocol: "TLSv1_method" });
  // ruleid: jgates.js.tls-old-protocol-version
  tls.DEFAULT_MIN_VERSION = "TLSv1.1";
  // ok: jgates.js.tls-old-protocol-version
  https.createServer({ minVersion: "TLSv1.2", cert: "c" });
  // ok: jgates.js.tls-old-protocol-version
  tls.DEFAULT_MIN_VERSION = "TLSv1.3";
}

function ciphers() {
  // ruleid: jgates.js.tls-weak-cipher-suite
  https.createServer({ ciphers: "ECDHE-RSA-AES128-GCM-SHA256:RC4-SHA" });
  // ruleid: jgates.js.tls-weak-cipher-suite
  https.createServer({ ciphers: "DES-CBC3-SHA:HIGH" });
  // ok: jgates.js.tls-weak-cipher-suite
  https.createServer({ ciphers: "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-CHACHA20-POLY1305" });
  // ok: jgates.js.tls-weak-cipher-suite
  https.createServer({ ciphers: "HIGH:!aNULL:!eNULL:!EXPORT:!DES:!3DES:!RC4" });
}

async function clients() {
  // ruleid: jgates.js.cleartext-http-url
  await fetch("http://api.example.com/data");
  // ruleid: jgates.js.cleartext-http-url
  await axios.get("http://api.example.com/items");
  // ruleid: jgates.js.cleartext-http-url
  http.get("http://api.example.com/ping", () => {});
  // ruleid: jgates.js.cleartext-http-url
  await got("ftp://files.example.com/archive");
  // ok: jgates.js.cleartext-http-url
  await fetch("https://api.example.com/data");
  // ok: jgates.js.cleartext-http-url
  await axios.get("http://localhost:3000/health");
  // ok: jgates.js.cleartext-http-url
  http.get("http://127.0.0.1:8080/ping", () => {});
}

function mtls() {
  // ruleid: jgates.js.mtls-client-certificate-not-verified
  https.createServer({ requestCert: true, rejectUnauthorized: false, ca: [fs.readFileSync("ca.pem")] });
  // ruleid: jgates.js.mtls-client-certificate-not-verified
  tls.createServer({ rejectUnauthorized: false, requestCert: true });
  // ok: jgates.js.mtls-client-certificate-not-verified
  https.createServer({ requestCert: true, rejectUnauthorized: true, ca: [fs.readFileSync("ca.pem")] });
  // ok: jgates.js.mtls-client-certificate-not-verified
  tls.createServer({ requestCert: true, ca: [fs.readFileSync("ca.pem")] });
}
