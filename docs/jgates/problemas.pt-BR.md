# JGates: problemas comuns

Cada erro do JGates traz um código (`error.code`), uma mensagem e uma instrução de correção (`error.fix`). Esta página junta os mais frequentes. Em dúvida, comece pelo diagnóstico:

```bash
jgates doctor
```

O `doctor` mostra os runtimes (Node, Python, Git, Docker), cada ferramenta do plano (pronta, ausente ou em versão incompatível), a preparação e, para o que falta, se é essencial, opcional (com a alternativa) ou não usada, com a receita que instala. Num terminal ele oferece instalar; sem terminal e sem `--fix` ele só lê e sai com 0 (veja [primeiros passos](primeiros-passos.pt-BR.md)).

## O run terminou "incompleto" (saída 2)

Incompleto não é reprovado: significa que faltou evidência. Olhe o motivo de cada etapa no resultado.

- **`TOOL_UNAVAILABLE`.** A ferramenta não está instalada ou está fora da faixa de versão do adaptador. A mensagem traz o comando, e `jgates doctor --fix` oferece a receita. Para as regras do Semgrep, use `jgates tools prepare --instance <id>`; para o Docker, veja se o daemon está de pé.
- **Etapa `blocked`.** Falta um binário, um arquivo de configuração (o ESLint sem `eslint.config`, por exemplo) ou o provedor de cobertura (`@vitest/coverage-v8`, `pytest-cov`). A cobertura não medida é "não medida", nunca 0%.
- **`INPUTS_CHANGED`.** Um arquivo analisado mudou durante o run. Execute de novo sem mexer no código.
- **Cobertura de arquitetura parcial.** O grafo de imports não resolveu uma dependência (um alias, por exemplo). Isso é lacuna de cobertura, nunca aprovação: ajuste a configuração do alias.

## Instalar o que falta

- **O quality gate aparece ausente, mas o Python está lá.** O Python achado não tem os pacotes do quality gate (`defusedxml`, `tomlkit`). O `jgates doctor --fix` cria o ambiente do JGates (`<JGATES_HOME>/tools/python`) com eles, e a ponte passa a usá-lo.
- **`python -m venv` falha.** No Debian e no Ubuntu o módulo `venv` vem num pacote à parte: instale o `python3-venv` e rode o `doctor --fix` de novo.
- **"Instalação automática indisponível".** O texto diz o motivo: falta um Python 3.11 ou mais novo para criar o ambiente; a variável `JGATES_PYTHON`, `JGATES_RUFF` ou `JGATES_SEMGREP` escolhe o executável (instale nele, ou tire a variável); a imagem precisa do Docker funcionando; ou o sistema não é um dos que o JGates sabe instalar o Docker (o texto aponta as instruções oficiais).
- **Em CI ou num script.** Sem terminal o `doctor` não pergunta: `jgates doctor --fix --yes` instala as essenciais, e `--include-optional` as opcionais. O Docker nunca é instalado assim: o comando do sistema espera um "s" no terminal.
- **O Docker foi instalado, mas o `docker` pede `sudo`.** No Linux, o seu usuário precisa entrar no grupo `docker` (`sudo usermod -aG docker $USER` e uma nova sessão). O JGates não faz isso por você.
- **Um run que terminou por falta de ferramenta.** Num terminal (sem `--json`, `--ci` ou `--no-interactive`), o `jgates run` lista o que faltou, oferece as mesmas receitas do `doctor` e, depois de instalar, pergunta se roda de novo. Fora dele, não pergunta nada, o código de saída é o de antes e a mensagem aponta `jgates doctor --fix`. O `quality-gate` rodado direto, sem Docker e com o sidecar local sem uma ferramenta, oferece num terminal instalá-la (pelo `jgates doctor --fix`, quando o `jgates` está no `PATH`) ou tentar o Docker; fora dele, mostra o erro de antes mais a dica. O sidecar local procura o Python nesta ordem: `JGATES_PYTHON`, `PYTHON`, o ambiente do JGates, o `PATH`.
- **Desfazer.** O ambiente do JGates é só uma pasta: apagar `<JGATES_HOME>/tools/python` volta ao que era antes (o `PATH` e o Python do sistema nunca foram tocados).

## O plano é recusado (saída 3)

- **`PLAN_EMPTY`.** Nada foi selecionado. Revise o perfil, o escopo e `--only`.
- **`PLAN_NOT_APPROVABLE`.** O plano tem um bloqueio (`CONFIG_INVALID` com `arquivo:linha`, um requisito sem cobertura, `EVIDENCE_MISSING` num comando genérico). Rode `jgates plan` e leia "Como resolver".
- **`PLAN_STALE`, `PLAN_TAMPERED`.** Um plano salvo (`--plan`) não bate mais com o projeto ou foi alterado. Gere o plano de novo.
- **`PLAN_WITH_FLAGS`.** `--plan` não combina com as flags que montam o plano.
- **`OPTION_NOT_SUPPORTED`.** Num projeto com `jgates.yml`, as flags antigas (`--bridge-mode` e semelhantes) não valem; escolha pelo perfil, `--skip` ou `--only`.
- **`CONFIG_EXISTS`.** Já há configuração. O `jgates init` não sobrescreve.

```bash
jgates config validate
jgates plan
```

## A configuração não salva

- **`REVISION_CONFLICT`.** O arquivo mudou no disco desde que você o abriu. A interface mostra a versão base, a sua e a atual; escolha qual manter. Pela CLI, passe o `--if-match` novo.
- **`STRUCTURED_EDIT_UNAVAILABLE`.** O formulário de TOML precisa do Python com o `tomlkit`; sem ele, o texto continua editável.
- **`GOVERNED_LOCKED`.** O servidor detectou o modo governado (`JGATES_POLICY_DIR`). A edição é bloqueada de propósito.
- **Edição visual recusada em JS.** Uma configuração dinâmica (função, spread, import calculado) só pode ser editada como texto.

## A interface

- Peça o link novo com `jgates ui`; o link de entrada é de uso único e vale 10 minutos. O servidor responde só no loopback, e um proxy ou um nome de host diferente recebe 421.
- Um run por vez: o segundo recebe 409 enquanto o primeiro não termina.
- Os controles marcados como indisponíveis e o filtro por componente que não aparece estão em [limitações](limitacoes.pt-BR.md).

## Espaço em disco e cache

- Rode `jgates gc --dry-run` para ver o que a retenção apagaria (veja [pasta de dados](pasta-de-dados.pt-BR.md)).
- Um resultado "reaproveitado" de uma execução anterior vem do cache. Para forçar a execução real, use `jgates run --no-cache`.

## Windows e macOS

O Windows ainda não foi testado e o macOS não foi testado em máquina real (veja [limitações](limitacoes.pt-BR.md)). Se algo falhar, anote o comando, o `runId` e a saída de `jgates doctor`.
