const crypto = require("crypto");
const https = require("https");
const jwt = require("jsonwebtoken");
const cors = require("cors");

function hashing(data) {
  // ruleid: jgates.js.weak-hash
  crypto.createHash("md5").update(data);
  // ruleid: jgates.js.weak-hash
  crypto.createHash("sha1").update(data);
  // ok: jgates.js.weak-hash
  crypto.createHash("sha256").update(data);
}

function ciphers(key, iv) {
  // ruleid: jgates.js.weak-cipher
  crypto.createCipheriv("des-ecb", key, iv);
  // ruleid: jgates.js.weak-cipher
  crypto.createCipher("aes192", key);
  // ok: jgates.js.weak-cipher
  crypto.createCipheriv("aes-256-gcm", key, iv);
}

function tls() {
  // ruleid: jgates.js.tls-verification-disabled
  new https.Agent({ rejectUnauthorized: false });
  // ok: jgates.js.tls-verification-disabled
  new https.Agent({ rejectUnauthorized: true });
}

function tokens(token, secret) {
  // ruleid: jgates.js.jwt-signature-not-verified
  jwt.decode(token);
  // ruleid: jgates.js.jwt-signature-not-verified
  jwt.verify(token, secret, { algorithms: ["none"] });
  // ok: jgates.js.jwt-signature-not-verified
  jwt.verify(token, secret, { algorithms: ["HS256"] });
}

// ruleid: jgates.js.cors-any-origin-with-credentials
cors({ origin: "*", credentials: true });
// ok: jgates.js.cors-any-origin-with-credentials
cors({ origin: "https://app.example.com", credentials: true });
