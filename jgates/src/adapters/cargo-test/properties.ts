// Finds the proptest property tests of a Rust crate. libtest does not say how a test was generated, so the .rs files
// are read (never compiled or executed): a function declared inside a `proptest! { ... }` block, or carrying a
// `#[proptest]` attribute (the test-strategy / proptest-attr-macro style), is a property test. Detection is static and
// fail-closed: a file that cannot be read contributes no property test, never a guessed one.
import fs from "node:fs";
import path from "node:path";

export interface PropertyScan {
  /** Property function name -> workspace-relative file that declares it (the first one found). */
  functions: Map<string, string>;
  /** The crate depends on or imports proptest (or test-strategy), even without a property test yet. */
  usesProptest: boolean;
}

const SKIP_DIRS = new Set(["target", "node_modules", ".git", ".jgates"]);
const MAX_FILES = 5000;

/** Blanks comments, string literals and char literals (keeping the length and the newlines), so braces inside them do not count. */
export function stripNoise(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(src[k] === "\n" ? "\n" : " ");
  };
  while (i < n) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if ((c === "r" || (c === "b" && next === "r")) && /^b?r#*"/.test(src.slice(i, i + 12))) {
      const m = /^b?r(#*)"/.exec(src.slice(i, i + 12)) as RegExpExecArray;
      const close = `"${m[1]}`;
      const end = src.indexOf(close, i + m[0].length);
      const j = end === -1 ? n : end + close.length;
      blank(i, j);
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      j = Math.min(n, j + 1);
      blank(i, j);
      i = j;
    } else if (c === "'") {
      // A char literal ('x', '\n', '\u{..}'); a lifetime ('a) has no closing quote right after.
      const m = /^'(?:\\u\{[0-9a-fA-F_]+\}|\\x[0-9a-fA-F]{2}|\\.|[^\\'])'/.exec(src.slice(i, i + 12));
      if (m) {
        blank(i, i + m[0].length);
        i += m[0].length;
      } else {
        out.push(c);
        i++;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

const OPEN = "{([";
const CLOSE = "})]";

/** The functions declared directly inside each `proptest! { ... }` block of a source (already stripped of noise). */
function blockFunctions(clean: string): string[] {
  const names: string[] = [];
  const start = /\bproptest\s*!\s*(?=[{(\[])/g;
  for (let m = start.exec(clean); m; m = start.exec(clean)) {
    const open = m.index + m[0].length;
    const stack: string[] = [];
    let end = -1;
    for (let i = open; i < clean.length; i++) {
      const ch = clean[i] as string;
      if (OPEN.includes(ch)) stack.push(CLOSE[OPEN.indexOf(ch)] as string);
      else if (CLOSE.includes(ch)) {
        stack.pop();
        if (stack.length === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    // Only the functions at the top level of the block: a nested fn inside a test body is not a property test.
    let depth = 0;
    const fn = /\bfn\s+([A-Za-z_]\w*)/y;
    for (let i = open + 1; i < end; i++) {
      const ch = clean[i] as string;
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth--;
      else if (depth === 0 && ch === "f" && clean.startsWith("fn", i) && /\s/.test(clean[i + 2] ?? "") && (i === 0 || !/\w/.test(clean[i - 1] as string))) {
        fn.lastIndex = i;
        const name = fn.exec(clean);
        if (name) {
          names.push(name[1] as string);
          i += name[0].length - 1;
        }
      }
    }
  }
  return names;
}

const ATTRIBUTE_FN = /#\s*\[\s*(?:\w+\s*::\s*)*proptest\b(?:\s*\([^\]]*\))?\s*\](?:\s*#\s*\[[^\]]*\])*\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/g;

/** The property functions of one Rust source: those in proptest! blocks and those with a #[proptest] attribute. */
export function propertyFunctions(source: string): string[] {
  const clean = stripNoise(source);
  const names = new Set(blockFunctions(clean));
  for (let m = ATTRIBUTE_FN.exec(clean); m; m = ATTRIBUTE_FN.exec(clean)) names.add(m[1] as string);
  ATTRIBUTE_FN.lastIndex = 0;
  return [...names];
}

/** Whether a Rust source imports or invokes proptest (or the attribute crate test-strategy). */
export function sourceUsesProptest(source: string): boolean {
  return /\b(?:proptest|test_strategy)\b/.test(stripNoise(source));
}

/** Whether a Cargo.toml lists proptest or an attribute front end of it as a dependency. */
export function manifestUsesProptest(toml: string): boolean {
  return toml.split(/\r?\n/).some((line) => {
    const code = line.replace(/#.*$/, "");
    return /^\s*(?:\[[^\]]*\.)?(?:proptest|test-strategy|test_strategy|proptest-attr-macro)\b/.test(code) || /^\s*\[[^\]]*dependencies\.(?:proptest|test-strategy|proptest-attr-macro)\]/.test(code);
  });
}

function* walk(root: string, budget: { left: number }): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(path.join(root, entry.name), budget);
    } else if (entry.isFile() && (entry.name.endsWith(".rs") || entry.name === "Cargo.toml")) {
      budget.left--;
      yield path.join(root, entry.name);
    }
  }
}

/** Reads the .rs files and Cargo.toml files under `dir` once; `rel` maps an absolute path to the path reported. */
export function scanProperties(dir: string, rel: (abs: string) => string): PropertyScan {
  const functions = new Map<string, string>();
  let usesProptest = false;
  for (const file of walk(dir, { left: MAX_FILES })) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (file.endsWith("Cargo.toml")) {
      if (manifestUsesProptest(text)) usesProptest = true;
      continue;
    }
    if (sourceUsesProptest(text)) usesProptest = true;
    for (const name of propertyFunctions(text)) if (!functions.has(name)) functions.set(name, rel(file));
  }
  return { functions, usesProptest: usesProptest || functions.size > 0 };
}
