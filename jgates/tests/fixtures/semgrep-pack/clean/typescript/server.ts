import { execFile } from "child_process";
import jwt from "jsonwebtoken";

export function ping(host: string): void {
  execFile("ping", [host]);
}

export function claims(token: string, secret: string): unknown {
  return jwt.verify(token, secret, { algorithms: ["HS256"], audience: "orders-service" });
}
