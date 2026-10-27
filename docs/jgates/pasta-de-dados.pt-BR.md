# JGates: a pasta de dados

O JGates não grava os seus dados dentro do projeto. Resultados, logs, planos, rascunhos e caches vivem numa **pasta de dados** do usuário. O projeto só recebe o que é configuração (`jgates.yml`, `.jgates/`) e o que você pede para gravar.

## Onde fica

| Sistema | Pasta padrão |
| --- | --- |
| Linux e outros | `$XDG_STATE_HOME/jgates`, ou `~/.local/state/jgates` |
| Windows | `%LOCALAPPDATA%\jgates` |
| macOS | `~/Library/Application Support/jgates` (sem teste em máquina real) |

A variável `JGATES_HOME` troca a pasta, para qualquer sistema. Ela é criada quando é preciso, com permissão só do usuário (`0700` nas pastas e `0600` nos arquivos, em sistemas POSIX).

## O que tem dentro

```text
jgates/
  workspaces.json            registro dos workspaces conhecidos
  preferences.json           tema e idioma (preferências pessoais)
  tools/                     regras e caches de ferramentas (por hash)
  workspaces/<id>/
    runs/<runId>/            result.json, plan.json, logs, events.jsonl, outputs/
    plans/                   o último plano
    drafts/                  rascunhos de edição não salvos
    cache/                   cache de resultados
    snapshots/               cópias temporárias de outro commit
    locks/                   travas
    server/                  arquivos de login da interface
    pii-fix/<fixId>/         originais trocados pelo jgates pii fix (contêm o dado pessoal; 7 dias)
```

O `<id>` do workspace vem do caminho real do projeto. Se você mover o projeto, o histórico antigo continua lá com o id antigo; religue-o com `jgates workspaces relink <idAntigo> --cwd <novo caminho>` e ele passa a aparecer no histórico do novo.

O idioma (português ou inglês) vem de `--locale`, da variável `JGATES_LOCALE` ou das Preferências da interface, que o guardam em `preferences.json`.

## O que o JGates nunca faz

- Não apaga arquivos do seu projeto. Se uma ferramenta criar ou mudar um arquivo no workspace durante o run, o `result.json` lista a mudança (`workspaceChanges`), e quem apaga é você. O único comando que muda arquivos do projeto é o `jgates pii fix`, e só depois da sua confirmação (ou `--yes`), com os originais guardados para o `--undo` (veja [segurança](seguranca.pt-BR.md#dados-pessoais-nos-arquivos-do-projeto)).
- Não apaga caches globais do usuário (o cache do npm, do pip ou do Ruff fora da pasta de dados).
- Não guarda segredos: valores de segredo e de dados pessoais são mascarados antes de gravar. A exceção são os originais do `jgates pii fix`, que precisam do conteúdo para o `--undo`: ficam em `pii-fix/`, com permissão só do usuário, e vencem em 7 dias (`fix.backupRetentionDays` no `.jgates/pii.yml`).

## Ver e limpar

```bash
jgates workspaces list
jgates history --limit 5
jgates gc --dry-run
```

O `gc --dry-run` mostra o que a retenção apagaria, sem apagar. Para apagar de fato, `jgates gc --yes`. A retenção padrão é de 30 dias, 2 GiB por workspace e 10 GiB no total, e protege o run marcado como baseline, os runs preservados e os runs sem resultado final com menos de 1 hora. Ajuste com `--max-age-days`, `--max-workspace-mb` e `--max-total-mb`, ou com as variáveis `JGATES_RETENTION_DAYS`, `JGATES_RETENTION_WORKSPACE_MB` e `JGATES_RETENTION_TOTAL_MB`. A limpeza só mexe dentro de `workspaces/` da pasta de dados. O `gc` também lista os originais vencidos do `jgates pii fix` (`piiFix` no `--json`) e, com `--yes`, os apaga; eles vencem pela data gravada na correção, não pelos limites acima.

A tela de Armazenamento (`#/preferences/storage`) mostra o espaço usado por workspace, deixa religar um workspace movido e apagar artefatos de um run (com confirmação).

## Cache de resultados

Cada etapa tem uma chave feita da versão do JGates, do conteúdo dos arquivos analisados e da configuração. Se a chave não mudou, o resultado anterior é reaproveitado e o `result.json` diz de qual run. Qualquer mudança em um arquivo analisado invalida as etapas (é conservador). Uma etapa que executa código do projeto ou depende da rede nunca é reaproveitada. Para ignorar o cache numa execução, use `jgates run --no-cache` ou `JGATES_NO_CACHE=1`.
