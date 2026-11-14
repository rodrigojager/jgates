import Handlebars from "handlebars";
import nunjucks from "nunjucks";
import React from "react";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, "");
}

export function page(req: any, res: any): void {
  // ruleid: jgates.js.xss-response-write
  res.send("<h1>" + req.query.name + "</h1>");
  const greeting: string = `<p>${req.body.comment}</p>`;
  // ruleid: jgates.js.xss-response-write
  res.send(greeting);
  // ok: jgates.js.xss-response-write
  res.send("<h1>" + escapeHtml(req.query.name) + "</h1>");
  // ok: jgates.js.xss-response-write
  res.send("<h1>Welcome</h1>");
}

export function widget(el: HTMLElement, html: string): void {
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

export function view(html: string): unknown[] {
  // ruleid: jgates.js.xss-react-dangerously-set-html
  const a = React.createElement("div", { dangerouslySetInnerHTML: { __html: html } });
  // ruleid: jgates.js.xss-react-dangerously-set-html
  const b = React.createElement("p", { className: "x", dangerouslySetInnerHTML: { __html: html } });
  // ok: jgates.js.xss-react-dangerously-set-html
  const c = React.createElement("div", { dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(html) } });
  // ok: jgates.js.xss-react-dangerously-set-html
  const d = React.createElement("div", { dangerouslySetInnerHTML: { __html: "<hr>" } });
  return [a, b, c, d];
}

export function engines(): void {
  // ruleid: jgates.js.xss-template-autoescape-off
  Handlebars.compile("<p>{{name}}</p>", { noEscape: true });
  // ruleid: jgates.js.xss-template-autoescape-off
  nunjucks.configure("views", { autoescape: false });
  // ok: jgates.js.xss-template-autoescape-off
  Handlebars.compile("<p>{{name}}</p>");
  // ok: jgates.js.xss-template-autoescape-off
  nunjucks.configure("views", { autoescape: true });
}
