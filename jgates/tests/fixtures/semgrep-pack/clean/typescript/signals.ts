// Uses none of the technologies the JavaScript/TypeScript signal rules cover. Words like graphql, jwt, ldap, mail or
// zip appear only in comments and strings. Never run.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NOTES: string = "we do not use graphql, jsonwebtoken, ldapjs, nodemailer, multer or adm-zip";

export interface Item {
  price: number;
  count: number;
}

export function total(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.count, 0);
}

export function readNotes(dir: string): string {
  return readFileSync(join(dir, "notes.txt"), "utf8") + NOTES;
}
