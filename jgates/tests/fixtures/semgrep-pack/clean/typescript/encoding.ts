import _ from "lodash";
import util from "util";
import markdownit from "markdown-it";
import Papa from "papaparse";
import Memcached from "memcached";
import crypto from "crypto";

export function exportData(req: any): { decoded: string; url: string; json: string } {
  const client = new Memcached("localhost:11211");
  client.get(crypto.createHash("sha256").update(req.query.key).digest("hex"), callback);
  Papa.unparse([[req.body.name]], { escapeFormulae: true });
  const decoded: string = decodeURIComponent(req.query.value);
  const url: string = "https://example.com/?q=" + encodeURIComponent(req.query.term);
  const json: string = JSON.stringify({ name: req.body.name });
  return { decoded, url, json };
}

export function findUsers(req: any, res: any): void {
  const matcher: RegExp = new RegExp(_.escapeRegExp(req.query.term));
  res.json(users.filter((u: { name: string }) => matcher.test(u.name)));
}

export const slug: RegExp = /^[\w\s]+$/;

export function audit(req: any): void {
  util.format("%s", req.query.message);
}

export const renderer = markdownit({ html: false });
