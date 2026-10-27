# JGates: CI

No CI as regras não são decididas pelo código que está sendo verificado. O `jgates ci` pega as regras de um **repositório de políticas** mantido por quem controla o pipeline, amarrado por um hash, e recusa tudo o que um job poderia usar para afrouxar o gate. Esta página explica o modelo, como montar a política, o que o `jgates ci` recusa ou considera menos confiável, e como proteger o pipeline no GitLab e no GitHub.

## O modelo

- **Localmente** você edita tudo: `jgates.yml`, perfis, templates, waivers. É a sua área de trabalho, e o `jgates run` a obedece.
- **No CI** só quem controla o pipeline define as regras. A configuração vem da pasta da política (`--policy` ou `JGATES_POLICY_DIR`), e o `jgates.yml` e o `.jgates/` do próprio projeto nunca são lidos.
- A política é amarrada por `JGATES_POLICY_SHA256`, uma variável protegida do CI. Se o hash da pasta da política for diferente, nada roda (saída 3).
- O commit é analisado numa cópia limpa, então arquivos que não estão no commit não contam.

## Montar o repositório de políticas

O repositório de políticas é um repositório comum com os mesmos arquivos de um projeto: `jgates.yml`, `.jgates/profiles.yml` e, se quiser, `.jgates/quality-policy.json` e `.jgates/waivers.json`. Para criá-lo e editá-lo, abra a interface sobre a pasta:

```bash
jgates ui --policy <policy-folder>
```

Nesse modo as telas Configuração e Ferramentas salvam na pasta da política, e a tela Política de CI (`#/policy`) mostra o hash, os arquivos que entram nele e os trechos prontos para GitHub Actions e GitLab CI. Dicas:

- Dê aos templates da política a ativação `always`. Um template ativado por arquivo deixa o projeto ligar ou desligar a ferramenta adicionando ou removendo esse arquivo.
- Defina na política os perfis que o CI pode usar; o `--profile` só aceita esses.
- A pasta da política não pode ter links simbólicos, e todo arquivo que a configuração cita precisa estar dentro dela.

## Atualizar o hash

Toda mudança na política muda o hash. Depois de integrar a mudança no repositório de políticas, copie o novo hash da tela Política de CI para a variável protegida `JGATES_POLICY_SHA256` (variável do repositório, do grupo ou da organização). Enquanto os dois forem diferentes, os jobs falham com `POLICY_HASH_MISMATCH`, que é o comportamento desejado: uma política alterada sem o dono do pipeline saber não roda.

## Rodar no CI

Os exemplos em `examples/ci` são o que a tela da política gera:

- `examples/ci/github-actions.yml` para o GitHub Actions;
- `examples/ci/gitlab-ci.yml` para o GitLab CI.

O comando é o mesmo nos dois:

```bash
jgates ci --policy <policy-folder> --sarif jgates.sarif
```

A política é obtida **fora** do projeto: no GitHub, dois passos `actions/checkout` (`path: project` e `path: policy`) e o comando roda em `project`; no GitLab, o projeto é `$CI_PROJECT_DIR` e a política é clonada em `$CI_BUILDS_DIR`. Uma política dentro do projeto analisado é recusada com `POLICY_INSIDE_PROJECT`.

Outras opções: `--head <commit>` (padrão: o HEAD do checkout), `--scope full|changed` (no CI o `changed` é ampliado para o commit inteiro), `--base <ref>`, `--profile <id>`, `--out <folder>`, `--fail-fast` e `--events-jsonl <file>`. Códigos de saída: 0 passou, 1 falhou, 2 incompleto, 3 opção recusada ou problema na política, 4 erro interno, 130 cancelado.

### Instalar o JGates no job

O JGates não é publicado em nenhum registro. Instale a partir do repositório, numa pasta fora do projeto analisado, e coloque a pasta de executáveis dela no `PATH` do job:

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates ci --policy <policy-folder>
```

No GitHub Actions, os exemplos instalam em `$RUNNER_TEMP/jgates` e acrescentam `$RUNNER_TEMP/jgates/node_modules/.bin` ao `$GITHUB_PATH`, o que vale para os passos seguintes. No GitLab CI, instalam numa pasta em `$CI_BUILDS_DIR`, fora de `$CI_PROJECT_DIR`, e fazem `export PATH=...` no mesmo `script`.

Não use `npm install --global git+https://github.com/rodrigojager/jgates`: numa instalação global de uma dependência git, o npm liga os comandos a um clone temporário que ele mesmo apaga, e o `jgates` some (veja [limitações](limitacoes.pt-BR.md)). Para jobs reproduzíveis, fixe uma tag ou um commit depois do `#`, ou guarde o tarball (`npm pack`) num armazenamento interno e instale esse arquivo; um tarball pode ser instalado com `--global`.

## O que o `jgates ci` recusa

Saída 3, antes de qualquer coisa rodar:

- `--skip`, `--only`, `--waiver`, `--no-cache`, `--plan`, `--path` e `--template`: o job não escolhe as próprias regras;
- `--bridge-mode quick` ou `offline`, e `--scope paths`;
- uma política sem `JGATES_POLICY_SHA256`, com hash diferente, com links simbólicos ou com referências fora da sua pasta;
- uma política de qualidade que desliga ou afrouxa os orçamentos obrigatórios;
- um commit com submódulo (gitlink) ou com link simbólico que aponta para fora do checkout.

O que não entra no `jgates ci` é a sua configuração pessoal: ele não lê nem grava o [cofre de chaves do usuário](seguranca.pt-BR.md#o-cofre-de-chaves-do-usuário) nem as [preferências e conexões de providers](semantic-gate.pt-BR.md#preferências-e-conexões). A revisão semântica no CI usa as chaves de API do ambiente do pipeline e os ajustes de provider do projeto ou da política.

## O que vem autodeclarado

Alguns resultados dependem de código que o projeto controla, então não são confiáveis:

| Confiança | Significado |
| --- | --- |
| trusted | A ferramenta lê o código sem executá-lo. Conta normalmente. |
| self-reported | A ferramenta executa código do projeto (testes, linters que carregam arquivos do projeto). O resultado vem marcado `selfReported` e só aprova se a política tiver `execution.trustSelfReported: true` (padrão: false). |
| excluded | Ferramentas que leem configuração ou arquivos de ignore da árvore analisada por conta própria. Os scanners nativos (gitleaks, trivy, osv-scanner, checkov, jscpd, dependency-cruiser, import-linter) não rodam por conta própria no `jgates ci`: a ponte do quality gate, endurecida, já os cobre. Do MegaLinter rodam só os linters verificados, os listados como `trusted` ou `self-reported` em `quality-gate/sidecar/config/megalinter-linters.json`; os demais ficam de fora. |

As supressões escritas no código (comentários que silenciam um achado) viram a etapa `jgates-ci.suppressions`, então aparecem no resultado em vez de sumir. Relatórios de cobertura que chegam dentro do commit são recusados, porque foi o projeto que os forneceu.

## Proteger o pipeline

A política só protege se o job que a executa não puder ser removido nem editado pelo projeto.

### GitLab

- Rode o job a partir de um **pipeline de compliance** ou de uma **Pipeline Execution Policy** de grupo, para que um merge request não consiga mudá-lo nem tirá-lo.
- Proteja o arquivo do pipeline: restrinja os branches, defina CODEOWNERS no `.gitlab-ci.yml` e exija a aprovação dos donos.
- Guarde `JGATES_POLICY_SHA256` como variável de grupo protegida, mascarada ou oculta, que só os mantenedores editam.
- Autorize o token de job do projeto a ler o repositório de políticas (lista de permissão do token de job no projeto da política).

### GitHub

- Exija o workflow por um **ruleset** com required workflows na organização, para que ele rode em todo pull request e não possa ser contornado no repositório.
- Coloque o arquivo do workflow sob **CODEOWNERS** e exija a revisão dos donos.
- Guarde `JGATES_POLICY_SHA256` como variável da organização, e dê ao token que lê o repositório de políticas acesso somente de leitura.
- Mantenha `permissions` mínimo: `contents: read`, e `security-events: write` só para enviar o SARIF.
