import ldap from "ldapjs";
import ldapEscape from "ldap-escape";
import xpath from "xpath";
import ejs from "ejs";
import libxmljs from "libxmljs2";
import libxslt from "libxslt";
import { execSync } from "child_process";
import express, { Request, Response } from "express";

const app = express();
const mailer = { deliver(text: string): void {} };
const directory = ldap.createClient({ url: "ldaps://directory.internal" });

app.get("/people", (req: Request, res: Response) => {
  directory.search("ou=people,dc=example", { filter: ldapEscape.filter`(uid=${req.query.user})` }, () => {});
  res.sendStatus(204);
});

app.get("/accounts", (req: Request, res: Response) => {
  const doc: unknown = {};
  const select = xpath.parse("//account[@name=$name]");
  const found = String(select.select({ node: doc as Node, variables: { name: req.query.name } }));
  res.sendStatus(found.length ? 200 : 404);
});

app.post("/page", (req: Request, res: Response) => {
  const page: string = ejs.render("<p>Hello <%= user %></p>", { user: req.body.user });
  res.sendStatus(page ? 200 : 204);
});

app.post("/import", (req: Request, res: Response) => {
  libxmljs.parseXml(req.body.xml, { noent: false, nonet: true });
  res.sendStatus(204);
});

app.post("/report", (req: Request, res: Response) => {
  libxslt.parseFile("/srv/app/styles/report.xsl", () => {});
  res.sendStatus(204);
});

function buildPdf(): void {
  execSync("pdflatex -no-shell-escape report.tex");
}

app.post("/notify", (req: Request, res: Response) => {
  const message: string = "To: " + req.body.to.replace(/[\r\n]+/g, "") + "\r\nSubject: Notice\r\n\r\nHello";
  mailer.deliver(message);
  res.sendStatus(204);
});
