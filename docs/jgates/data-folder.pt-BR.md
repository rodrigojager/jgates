# JGates: a pasta de dados

O JGates não escreve os dados dele dentro do projeto. Resultados, logs, planos e rascunhos ficam numa **pasta de dados** do usuário, e as partes pesadas (a imagem de ferramentas, a cópia do projeto, as dependências, as bases de vulnerabilidades) ficam no motor de contêineres como volumes e imagens com rótulo. O projeto recebe apenas configuração (`jgates.yml`, `.jgates/`) e o que você pedir para ele escrever.

## Onde fica

| Sistema | Pasta padrão |
| --- | --- |
| Linux e outros | `$XDG_STATE_HOME/jgates`, ou `~/.local/state/jgates` |
| Windows | `%LOCALAPPDATA%\jgates` |
| macOS | `~/Library/Application Support/jgates` (não testado numa máquina real) |

A variável `JGATES_HOME` muda a pasta, em qualquer sistema. Ela é criada quando preciso, com permissão só para o usuário (pastas `0700` e arquivos `0600`, nos sistemas POSIX).

## O que tem dentro

```text
jgates/
  workspaces.json            registro dos workspaces conhecidos
  preferences.json           tema e idioma (preferências pessoais)
  codeql-terms.json          a data em que você aceitou os termos do CodeQL (se aceitou)
  workspaces/<id>/
    runs/<runId>/            result.json, plan.json, logs, events.jsonl, outputs/
    plans/                   o último plano
    drafts/                  rascunhos de edição não salvos
    cache/                   cache de resultados
    snapshots/               cópias temporárias de outro commit
    locks/                   travas
    server/                  arquivos de login da interface
    pii-fix/<fixId>/         originais trocados por jgates pii fix (guardam os dados pessoais; 7 dias)
```

A pasta de uma execução é a única pasta do computador que um contêiner de passo enxerga: ela é montada em `/output`, e o passo escreve os relatórios ali. Nada mais da sua máquina é montado num passo.

O `<id>` do workspace vem do caminho real do projeto. Se você mover o projeto, o histórico antigo continua lá, com o id antigo; religue com `jgates workspaces relink <idAntigo> --cwd <novo caminho>` e ele aparece no histórico do novo.

O idioma (português ou inglês) vem de `--locale`, da variável `JGATES_LOCALE` ou das Preferências da interface, que o guardam em `preferences.json`.

## O que fica no motor de contêineres

Todo objeto tem o rótulo `org.jgates.managed=true`, e os volumes são compartilhados onde faz sentido. Veja [armazenamento e limpeza](storage.pt-BR.md) para a tabela completa, os tamanhos e como removê-los.

- `jgates-<workspace>-src`: a cópia sincronizada do projeto que os passos leem em `/workspace`. Ela é refeita a partir dos seus arquivos; o projeto em si nunca é escrito.
- `jgates-<workspace>-deps-<componente>`: as dependências de cada componente (`jgates deps`).
- `jgates-toolchains` e `jgates-cache`: versões de linguagens e navegadores que os projetos fixam, e os caches de pacotes, compartilhados por todos os workspaces.
- `jgates-data`: as bases de vulnerabilidades, somente leitura para os passos. O `jgates tools update-data` as atualiza e registra quando cada uma foi buscada; uma base mais velha que `execution.dataMaxAgeDays` (7 dias por padrão) ou nunca baixada deixa as verificações que a usam `incomplete` (`DATA_STALE`, `DATA_MISSING`).
- `jgates-codeql`: o bundle do CodeQL, só se você o preparou com `jgates tools prepare-codeql`.

## O que o JGates nunca faz

- Não escreve no seu projeto. Um passo roda numa cópia num volume; se uma ferramenta muda um arquivo ali, a mudança fica na cópia e o `result.json` a lista (`workspaceChanges`). Os arquivos do projeto mudam só pelo que você pede: `jgates init`, o editor e as telas de configuração, `jgates tools add-custom`, e `jgates pii fix`, que pede a sua confirmação (ou `--yes`) e guarda os originais para o `--undo` (veja [segurança](security.pt-BR.md#dados-pessoais-nos-arquivos-do-projeto)).
- Não apaga os caches globais do usuário (o cache do npm, do pip ou do Ruff fora da pasta de dados).
- Não guarda segredos: valores de segredos e de dados pessoais são mascarados antes de gravar. A exceção são os originais do `jgates pii fix`, que precisam do conteúdo para o `--undo`: ficam em `pii-fix/`, legíveis só pelo usuário, e expiram em 7 dias (`fix.backupRetentionDays` no `.jgates/pii.yml`).
- Não remove um objeto do motor que não tenha o rótulo do JGates, nem um que esteja em uso.

## Ver e limpar

```bash
jgates workspaces list
jgates history --limit 5
jgates gc --dry-run
```

`gc --dry-run` mostra o que a retenção apagaria, sem apagar. Para apagar de verdade, `jgates gc --yes`. A retenção padrão é de 30 dias, 2 GiB por workspace e 10 GiB no total, e ela protege a execução marcada como linha de base, as execuções preservadas e as execuções sem resultado final com menos de 1 hora. Ajuste com `--max-age-days`, `--max-workspace-mb` e `--max-total-mb`, ou com as variáveis `JGATES_RETENTION_DAYS`, `JGATES_RETENTION_WORKSPACE_MB` e `JGATES_RETENTION_TOTAL_MB`. A limpeza só mexe em `workspaces/` dentro da pasta de dados. O `gc` também lista os originais vencidos do `jgates pii fix` (`piiFix` no `--json`) e, com `--yes`, os apaga; eles vencem pela data gravada na hora da correção, não pelos limites acima.

O `jgates clean` faz isso e mais (imagens de outras versões, volumes de workspaces que não existem mais), e o `jgates uninstall` remove tudo: veja [armazenamento e limpeza](storage.pt-BR.md). A tela Armazenamento (`#/preferences/storage`) mostra o espaço usado por workspace e por categoria, permite religar um workspace movido e apagar os artefatos de uma execução (com confirmação).

## Cache de resultados

Cada etapa tem uma chave feita da versão do JGates, do conteúdo dos arquivos analisados e da configuração. Se a chave não mudou, o resultado anterior é reaproveitado e o `result.json` diz de qual execução. Qualquer mudança num arquivo analisado invalida as etapas (é conservador). Uma etapa que executa código do projeto ou depende da rede nunca é reaproveitada. Para ignorar o cache numa execução, use `jgates run --no-cache` ou `JGATES_NO_CACHE=1`.
