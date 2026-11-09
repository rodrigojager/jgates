# JGates: os dois gates e a sequência

O JGates V2 tem dois gates que você escolhe de forma independente. O **Quality** é determinístico e não gasta tokens:
os adaptadores, mascotes e resultados que você já conhece. O **Semantic** é raciocínio e investigação por modelo, com
execuções, histórico, telas e mascotes próprios. Escolher os dois cria duas execuções distintas, nunca uma execução com
dois veredictos.

## Escolhendo os gates

O padrão é só o Quality. A escolha fica em `selection.gates` do `jgates.yml` (ou de um perfil) e pode ser trocada em uma
execução:

```bash
jgates run --gates quality --dry-run
jgates run --gates quality,semantic --dry-run
jgates run --gates semantic --dry-run
```

`--dry-run` mostra o plano da sequência sem executar nada: quais gates rodam, de onde veio cada escolha e, para o
Semantic depois do Quality, se o pré-requisito do Quality seria atendido. A interface mostra o mesmo plano nas telas de
validação (escolha do gate) e na visão da sequência.

## Identidade das execuções e sequências

- Execuções Quality são `run_...`, execuções Semantic são `sem_...` e uma sequência é `seq_...`. Um ID de execução nunca
  serve aos dois gates.
- Uma sequência é um pequeno registro de coordenação que liga as referências das execuções em ordem. Ela nunca reescreve
  a decisão de nenhuma das execuções.
- O Semantic nunca sobrescreve um resultado do Quality. O bloco consultivo `result.semantic` que `jgates run --semantic`
  grava continua funcionando como antes.
- Semantic sozinho funciona sem nenhum histórico do Quality.

## Quando o Semantic começa depois do Quality

O Semantic começa automaticamente só depois de uma aprovação do Quality completa, atual e não reduzida. Caso contrário a
sequência para com um código de motivo e a execução Semantic não é criada: `QUALITY_FAILED`, `QUALITY_INCOMPLETE`,
`QUALITY_REDUCED`, `QUALITY_INVALID`, `QUALITY_CANCELLED`, `QUALITY_ERROR`, `QUALITY_TIMEOUT`, `QUALITY_PARTIAL`,
`SOURCE_CHANGED`, `SOURCE_UNVERIFIABLE`, `QUALITY_SCOPE_*`, `SEMANTIC_SETTINGS_CHANGED` e `QUALITY_COVERAGE_MISSING`.

```bash
jgates run --gates quality,semantic --manual-advance
jgates run --advance <sequence-id>
jgates run --gates quality,semantic --reuse-quality
```

- `--manual-advance` roda o Quality e espera: a sequência fica aberta até você avançar com `--advance` (ou pela
  interface).
- `--reuse-quality` reaproveita uma execução Quality anterior em vez de rodar o Quality de novo, só quando ela ainda é
  atual para a mesma fonte e escopo; a sequência registra essa procedência.
- `--advance` continua uma sequência em espera quando o pré-requisito é atendido.

## Execuções Semantic

```bash
jgates semantic methods
jgates semantic plan --method general-review --rigor standard
jgates semantic run --scope selected --path <path> --method security-audit --rigor deep
jgates semantic status <run_id>
jgates semantic history
jgates semantic cancel <run_id>
```

- `plan` mostra o que rodaria (escopo, método, orçamento, bloqueios) e não gasta nada. `run` executa.
- `status`, `history` e `cancel` atuam só em execuções Semantic. Cancelar para apenas os processos que a execução
  iniciou e mantém a evidência parcial.
- Use `--events-jsonl` para receber eventos em linhas JSON, `--run-id` para escolher uma execução e
  `--quality <run_id|latest>` para anexar uma execução Quality como evidência.

### Escopo

O escopo diz quais arquivos são o assunto da revisão. Ele é independente do rigor e do orçamento, e nunca é ampliado em
silêncio.

| Modo | Flags | Significado |
| --- | --- | --- |
| `full-recommended` | `--scope full-recommended` | A revisão recomendada do projeto inteiro. |
| `selected` | `--scope selected --path <p> --subsystem <s> --exclude <p>` | Só os caminhos ou subsistemas que você nomear. |
| `incremental` | `--scope incremental --base <ref> --target <ref> --dirty --baseline` | O que mudou entre duas referências, com ou sem alterações não commitadas; `--baseline` herda a cobertura de uma execução limpa anterior. |

Sem `--baseline`, a cobertura herdada aparece como `NO_BASELINE`. A conclusão do escopo é informada separadamente da
cobertura do repositório.

### Contexto, métodos, rigor e orçamento

- Contexto: `--context-policy`, `--context-max-files`, `--context-max-depth`, `--context-max-bytes` e
  `--allow-context <path>` controlam até onde a revisão pode ler além dos assuntos. Toda recusa e expansão é registrada.
- Os métodos são a única escolha do que roda: `--method <id>[,<id>]` (veja [os métodos Semantic](semantic-methods.pt-BR.md)).
  As telas os oferecem como caixas de seleção, com Revisão geral marcada por padrão e ao menos um obrigatório; cada
  método escolhido roda como sua própria revisão, em ordem. `--purpose general-review|security` é apenas um atalho que
  seleciona os métodos desse propósito (`--purpose security` equivale a `--method security-audit`); com os dois, os
  métodos vencem.
- `--rigor quick|standard|deep` define quanto do orçamento é reservado à validação antes da caça.
- `--budget-calls` e `--budget-tokens` limitam chamadas e tokens. Um orçamento esgotado antes da validação necessária
  deixa a execução incompleta, nunca favorável.

Saída de modelo ausente, malformada ou inacabada é inválida ou incompleta, nunca uma aprovação. Severidade, estado de
confirmação (`confirmed`, `needs-validation`, `rejected`), completude da execução e cobertura são campos separados.

## Regressões geradas

Os métodos podem propor um teste que teria pegado um achado. Essas propostas nunca são aplicadas sozinhas:

```bash
jgates regressions list
```

`jgates regressions show <id>` e `jgates regressions validate <id>` inspecionam e validam uma proposta em um sandbox;
`jgates regressions incorporate <id> --approve` a adiciona às verificações Quality do projeto, e somente com
`--approve`.

## A área Semantic e seus mascotes

O `jgates ui` tem uma área Semantic separada (telas de histórico, configuração, preparação, execução e resultados) e
quatro mascotes de IA: Scout, Tracker, Challenger e Verifier. Os seis mascotes do Quality nunca mostram trabalho de IA e
os mascotes de IA nunca mostram um domínio do Quality. Veja [os mascotes Semantic](semantic-mascots.pt-BR.md).
