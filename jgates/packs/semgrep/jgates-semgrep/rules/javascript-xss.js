const Handlebars = require("handlebars");
const nunjucks = require("nunjucks");
const React = require("react");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, "");
}

function page(req, res) {
  // ruleid: jgates.js.xss-response-write
  res.send("<h1>" + req.query.name + "</h1>");
  const greeting = `<p>${req.body.comment}</p>`;
  // ruleid: jgates.js.xss-response-write
  res.send(greeting);
  // ok: jgates.js.xss-response-write
  res.send("<h1>" + escapeHtml(req.query.name) + "</h1>");
  // ok: jgates.js.xss-response-write
  res.send("<h1>Welcome</h1>");
}

function widget(el, html, target) {
  // ruleid: jgates.js.xss-dom-html-write
  el.innerHTML = html;
  // ruleid: jgates.js.xss-dom-html-write
  document.write(location.hash);
  // ruleid: jgates.js.xss-dom-html-write
  el.insertAdjacentHTML("beforeend", html);
  // ok: jgates.js.xss-dom-html-write
  el.innerHTML = "<b>fixed</b>";
  // ok: jgates.js.xss-dom-html-write
  el.innerHTML = DOMPurify.sanitize(html);
  // ok: jgates.js.xss-dom-html-write
  el.textContent = html;
}

function view(html) {
  // ruleid: jgates.js.xss-react-dangerously-set-html
  const a = <div dangerouslySetInnerHTML={{ __html: html }} />;
  // ruleid: jgates.js.xss-react-dangerously-set-html
  const b = React.createElement("div", { dangerouslySetInnerHTML: { __html: html } });
  // ok: jgates.js.xss-react-dangerously-set-html
  const c = <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
  // ok: jgates.js.xss-react-dangerously-set-html
  const d = <div dangerouslySetInnerHTML={{ __html: "<hr>" }} />;
  return [a, b, c, d];
}

function engines() {
  // ruleid: jgates.js.xss-template-autoescape-off
  Handlebars.compile("<p>{{name}}</p>", { noEscape: true });
  // ruleid: jgates.js.xss-template-autoescape-off
  nunjucks.configure("views", { autoescape: false });
  // ok: jgates.js.xss-template-autoescape-off
  Handlebars.compile("<p>{{name}}</p>");
  // ok: jgates.js.xss-template-autoescape-off
  nunjucks.configure("views", { autoescape: true });
}
