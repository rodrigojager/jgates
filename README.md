# JGates

JGates validates a repository before an approval: it discovers the components, builds a plan you can review, runs the checks and writes a result with the decision and the evidence. The local interface and CI use the same engine.

---

## English

### What it is

JGates is the product; it is made of two gates:

- the **quality gate** (`quality-gate`): deterministic checks, no AI (budgets for file and change size, linters, security scanners, duplication, infrastructure files, test and coverage evidence);
- the **semantic gate** (`semantic-gate`): an optional review by an AI model, which never approves or rejects on its own.

The main command is `jgates`. It runs the quality gate and, when you ask, the semantic gate; it stores each run outside the project, shows the result on the command line and in a local interface, and produces the same result in CI mode. The `quality-gate` and `semantic-gate` commands can also be used directly.

### Components

| Component | What it does | Documentation |
| --- | --- | --- |
| `jgates` | Discovers the project, builds the plan, runs it, keeps the history, opens the interface and runs the governed CI. | [docs/jgates/](docs/jgates/getting-started.en.md) |
| `quality-gate` | The quality gate, used by `jgates` or directly. | [quality-gate/README.md](quality-gate/README.md) |
| `semantic-gate` | The semantic gate, used by `jgates` or directly. | [semantic-gate/README.md](semantic-gate/README.md) |

### Requirements

- Node 22 or newer and Git, to run JGates itself.
- A Docker-compatible container engine on `linux/amd64` (Docker Desktop, Rancher Desktop, Podman Desktop or Docker Engine). Every check runs in a container of one JGates tools image, so no scanner, linter, test runner or language runtime of your project is installed on your machine. Docker Desktop has license terms of its own; read them, or use one of the alternatives.
- About 2 GB to download the tools image and around 6 GB of disk once unpacked, plus the project's dependencies and the vulnerability databases, which also live in the engine (see [storage and cleanup](docs/jgates/storage.en.md)).
- Linux was tested. On Windows 10 with Docker Desktop the first-run flow was checked by hand (see [limitations](docs/jgates/limitations.en.md)). macOS was not tested on a real Mac.

### Installation

JGates is not published to the npm registry; it is installed from the repository on GitHub. In an empty folder or in your project's folder:

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates setup
```

npm downloads the repository and runs the `prepare` script, which compiles JGates and the interface; this takes a few minutes. The commands are then available as `npx jgates`, `npx quality-gate` and `npx semantic-gate`.

To have `jgates` on the `PATH` without depending on a project, install it into a folder of its own and put that folder's executables on the `PATH`:

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates setup
```

For a global installation, or to install on a machine that cannot reach GitHub, pack a clone and install the generated file:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates setup
```

`npm install --global git+https://github.com/rodrigojager/jgates` **does not work**: for a global install of a git dependency, npm links the commands to a temporary clone that it then deletes, so the commands point at nothing. Use one of the forms above (see [limitations](docs/jgates/limitations.en.md)).

`jgates --version` prints the version and, on stderr, the build and its folder: use it to check which installation a terminal runs (a terminal opened before an install keeps its old `PATH`).

To update, run `jgates update`: it asks the repository on GitHub for the newest commit of `main`, says whether there is an update and, after you confirm, installs it the same way this JGates was installed (`--check` only checks, `--yes` installs without asking, `--ref` picks another branch or tag). The interface does the same in About > Updates. JGates never checks on its own: this is the only time it goes online, and only when you ask.

### Getting started

The quickest path is the interface. In the project folder:

```bash
jgates ui
```

On first access it opens the guided setup: it checks Docker and the machine (memory, disk, CPUs) and lets you pick the engine executable (Docker, Podman or another), lists and downloads the JGates tools (in the background, while you go on), describes what it detected in the project, creates `jgates.yml` with the profile you choose and adjust right there (`strict` requires tests and coverage and turns on every other check "where a tool exists": where none does, the check shows as "does not apply here", with the reason and the fix, and never blocks), prepares the dependencies and starts the first validation. The bar at the top lists what the validation still needs (Docker stopped, a folder Git does not trust, tools not downloaded), each with the button that fixes it. Then **New validation**: choose the gate and the target, review the plan (each check that will not run comes with its reason and action) and run. The run screen shows each phase and step, its time and a heartbeat while it works; the result shows one card per check (passed, failed, not applicable...) and one per finding with tool, rule, file and line. Every configuration file has a guided screen that writes one key at a time and keeps your comments, and a YAML editor with live validation; see [the local interface](docs/jgates/local-ui.en.md).

The same from the terminal:

```bash
jgates setup
jgates status
jgates init
jgates plan
jgates run
```

- `setup` prepares the machine: it checks the container engine and the disk, downloads the tools image at the version this JGates pins, creates the shared volumes and downloads the vulnerability databases. It is safe to run again. `status` shows whether the machine is ready (engine, image, data age, dependencies and services of the project, disk). `jgates doctor` keeps its own flow and classifies what the plan is missing; it never installs a tool on your machine.
- `init` discovers the project's components and creates `jgates.yml` and `.jgates/profiles.yml`, which are versioned with the code. The profiles are `minimal`, `standard` and `strict`. The minimum test coverage is the project's own `fail_under` (`pyproject.toml`, `.coveragerc`...) unless the JGates policy sets another.
- `plan` shows what will run, what is left out and the requirements without coverage, without executing anything.
- `run` executes the plan and stores the result and the decision. The exit code tells the decision: 0 approved, 1 failed, 2 incomplete (something required could not be proven; it never becomes approved), 3 invalid usage or configuration, 4 internal error, 130 cancelled. When a run cannot start because the engine or the tools image is not ready, the result is incomplete and names the reason with its action (for example `jgates setup`); nothing is installed on your machine. At a terminal the run shows colors and a live line with the time of the running step; `--plain` prints one line per step (and one a minute while a long step works) for agents and logs. It ends with the file to read to fix: `agent-context.md` in the run folder (the same summary as the interface's "Copy to the agent" button), with `result.json` beside it.

Runs and drafts live in a data folder outside the project (`~/.local/state/jgates` on Linux; `JGATES_HOME` changes the folder), and the tools, the copy of the project and its dependencies live in labeled volumes of the engine. To see the history and export a result, use `jgates history` and `jgates report`. To free space or remove everything JGates created, use `jgates clean` and `jgates uninstall` (see [storage and cleanup](docs/jgates/storage.en.md)). The complete walkthrough is in [getting started](docs/jgates/getting-started.en.md).

The bundled Semgrep pack has four classes: `ERROR`, `WARNING`, ordinary `INFO` (informational findings that do not block
the validation) and **Review**. Review findings appear under **To review**, counted separately, never block or change
the exit code, and never make an ASVS requirement examined. **Mark as reviewed** records a per-occurrence project waiver;
Review alone never produces "approved with N waivers". See [Quality integrations](docs/jgates/quality-integrations.en.md).

### In CI

On your own computer you edit everything: `jgates.yml`, profiles, templates and waivers. In CI the rules do not come from the project being analyzed: `jgates ci` reads the rules from a policy repository, pinned by a hash (`JGATES_POLICY_SHA256`), and analyzes the commit in a clean copy.

```bash
jgates ci --policy <policy-folder> --sarif jgates.sarif
```

The job runs inside the JGates tools image pinned by digest (`container: <registry>/jgates-tools@sha256:<digest>`), so nothing is installed in it. The model, how to build the policy repository, the examples for GitHub Actions and GitLab CI (`examples/ci/github-actions.yml` and `examples/ci/gitlab-ci.yml`), the policy for own images and how to protect the pipeline are in [docs/jgates/ci.en.md](docs/jgates/ci.en.md).

### Semantic gate

The AI review is optional. It runs only when `jgates.yml` configures a provider (the `extensions.semantic-gate` block) and the run asks for the review. In `jgates ui`, the **Semantic (AI)** area asks "Who will do the AI review?" and writes that block for you: it detects the agent CLIs you already have (`claude-code`, `codex-cli`, `gemini-cli`, `opencode`), shows whether each is installed and logged in, and opens the CLI's own login when needed (JGates has no OAuth of its own and never reads the CLI's tokens). By hand, it is:

```bash
jgates run --semantic
```

The configuration keeps only the name of the environment variable that holds the API key, never the value. The key comes from the CLI login (the CLI providers), from the environment variable, or from your own key store, outside every project: store it on the **Semantic (AI) > Providers and keys** screen of `jgates ui` or with `jgates secrets set <NAME>` (the value is read from the terminal, never from an argument, and no output shows it); the environment wins over the store, and `jgates ci` uses only the environment. `jgates providers` keeps your preferences per provider (base URL, default model, key name) and named connections to a gateway such as LiteLLM, which a project uses with `provider: <name>`. Before building the request, JGates masks recognized secrets and personal data in the context, but this masking by patterns does not catch everything. You configure it in the `extensions.semantic-gate.masking` block: which entities are masked, your own patterns, external tools declared in `.jgates/pii.yml` (`tools`), a list of paths allowed in the context (`include`) and what to do on a finding (`onMatch: mask` or `block`). The prompts are files you can show with `semantic-gate prompts`, export with `semantic-gate prompts --export <folder>` and replace or extend per project (`prompts`). The providers table (OpenRouter, OpenAI, Anthropic, Gemini, Ollama, `openai-compatible`, OpenCode and the Codex, Claude Code, Gemini and OpenCode CLIs) and the use of a gateway such as LiteLLM, through the `openai-compatible` provider, are in the semantic gate page. The result is stored next to the decision and does not change it. Details are in [semantic gate](docs/jgates/semantic-gate.en.md) and in the [component README](semantic-gate/README.md). Beyond this advisory block, the Semantic gate also runs on its own, with separate runs, scope modes, methods and history (`jgates semantic`, or `jgates run --gates quality,semantic`): see [the two gates](docs/jgates/gates.en.md).

### Personal data in the project files

So that personal data (CPF, CNPJ, card, phone, or what a tool of yours recognizes) does not reach git, JGates checks and fixes the project files, only through an explicit command; `jgates run` never touches the project:

```bash
jgates pii check --staged
jgates pii fix --dry-run --diff
jgates pii fix --yes
jgates pii fix --undo
jgates hooks install pre-commit
```

`pii check` detects without changing anything (exit 0 clean, 1 with findings, 2 incomplete) and shows files and the count by label, never the value. `pii fix` corrects only through a tool you name in `fix.tools` of `.jgates/pii.yml`: it works on a copy, shows what would change, asks for confirmation (or takes `--yes`), applies file by file only if the file did not change and keeps the originals, which hold the personal data, for 7 days so that `pii fix --undo` can restore them byte for byte. `hooks install pre-commit` is an optional, local Git hook that stops (or fixes) a commit with personal data in the staged files; it never replaces a hook of yours and does nothing when `core.hooksPath` is set (it shows the line to add instead), and `hooks uninstall pre-commit` removes only the hook it wrote. Fixing a file does not clean the git history. Details in [security](docs/jgates/security.en.md#personal-data-in-the-project-files) and in the [data folder](docs/jgates/data-folder.en.md).

### Agents

JGates does not host an agent: it gives one a plan that can be reviewed, a result bound to the state of the code and a safe summary of the failures. The installed JGates carries the skill that teaches the cycle (plan, run, fix, run again, without changing the criteria):

```bash
jgates skill
jgates skill --install <skills-folder>/jgates
```

The first prints it (an agent can read it straight from the terminal); the second copies it as `SKILL.md` into your agent's skills folder (for Claude Code, `~/.claude/skills/jgates`). The shortest instruction for an agent is: *run `jgates skill` and follow it*. In short, the agent runs `jgates run --plain` (or `--json`), reads the `agent-context.md` whose path the run prints at the end, fixes the code and runs again. For the gates used directly, the repository also ships `use-jgates-quality/` (`quality-gate` headless) and `use-jgates-semantic/` (`semantic-gate` headless).

A reduced run (`reduced: true`) or an incomplete one never closes the cycle as approved. See [agents](docs/jgates/agents.en.md).

### Security and limitations

JGates reads and runs tools over code that may not be trusted, and it has a local interface. What it protects, how, and what it does not promise is in [security](docs/jgates/security.en.md). What it does not do yet and what was not tested is in [limitations](docs/jgates/limitations.en.md). JGates sends no telemetry. The governed CI protects the gate against the code author only together with the external policy and a controlled runner.

### Documentation

- [Getting started](docs/jgates/getting-started.en.md)
- [The local interface](docs/jgates/local-ui.en.md)
- [CI](docs/jgates/ci.en.md)
- [Templates and profiles](docs/jgates/templates-and-profiles.en.md)
- [Editor](docs/jgates/editor.en.md)
- [Adapters](docs/jgates/adapters.en.md) and the [compatibility matrix](docs/jgates/compatibility.en.md)
- [Semantic gate](docs/jgates/semantic-gate.en.md)
- [The two gates and their sequence](docs/jgates/gates.en.md), the [Semantic methods](docs/jgates/semantic-methods.en.md) and the [Semantic mascots](docs/jgates/semantic-mascots.en.md)
- [Quality integrations and the capability matrix](docs/jgates/quality-integrations.en.md)
- [The ASVS coverage map](docs/jgates/asvs-coverage.en.md): every OWASP ASVS 5.0.0 requirement in one of five states (`jgates coverage asvs`); it shows what was examined, never that a project meets the standard. A bundled pack of original Semgrep rules for nine kinds of file (JavaScript/TypeScript, Python, Go, C#, Rust, Java, PHP, HTML and configuration files) feeds it with deterministic checks; policy rules appear as informational findings that do not block the validation, the map suggests "not applicable" when a scan finds no sign of a technology, and the opt-in ASVS review adds an AI review, counted apart
- [Project services](docs/jgates/services.en.md)
- [Your own tools and images](docs/jgates/extension.en.md)
- [Storage and cleanup](docs/jgates/storage.en.md)
- [Agents](docs/jgates/agents.en.md)
- [Data folder](docs/jgates/data-folder.en.md)
- [Security](docs/jgates/security.en.md)
- [Limitations](docs/jgates/limitations.en.md)
- [Common problems](docs/jgates/troubleshooting.en.md)
- [Third-party licenses](THIRD_PARTY_NOTICES.md)

### Development

`npm install` builds JGates and `npm test` runs the suites of the root, the semantic gate, the quality gate and JGates. The tests call `python`: use a virtual environment (`python3 -m venv .venv`, `.venv/bin/pip install -e quality-gate`) with `.venv/bin` on the `PATH`. The default suite uses no Docker and spends no model tokens.

### License

MIT. See [LICENSE](LICENSE).

---

## Português

O JGates valida um repositório antes de uma aprovação: descobre os componentes, monta um plano que você pode revisar, executa as verificações e grava um resultado com a decisão e as evidências. A interface local e o CI usam o mesmo motor.

### O que é

O JGates é o produto; ele é composto por dois gates:

- o **quality gate** (`quality-gate`): verificações determinísticas, sem IA (orçamentos de tamanho de arquivo e de mudança, linters, scanners de segurança, duplicação, arquivos de infraestrutura, evidências de testes e de cobertura);
- o **semantic gate** (`semantic-gate`): uma revisão opcional feita por um modelo de IA, que nunca aprova nem reprova sozinha.

O comando principal é o `jgates`. Ele roda o quality gate e, quando você pede, o semantic gate; grava cada execução fora do projeto, mostra o resultado na linha de comando e numa interface local e produz o mesmo resultado em modo de CI. Os comandos `quality-gate` e `semantic-gate` também podem ser usados diretamente.

### Componentes

| Componente | O que faz | Documentação |
| --- | --- | --- |
| `jgates` | Descobre o projeto, monta o plano, executa, guarda o histórico, abre a interface e roda o CI governado. | [docs/jgates/](docs/jgates/getting-started.pt-BR.md) |
| `quality-gate` | O quality gate, usado pelo `jgates` ou diretamente. | [quality-gate/README.md](quality-gate/README.md) |
| `semantic-gate` | O semantic gate, usado pelo `jgates` ou diretamente. | [semantic-gate/README.md](semantic-gate/README.md) |

### Requisitos

- Node 22 ou mais novo e Git, para rodar o próprio JGates.
- Um motor de contêineres compatível com o Docker em `linux/amd64` (Docker Desktop, Rancher Desktop, Podman Desktop ou Docker Engine). Toda verificação roda num contêiner de uma imagem de ferramentas do JGates, então nenhum scanner, linter, executor de testes ou runtime de linguagem do seu projeto é instalado na sua máquina. O Docker Desktop tem termos de licença próprios; leia-os, ou use uma das alternativas.
- Cerca de 2 GB para baixar a imagem de ferramentas e uns 6 GB de disco depois de descompactada, mais as dependências do projeto e as bases de vulnerabilidades, que também ficam no motor (veja [armazenamento e limpeza](docs/jgates/storage.pt-BR.md)).
- O Linux foi testado. No Windows 10 com Docker Desktop o fluxo do primeiro uso foi conferido à mão (veja [limitações](docs/jgates/limitations.pt-BR.md)). O macOS não foi testado num Mac real.

### Instalação

O JGates não é publicado no registro do npm; a instalação vem do repositório no GitHub. Numa pasta vazia ou na pasta do seu projeto:

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates setup
```

O npm baixa o repositório e roda o script `prepare`, que compila o JGates e a interface; isso leva alguns minutos. Os comandos ficam disponíveis com `npx jgates`, `npx quality-gate` e `npx semantic-gate`.

Para ter o `jgates` no `PATH` sem depender de um projeto, instale numa pasta própria e coloque a pasta de executáveis dela no `PATH`:

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates setup
```

Para uma instalação global, ou para instalar sem acesso ao GitHub na máquina de destino, empacote um clone e instale o arquivo gerado:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates setup
```

O `npm install --global git+https://github.com/rodrigojager/jgates` **não funciona**: numa instalação global de uma dependência git, o npm liga os comandos a um clone temporário que ele mesmo apaga em seguida, e os comandos ficam apontando para nada. Use uma das formas acima (veja [limitações](docs/jgates/limitations.pt-BR.md)).

O `jgates --version` mostra a versão e, no stderr, a build e a pasta dela: use para conferir qual instalação um terminal está rodando (um terminal aberto antes de uma instalação mantém o `PATH` antigo).

Para atualizar, rode `jgates update`: ele pergunta ao repositório no GitHub qual é o commit mais novo da `main`, diz se há atualização e, depois que você confirma, instala do mesmo jeito que este JGates foi instalado (`--check` só verifica, `--yes` instala sem perguntar, `--ref` escolhe outra branch ou tag). A interface faz o mesmo em Sobre > Atualizações. O JGates nunca verifica sozinho: é o único momento em que ele acessa a internet, e só quando você pede.

### Primeiros passos

O caminho mais rápido é a interface. Na pasta do projeto:

```bash
jgates ui
```

No primeiro acesso ela abre a configuração guiada: confere o Docker e a máquina (memória, disco, CPUs) e deixa escolher o executável do motor (Docker, Podman ou outro), lista e baixa as ferramentas do JGates (em segundo plano, enquanto você segue), descreve o que foi detectado no projeto, cria o `jgates.yml` com o perfil que você escolher e ajustar ali mesmo (o `strict` exige testes e cobertura e liga todas as outras verificações "onde houver ferramenta": onde não há, a verificação aparece como "não se aplica aqui", com o motivo e a correção, e nunca bloqueia), prepara as dependências e inicia a primeira validação. A barra no topo lista o que a validação ainda precisa (Docker parado, pasta em que o Git não confia, ferramentas não baixadas), cada item com o botão que resolve. Depois, **Nova validação**: escolha o gate e o alvo, revise o plano (cada verificação que não vai rodar vem com o motivo e a ação) e execute. A tela de acompanhamento mostra cada fase e etapa, o tempo e um batimento enquanto ela trabalha; o resultado mostra um cartão por verificação (passou, falhou, não se aplica...) e um por achado, com ferramenta, regra, arquivo e linha. Cada arquivo de configuração tem uma tela guiada que grava uma chave por vez e mantém os seus comentários, e um editor de YAML com validação enquanto você digita; veja [a interface local](docs/jgates/local-ui.pt-BR.md).

O mesmo pelo terminal:

```bash
jgates setup
jgates status
jgates init
jgates plan
jgates run
```

- `setup` prepara a máquina: confere o motor de contêineres e o disco, baixa a imagem de ferramentas na versão que este JGates fixa, cria os volumes compartilhados e baixa as bases de vulnerabilidades. Pode rodar de novo sem problema. `status` mostra se a máquina está pronta (motor, imagem, idade dos dados, dependências e serviços do projeto, disco). O `jgates doctor` mantém o fluxo próprio e classifica o que o plano não tem; ele nunca instala uma ferramenta na sua máquina.
- `init` descobre os componentes do projeto e cria `jgates.yml` e `.jgates/profiles.yml`, que ficam versionados com o código. Os perfis são `minimal`, `standard` e `strict`. A cobertura mínima de testes é o `fail_under` do próprio projeto (`pyproject.toml`, `.coveragerc`...), a menos que a política do JGates defina outra.
- `plan` mostra o que vai executar, o que fica de fora e os requisitos sem cobertura, sem executar nada.
- `run` executa o plano e grava o resultado e a decisão. O código de saída diz a decisão: 0 aprovado, 1 reprovado, 2 incompleto (algo exigido não pôde ser provado; nunca vira aprovado), 3 uso ou configuração inválidos, 4 erro interno, 130 cancelado. Quando um run não consegue começar porque o motor ou a imagem de ferramentas não está pronto, o resultado é incompleto e nomeia o motivo com a ação dele (por exemplo `jgates setup`); nada é instalado na sua máquina. Num terminal, o run mostra cores e uma linha viva com o tempo da etapa em andamento; `--plain` imprime uma linha por etapa (e uma por minuto enquanto uma etapa longa trabalha), para agentes e logs. Ele termina com o arquivo a ler para corrigir: `agent-context.md`, na pasta do run (o mesmo resumo do botão "Copiar para o agente" da interface), com o `result.json` ao lado.

Os runs e os rascunhos ficam numa pasta de dados fora do projeto (`~/.local/state/jgates` no Linux; `JGATES_HOME` muda a pasta), e as ferramentas, a cópia do projeto e as dependências dele ficam em volumes com rótulo do motor. Para ver o histórico e exportar um resultado, use `jgates history` e `jgates report`. Para liberar espaço ou remover tudo o que o JGates criou, use `jgates clean` e `jgates uninstall` (veja [armazenamento e limpeza](docs/jgates/storage.pt-BR.md)). O passo a passo completo está em [primeiros passos](docs/jgates/getting-started.pt-BR.md).

O pacote Semgrep tem quatro classes: `ERROR`, `WARNING`, `INFO` comum (achados informativos que não bloqueiam
a validação) e **Revisar**. Achados Revisar aparecem em **Para revisar**, contados separadamente, nunca bloqueiam nem
mudam o código de saída e nunca tornam um requisito ASVS examinado. **Marcar como revisado** registra uma dispensa
por ocorrência no projeto; Revisar sozinho nunca produz "aprovado com N dispensas".
Veja [integrações do Quality](docs/jgates/quality-integrations.pt-BR.md).

### No CI

No computador local você edita tudo: `jgates.yml`, perfis, templates e waivers. No CI, as regras não vêm do projeto analisado: o `jgates ci` lê as regras de um repositório de políticas, conferido por um hash (`JGATES_POLICY_SHA256`), e analisa o commit numa cópia limpa.

```bash
jgates ci --policy <policy-folder> --sarif jgates.sarif
```

O job roda dentro da imagem de ferramentas do JGates fixada por digest (`container: <registry>/jgates-tools@sha256:<digest>`), então nada é instalado nele. O modelo, a criação do repositório de políticas, os exemplos para GitHub Actions e GitLab CI (`examples/ci/github-actions.yml` e `examples/ci/gitlab-ci.yml`), a política de imagens próprias e como proteger o pipeline estão em [docs/jgates/ci.pt-BR.md](docs/jgates/ci.pt-BR.md).

### Semantic gate

A revisão por IA é opcional. Ela só roda quando o `jgates.yml` configura um provedor (bloco `extensions.semantic-gate`) e a execução pede a revisão. No `jgates ui`, a área **Semântica (IA)** pergunta "Quem vai fazer a revisão por IA?" e grava esse bloco para você: ela detecta os CLIs de agente que você já tem (`claude-code`, `codex-cli`, `gemini-cli`, `opencode`), mostra se cada um está instalado e com login e abre o login do próprio CLI quando precisa (o JGates não tem OAuth próprio e nunca lê os tokens do CLI). À mão, fica assim:

```bash
jgates run --semantic
```

A configuração guarda só o nome da variável de ambiente com a chave de API, nunca o valor. A chave vem do login do CLI (os providers de CLI), da variável de ambiente ou do seu cofre de chaves, fora de qualquer projeto: grave-a na tela **Semântica (IA) > Provedores e chaves** do `jgates ui` ou com `jgates secrets set <NOME>` (o valor é lido do terminal, nunca de um argumento, e nenhuma saída o mostra); o ambiente vence o cofre, e o `jgates ci` usa só o ambiente. O `jgates providers` guarda as suas preferências por provider (base URL, modelo padrão, nome da chave) e conexões com nome para um gateway como o LiteLLM, que um projeto usa com `provider: <nome>`. Antes de montar o pedido, o JGates mascara segredos e dados pessoais reconhecidos no contexto, mas essa proteção por padrões não pega tudo. Você a configura no bloco `extensions.semantic-gate.masking`: quais entidades são mascaradas, padrões seus, ferramentas externas declaradas em `.jgates/pii.yml` (`tools`), uma lista de caminhos permitidos no contexto (`include`) e o que fazer diante de um achado (`onMatch: mask` ou `block`). Os prompts são arquivos que você mostra com `semantic-gate prompts`, exporta com `semantic-gate prompts --export <pasta>` e substitui ou estende por projeto (`prompts`). A tabela de providers (OpenRouter, OpenAI, Anthropic, Gemini, Ollama, `openai-compatible`, OpenCode e os CLIs Codex, Claude Code, Gemini e OpenCode) e o uso de um gateway como o LiteLLM, pelo provider `openai-compatible`, estão na página do semantic gate. O resultado fica ao lado da decisão e não a muda. Os detalhes estão em [semantic gate](docs/jgates/semantic-gate.pt-BR.md) e no [README do componente](semantic-gate/README.md). Além desse bloco consultivo, o Semantic gate também roda sozinho, com execuções, modos de escopo, métodos e histórico próprios (`jgates semantic`, ou `jgates run --gates quality,semantic`): veja [os dois gates](docs/jgates/gates.pt-BR.md).

### Dados pessoais nos arquivos do projeto

Para que um dado pessoal (CPF, CNPJ, cartão, telefone, ou o que uma ferramenta sua reconhece) não suba para o git, o JGates verifica e corrige os arquivos do projeto, só por um comando explícito; o `jgates run` nunca mexe no projeto:

```bash
jgates pii check --staged
jgates pii fix --dry-run --diff
jgates pii fix --yes
jgates pii fix --undo
jgates hooks install pre-commit
```

O `pii check` detecta sem mudar nada (saída 0 limpo, 1 com achado, 2 incompleto) e mostra os arquivos e a contagem por rótulo, nunca o valor. O `pii fix` corrige só por uma ferramenta que você indica em `fix.tools` do `.jgates/pii.yml`: trabalha numa cópia, mostra o que mudaria, pede confirmação (ou aceita `--yes`), aplica arquivo por arquivo só se o arquivo não mudou e guarda os originais, que contêm o dado pessoal, por 7 dias, para o `pii fix --undo` restaurá-los byte a byte. O `hooks install pre-commit` é um gancho do Git opcional e local que barra (ou corrige) um commit com dado pessoal nos arquivos do stage; nunca substitui um gancho seu e não faz nada com `core.hooksPath` definido (mostra a linha para acrescentar), e o `hooks uninstall pre-commit` tira só o gancho que ele gravou. Corrigir o arquivo não limpa o histórico do git. Detalhes em [segurança](docs/jgates/security.pt-BR.md#dados-pessoais-nos-arquivos-do-projeto) e na [pasta de dados](docs/jgates/data-folder.pt-BR.md).

### Agentes

O JGates não hospeda um agente: dá a ele um plano revisável, um resultado ligado ao estado do código e um resumo seguro das falhas. O JGates instalado traz o skill que ensina o ciclo (plano, execução, correção, nova execução, sem mudar os critérios):

```bash
jgates skill
jgates skill --install <skills-folder>/jgates
```

O primeiro imprime o skill (um agente lê direto pelo terminal); o segundo o copia como `SKILL.md` para a pasta de skills do seu agente (no Claude Code, `~/.claude/skills/jgates`). A instrução mais curta para um agente é: *rode `jgates skill` e siga*. Em resumo, o agente roda `jgates run --plain` (ou `--json`), lê o `agent-context.md` cujo caminho o run imprime no fim, corrige o código e roda de novo. Para os gates usados diretamente, o repositório também traz `use-jgates-quality/` (`quality-gate` headless) e `use-jgates-semantic/` (`semantic-gate` headless).

Um run reduzido (`reduced: true`) ou incompleto nunca encerra o ciclo como aprovado. Veja [agentes](docs/jgates/agents.pt-BR.md).

### Segurança e limitações

O JGates lê e executa ferramentas sobre código que pode não ser confiável, e tem uma interface local. O que ele protege, como, e o que ele não promete estão em [segurança](docs/jgates/security.pt-BR.md). O que ainda não faz e o que não foi testado está em [limitações](docs/jgates/limitations.pt-BR.md). O JGates não envia telemetria. O CI governado protege o gate contra o autor do código só com a política externa e um runner controlado.

### Documentação

- [Primeiros passos](docs/jgates/getting-started.pt-BR.md)
- [A interface local](docs/jgates/local-ui.pt-BR.md)
- [CI](docs/jgates/ci.pt-BR.md)
- [Templates e perfis](docs/jgates/templates-and-profiles.pt-BR.md)
- [Editor](docs/jgates/editor.pt-BR.md)
- [Adaptadores](docs/jgates/adapters.pt-BR.md) e [matriz de compatibilidade](docs/jgates/compatibility.pt-BR.md)
- [Semantic gate](docs/jgates/semantic-gate.pt-BR.md)
- [Os dois gates e a sequência](docs/jgates/gates.pt-BR.md), os [métodos Semantic](docs/jgates/semantic-methods.pt-BR.md) e os [mascotes Semantic](docs/jgates/semantic-mascots.pt-BR.md)
- [Integrações do Quality e a matriz de capacidades](docs/jgates/quality-integrations.pt-BR.md)
- [O mapa de cobertura ASVS](docs/jgates/asvs-coverage.pt-BR.md): cada requisito do OWASP ASVS 5.0.0 em um de cinco estados (`jgates coverage asvs`); mostra o que foi examinado, nunca que um projeto atende ao padrão. Um pacote de regras originais do Semgrep para nove tipos de arquivo (JavaScript/TypeScript, Python, Go, C#, Rust, Java, PHP, HTML e arquivos de configuração) o alimenta com verificações determinísticas; regras de política aparecem como achados informativos que não bloqueiam a validação, o mapa sugere "não se aplica" quando uma varredura não encontra nenhum sinal de uma tecnologia, e a revisão ASVS, opcional, acrescenta uma revisão por IA, contada à parte
- [Serviços do projeto](docs/jgates/services.pt-BR.md)
- [Suas próprias ferramentas e imagens](docs/jgates/extension.pt-BR.md)
- [Armazenamento e limpeza](docs/jgates/storage.pt-BR.md)
- [Agentes](docs/jgates/agents.pt-BR.md)
- [Pasta de dados](docs/jgates/data-folder.pt-BR.md)
- [Segurança](docs/jgates/security.pt-BR.md)
- [Limitações](docs/jgates/limitations.pt-BR.md)
- [Problemas comuns](docs/jgates/troubleshooting.pt-BR.md)
- [Licenças de terceiros](THIRD_PARTY_NOTICES.md)

### Desenvolvimento

`npm install` compila o JGates e `npm test` roda as suítes da raiz, do semantic gate, do quality gate e do JGates. Os testes chamam `python`: use um ambiente virtual (`python3 -m venv .venv`, `.venv/bin/pip install -e quality-gate`) com o `.venv/bin` no `PATH`. A suíte padrão não usa Docker nem gasta tokens de modelo.

### Licença

MIT. Veja [LICENSE](LICENSE).
