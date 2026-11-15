import util from "util";
import markdownit from "markdown-it";

export function findUsers(req: any, res: any): void {
  const matcher: RegExp = new RegExp(req.query.term);
  res.json(users.filter((u: { name: string }) => matcher.test(u.name)));
}

export const slug: RegExp = /^(\w+)+$/;

export function audit(req: any): void {
  util.format(req.query.message, "audit");
}

export const renderer = markdownit({ html: true });
