/**
 * Unified diff of two texts by lines (Myers' O(ND) algorithm on the part between the common prefix and suffix).
 * Lines are compared with their line break, so a CRLF/LF change shows up as a change.
 */

export interface DiffOptions {
  oldLabel?: string;
  newLabel?: string;
  /** Context lines around each change (default 3). */
  context?: number;
}

type Op = { kind: " " | "-" | "+"; line: string };

/** Splits text into lines that keep their line break. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Edit distance beyond which the diff of the changed middle is shown as a full replacement (bounds time and memory). */
const MAX_EDIT_DISTANCE = 4000;

/** Shortest edit script between two line arrays; a full replacement when it would cost more than MAX_EDIT_DISTANCE. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const replaceAll = (): Op[] => [...a.map((line) => ({ kind: "-" as const, line })), ...b.map((line) => ({ kind: "+" as const, line }))];
  if (n === 0 || m === 0) return replaceAll();
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is the window [-d, d] of v before step d (index k + d).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) x = v[offset + k + 1] as number;
      else x = (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return replaceAll();
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const vd = trace[d] as Int32Array;
    const at = (k: number) => (k < -d || k > d ? 0 : (vd[k + d] as number));
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY && x > 0 && y > 0) {
      ops.push({ kind: " ", line: a[x - 1] as string });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ kind: "+", line: b[y - 1] as string });
    else ops.push({ kind: "-", line: a[x - 1] as string });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const head: Op[] = a.slice(0, pre).map((line) => ({ kind: " ", line }));
  const tail: Op[] = a.slice(a.length - suf).map((line) => ({ kind: " ", line }));
  return [...head, ...myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)), ...tail];
}

function render(line: string): string[] {
  return line.endsWith("\n") ? [line.slice(0, -1)] : [line, "\\ No newline at end of file"];
}

/** Unified diff ("" when the texts are equal). */
export function unifiedDiff(oldText: string, newText: string, options: DiffOptions = {}): string {
  if (oldText === newText) return "";
  const context = options.context ?? 3;
  const ops = lineOps(splitLines(oldText), splitLines(newText));
  const out: string[] = [`--- ${options.oldLabel ?? "a"}`, `+++ ${options.newLabel ?? "b"}`];
  // Old/new line number (1-based) before each op.
  const pos: Array<{ o: number; n: number }> = [];
  let o = 1;
  let nn = 1;
  for (const op of ops) {
    pos.push({ o, n: nn });
    if (op.kind !== "+") o++;
    if (op.kind !== "-") nn++;
  }
  let i = 0;
  while (i < ops.length) {
    if ((ops[i] as Op).kind === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while changes are close enough to share context.
    for (;;) {
      while (end < ops.length && (ops[end] as Op).kind !== " ") end++;
      let gap = end;
      while (gap < ops.length && (ops[gap] as Op).kind === " ") gap++;
      if (gap < ops.length && gap - end <= context * 2) end = gap;
      else {
        end = Math.min(ops.length, end + context);
        break;
      }
    }
    const slice = ops.slice(start, end);
    const first = pos[start] as { o: number; n: number };
    const oldCount = slice.filter((s) => s.kind !== "+").length;
    const newCount = slice.filter((s) => s.kind !== "-").length;
    const oldStart = oldCount === 0 ? first.o - 1 : first.o;
    const newStart = newCount === 0 ? first.n - 1 : first.n;
    out.push(`@@ -${oldStart}${oldCount === 1 ? "" : `,${oldCount}`} +${newStart}${newCount === 1 ? "" : `,${newCount}`} @@`);
    for (const s of slice) for (const [j, text] of render(s.line).entries()) out.push(j === 0 ? s.kind + text : text);
    i = end;
  }
  return out.join("\n") + "\n";
}
