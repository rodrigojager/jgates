import util from "util";
import markdownit from "markdown-it";
import Papa from "papaparse";
import Memcached from "memcached";

export function exportData(req: any): { decoded: string; url: string; json: string } {
  const client = new Memcached("localhost:11211");
  client.get(req.query.key, callback);
  Papa.unparse([[req.body.name]]);
  const decoded: string = decodeURIComponent(decodeURIComponent(req.query.value));
  const url: string = "https://example.com/?q=" + req.query.term;
  const json: string = '{"name":"' + req.body.name + '"}';
  return { decoded, url, json };
}

export function findUsers(req: any, res: any): void {
  const matcher: RegExp = new RegExp(req.query.term);
  res.json(users.filter((u: { name: string }) => matcher.test(u.name)));
}

export const slug: RegExp = /^(\w+)+$/;

export function audit(req: any): void {
  util.format(req.query.message, "audit");
}

export const renderer = markdownit({ html: true });
