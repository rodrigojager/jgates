import * as jwt from "jsonwebtoken";
import * as https from "https";
import * as fs from "fs";

export function verifyWithHeaderKey(token: string, done: jwt.VerifyCallback): void {
  jwt.verify(token, (header: jwt.JwtHeader, cb: jwt.SigningKeyCallback) => fetchKey(header.jku, cb), { audience: "api" }, done);
}

export function verifyLong(token: string, secret: string): unknown {
  return jwt.verify(token, secret, { audience: "api", ignoreExpiration: true });
}

export function verifyAnyAudience(token: string, secret: string): unknown {
  return jwt.verify(token, secret, { algorithms: ["HS256"] });
}

export function authorizeUrl(clientId: string): string {
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://app.example.com/cb" });
  return "https://idp.example.com/authorize?" + query.toString();
}

export function startServer(app: https.RequestListener): https.Server {
  return https.createServer({ cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem"), minVersion: "TLSv1", ciphers: "HIGH:RC4-SHA" }, app);
}

export async function loadProfile(id: string): Promise<unknown> {
  const res = await fetch("http://profiles.example.com/api/" + id);
  return res.json();
}

export function startMutualServer(app: https.RequestListener): https.Server {
  return https.createServer({ requestCert: true, rejectUnauthorized: false, cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem") }, app);
}
