import * as crypto from "crypto";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";

interface SecretRecord {
  publicKey: string;
  value: string;
}

function createKeys(): unknown[] {
  const strong = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
  const curve = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return [strong, curve, crypto.createDiffieHellman(2048)];
}

function encryptRecord(record: SecretRecord, key: Buffer): unknown[] {
  const gcm = crypto.createCipheriv("aes-256-gcm", key, crypto.randomBytes(12));
  const chacha = crypto.createCipheriv("chacha20-poly1305", key, crypto.randomBytes(12));
  const rsa = crypto.publicEncrypt(
    { key: record.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(record.value),
  );
  return [gcm, chacha, rsa];
}

async function storePassword(password: string, salt: string): Promise<unknown[]> {
  const hashed: string = await bcrypt.hash(password, 12);
  return [hashed, crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256")];
}

function verifyRequest(request: { headers: Record<string, string> }, body: string): boolean {
  const expectedSignature: Buffer = crypto.createHmac("sha256", process.env.HMAC_KEY as string).update(body).digest();
  const supplied: Buffer = Buffer.from(request.headers["x-signature"] || "", "hex");
  return supplied.length === expectedSignature.length && crypto.timingSafeEqual(supplied, expectedSignature);
}

function sign(body: string, payload: object): unknown[] {
  const mac: string = crypto.createHmac("sha256", process.env.HMAC_KEY as string).update(body).digest("hex");
  const embedded = crypto.createCipheriv("aes-256-gcm", Buffer.from(process.env.DATA_KEY as string, "hex"), crypto.randomBytes(12));
  const token: string = jwt.sign(payload, process.env.JWT_SECRET as string);
  return [mac, embedded, token];
}

function newTokens(): string[] {
  const resetToken: string = crypto.randomBytes(32).toString("hex");
  const apiKey: string = crypto.randomBytes(32).toString("base64url");
  return [resetToken, apiKey];
}
