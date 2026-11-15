const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const uuid = require("uuid");

function createKeys() {
  const weak = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const midsize = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return [weak, midsize, crypto.createDiffieHellman(1024)];
}

function encryptRecord(record, key) {
  const staticIv = crypto.createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  const cbc = crypto.createCipheriv("aes-256-cbc", key, crypto.randomBytes(16));
  const ecb = crypto.createCipheriv("aes-128-ecb", key, null);
  const rsa = crypto.publicEncrypt({ key: record.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(record.value));
  return [staticIv, cbc, ecb, rsa];
}

async function storePassword(password, salt) {
  const cheap = await bcrypt.hash(password, 4);
  const fast = crypto.createHash("sha256").update(password).digest("hex");
  return [cheap, fast, crypto.pbkdf2Sync(password, salt, 1000, 32, "sha256")];
}

function verifyRequest(request, body) {
  const expectedSignature = crypto.createHmac("sha256", process.env.HMAC_KEY).update(body).digest("hex");
  return request.headers["x-signature"] === expectedSignature;
}

function sign(body, payload) {
  const legacy = crypto.createHmac("sha1", process.env.HMAC_KEY).update(body).digest("hex");
  const embedded = crypto.createCipheriv("aes-256-gcm", "0123456789abcdef0123456789abcdef", crypto.randomBytes(12));
  const token = jwt.sign(payload, "my-jwt-secret");
  return [legacy, embedded, token];
}

function newTokens() {
  const resetToken = Math.random().toString(36).slice(2);
  const apiKey = uuid.v4();
  return [resetToken, apiKey];
}
