// ICU-style plural blocks in a message: "{count, plural, one {# test} other {# tests}}". The same syntax and rules as the
// core translator (jgates/src/i18n/index.ts): exactly 1 is "one", everything else (0 included) is "other"; "=N {...}" matches
// that exact number; "#" is replaced by the number; a block with a missing or non-numeric count is left as written.

type Params = Record<string, string | number>;

function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

const PLURAL_HEAD = /\{(\w+),\s*plural,\s*/y;

export function resolvePlurals(template: string, params: Params): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) break;
    PLURAL_HEAD.lastIndex = open;
    const head = PLURAL_HEAD.exec(template);
    const end = head ? closingBrace(template, open) : -1;
    if (!head || end < 0) {
      out += template.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const branches = new Map<string, string>();
    let cursor = open + head[0].length;
    const bodyEnd = end - 1;
    while (cursor < bodyEnd) {
      const label = /\s*(=\d+|\w+)\s*\{/y;
      label.lastIndex = cursor;
      const found = label.exec(template);
      if (!found) break;
      const branchOpen = cursor + found[0].length - 1;
      const branchEnd = closingBrace(template, branchOpen);
      if (branchEnd < 0 || branchEnd > bodyEnd) break;
      branches.set(found[1] as string, template.slice(branchOpen + 1, branchEnd - 1));
      cursor = branchEnd;
    }
    const raw = params[head[1] as string];
    const count = raw === undefined || raw === "" ? NaN : Number(raw);
    out += template.slice(i, open);
    if (Number.isNaN(count) || !branches.has("other")) {
      out += template.slice(open, end);
    } else {
      const chosen = branches.get(`=${count}`) ?? branches.get(count === 1 ? "one" : "other") ?? (branches.get("other") as string);
      out += chosen.replace(/#/g, String(raw));
    }
    i = end;
  }
  return out + template.slice(i);
}
