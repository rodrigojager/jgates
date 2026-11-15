import * as crypto from "crypto";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import * as uuid from "uuid";

interface SecretRecord {
  publicKey: string;
  value: string;
}

function createKeys(): unknown[] {
  const weak = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const midsize = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return [weak, midsize, crypto.createDiffieHellman(1024)];
}

function encryptRecord(record: SecretRecord, key: Buffer): unknown[] {
  const staticIv = crypto.createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  const cbc = crypto.createCipheriv("aes-256-cbc", key, crypto.randomBytes(16));
  const ecb = crypto.createCipheriv("aes-128-ecb", key, null);
  const rsa = crypto.publicEncrypt({ key: record.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(record.value));
  return [staticIv, cbc, ecb, rsa];
}

async function storePassword(password: string, salt: string): Promise<unknown[]> {
  const cheap: string = await bcrypt.hash(password, 4);
  const fast: string = crypto.createHash("sha256").update(password).digest("hex");
  return [cheap, fast, crypto.pbkdf2Sync(password, salt, 1000, 32, "sha256")];
}

function verifyRequest(request: { headers: Record<string, string> }, body: string): boolean {
  const expectedSignature: string = crypto.createHmac("sha256", process.env.HMAC_KEY as string).update(body).digest("hex");
  return request.headers["x-signature"] === expectedSignature;
}

function sign(body: string, payload: object): unknown[] {
  const legacy: string = crypto.createHmac("sha1", process.env.HMAC_KEY as string).update(body).digest("hex");
  const embedded = crypto.createCipheriv("aes-256-gcm", "0123456789abcdef0123456789abcdef", crypto.randomBytes(12));
  const token: string = jwt.sign(payload, "my-jwt-secret");
  return [legacy, embedded, token];
}

function newTokens(): string[] {
  const resetToken: string = Math.random().toString(36).slice(2);
  const apiKey: string = uuid.v4();
  return [resetToken, apiKey];
}
