// The parse problems the adapters write in English when a tool's report cannot be read ("the report is not JSON"). They are
// diagnostics of the adapters' own code, not sentences of a catalogue, and they travel as the {problem} or {detail} parameter
// of a message. In Portuguese the translator replaces the known ones inside such a parameter, so a step error never mixes
// languages. "{}" stands for a value (a number, a name) that is kept as it is.

const TABLE: ReadonlyArray<readonly [string, string]> = [
  ["exit {} without a located error in the output", "saída {} sem um erro localizado na saída"],
  ["unexpected exit {} after a finished build", "saída inesperada {} depois de um build concluído"],
  ["unexpected exit {}", "saída inesperada {}"],
  ["build finished but the exit was {}", "o build terminou, mas a saída foi {}"],
  ["exit {} but {} finding(s) are listed", "saída {}, mas há {} achados listados"],
  ["exit {} but {} file(s) are listed", "saída {}, mas há {} arquivos listados"],
  ["exit {} but no finding was listed", "saída {}, mas nenhum achado foi listado"],
  ["exit {} but no unformatted file was listed", "saída {}, mas nenhum arquivo sem formatação foi listado"],
  ["the document has no generalDiagnostics or summary", "o documento não tem generalDiagnostics nem summary"],
  ["a diagnostic has no file or message", "um diagnóstico não tem arquivo nem mensagem"],
  ["a line of the output is not JSON", "uma linha da saída não é JSON"],
  ["a line of the message stream is not JSON", "uma linha do fluxo de mensagens não é JSON"],
  ["no build-finished message in the output", "a saída não tem a mensagem de fim do build"],
  ["the message stream has no build-finished message", "o fluxo de mensagens não tem a mensagem de fim do build"],
  ["the crate did not compile", "o crate não compilou"],
  ["the response is not a PII bridge response", "a resposta não é uma resposta da ponte de dados pessoais"],
  ["findings is not a list", "findings não é uma lista"],
  ["entry {} has no rule, entity, severity, path or message", "a entrada {} não tem regra, entidade, severidade, caminho ou mensagem"],
  ["no libtest summary line (test result: ...) in the output", "a saída não tem a linha de resumo do libtest (test result: ...)"],
  ["the cargo llvm-cov report was not written", "o relatório do cargo llvm-cov não foi escrito"],
  ["not JSON: ", "não é JSON: "],
  ["no data in the llvm-cov export", "a exportação do llvm-cov não tem dados"],
  ["no totals.lines in the llvm-cov export", "a exportação do llvm-cov não tem totals.lines"],
  ["the report is an empty list", "o relatório é uma lista vazia"],
  ["document {} is not an object", "o documento {} não é um objeto"],
  ["document {} has no results or summary object", "o documento {} não tem o objeto results ou summary"],
  ["document {} has failed_checks that is not a list", "o documento {} tem failed_checks que não é uma lista"],
  ["a failed check of document {} has no check_id", "uma verificação reprovada do documento {} não tem check_id"],
  ["the failed check {} has no file", "a verificação reprovada {} não tem arquivo"],
  ["no SARIF file was written", "nenhum arquivo SARIF foi escrito"],
  ["the document has no modules list", "o documento não tem a lista modules"],
  ["module {} has no source", "o módulo {} não tem source"],
  ["a dependency of {} has no module", "uma dependência de {} não tem módulo"],
  ["dependencies of {} is not a list", "as dependências de {} não são uma lista"],
  ["the build did not complete", "o build não terminou"],
  ["the build failed without an error the adapter can read", "o build falhou sem um erro que o adaptador consiga ler"],
  ["no TRX file was written", "nenhum arquivo TRX foi escrito"],
  ["not a TRX TestRun document", "não é um documento TestRun do TRX"],
  ["no coverage.cobertura.xml was written", "nenhum coverage.cobertura.xml foi escrito"],
  ["no lines-covered / lines-valid on the coverage element", "o elemento coverage não tem lines-covered / lines-valid"],
  ["no JSON in the output", "a saída não tem JSON"],
  ["the output is not JSON", "a saída não é JSON"],
  ["not a dotnet list package report (no projects)", "não é um relatório do dotnet list package (sem projetos)"],
  ["no package source was asked for vulnerability data", "nenhuma fonte de pacotes foi consultada para dados de vulnerabilidade"],
  ["a project without a path", "um projeto sem caminho"],
  ["the document is not a list of files", "o documento não é uma lista de arquivos"],
  ["entry {} has no filePath or messages", "a entrada {} não tem filePath nem messages"],
  ["message {} of {} has no text", "a mensagem {} de {} não tem texto"],
  ["the report is not an array of findings", "o relatório não é uma lista de achados"],
  ["finding {} has no RuleID, File or StartLine", "o achado {} não tem RuleID, File nem StartLine"],
  [" was not written", " não foi escrito"],
  ["no go test -json event in the output", "a saída não tem nenhum evento do go test -json"],
  ["not a Go coverage profile (no mode line)", "não é um perfil de cobertura do Go (sem a linha mode)"],
  ["unreadable coverage line: ", "linha de cobertura ilegível: "],
  ["the report is not JSON", "o relatório não é JSON"],
  ["the report has no Issues list", "o relatório não tem a lista Issues"],
  ["an issue of the report has no linter or position", "um problema do relatório não tem linter nem posição"],
  ["the report is not a list", "o relatório não é uma lista"],
  ["an entry of the report has no file or code", "uma entrada do relatório não tem arquivo nem código"],
  ["the graph helper timed out", "o auxiliar do grafo excedeu o tempo"],
  ["the graph helper gave no JSON: ", "o auxiliar do grafo não devolveu JSON: "],
  ["the graph helper answered an unexpected document", "o auxiliar do grafo devolveu um documento inesperado"],
  ["empty output", "saída vazia"],
  ["the report does not start with the Contracts banner", "o relatório não começa com o título Contracts"],
  ["no 'Analyzed N files, M dependencies.' line", "falta a linha 'Analyzed N files, M dependencies.'"],
  ["the Analyzed line is not underlined", "a linha Analyzed não está sublinhada"],
  ["unrecognised line in the contracts list: ", "linha não reconhecida na lista de contratos: "],
  ["the report has no 'Contracts: K kept, B broken.' line (output cut short?)", "falta a linha 'Contracts: K kept, B broken.' no relatório (saída cortada?)"],
  ["the totals of the report do not match its contract lines", "os totais do relatório não batem com as linhas de contrato"],
  ["unexpected text after the totals: ", "texto inesperado depois dos totais: "],
  ["broken contracts without the Broken contracts section (output cut short?)", "contratos quebrados sem a seção Broken contracts (saída cortada?)"],
  ["the report does not end where the tool ends it (output cut short?)", "o relatório não termina onde a ferramenta o termina (saída cortada?)"],
  ["(output cut short?)", "(saída cortada?)"],
  ["the Jest results file was not written", "o arquivo de resultados do Jest não foi escrito"],
  ["coverage-summary.json was not written", "coverage-summary.json não foi escrito"],
  ["not an object", "não é um objeto"],
  ["the report has no duplicates list", "o relatório não tem a lista duplicates"],
  ["duplicate {} has no firstFile or secondFile", "a duplicação {} não tem firstFile nem secondFile"],
  ["the document is not a list of changes", "o documento não é uma lista de mudanças"],
  ["change {} has no id, text or level", "a mudança {} não tem id, texto ou nível"],
  ["the report has no results list", "o relatório não tem a lista results"],
  ["result {} has no source path or packages list", "o resultado {} não tem caminho de origem nem lista de pacotes"],
  ["a package of {} has no name", "um pacote de {} não tem nome"],
  ["the package {} has no vulnerabilities or groups list", "o pacote {} não tem lista de vulnerabilidades nem de grupos"],
  ["a vulnerability of {} has no id", "uma vulnerabilidade de {} não tem id"],
  ["a group of {} has no ids", "um grupo de {} não tem ids"],
  ["report was not written", "relatório não foi escrito"],
  ["report is not a JSON object", "relatório não é um objeto JSON"],
  ["report is not JSON", "relatório não é JSON"],
  ["not a pytest-benchmark report (no benchmarks)", "não é um relatório do pytest-benchmark (sem benchmarks)"],
  ["a benchmark without stats", "um benchmark sem estatísticas"],
  ["a benchmark without a name or a mean", "um benchmark sem nome ou média"],
  ["a test file that is not an object", "um arquivo de teste que não é um objeto"],
  ["a benchmark without tasks", "um benchmark sem tarefas"],
  ["a benchmark task without a name or a mean latency", "uma tarefa de benchmark sem nome ou latência média"],
  ["not a vitest bench report (no testResults, no files)", "não é um relatório do vitest bench (sem testResults nem arquivos)"],
  ["a file without groups", "um arquivo sem grupos"],
  ["a group without benchmarks", "um grupo sem benchmarks"],
  ["no benchmark line and no PASS in the go test output", "a saída do go test não tem linha de benchmark nem PASS"],
  ["BenchmarkDotNet wrote no JSON report", "o BenchmarkDotNet não escreveu relatório JSON"],
  ["not a BenchmarkDotNet report (no Benchmarks)", "não é um relatório do BenchmarkDotNet (sem Benchmarks)"],
  ["a benchmark that is not an object", "um benchmark que não é um objeto"],
  ["the Playwright JSON report was not written", "o relatório JSON do Playwright não foi escrito"],
  ["the Playwright JSON report is not JSON", "o relatório JSON do Playwright não é JSON"],
  ["not a Playwright JSON report (no suites / stats)", "não é um relatório JSON do Playwright (sem suites / stats)"],
  ["the JUnit report was not written", "o relatório JUnit não foi escrito"],
  ["totals without covered_lines or num_statements", "totals sem covered_lines nem num_statements"],
  ["covered_lines is larger than num_statements", "covered_lines é maior que num_statements"],
  ["no totals", "sem totals"],
  ["the document is not a list", "o documento não é uma lista"],
  ["entry {} has no code, message or filename", "a entrada {} não tem código, mensagem ou nome de arquivo"],
  ["the document has no results list", "o documento não tem a lista results"],
  ["result {} has no check_id, path or message", "o resultado {} não tem check_id, caminho ou mensagem"],
  ["the report has no comments list", "o relatório não tem a lista comments"],
  ["a comment of the report has no file or code", "um comentário do relatório não tem arquivo nem código"],
  ["the report is not an object", "o relatório não é um objeto"],
  ["Results is not a list", "Results não é uma lista"],
  ["result {} has no Target", "o resultado {} não tem Target"],
  ["the document is not a list of findings", "o documento não é uma lista de achados"],
  ["no testResults list", "sem a lista testResults"],
  ["no total.lines in the summary", "o resumo não tem total.lines"],
  ["the {} volume is not prepared", "o volume {} não está preparado"],
  ["the output was truncated", "a saída foi truncada"],
  ["output truncated", "saída truncada"],
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [...TABLE]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([english, portuguese]) => {
    let at = 0;
    const source = english
      .split("{}")
      .map(escape)
      .join("([^\\s,;:()]+)");
    const replacement = portuguese.replace(/\{\}/g, () => `$${++at}`);
    return { pattern: new RegExp(source, "g"), replacement };
  });

const cache = new Map<string, string>();

/** The Portuguese text of a parameter that holds a known adapter parse problem; any other text is returned as it is. */
export function localizeTechnical(value: string): string {
  if (value.length > 400 || !/[a-z]{3}/.test(value)) return value;
  const hit = cache.get(value);
  if (hit !== undefined) return hit;
  let out = value;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replacement);
  if (cache.size > 500) cache.clear();
  cache.set(value, out);
  return out;
}
