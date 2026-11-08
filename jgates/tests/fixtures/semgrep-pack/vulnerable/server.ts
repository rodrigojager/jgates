import { exec } from "child_process";
import jwt from "jsonwebtoken";

export function ping(host: string): void {
  exec("ping " + host);
}

export function claims(token: string): unknown {
  return jwt.decode(token);
}
