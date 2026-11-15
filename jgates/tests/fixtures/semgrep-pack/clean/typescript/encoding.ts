import _ from "lodash";
import util from "util";
import markdownit from "markdown-it";

export function findUsers(req: any, res: any): void {
  const matcher: RegExp = new RegExp(_.escapeRegExp(req.query.term));
  res.json(users.filter((u: { name: string }) => matcher.test(u.name)));
}

export const slug: RegExp = /^[\w\s]+$/;

export function audit(req: any): void {
  util.format("%s", req.query.message);
}

export const renderer = markdownit({ html: false });
