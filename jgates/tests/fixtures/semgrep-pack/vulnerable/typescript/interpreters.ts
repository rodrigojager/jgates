import ldap from "ldapjs";
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
  directory.search("ou=people,dc=example", { filter: "(uid=" + req.query.user + ")" }, () => {});
  res.sendStatus(204);
});

app.get("/accounts", (req: Request, res: Response) => {
  const doc: unknown = {};
  const found = String(xpath.select("//account[@name='" + req.query.name + "']", doc as Node));
  res.sendStatus(found.length ? 200 : 404);
});

app.post("/page", (req: Request, res: Response) => {
  const page: string = ejs.render(req.body.template, { user: "guest" });
  res.sendStatus(page ? 200 : 204);
});

app.post("/import", (req: Request, res: Response) => {
  libxmljs.parseXml(req.body.xml, { noent: true });
  res.sendStatus(204);
});

app.post("/report", (req: Request, res: Response) => {
  libxslt.parse(req.body.stylesheet, () => {});
  res.sendStatus(204);
});

function buildPdf(): void {
  execSync("pdflatex -shell-escape report.tex");
}

app.post("/notify", (req: Request, res: Response) => {
  const message: string = "To: " + req.body.to + "\r\nSubject: Notice\r\n\r\nHello";
  mailer.deliver(message);
  res.sendStatus(204);
});
