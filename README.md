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
| `jgates` | Discovers the project, builds the plan, runs it, keeps the history, opens the interface and runs the governed CI. | [docs/jgates/](docs/jgates/primeiros-passos.en.md) |
| `quality-gate` | The quality gate, used by `jgates` or directly. | [quality-gate/README.md](quality-gate/README.md) |
| `semantic-gate` | The semantic gate, used by `jgates` or directly. | [semantic-gate/README.md](semantic-gate/README.md) |

### Requirements

- Node 22 or newer, Python 3.11 or newer and Git.
- Docker is optional: it is needed for the tools that run in a container (Gitleaks, Trivy, OSV-Scanner, Checkov and the bridge's MegaLinter) and for the quality gate image. Without Docker, `quality-gate` runs the local Python sidecar and fails explicitly if a required tool is not installed.
- Linux was tested. Windows was not tested yet (the tests that depend on it are marked and skip elsewhere), and macOS was not tested on a real Mac.

### Installation

JGates is not published to the npm registry; it is installed from the repository on GitHub. In an empty folder or in your project's folder:

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates doctor
```

npm downloads the repository and runs the `prepare` script, which compiles JGates and the interface; this takes a few minutes. The commands are then available as `npx jgates`, `npx quality-gate` and `npx semantic-gate`.

To have `jgates` on the `PATH` without depending on a project, install it into a folder of its own and put that folder's executables on the `PATH`:

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates doctor
```

For a global installation, or to install on a machine that cannot reach GitHub, pack a clone and install the generated file:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates doctor
```

`npm install --global git+https://github.com/rodrigojager/jgates` **does not work**: for a global install of a git dependency, npm links the commands to a temporary clone that it then deletes, so the commands point at nothing. Use one of the forms above (see [limitations](docs/jgates/limitacoes.en.md)).

### Getting started

In the project folder:

```bash
jgates doctor
jgates init
jgates ui
jgates plan
jgates run
```

- `doctor` shows the runtimes (Node, Python, Git, Docker) and the state of the tools, and classifies what is missing as essential, optional or unused. It installs nothing on its own: on a terminal it offers the recipes of what is missing, and `jgates doctor --fix` (with `--yes` and `--include-optional`) installs them.
- `init` discovers the project's components and creates `jgates.yml` and `.jgates/profiles.yml`, which are versioned with the code. The profiles are `minimal`, `standard` and `strict`.
- `ui` opens the local interface (on this computer only) to see and edit the configuration, the tools and the results.
- `plan` shows what will run, what is left out and the requirements without coverage, without executing anything.
- `run` executes the plan and stores the result and the decision. The exit code tells the decision: 0 approved, 1 failed, 2 incomplete (something required could not be proven; it never becomes approved), 3 invalid usage or configuration, 4 internal error, 130 cancelled. When a run ends because a tool is missing, on a terminal `jgates run` lists what is missing, offers the same recipes as `doctor` and, after installing, asks whether to run again; with `--json`, `--ci` or without a terminal it asks nothing, the exit code is unchanged and the message points to `jgates doctor --fix`.

Runs, caches and prepared tools live in a data folder outside the project (`~/.local/state/jgates` on Linux; `JGATES_HOME` changes the folder). To see the history and export a result, use `jgates history` and `jgates report`. The complete walkthrough is in [getting started](docs/jgates/primeiros-passos.en.md).

### In CI

On your own computer you edit everything: `jgates.yml`, profiles, templates and waivers. In CI the rules do not come from the project being analyzed: `jgates ci` reads the rules from a policy repository, pinned by a hash (`JGATES_POLICY_SHA256`), and analyzes the commit in a clean copy.

```bash
jgates ci --policy <policy-folder> --sarif jgates.sarif
```

The model, how to build the policy repository, the examples for GitHub Actions and GitLab CI (`examples/ci/github-actions.yml` and `examples/ci/gitlab-ci.yml`) and how to protect the pipeline are in [docs/jgates/ci.en.md](docs/jgates/ci.en.md).

### Semantic gate

The AI review is optional. It runs only when `jgates.yml` configures a provider (the `extensions.semantic-gate` block) and the run asks for the review:

```bash
jgates run --semantic
```

The configuration keeps only the name of the environment variable that holds the API key, never the value. The key comes from the CLI login (the CLI providers), from the environment variable, or from your own key store, outside every project: store it on the **Preferences > Providers and keys** screen of `jgates ui` or with `jgates secrets set <NAME>` (the value is read from the terminal, never from an argument, and no output shows it); the environment wins over the store, and `jgates ci` uses only the environment. `jgates providers` keeps your preferences per provider (base URL, default model, key name) and named connections to a gateway such as LiteLLM, which a project uses with `provider: <name>`. Before building the request, JGates masks recognized secrets and personal data in the context, but this masking by patterns does not catch everything. You configure it in the `extensions.semantic-gate.masking` block: which entities are masked, your own patterns, external tools declared in `.jgates/pii.yml` (`tools`), a list of paths allowed in the context (`include`) and what to do on a finding (`onMatch: mask` or `block`). The prompts are files you can show with `semantic-gate prompts`, export with `semantic-gate prompts --export <folder>` and replace or extend per project (`prompts`). The providers table (OpenRouter, OpenAI, Anthropic, Gemini, Ollama, `openai-compatible`, OpenCode and the Codex, Claude Code, Gemini and OpenCode CLIs) and the use of a gateway such as LiteLLM, through the `openai-compatible` provider, are in the semantic gate page. The result is stored next to the decision and does not change it. Details are in [semantic gate](docs/jgates/semantic-gate.en.md) and in the [component README](semantic-gate/README.md).

### Personal data in the project files

So that personal data (CPF, CNPJ, card, phone, or what a tool of yours recognizes) does not reach git, JGates checks and fixes the project files, only through an explicit command; `jgates run` never touches the project:

```bash
jgates pii check --staged
jgates pii fix --dry-run --diff
jgates pii fix --yes
jgates pii fix --undo
jgates hooks install pre-commit
```

`pii check` detects without changing anything (exit 0 clean, 1 with findings, 2 incomplete) and shows files and the count by label, never the value. `pii fix` corrects only through a tool you name in `fix.tools` of `.jgates/pii.yml`: it works on a copy, shows what would change, asks for confirmation (or takes `--yes`), applies file by file only if the file did not change and keeps the originals, which hold the personal data, for 7 days so that `pii fix --undo` can restore them byte for byte. `hooks install pre-commit` is an optional, local Git hook that stops (or fixes) a commit with personal data in the staged files; it never replaces a hook of yours and does nothing when `core.hooksPath` is set (it shows the line to add instead), and `hooks uninstall pre-commit` removes only the hook it wrote. Fixing a file does not clean the git history. Details in [security](docs/jgates/seguranca.en.md#personal-data-in-the-project-files) and in the [data folder](docs/jgates/pasta-de-dados.en.md).

### Agents

JGates does not host an agent: it gives one a plan that can be reviewed, a result bound to the state of the code and a safe summary of the failures (`jgates report <runId> --agent-context`). The repository ships three skills, which you copy to your agent's skills folder:

- `jgates/skill/SKILL.md`: the `jgates` cycle (plan, run, fix, run again), without changing the criteria;
- `use-jgates-quality/`: `quality-gate` in headless mode;
- `use-jgates-semantic/`: `semantic-gate` in headless mode.

A reduced run (`reduced: true`) or an incomplete one never closes the cycle as approved. See [agents](docs/jgates/agentes.en.md).

### Security and limitations

JGates reads and runs tools over code that may not be trusted, and it has a local interface. What it protects, how, and what it does not promise is in [security](docs/jgates/seguranca.en.md). What it does not do yet and what was not tested is in [limitations](docs/jgates/limitacoes.en.md). JGates sends no telemetry. The governed CI protects the gate against the code author only together with the external policy and a controlled runner.

### Documentation

- [Getting started](docs/jgates/primeiros-passos.en.md)
- [CI](docs/jgates/ci.en.md)
- [Templates and profiles](docs/jgates/templates-e-perfis.en.md)
- [Editor](docs/jgates/editor.en.md)
- [Adapters](docs/jgates/adaptadores.en.md) and the [compatibility matrix](docs/jgates/compatibilidade.en.md)
- [Semantic gate](docs/jgates/semantic-gate.en.md)
- [Agents](docs/jgates/agentes.en.md)
- [Data folder](docs/jgates/pasta-de-dados.en.md)
- [Security](docs/jgates/seguranca.en.md)
- [Limitations](docs/jgates/limitacoes.en.md)
- [Common problems](docs/jgates/problemas.en.md)
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
| `jgates` | Descobre o projeto, monta o plano, executa, guarda o histórico, abre a interface e roda o CI governado. | [docs/jgates/](docs/jgates/primeiros-passos.pt-BR.md) |
| `quality-gate` | O quality gate, usado pelo `jgates` ou diretamente. | [quality-gate/README.md](quality-gate/README.md) |
| `semantic-gate` | O semantic gate, usado pelo `jgates` ou diretamente. | [semantic-gate/README.md](semantic-gate/README.md) |

### Requisitos

- Node 22 ou mais novo, Python 3.11 ou mais novo e Git.
- Docker é opcional: é preciso para as ferramentas que rodam em container (Gitleaks, Trivy, OSV-Scanner, Checkov e o MegaLinter da ponte) e para a imagem do quality gate. Sem o Docker, o `quality-gate` roda o sidecar Python local e falha de forma explícita se uma ferramenta exigida não estiver instalada.
- O Linux foi testado. O Windows ainda não foi testado (os testes que dependem dele estão marcados e pulam fora dele), e o macOS não foi testado num Mac real.

### Instalação

O JGates não é publicado no registro do npm; a instalação vem do repositório no GitHub. Numa pasta vazia ou na pasta do seu projeto:

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates doctor
```

O npm baixa o repositório e roda o script `prepare`, que compila o JGates e a interface; isso leva alguns minutos. Os comandos ficam disponíveis com `npx jgates`, `npx quality-gate` e `npx semantic-gate`.

Para ter o `jgates` no `PATH` sem depender de um projeto, instale numa pasta própria e coloque a pasta de executáveis dela no `PATH`:

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates doctor
```

Para uma instalação global, ou para instalar sem acesso ao GitHub na máquina de destino, empacote um clone e instale o arquivo gerado:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates doctor
```

O `npm install --global git+https://github.com/rodrigojager/jgates` **não funciona**: numa instalação global de uma dependência git, o npm liga os comandos a um clone temporário que ele mesmo apaga em seguida, e os comandos ficam apontando para nada. Use uma das formas acima (veja [limitações](docs/jgates/limitacoes.pt-BR.md)).

### Primeiros passos

Na pasta do projeto:

```bash
jgates doctor
jgates init
jgates ui
jgates plan
jgates run
```

- `doctor` mostra os runtimes (Node, Python, Git, Docker) e o estado das ferramentas, e classifica o que falta como essencial, opcional ou sem uso. Ele não instala nada sozinho: num terminal, oferece as receitas do que falta, e `jgates doctor --fix` (com `--yes` e `--include-optional`) instala.
- `init` descobre os componentes do projeto e cria `jgates.yml` e `.jgates/profiles.yml`, que ficam versionados com o código. Os perfis são `minimal`, `standard` e `strict`.
- `ui` abre a interface local (só neste computador) para ver e editar a configuração, as ferramentas e os resultados.
- `plan` mostra o que vai executar, o que fica de fora e os requisitos sem cobertura, sem executar nada.
- `run` executa o plano e grava o resultado e a decisão. O código de saída diz a decisão: 0 aprovado, 1 reprovado, 2 incompleto (algo exigido não pôde ser provado; nunca vira aprovado), 3 uso ou configuração inválidos, 4 erro interno, 130 cancelado. Quando um run termina por falta de uma ferramenta, num terminal o `jgates run` lista o que falta, oferece as mesmas receitas do `doctor` e, depois de instalar, pergunta se deve rodar de novo; com `--json`, `--ci` ou sem terminal ele não pergunta nada, o código de saída é o mesmo e a mensagem aponta para `jgates doctor --fix`.

Os runs, os caches e as ferramentas preparadas ficam numa pasta de dados fora do projeto (`~/.local/state/jgates` no Linux; `JGATES_HOME` muda a pasta). Para ver o histórico e exportar um resultado, use `jgates history` e `jgates report`. O passo a passo completo está em [primeiros passos](docs/jgates/primeiros-passos.pt-BR.md).

### No CI

No computador local você edita tudo: `jgates.yml`, perfis, templates e waivers. No CI, as regras não vêm do projeto analisado: o `jgates ci` lê as regras de um repositório de políticas, conferido por um hash (`JGATES_POLICY_SHA256`), e analisa o commit numa cópia limpa.

```bash
jgates ci --policy <policy-folder> --sarif jgates.sarif
```

O modelo, a criação do repositório de políticas, os exemplos para GitHub Actions e GitLab CI (`examples/ci/github-actions.yml` e `examples/ci/gitlab-ci.yml`) e como proteger o pipeline estão em [docs/jgates/ci.pt-BR.md](docs/jgates/ci.pt-BR.md).

### Semantic gate

A revisão por IA é opcional. Ela só roda quando o `jgates.yml` configura um provedor (bloco `extensions.semantic-gate`) e a execução pede a revisão:

```bash
jgates run --semantic
```

A configuração guarda só o nome da variável de ambiente com a chave de API, nunca o valor. A chave vem do login do CLI (os providers de CLI), da variável de ambiente ou do seu cofre de chaves, fora de qualquer projeto: grave-a na tela **Preferências > Providers e chaves** do `jgates ui` ou com `jgates secrets set <NOME>` (o valor é lido do terminal, nunca de um argumento, e nenhuma saída o mostra); o ambiente vence o cofre, e o `jgates ci` usa só o ambiente. O `jgates providers` guarda as suas preferências por provider (base URL, modelo padrão, nome da chave) e conexões com nome para um gateway como o LiteLLM, que um projeto usa com `provider: <nome>`. Antes de montar o pedido, o JGates mascara segredos e dados pessoais reconhecidos no contexto, mas essa proteção por padrões não pega tudo. Você a configura no bloco `extensions.semantic-gate.masking`: quais entidades são mascaradas, padrões seus, ferramentas externas declaradas em `.jgates/pii.yml` (`tools`), uma lista de caminhos permitidos no contexto (`include`) e o que fazer diante de um achado (`onMatch: mask` ou `block`). Os prompts são arquivos que você mostra com `semantic-gate prompts`, exporta com `semantic-gate prompts --export <pasta>` e substitui ou estende por projeto (`prompts`). A tabela de providers (OpenRouter, OpenAI, Anthropic, Gemini, Ollama, `openai-compatible`, OpenCode e os CLIs Codex, Claude Code, Gemini e OpenCode) e o uso de um gateway como o LiteLLM, pelo provider `openai-compatible`, estão na página do semantic gate. O resultado fica ao lado da decisão e não a muda. Os detalhes estão em [semantic gate](docs/jgates/semantic-gate.pt-BR.md) e no [README do componente](semantic-gate/README.md).

### Dados pessoais nos arquivos do projeto

Para que um dado pessoal (CPF, CNPJ, cartão, telefone, ou o que uma ferramenta sua reconhece) não suba para o git, o JGates verifica e corrige os arquivos do projeto, só por um comando explícito; o `jgates run` nunca mexe no projeto:

```bash
jgates pii check --staged
jgates pii fix --dry-run --diff
jgates pii fix --yes
jgates pii fix --undo
jgates hooks install pre-commit
```

O `pii check` detecta sem mudar nada (saída 0 limpo, 1 com achado, 2 incompleto) e mostra os arquivos e a contagem por rótulo, nunca o valor. O `pii fix` corrige só por uma ferramenta que você indica em `fix.tools` do `.jgates/pii.yml`: trabalha numa cópia, mostra o que mudaria, pede confirmação (ou aceita `--yes`), aplica arquivo por arquivo só se o arquivo não mudou e guarda os originais, que contêm o dado pessoal, por 7 dias, para o `pii fix --undo` restaurá-los byte a byte. O `hooks install pre-commit` é um gancho do Git opcional e local que barra (ou corrige) um commit com dado pessoal nos arquivos do stage; nunca substitui um gancho seu e não faz nada com `core.hooksPath` definido (mostra a linha para acrescentar), e o `hooks uninstall pre-commit` tira só o gancho que ele gravou. Corrigir o arquivo não limpa o histórico do git. Detalhes em [segurança](docs/jgates/seguranca.pt-BR.md#dados-pessoais-nos-arquivos-do-projeto) e na [pasta de dados](docs/jgates/pasta-de-dados.pt-BR.md).

### Agentes

O JGates não hospeda um agente: dá a ele um plano revisável, um resultado ligado ao estado do código e um resumo seguro das falhas (`jgates report <runId> --agent-context`). O repositório traz três skills, que você copia para a pasta de skills do seu agente:

- `jgates/skill/SKILL.md`: o ciclo do `jgates` (plano, execução, correção, nova execução), sem mudar os critérios;
- `use-jgates-quality/`: o `quality-gate` em modo headless;
- `use-jgates-semantic/`: o `semantic-gate` em modo headless.

Um run reduzido (`reduced: true`) ou incompleto nunca encerra o ciclo como aprovado. Veja [agentes](docs/jgates/agentes.pt-BR.md).

### Segurança e limitações

O JGates lê e executa ferramentas sobre código que pode não ser confiável, e tem uma interface local. O que ele protege, como, e o que ele não promete estão em [segurança](docs/jgates/seguranca.pt-BR.md). O que ainda não faz e o que não foi testado está em [limitações](docs/jgates/limitacoes.pt-BR.md). O JGates não envia telemetria. O CI governado protege o gate contra o autor do código só com a política externa e um runner controlado.

### Documentação

- [Primeiros passos](docs/jgates/primeiros-passos.pt-BR.md)
- [CI](docs/jgates/ci.pt-BR.md)
- [Templates e perfis](docs/jgates/templates-e-perfis.pt-BR.md)
- [Editor](docs/jgates/editor.pt-BR.md)
- [Adaptadores](docs/jgates/adaptadores.pt-BR.md) e [matriz de compatibilidade](docs/jgates/compatibilidade.pt-BR.md)
- [Semantic gate](docs/jgates/semantic-gate.pt-BR.md)
- [Agentes](docs/jgates/agentes.pt-BR.md)
- [Pasta de dados](docs/jgates/pasta-de-dados.pt-BR.md)
- [Segurança](docs/jgates/seguranca.pt-BR.md)
- [Limitações](docs/jgates/limitacoes.pt-BR.md)
- [Problemas comuns](docs/jgates/problemas.pt-BR.md)
- [Licenças de terceiros](THIRD_PARTY_NOTICES.md)

### Desenvolvimento

`npm install` compila o JGates e `npm test` roda as suítes da raiz, do semantic gate, do quality gate e do JGates. Os testes chamam `python`: use um ambiente virtual (`python3 -m venv .venv`, `.venv/bin/pip install -e quality-gate`) com o `.venv/bin` no `PATH`. A suíte padrão não usa Docker nem gasta tokens de modelo.

### Licença

MIT. Veja [LICENSE](LICENSE).
