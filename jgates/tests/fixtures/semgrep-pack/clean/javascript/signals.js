// Uses none of the technologies the JavaScript signal rules cover. Words like graphql, jwt, ldap, mail or zip
// appear only in comments and strings. Never run.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const NOTES = "we do not use graphql, jsonwebtoken, ldapjs, nodemailer, multer or adm-zip";

export function digestOf(file) {
  const text = fs.readFileSync(path.resolve(file), "utf8");
  return createHash("sha256").update(text).digest("hex");
}

export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.count, 0);
}

export const label = `${NOTES.length} characters of notes`;
