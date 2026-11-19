const jwt = require("jsonwebtoken");
const https = require("https");
const fs = require("fs");

function verifyWithHeaderKey(token, done) {
  return jwt.verify(token, (header, cb) => fetchKey(header.jku, cb), { audience: "api" }, done);
}

function verifyLong(token, secret) {
  return jwt.verify(token, secret, { audience: "api", ignoreExpiration: true });
}

function verifyAnyAudience(token, secret) {
  return jwt.verify(token, secret, { algorithms: ["HS256"] });
}

function authorizeUrl(clientId) {
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://app.example.com/cb" });
  return "https://idp.example.com/authorize?" + query.toString();
}

function startServer(app) {
  return https.createServer({ cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem"), minVersion: "TLSv1", ciphers: "HIGH:RC4-SHA" }, app);
}

async function loadProfile(id) {
  const res = await fetch("http://profiles.example.com/api/" + id);
  return res.json();
}

function startMutualServer(app) {
  return https.createServer({ requestCert: true, rejectUnauthorized: false, cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem") }, app);
}

module.exports = { verifyWithHeaderKey, verifyLong, verifyAnyAudience, authorizeUrl, startServer, loadProfile, startMutualServer };
