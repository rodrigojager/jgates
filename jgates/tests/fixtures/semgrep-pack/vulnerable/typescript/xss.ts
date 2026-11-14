export function hello(req: any, res: any): void {
  res.send("<h1>Hello " + req.query.name + "</h1>");
}

export function show(el: HTMLElement, html: string): void {
  el.innerHTML = html;
}
