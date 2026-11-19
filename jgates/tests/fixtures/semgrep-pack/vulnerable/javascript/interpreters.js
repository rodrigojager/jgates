const ldap = require("ldapjs");
const xpath = require("xpath");
const ejs = require("ejs");
const libxmljs = require("libxmljs2");
const libxslt = require("libxslt");
const { execSync } = require("child_process");
const express = require("express");

const app = express();
const mailer = { deliver(text) {} };
const directory = ldap.createClient({ url: "ldaps://directory.internal" });

app.get("/people", (req, res) => {
  directory.search("ou=people,dc=example", { filter: "(uid=" + req.query.user + ")" }, () => {});
  res.sendStatus(204);
});

app.get("/accounts", (req, res) => {
  const doc = {};
  const found = String(xpath.select("//account[@name='" + req.query.name + "']", doc));
  res.sendStatus(found.length ? 200 : 404);
});

app.post("/page", (req, res) => {
  const page = ejs.render(req.body.template, { user: "guest" });
  res.sendStatus(page ? 200 : 204);
});

app.post("/import", (req, res) => {
  libxmljs.parseXml(req.body.xml, { noent: true });
  res.sendStatus(204);
});

app.post("/report", (req, res) => {
  libxslt.parse(req.body.stylesheet, () => {});
  res.sendStatus(204);
});

function buildPdf() {
  execSync("pdflatex -shell-escape report.tex");
}

app.post("/notify", (req, res) => {
  const message = "To: " + req.body.to + "\r\nSubject: Notice\r\n\r\nHello";
  mailer.deliver(message);
  res.sendStatus(204);
});
