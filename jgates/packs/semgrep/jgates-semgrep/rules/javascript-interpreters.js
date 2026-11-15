const ldap = require("ldapjs");
const ldapEscape = require("ldap-escape");
const xpath = require("xpath");
const ejs = require("ejs");
const pug = require("pug");
const Handlebars = require("handlebars");
const nunjucks = require("nunjucks");
const libxmljs = require("libxmljs2");
const libxslt = require("libxslt");
const { execSync, spawn } = require("child_process");
const express = require("express");

const app = express();

app.get("/ldap", (req, res) => {
  const client = ldap.createClient({ url: "ldaps://directory.internal" });
  // ruleid: jgates.js.ldap-injection
  client.search("ou=people,dc=example", { filter: "(uid=" + req.query.user + ")" }, () => {});
  // ruleid: jgates.js.ldap-injection
  client.search("ou=people,dc=example", { filter: `(&(uid=${req.body.user})(active=1))` }, () => {});
  // ruleid: jgates.js.ldap-injection
  client.search(`uid=${req.params.id},ou=people,dc=example`, { scope: "base" }, () => {});
  // ok: jgates.js.ldap-injection
  client.search("ou=people,dc=example", { filter: ldapEscape.filter`(uid=${req.query.user})` }, () => {});
  // ok: jgates.js.ldap-injection
  client.search("ou=people,dc=example", { filter: "(uid=" + ldapEscape.filter`${req.query.user}` + ")" }, () => {});
  // ok: jgates.js.ldap-injection
  client.search("ou=people,dc=example", { filter: "(objectClass=person)" }, () => {});
  res.end();
});

app.get("/xpath", (req, res) => {
  const doc = {};
  // ruleid: jgates.js.xpath-injection
  xpath.select("//user[name='" + req.query.name + "']", doc);
  // ruleid: jgates.js.xpath-injection
  xpath.select1(`//user[@id='${req.body.id}']`, doc);
  // ok: jgates.js.xpath-injection
  xpath.parse("//user[name=$name]").select({ node: doc, variables: { name: req.query.name } });
  // ok: jgates.js.xpath-injection
  xpath.select("//user[@active='1']", doc);
  res.end();
});

app.post("/render", (req, res) => {
  // ruleid: jgates.js.template-from-request
  res.send(ejs.render(req.body.template, { user: "x" }));
  // ruleid: jgates.js.template-from-request
  res.send(pug.render(req.query.tpl));
  // ruleid: jgates.js.template-from-request
  const compiled = Handlebars.compile(req.body.source);
  // ruleid: jgates.js.template-from-request
  res.send(nunjucks.renderString(req.body.page, {}));
  // ok: jgates.js.template-from-request
  res.send(ejs.render("<p><%= name %></p>", { name: req.body.name }));
  // ok: jgates.js.template-from-request
  res.send(nunjucks.render("page.html", { name: req.body.name }));
  // ok: jgates.js.template-from-request
  res.send(Handlebars.compile("<p>{{name}}</p>")({ name: req.query.name }));
});

function parse(text) {
  // ruleid: jgates.js.xml-external-entity
  libxmljs.parseXml(text, { noent: true });
  // ruleid: jgates.js.xml-external-entity
  libxmljs.parseXmlString(text, { dtdload: true, nonet: false });
  // ok: jgates.js.xml-external-entity
  libxmljs.parseXml(text, { noent: false, nonet: true });
  // ok: jgates.js.xml-external-entity
  libxmljs.parseXml(text);
}

app.post("/transform", (req, res) => {
  // ruleid: jgates.js.xslt-from-request
  libxslt.parse(req.body.stylesheet, () => {});
  // ruleid: jgates.js.xslt-from-request
  libxslt.parseFile(req.query.file, () => {});
  // ok: jgates.js.xslt-from-request
  libxslt.parse(fixedStylesheet, () => {});
  // ok: jgates.js.xslt-from-request
  libxslt.parseFile("/srv/app/styles/report.xsl", () => {});
});

function build(name) {
  // ruleid: jgates.js.latex-shell-escape
  execSync("pdflatex -shell-escape " + name);
  // ruleid: jgates.js.latex-shell-escape
  spawn("xelatex", ["-interaction=nonstopmode", "--shell-escape", name]);
  // ruleid: jgates.js.latex-shell-escape
  execSync(`lualatex -enable-write18 ${name}`);
  // ok: jgates.js.latex-shell-escape
  execSync("pdflatex -no-shell-escape " + name);
  // ok: jgates.js.latex-shell-escape
  spawn("pdflatex", ["-halt-on-error", name]);
}

app.post("/mail", (req, res) => {
  // ruleid: jgates.js.mail-header-injection
  const a = "To: " + req.body.to + "\r\nSubject: Hello\r\n\r\nBody";
  // ruleid: jgates.js.mail-header-injection
  const b = `Subject: ${req.body.subject}\r\nTo: ops@example.com\r\n\r\nBody`;
  // ok: jgates.js.mail-header-injection
  const c = "To: " + req.body.to.replace(/[\r\n]+/g, "") + "\r\n\r\nBody";
  // ok: jgates.js.mail-header-injection
  const d = "To: ops@example.com\r\n\r\n" + req.body.message;
  res.end(a + b + c + d);
});
