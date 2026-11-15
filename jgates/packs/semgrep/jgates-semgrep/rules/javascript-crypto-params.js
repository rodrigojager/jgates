const crypto = require("crypto");
const forge = require("node-forge");
const CryptoJS = require("crypto-js");
const bcrypt = require("bcrypt");
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const uuid = require("uuid");

function keySizes() {
  // ruleid: jgates.js.weak-key-size
  crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  // ruleid: jgates.js.weak-key-size
  forge.pki.rsa.generateKeyPair(512);
  // ruleid: jgates.js.weak-key-size
  crypto.generateKeyPairSync("ec", { namedCurve: "secp192k1" });
  // ok: jgates.js.weak-key-size
  crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
  // ok: jgates.js.weak-key-size
  crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  // ruleid: jgates.js.rsa-key-below-3072
  crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  // ruleid: jgates.js.rsa-key-below-3072
  forge.pki.rsa.generateKeyPair(3000);
  // ok: jgates.js.rsa-key-below-3072
  crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  // ok: jgates.js.rsa-key-below-3072
  forge.pki.rsa.generateKeyPair(4096);
}

function ivs(key, message) {
  // ruleid: jgates.js.static-iv-or-nonce
  crypto.createCipheriv("aes-256-gcm", key, "000000000000");
  // ruleid: jgates.js.static-iv-or-nonce
  crypto.createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  // ruleid: jgates.js.static-iv-or-nonce
  CryptoJS.AES.encrypt(message, key, { iv: "0123456789abcdef" });
  // ok: jgates.js.static-iv-or-nonce
  crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12));
  const iv = crypto.randomBytes(12);
  // ok: jgates.js.static-iv-or-nonce
  crypto.createCipheriv("aes-256-gcm", key, iv);
}

function modes(key, iv, message) {
  // ruleid: jgates.js.cipher-mode-without-authentication
  crypto.createCipheriv("aes-256-cbc", key, iv);
  // ruleid: jgates.js.cipher-mode-without-authentication
  crypto.createDecipheriv("aes-128-ctr", key, iv);
  // ruleid: jgates.js.cipher-mode-without-authentication
  CryptoJS.AES.encrypt(message, key, { mode: CryptoJS.mode.CFB });
  // ok: jgates.js.cipher-mode-without-authentication
  crypto.createCipheriv("aes-256-gcm", key, iv);
  // ok: jgates.js.cipher-mode-without-authentication
  crypto.createCipheriv("chacha20-poly1305", key, iv);
}

function weakModes(key, data, publicKey, privateKey) {
  // ruleid: jgates.js.weak-cipher-mode
  crypto.createCipheriv("aes-128-ecb", key, null);
  // ruleid: jgates.js.weak-cipher-mode
  crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, data);
  // ruleid: jgates.js.weak-cipher-mode
  crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, data);
  // ok: jgates.js.weak-cipher-mode
  crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12));
  // ok: jgates.js.weak-cipher-mode
  crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, data);
}

async function kdf(password, salt) {
  // ruleid: jgates.js.weak-kdf-parameters
  crypto.pbkdf2Sync(password, salt, 1000, 32, "sha256");
  // ruleid: jgates.js.weak-kdf-parameters
  await bcrypt.hash(password, 4);
  // ruleid: jgates.js.weak-kdf-parameters
  crypto.scryptSync(password, salt, 32, { N: 1024 });
  // ruleid: jgates.js.weak-kdf-parameters
  await argon2.hash(password, { memoryCost: 1024 });
  // ruleid: jgates.js.weak-kdf-parameters
  await argon2.hash(password, { timeCost: 1 });
  // ok: jgates.js.weak-kdf-parameters
  crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256");
  // ok: jgates.js.weak-kdf-parameters
  await bcrypt.hash(password, 12);
  // ok: jgates.js.weak-kdf-parameters
  crypto.scryptSync(password, salt, 32, { N: 32768 });
  // ok: jgates.js.weak-kdf-parameters
  await argon2.hash(password, { memoryCost: 65536, timeCost: 3 });
}

function passwordHashing(password, salt) {
  // ruleid: jgates.js.password-hash-with-fast-hash
  crypto.createHash("sha256").update(password).digest("hex");
  // ruleid: jgates.js.password-hash-with-fast-hash
  CryptoJS.SHA256(password);
  // ruleid: jgates.js.password-hash-with-fast-hash
  crypto.createHash("sha512").update(salt + password).digest("hex");
  // ok: jgates.js.password-hash-with-fast-hash
  crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256");
  // ok: jgates.js.password-hash-with-fast-hash
  crypto.createHash("sha256").update(salt).digest("hex");
}

function comparisons(request, secret, body) {
  const expectedSignature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  // ruleid: jgates.js.timing-unsafe-comparison
  if (request.headers["x-signature"] === expectedSignature) return true;
  // ruleid: jgates.js.timing-unsafe-comparison
  if (crypto.createHmac("sha256", secret).update(body).digest("hex") !== request.query.sig) return false;
  const supplied = Buffer.from(request.headers["x-signature"] || "");
  const expected = Buffer.from(expectedSignature);
  // ok: jgates.js.timing-unsafe-comparison
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return true;
  // ok: jgates.js.timing-unsafe-comparison
  if (request.headers["x-signature"] === undefined) return false;
  return false;
}

function signatures(key, data) {
  // ruleid: jgates.js.weak-signature-hash
  crypto.createHmac("md5", key).update(data);
  // ruleid: jgates.js.weak-signature-hash
  crypto.createSign("RSA-SHA1").update(data);
  // ruleid: jgates.js.weak-signature-hash
  crypto.createVerify("sha1").update(data);
  // ruleid: jgates.js.weak-signature-hash
  CryptoJS.HmacSHA1(data, key);
  // ok: jgates.js.weak-signature-hash
  crypto.createHmac("sha256", key).update(data);
  // ok: jgates.js.weak-signature-hash
  crypto.createSign("RSA-SHA256").update(data);
}

function dh() {
  // ruleid: jgates.js.weak-dh-parameters
  crypto.createDiffieHellman(1024);
  // ruleid: jgates.js.weak-dh-parameters
  crypto.getDiffieHellman("modp2");
  // ok: jgates.js.weak-dh-parameters
  crypto.createDiffieHellman(2048);
  // ok: jgates.js.weak-dh-parameters
  crypto.getDiffieHellman("modp14");
}

function hardcodedKeys(iv, data, payload) {
  // ruleid: jgates.js.hardcoded-encryption-key
  crypto.createCipheriv("aes-256-gcm", "0123456789abcdef0123456789abcdef", iv);
  // ruleid: jgates.js.hardcoded-encryption-key
  crypto.createHmac("sha256", "shared-signing-secret").update(data);
  // ruleid: jgates.js.hardcoded-encryption-key
  jwt.sign(payload, "my-jwt-secret", { expiresIn: "1h" });
  // ruleid: jgates.js.hardcoded-encryption-key
  CryptoJS.AES.encrypt(data, "hardcoded-passphrase");
  // ok: jgates.js.hardcoded-encryption-key
  crypto.createCipheriv("aes-256-gcm", Buffer.from(process.env.DATA_KEY, "hex"), iv);
  // ok: jgates.js.hardcoded-encryption-key
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1h" });
  // ok: jgates.js.hardcoded-encryption-key
  crypto.createHmac("sha256", process.env.HMAC_KEY).update(data);
}

function randomness() {
  // ruleid: jgates.js.insecure-random-for-secret
  const resetToken = Math.random().toString(36).slice(2);
  // ruleid: jgates.js.insecure-random-for-secret
  const code = Math.floor(100000 + Math.random() * 900000);
  const raw = Math.random();
  // ruleid: jgates.js.insecure-random-for-secret
  const sessionSecret = raw.toString(16);
  // ruleid: jgates.js.insecure-random-for-secret
  const record = { apiKey: Math.random().toString(36) };
  // ok: jgates.js.insecure-random-for-secret
  const safeToken = crypto.randomBytes(32).toString("hex");
  // ok: jgates.js.insecure-random-for-secret
  const jitter = Math.random() * 100;
  // ok: jgates.js.insecure-random-for-secret
  const safeCode = crypto.randomInt(100000, 1000000);
  return [resetToken, code, sessionSecret, record, safeToken, jitter, safeCode];
}

function uuids() {
  // ruleid: jgates.js.uuid-as-secret-token
  const resetToken = uuid.v4();
  // ruleid: jgates.js.uuid-as-secret-token
  const apiKey = crypto.randomUUID();
  // ok: jgates.js.uuid-as-secret-token
  const requestId = uuid.v4();
  // ok: jgates.js.uuid-as-secret-token
  const accessToken = crypto.randomBytes(32).toString("hex");
  return [resetToken, apiKey, requestId, accessToken];
}
