const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

function createKeys() {
  const strong = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
  const curve = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return [strong, curve, crypto.createDiffieHellman(2048)];
}

function encryptRecord(record, key) {
  const gcm = crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12));
  const chacha = crypto.createCipheriv("chacha20-poly1305", key, crypto.randomBytes(12));
  const rsa = crypto.publicEncrypt(
    { key: record.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(record.value),
  );
  return [gcm, chacha, rsa];
}

async function storePassword(password, salt) {
  const hashed = await bcrypt.hash(password, 12);
  return [hashed, crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256")];
}

function verifyRequest(request, body) {
  const expectedSignature = crypto.createHmac("sha256", process.env.HMAC_KEY).update(body).digest();
  const supplied = Buffer.from(request.headers["x-signature"] || "", "hex");
  return supplied.length === expectedSignature.length && crypto.timingSafeEqual(supplied, expectedSignature);
}

function sign(body, payload) {
  const mac = crypto.createHmac("sha256", process.env.HMAC_KEY).update(body).digest("hex");
  const embedded = crypto.createCipheriv("aes-256-gcm", Buffer.from(process.env.DATA_KEY, "hex"), crypto.randomBytes(12));
  const token = jwt.sign(payload, process.env.JWT_SECRET);
  return [mac, embedded, token];
}

function newTokens() {
  const resetToken = crypto.randomBytes(32).toString("hex");
  const apiKey = crypto.randomBytes(32).toString("base64url");
  return [resetToken, apiKey];
}
