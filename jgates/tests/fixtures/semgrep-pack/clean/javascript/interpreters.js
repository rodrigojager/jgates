const ldap = require("ldapjs");
const ldapEscape = require("ldap-escape");
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
  directory.search("ou=people,dc=example", { filter: ldapEscape.filter`(uid=${req.query.user})` }, () => {});
  res.sendStatus(204);
});

app.get("/accounts", (req, res) => {
  const doc = {};
  const select = xpath.parse("//account[@name=$name]");
  const found = String(select.select({ node: doc, variables: { name: req.query.name } }));
  res.sendStatus(found.length ? 200 : 404);
});

app.post("/page", (req, res) => {
  const page = ejs.render("<p>Hello <%= user %></p>", { user: req.body.user });
  res.sendStatus(page ? 200 : 204);
});

app.post("/import", (req, res) => {
  libxmljs.parseXml(req.body.xml, { noent: false, nonet: true });
  res.sendStatus(204);
});

app.post("/report", (req, res) => {
  libxslt.parseFile("/srv/app/styles/report.xsl", () => {});
  res.sendStatus(204);
});

function buildPdf() {
  execSync("pdflatex -no-shell-escape report.tex");
}

app.post("/notify", (req, res) => {
  const message = "To: " + req.body.to.replace(/[\r\n]+/g, "") + "\r\nSubject: Notice\r\n\r\nHello";
  mailer.deliver(message);
  res.sendStatus(204);
});
