function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, "");
}

export function hello(req: any, res: any): void {
  res.send("<h1>Hello " + escapeHtml(req.query.name) + "</h1>");
}

export function show(el: HTMLElement, text: string): void {
  el.textContent = text;
}
