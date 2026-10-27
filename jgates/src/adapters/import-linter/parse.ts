// Parser of the report `lint-imports` prints (Import Linter has no machine-readable output). It is versioned: the
// grammar below is the one of the pinned version (fixtures in tests/fixtures/parsers/import-linter/v2.15-*.txt), and
// it is fail-closed. Anything it does not recognise, a summary that does not add up, a broken contract without its
// details or a report cut short is a problem, never "zero findings".
//
// Grammar (2.15):
//   Contracts banner, "Analyzed N files, M dependencies." + a line of dashes, one "<name> KEPT|BROKEN" line per
//   contract, "Contracts: K kept, B broken."; when B > 0, a "Broken contracts" banner and, per broken contract, its
//   name underlined with dashes, then groups: "<header>:" followed by chains ("- a -> b (l.1, l.3)" plus indented
//   continuation lines for the next links), each ended by a blank line. The report of a broken run ends with a blank line.

export const PARSER_VERSIONS = ["2.15"] as const;

export interface ImportLink {
  from: string;
  to: string;
  /** Lines of the import in the importer, when the tool says them. */
  lines: number[];
}

export interface BrokenGroup {
  /** "a is not allowed to import b" (the tool's own sentence). */
  header: string;
  /** Each chain is one or more consecutive links (the first one starts in the importer). */
  chains: ImportLink[][];
}

export interface ParsedContract {
  name: string;
  status: "kept" | "broken";
  groups: BrokenGroup[];
}

export interface ImportLinterReport {
  ok: boolean;
  /** Why the report could not be interpreted (set when ok is false). */
  problem?: string;
  analyzed?: { files: number; dependencies: number };
  contracts: ParsedContract[];
  kept: number;
  broken: number;
}

const FAIL = (problem: string): ImportLinterReport => ({ ok: false, problem, contracts: [], kept: 0, broken: 0 });

const BANNER = /^-+$/;
const ANALYZED = /^Analyzed (\d+) files?, (\d+) dependenc(?:y|ies)\.$/;
const STATUS = /^(.+) (KEPT|BROKEN)$/;
const FOOTER = /^Contracts: (\d+) kept, (\d+) broken\.$/;
const CHAIN_FIRST = /^- {1,3}(\S+) -> (\S+?)(?: \((l\.\d+(?:, l\.\d+)*)\))?$/;
const CHAIN_NEXT = /^ {2,}(\S+) -> (\S+?)(?: \((l\.\d+(?:, l\.\d+)*)\))?$/;

function link(m: RegExpExecArray): ImportLink {
  const lines = m[3] ? m[3].split(",").map((s) => Number(s.trim().slice(2))) : [];
  return { from: m[1] as string, to: m[2] as string, lines };
}

export function parseImportLinterOutput(text: string): ImportLinterReport {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const peek = (): string | undefined => lines[i];
  const skipBlank = (): void => {
    while (i < lines.length && (lines[i] as string).trim() === "") i++;
  };

  skipBlank();
  if (peek() === undefined) return FAIL("empty output");
  // --- "Contracts" banner
  if (!(BANNER.test(peek() ?? "") && lines[i + 1] === "Contracts" && BANNER.test(lines[i + 2] ?? ""))) return FAIL("the report does not start with the Contracts banner");
  i += 3;
  skipBlank();
  const analyzed = ANALYZED.exec(peek() ?? "");
  if (!analyzed) return FAIL("no 'Analyzed N files, M dependencies.' line");
  i++;
  if (!BANNER.test(peek() ?? "")) return FAIL("the Analyzed line is not underlined");
  i++;
  skipBlank();

  // --- one status line per contract, then the totals
  const contracts: ParsedContract[] = [];
  let footer: RegExpExecArray | null = null;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i++;
      continue;
    }
    footer = FOOTER.exec(line);
    if (footer) {
      i++;
      break;
    }
    const status = STATUS.exec(line);
    if (!status) return FAIL(`unrecognised line in the contracts list: ${JSON.stringify(line.slice(0, 80))}`);
    contracts.push({ name: status[1] as string, status: status[2] === "KEPT" ? "kept" : "broken", groups: [] });
    i++;
  }
  if (!footer) return FAIL("the report has no 'Contracts: K kept, B broken.' line (output cut short?)");
  const kept = Number(footer[1]);
  const broken = Number(footer[2]);
  if (contracts.filter((c) => c.status === "kept").length !== kept || contracts.filter((c) => c.status === "broken").length !== broken) {
    return FAIL("the totals of the report do not match its contract lines");
  }
  const base = { analyzed: { files: Number(analyzed[1]), dependencies: Number(analyzed[2]) }, contracts, kept, broken };

  skipBlank();
  if (broken === 0) {
    if (i < lines.length) return FAIL(`unexpected text after the totals: ${JSON.stringify((lines[i] as string).slice(0, 80))}`);
    return { ok: true, ...base };
  }

  // --- details of the broken contracts
  if (!(BANNER.test(peek() ?? "") && lines[i + 1] === "Broken contracts" && BANNER.test(lines[i + 2] ?? ""))) return FAIL("broken contracts without the Broken contracts section (output cut short?)");
  i += 3;
  const pending = new Set(contracts.filter((c) => c.status === "broken").map((c) => c.name));
  const byName = new Map(contracts.map((c) => [c.name, c]));
  let current: ParsedContract | null = null;
  let group: BrokenGroup | null = null;
  let chain: ImportLink[] | null = null;
  const closeChain = (): void => {
    if (chain && group) group.chains.push(chain);
    chain = null;
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    const next = lines[i + 1];
    if (line.trim() === "") {
      closeChain();
      i++;
      continue;
    }
    // A contract name underlined with dashes of the same length.
    if (next !== undefined && BANNER.test(next) && next.length === line.length && !line.startsWith(" ") && !line.startsWith("-") && byName.has(line)) {
      closeChain();
      current = byName.get(line) as ParsedContract;
      if (current.status !== "broken") return FAIL(`details for the contract ${line}, which the report says is kept`);
      if (!pending.delete(line)) return FAIL(`details for the contract ${line} appear twice`);
      group = null;
      i += 2;
      continue;
    }
    if (!current) return FAIL(`text before the first broken contract: ${JSON.stringify(line.slice(0, 80))}`);
    if (line.endsWith(":") && !line.startsWith("-") && !line.startsWith(" ")) {
      closeChain();
      group = { header: line.slice(0, -1), chains: [] };
      current.groups.push(group);
      i++;
      continue;
    }
    const first = CHAIN_FIRST.exec(line);
    if (first && group) {
      closeChain();
      chain = [link(first)];
      i++;
      continue;
    }
    const more = CHAIN_NEXT.exec(line);
    if (more && chain) {
      chain.push(link(more));
      i++;
      continue;
    }
    return FAIL(`unrecognised line in the details of ${current.name}: ${JSON.stringify(line.slice(0, 80))}`);
  }
  closeChain();
  if (pending.size > 0) return FAIL(`no details for the broken contract(s): ${[...pending].join(", ")} (output cut short?)`);
  for (const c of contracts) {
    if (c.status === "broken" && (c.groups.length === 0 || c.groups.some((g) => g.chains.length === 0))) return FAIL(`the details of ${c.name} are incomplete (output cut short?)`);
  }
  // A broken report ends with two blank lines after the last chain; a line cut in the middle does not. (A cut exactly
  // between two groups cannot be told from the end by the text alone: the run also checks the exit code and truncation.)
  if (!text.replace(/\r\n/g, "\n").endsWith("\n\n\n")) return FAIL("the report does not end where the tool ends it (output cut short?)");
  return { ok: true, ...base };
}
