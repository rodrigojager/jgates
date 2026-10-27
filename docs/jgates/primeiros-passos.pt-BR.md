# JGates: primeiros passos

O JGates valida um repositório antes de uma aprovação: descobre os componentes, monta um plano que você pode revisar, executa as verificações e grava um resultado com a decisão e as evidências. O JGates reúne o quality gate (`quality-gate`) e o semantic gate (`semantic-gate`); o comando principal é o `jgates`.

Esta página leva do zero à primeira validação. As outras páginas desta pasta: [templates e perfis](templates-e-perfis.pt-BR.md), [editor](editor.pt-BR.md), [adaptadores](adaptadores.pt-BR.md) (com a [matriz de compatibilidade](compatibilidade.pt-BR.md)).

## O que você precisa

- Node 22 ou mais novo, Python 3.11 ou mais novo e Git.
- Docker é opcional: só os scanners que rodam em container (Gitleaks, Trivy, OSV-Scanner, Checkov e o MegaLinter da ponte) precisam dele.
- O Linux foi testado. O Windows ainda não foi testado (os testes que dependem dele estão marcados e pulam fora dele), e o macOS não foi testado num Mac real.

## Instalar

O JGates não é publicado no registro do npm: a instalação vem do repositório no GitHub. Numa pasta vazia (ou na pasta do seu projeto):

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates doctor
```

O npm baixa o repositório e roda o script `prepare`, que compila o JGates e a interface; isso leva alguns minutos. A partir daí os comandos são `npx jgates`, `npx quality-gate` e `npx semantic-gate` (ou `node_modules/.bin/...`). Nos exemplos abaixo o `jgates` vem direto, como se estivesse no `PATH`.

Para ter o `jgates` no `PATH` sem depender de um projeto, instale numa pasta própria e coloque a pasta de executáveis dela no `PATH` (no Windows, acrescente `node_modules\.bin` dessa pasta ao `Path`):

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates doctor
```

Para uma instalação global, ou para instalar sem acesso ao GitHub na máquina de destino, empacote um clone e instale o arquivo gerado. Esse é o caminho coberto pelo teste `tests/install.test.js` e pelo script `scripts/smoke-install.mjs`, inclusive em uma pasta com espaço e acentos no caminho:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates doctor
```

Em vez do `--global`, você pode instalar o arquivo dentro do seu projeto (`npm install /caminho/do/clone/jgates-0.3.0.tgz`) e usar `npx jgates`. Para repetir a prova de instalação (por exemplo no Windows), rode `node scripts/smoke-install.mjs` na raiz do clone, com o JGates já compilado (`npm --prefix jgates run build`).

O `npm install --global git+https://github.com/rodrigojager/jgates` **não funciona**: numa instalação global de uma dependência git, o npm liga os comandos a um clone temporário que ele mesmo apaga em seguida. Use a pasta com `--prefix`, a instalação dentro do projeto ou o tarball (veja [limitações](limitacoes.pt-BR.md)).

## Conferir a máquina

```bash
jgates doctor
```

O `doctor` mostra os runtimes (Node, Python, Git, Docker) e, para cada ferramenta do plano, se ela está pronta, ausente ou numa versão incompatível. Para o que falta, ele diz a classificação, tirada da configuração do projeto (`.jgates/tools.yml`):

- **essencial**: uma verificação ligada não roda sem isso, e não há outro runner; o texto mostra também como desligar a verificação numa execução (`jgates run --skip tool:<id>`);
- **opcional**: há alternativa, e o texto diz qual (a imagem preparada no lock quando falta a ferramenta local; a ferramenta local quando falta a imagem ou o Docker), com a linha a mudar no `tools.yml`;
- **não usada**: nenhuma verificação ligada precisa disso.

Cada item que falta traz a receita que o instala, mostrada antes de rodar: o comando, os hosts de rede e onde grava. Num terminal, o `doctor` pergunta primeiro se instala as essenciais e depois, numa pergunta à parte, as opcionais; qualquer resposta que não seja "s" cancela sem instalar. Sem nada essencial faltando ele não pergunta, a não ser com `--fix`:

```bash
jgates doctor --fix
```

- `jgates doctor --fix --yes` instala as essenciais sem perguntar, e `--include-optional` junta as opcionais.
- Com `--json`, `--ci`, `--no-interactive` ou sem terminal, o `doctor` nunca pergunta. O JSON traz, para cada runtime e ferramenta, `classification` (`essential`, `optional`, `unused`), `alternative`, `recipe` (a prévia) e, no topo, a lista `install` com o que falta.
- Sem `--fix` e sem terminal, ele só lê o ambiente (não cria nem a pasta de dados) e sai com 0. Com `--fix`, sai com 1 quando uma instalação que rodou falhou.

As receitas:

- **Pacotes Python** (os pacotes do quality gate, o Ruff e o Semgrep): vão para um ambiente próprio do JGates em `<JGATES_HOME>/tools/python`, criado com `python -m venv` a partir do seu Python 3.11 ou mais novo, sem mexer no Python do sistema. A rede é o PyPI (`pypi.org`, `files.pythonhosted.org`), ou o índice de `PIP_INDEX_URL`. Os adaptadores do Ruff e do Semgrep e a ponte do quality gate procuram as ferramentas ali depois de `JGATES_RUFF`, `JGATES_SEMGREP` e `JGATES_PYTHON` e antes do `PATH`; o Python do projeto (o do pytest) continua sendo o do `PATH`.
- **Imagens e regras**: a mesma preparação de `jgates tools prepare --instance <id>` (veja [adaptadores](adaptadores.pt-BR.md)).
- **Docker**: o JGates mostra o comando oficial do sistema detectado (`apt-get` no Debian e no Ubuntu, `dnf` no Fedora, `brew` no macOS, `winget` no Windows) e só o executa depois de um "s" no terminal; o próprio comando pede o `sudo`, e o `--yes` não vale para ele. Com o Docker instalado e parado, a receita o inicia (`sudo systemctl start docker` no Linux). Num sistema que o JGates não conhece, o texto aponta as instruções oficiais. Os comandos do macOS e do Windows ainda não foram testados nessas máquinas.

O JGates nunca roda `sudo` por conta própria.

## Descobrir e configurar

```bash
jgates discover
jgates init --profile standard --no-interactive
jgates config validate
```

- `discover` lê só os arquivos do projeto (nada é executado) e lista os componentes e as linguagens: no repositório de exemplo, `api` (Python), `web` e `libs/shared` (TypeScript).
- `init` cria `jgates.yml` e `.jgates/profiles.yml` com o perfil que você escolher (`minimal`, `standard` ou `strict`; o padrão é `standard`) e os templates das stacks encontradas. Se já houver configuração, ele recusa com `CONFIG_EXISTS` e não muda nada.
- `config validate` confere sintaxe, schema e referências dos arquivos, e diz o arquivo e a linha de cada problema.

Os arquivos do projeto ficam versionados com o código (`jgates.yml`, `.jgates/*.yml`, `.jgates/lock.json`). O que o JGates produz (runs, caches, ferramentas preparadas, rascunhos) fica na pasta de dados, fora do projeto: `~/.local/state/jgates` no Linux (ou `XDG_STATE_HOME`), `Library/Application Support/jgates` no macOS e `%LOCALAPPDATA%\jgates` no Windows. `JGATES_HOME` troca a pasta.

## Ver o plano e executar

```bash
jgates plan
jgates run
```

O `plan` não instala, não executa e não altera nada. Ele mostra três grupos: o que vai executar (com o comando efetivo e de onde veio cada decisão), o que fica de fora, e os requisitos sem cobertura. Um requisito obrigatório sem nenhuma verificação que o cubra deixa o plano não aprovável.

O `run` executa exatamente um plano. Para executar exatamente o plano que você revisou:

```bash
jgates plan --out ./plano.json
jgates run --plan ./plano.json --no-interactive
```

Se o projeto ou o plano mudou depois de gravado, o `run --plan` recusa (`PLAN_STALE` ou `PLAN_TAMPERED`, saída 3) em vez de executar outra coisa.

### Códigos de saída

| Código | Decisão | Significado |
| --- | --- | --- |
| 0 | `passed` | Todos os requisitos obrigatórios foram cobertos e passaram. |
| 1 | `failed` | Há falha em algum requisito. |
| 2 | `incomplete` | Algo obrigatório não pôde ser provado (ferramenta ausente, cobertura parcial, execução reduzida). Nunca vira aprovado. |
| 3 | `invalid` | Uso ou configuração inválidos; nada foi executado. |
| 4 | erro interno | Falha do próprio JGates. |
| 130 | `cancelled` | A execução foi interrompida. |

## Resultado e histórico

```bash
jgates history
jgates report <runId> --format json
jgates report <runId> --format sarif --out ./relatorio.sarif
```

Cada run grava um `result.json` na pasta de dados. `report --format json` devolve esse arquivo sem alterar um byte, e `--format sarif` gera um SARIF 2.1.0 para ferramentas de revisão de código. `report <runId> --agent-context` gera o resumo seguro para colar em um agente.

## A interface

```bash
jgates ui --no-open
```

O `ui` sobe um servidor local só neste computador (`127.0.0.1`). Ele não imprime o segredo da sessão: o link de entrada, de uso único e com validade de 10 minutos, fica num arquivo da pasta de dados (o campo `launcher` da saída com `--json`). Abra esse arquivo no navegador. Sem `--no-open`, o JGates abre o navegador sozinho.

Telas principais: Visão geral (`#/overview`), Workspace (`#/workspace`), Ferramentas (`#/tools`), Configuração (`#/config`), Ambiente (`#/environment`), Preferências (`#/preferences`, com a tela Providers e chaves em `#/preferences/providers`) e Ajuda (`#/help`). Tudo o que a interface faz tem um comando equivalente.

## Em CI e com agentes

Os comandos aceitam `--json` (um único documento no stdout; o progresso humano vai para o stderr) e `--no-interactive` (nunca espera resposta: dado faltando vira erro com a instrução de correção). O ciclo de um agente é plano, execução, correção e nova execução, sem mudar os critérios; a skill `jgates/skill/SKILL.md` descreve o ciclo. Em um pipeline de CI que impõe as regras, o comando é o `jgates ci`, descrito em [CI](ci.pt-BR.md).

```bash
jgates run --profile standard --scope changed --base main --no-interactive --json
```

Um run com `reduced: true` (algo exigido pelo perfil foi desligado só naquela execução) nunca encerra o ciclo como aprovado. Veja em [templates e perfis](templates-e-perfis.pt-BR.md).
