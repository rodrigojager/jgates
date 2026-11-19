import * as jwt from "jsonwebtoken";
import * as https from "https";
import * as fs from "fs";

export function verifyWithHeaderKey(token: string, client: KeyClient, done: jwt.VerifyCallback): void {
  jwt.verify(token, (header: jwt.JwtHeader, cb: jwt.SigningKeyCallback) => client.getSigningKey(header.kid, cb), { audience: "api" }, done);
}

export function verifyLong(token: string, secret: string): unknown {
  return jwt.verify(token, secret, { audience: "api", ignoreExpiration: false });
}

export function verifyAudience(token: string, secret: string): unknown {
  return jwt.verify(token, secret, { algorithms: ["HS256"], audience: "api" });
}

export function authorizeUrl(clientId: string, state: string, challenge: string): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://app.example.com/cb",
    state: state,
    code_challenge: challenge,
  });
  return "https://idp.example.com/authorize?" + query.toString();
}

export function startServer(app: https.RequestListener): https.Server {
  return https.createServer({ cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem"), minVersion: "TLSv1.2", ciphers: "ECDHE-RSA-AES128-GCM-SHA256" }, app);
}

export async function loadProfile(id: string): Promise<unknown> {
  const res = await fetch("https://profiles.example.com/api/" + id);
  return res.json();
}

export function startMutualServer(app: https.RequestListener): https.Server {
  return https.createServer({ requestCert: true, rejectUnauthorized: true, ca: [fs.readFileSync("ca.pem")], cert: fs.readFileSync("c.pem"), key: fs.readFileSync("k.pem") }, app);
}
