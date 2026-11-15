const jwt = require("jsonwebtoken");
const https = require("https");
const fs = require("fs");

function verifyWithHeaderKey(token, client, done) {
  return jwt.verify(token, (header, cb) => client.getSigningKey(header.kid, cb), { audience: "api" }, done);
}

function verifyLong(token, secret) {
  return jwt.verify(token, secret, { audience: "api", ignoreExpiration: false });
}

function verifyAudience(token, secret) {
  return jwt.verify(token, secret, { algorithms: ["HS256"], audience: "api" });
}

function authorizeUrl(clientId, state, challenge) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://app.example.com/cb",
    state: state,
    code_challenge: challenge,
  });
  return "https://idp.example.com/authorize?" + query.toString();
}

function startServer(app) {
  return https.createServer({ cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem"), minVersion: "TLSv1.2", ciphers: "ECDHE-RSA-AES128-GCM-SHA256" }, app);
}

async function loadProfile(id) {
  const res = await fetch("https://profiles.example.com/api/" + id);
  return res.json();
}

function startMutualServer(app) {
  return https.createServer({ requestCert: true, rejectUnauthorized: true, ca: [fs.readFileSync("ca.pem")], cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem") }, app);
}

module.exports = { verifyWithHeaderKey, verifyLong, verifyAudience, authorizeUrl, startServer, loadProfile, startMutualServer };
