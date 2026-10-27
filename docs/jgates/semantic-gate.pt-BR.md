# JGates: o semantic gate

O semantic gate pede a um modelo de IA uma revisão do código (correção, testes, segurança, manutenção, arquitetura, desempenho). No JGates ele é **opcional e separado da decisão**: nunca roda por padrão, nunca vem de um template, e o que ele conclui não aprova nem reprova o núcleo. O comando `semantic-gate` também pode ser usado diretamente.

## Quando ele roda

Só quando duas coisas acontecem juntas:

1. o projeto configura um provider em `jgates.yml`, no bloco `extensions.semantic-gate`;
2. o run pede a revisão com `--semantic`.

Sem a flag, o JGates nunca chama um provider. O `jgates init` não escreve nenhum provider.

```yaml
extensions:
  semantic-gate:
    provider: openai
    model: um-modelo
    scope: changed
    apiKeyEnv: MINHA_CHAVE_DE_API
    maxCalls: 4
    timeoutSeconds: 120
```

```bash
jgates run --semantic
```

O bloco aceita `provider`, `model`, `scope` (`changed`, `full` ou `paths`), `paths`, `excludes`, `include`, `masking` (veja abaixo), `prompts` (veja [os prompts](#os-prompts)), `objective`, `timeoutSeconds`, `maxContextChars`, `maxCalls`, `threshold`, `baseUrl`, `allowInsecureHttp`, `apiKeyEnv`, `command`, `commandArgs`, `commandPromptMode`, `commandOutput`, `costPerCall` e `enabled: false` para desligar. Uma chave desconhecida é um problema do bloco (estado `invalid`). O `provider` é um provider da tabela abaixo ou o nome de uma [conexão](#preferências-e-conexões) das suas preferências. A `baseUrl` do projeto segue a mesma regra das preferências (`http` só para loopback; `allowInsecureHttp: true` confirma outro host).

## A chave de API

A configuração guarda **só o nome** da variável (`apiKeyEnv`, ou o nome padrão do provider da tabela abaixo), nunca o valor. Há três formas de dar a chave:

1. **Login do CLI.** Os providers de CLI (`codex-cli`, `claude-code`, `gemini-cli`, `opencode`) usam o login do próprio CLI e não precisam de chave.
2. **Variável de ambiente.** Exporte a variável no ambiente onde roda o `jgates run`. É a forma do CI: o `jgates ci` usa só o ambiente (os segredos do pipeline) e nunca lê o cofre.
3. **Cofre do usuário.** Grave a chave uma vez pela tela **Preferências > Providers e chaves** do `jgates ui` ou com o `jgates secrets`, e ela vale para todos os projetos da sua máquina. O cofre fica fora de qualquer projeto (veja [a segurança](seguranca.pt-BR.md#o-cofre-de-chaves-do-usuário)), e a variável de ambiente, quando existe, vence o cofre.

```bash
jgates secrets set <NAME>
jgates secrets test <NAME>
jgates secrets unset <NAME>
```

O `set` lê o valor do terminal sem mostrá-lo, ou do stdin quando não é um terminal (`printf %s "$CHAVE" | jgates secrets set <NAME>`); o valor nunca é aceito como argumento. O `jgates secrets list` mostra cada nome com o estado (definida ou ausente), a origem (ambiente, cofre ou nenhuma) e a data da última gravação, nunca o valor: o texto mostra `********`, e o JSON nem isso. O `test` lista os modelos do provider com a chave, sem mandar prompt nem gastar token (para o `openai-compatible`, com o endereço em `SEMANTIC_GATE_BASE_URL`). O `semantic-gate auth set|list|unset` opera sobre o mesmo cofre.

Pela tela, cada provider e cada conexão mostra a chave dele com o estado: `********` e a data da gravação, a variável de ambiente que vale, ou ausente. **Gravar chave** e **Trocar chave** abrem um campo de senha sem autocompletar, que volta vazio depois de salvar; **Remover chave** pede confirmação; **Testar** lista os modelos do provider com a chave, sem gastar token. Quando a variável de ambiente está definida, a tela avisa que ela tem precedência. A tela nunca mostra o valor guardado, e no modo governado ou editando a política de CI ela só lê.

O valor do cofre só entra no ambiente de quem declara o nome: o provider do semantic gate (`apiKeyEnv` ou o nome padrão do provider) e as ferramentas externas de PII que listam o nome em `passEnv`. Nenhum outro processo do run recebe o valor, e ele não aparece no `result.json`, nos logs nem nos eventos.

## Os providers

A tabela foi conferida contra a documentação oficial de cada provider em 27/10/2026. Os modelos de exemplo eram ids atuais nessa data; use o que você tem.

| Provider | O que o semantic gate chama | O que precisa | Modelo de exemplo |
| --- | --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-5.5` |
| `openai` | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` | `gpt-6-astra` |
| `anthropic` | `https://api.anthropic.com/v1/messages`, versão da API `2026-10-21` | `ANTHROPIC_API_KEY` (ou `CLAUDE_API_KEY`) | `claude-opus-5-5`, `claude-sonnet-5-5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/models/<modelo>:generateContent`, com a chave no cabeçalho `x-goog-api-key` | `GEMINI_API_KEY` (ou `GOOGLE_API_KEY`) | `gemini-3.8-flash`, `gemini-4-argon` |
| `ollama` | `http://127.0.0.1:11434/api/chat` (ou `OLLAMA_HOST`, ou `baseUrl`) | um servidor Ollama com o modelo baixado | um nome de `ollama list` |
| `openai-compatible` | `<baseUrl>/chat/completions` | `baseUrl` e `SEMANTIC_GATE_API_KEY` (ou a variável de `apiKeyEnv`) | o nome que o servidor expõe |
| `opencode-api` | `https://opencode.ai/inference/openai/v1/chat/completions` (OpenCode Zen) | `OPENCODE_API_KEY` | `kimi-k3` |
| `codex-cli` | `codex exec [-m <modelo>] --sandbox <modo> --skip-git-repo-check -` | Codex CLI 0.122.0 ou mais novo, com login feito | `gpt-6-astra` |
| `claude-code` | `claude --print [--model <modelo>] --tools "" --strict-mcp-config` | Claude Code 2.1.0 ou mais novo, com login feito | `sonnet`, `claude-sonnet-5-5` |
| `gemini-cli` | `gemini [--model <modelo>] --approval-mode default --output-format text` | Gemini CLI 0.30.0 ou mais novo, com login feito | `gemini-3.8-flash` |
| `opencode` | `opencode run --agent semantic-gate-review [--model <modelo>] --format default` (com `--standalone` no OpenCode 2) | OpenCode 1.2.0 ou mais novo, com o provider do modelo configurado | `opencode/kimi-k3` |
| `command` | o comando e os argumentos que você configurar | `command`, e `commandArgs` e `commandPromptMode` se precisar | — |

- **Temperatura.** Só vai na chamada quando você a configura (`temperature` no `.semantic-gate.json` ou `SEMANTIC_GATE_TEMPERATURE`); sem ela, vale o padrão do modelo. Os modelos de raciocínio atuais (OpenAI a partir do GPT-5, Claude a partir do 4.7) recusam um valor fora do padrão, e a versão `2026-10-21` da API da Anthropic removeu o parâmetro: o provider `anthropic` nunca o envia.
- **OpenCode Zen.** O `opencode-api` fala com os modelos que o Zen serve por chat completions (Kimi, GLM, DeepSeek, Qwen Max e os gratuitos). Os modelos Claude, GPT e Gemini do Zen usam outros formatos de API; para eles, use o CLI `opencode` ou o provider do fabricante.
- **O prompt dos CLIs vai pela entrada padrão.** Um prompt de revisão passa com folga do limite de um argumento (128 KiB no Linux; 32 KiB para a linha de comando inteira no Windows). O `gemini-cli` roda sem interface porque a entrada vem de um pipe, e lê até 8 MB dela; o `--prompt` não é usado. O `opencode` sem subcomando abre a interface; o modo sem interface é o `opencode run`.
- **Versão dos CLIs.** Antes da revisão, o semantic gate roda `<cli> --version`. Se o CLI não está instalado, se a versão não pode ser lida ou se ela é mais velha que a mínima da tabela, ele para sem chamar o modelo (o `semantic-gate` sai com código 2; no `jgates run`, o estado é `unavailable`) e a mensagem traz a versão encontrada, a mínima e o comando para atualizar: `npm install -g @openai/codex@latest`, `claude update`, `npm install -g @google/gemini-cli@latest` ou `opencode upgrade`. Um script seu que não responde a `--version` usa o provider `command`.
- **Os CLIs não editam o projeto.** O `claude-code` roda sem nenhuma ferramenta (`--tools ""`) e sem servidores MCP. O `gemini-cli` roda com `--approval-mode default`: sem ninguém para aprovar, o que pede aprovação (editar arquivo, rodar shell) é negado, mesmo que a sua configuração tenha outro modo padrão. O `opencode` roda com o agente `semantic-gate-review`, que o semantic gate define em `OPENCODE_CONFIG_CONTENT` com todas as permissões negadas (uma configuração que você já passa nessa variável é mantida e só ganha o agente). O `codex-cli` roda por padrão com `--sandbox read-only`; ele só escreve se você pedir com `--codex-sandbox workspace-write` ou `--codex-sandbox danger-full-access` (`--codex-bypass-sandbox` remove o sandbox).

## Preferências e conexões

As preferências de providers são suas, não do projeto: ficam no `config.json` global do `semantic-gate`, ao lado do cofre (`SEMANTIC_GATE_HOME`, senão `%APPDATA%\semantic-gate` no Windows, senão `$XDG_CONFIG_HOME/semantic-gate`), e valem para todos os projetos da máquina. Elas guardam, por provider conhecido, a base URL (a do provider, trocável por um proxy), o modelo padrão e o nome da chave; e **conexões com nome** do tipo `openai-compatible` (um gateway: LiteLLM, vLLM, um proxy do time, o Ollama em `/v1`), com base URL, nome da chave no cofre, modelo padrão e cabeçalhos extras sem segredo. Um projeto usa uma conexão com `provider: <nome>`.

```bash
jgates providers set <provider> --base-url <url> --model <model> --key-env <NAME>
jgates providers add <name> --base-url <url> --model <model> --key-env <NAME> --header X-Team=core
jgates providers test <name>
jgates providers remove <name>
```

- O `jgates providers list` mostra cada provider e cada conexão com o valor de cada campo e de onde ele vem (sua preferência ou o padrão do provider), e o estado da chave (definida no ambiente ou no cofre, ou ausente), nunca o valor. Com `--json`, cada campo é `{ "value", "origin" }`.
- O `set` muda um provider conhecido ou uma conexão; um valor vazio (`--model ""`) remove o campo e volta ao padrão. O `remove` apaga uma conexão, ou as preferências de um provider conhecido.
- O `test` lista os modelos do provider ou da conexão com a base URL, os cabeçalhos e a chave das preferências, sem mandar prompt nem gastar token.
- **Precedência, campo a campo:** o valor do projeto (`jgates.yml`), depois a sua preferência, depois o padrão do provider. Um projeto pode fixar só o modelo e herdar a base URL e a chave das suas preferências. O estado do semantic gate (o cartão da interface e `result.semantic.effective`) mostra de onde veio cada valor: `project`, `user`, `default` ou `unset`.
- **`jgates ci` ignora as preferências:** só a política e o ambiente do pipeline contam. Um projeto que usa uma conexão no CI fica com o estado `invalid` e a razão diz isso; no CI, use `provider: openai-compatible` com a `baseUrl` no projeto ou na política.
- **O nome de uma conexão** tem letras minúsculas, dígitos e `-` (`^[a-z0-9][a-z0-9-]{0,62}$`) e não pode ser o de um provider conhecido (`openai`, `claude`, `ollama`, `command`...). A chave dela é a variável de `--key-env`; sem ela, `<NOME>_API_KEY` (para `litellm-local`, `LITELLM_LOCAL_API_KEY`), e uma conexão sem chave definida chama o gateway sem `Authorization`.
- **Segurança.** A base URL é `http` ou `https`, sem usuário, senha, query nem fragmento; `http` só vale para loopback (`localhost`, `127.0.0.0/8`, `::1`) ou com a confirmação explícita `--allow-http`, porque a chave iria em texto claro. Mudar a base URL apaga a confirmação dada para a anterior. Um cabeçalho extra com nome de credencial (`Authorization`, `Cookie`, `*-key`, `*-token`, `*-secret`) ou com valor `Bearer ...` é recusado: a credencial vai no cofre. Cada campo recusado vem na mensagem com o nome dele (`baseUrl`, `headers.X-Api-Key`, `name`), e nada é gravado.
- **Pela interface.** A tela **Preferências > Providers e chaves** faz o mesmo que o `jgates providers`: Configurar (base URL, modelo padrão, com a lista de modelos do provider quando a chave está definida, nome da chave e cabeçalhos), Testar, Acrescentar conexão e Remover conexão. No projeto, o cartão do semantic gate em **Ferramentas** edita os campos essenciais do `extensions.semantic-gate` (ligado, provider ou conexão, modelo, escopo, limites e a base URL opcional) com o motor de formulários: o arquivo é a fonte, cada mudança é um patch mínimo do `jgates.yml` e um arquivo que mudou no meio é um conflito de revisão. O mascaramento e os prompts continuam no arquivo.
- O `semantic-gate` lê as mesmas preferências: `semantic-gate models list <name>` lista os modelos de uma conexão, e `--provider <name>` a usa. No `.semantic-gate.json`, no ambiente e nas flags, os valores vencem as preferências do mesmo jeito.

## Um gateway (LiteLLM ou outro)

O semantic gate não embute o LiteLLM nem outro gateway. Ele traria o Python e muitas dependências para uma ferramenta que hoje é Node sem dependências, e é mais um servidor para operar; o LiteLLM também já teve versões maliciosas publicadas no PyPI (1.82.7 e 1.82.8, em 24/03/2026). Quem quer um ponto central para chaves, cotas, logs ou troca de modelo roda o gateway à parte e cria uma conexão para ele (ou aponta o provider `openai-compatible` para ele no projeto).

Com o proxy do LiteLLM, por exemplo:

```yaml
# config.yaml do proxy
model_list:
  - model_name: revisao
    litellm_params:
      model: anthropic/claude-sonnet-5-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

```bash
litellm --config config.yaml   # escuta em http://0.0.0.0:4000
```

Crie a conexão uma vez, com o `model_name` do gateway, e grave a chave do gateway (a master key ou uma chave virtual, não a do fabricante) no cofre com `jgates secrets set LITELLM_API_KEY`:

```bash
jgates providers add litellm-local --base-url http://localhost:4000/v1 --model <model_name> --key-env LITELLM_API_KEY
```

O `jgates providers test litellm-local` confere o endereço e a chave listando os modelos que o gateway expõe. Cada projeto passa a usar a conexão pelo nome:

```yaml
# jgates.yml
extensions:
  semantic-gate:
    provider: litellm-local
```

O projeto pode fixar um `model` diferente do padrão da conexão. Sem conexão, o mesmo fica no projeto: `provider: openai-compatible`, `baseUrl: http://localhost:4000/v1`, `model: revisao` e `apiKeyEnv: LITELLM_API_KEY` (a forma do CI, que não lê as preferências). Direto pelo `semantic-gate`, `--provider litellm-local` usa a conexão, e `--provider openai-compatible --base-url http://localhost:4000/v1 --model revisao --api-key-env LITELLM_API_KEY` faz o mesmo sem ela. Qualquer outro gateway com `/chat/completions` e `/models` no formato da OpenAI funciona do mesmo jeito.

Fixe a versão do gateway e confira de onde vêm o pacote ou a imagem. O gateway recebe o mesmo contexto que o provider, já mascarado: confie nele como confiaria no provider.

## O que o provider recebe

Antes de montar o prompt, o JGates filtra e mascara o contexto, nesta ordem:

1. arquivos que costumam guardar segredos (`.env`, `.npmrc`, chaves e certificados, `~/.aws/credentials`) saem do contexto, qualquer que seja a configuração;
2. a lista `excludes` tira o que você quiser, e a lista `include`, quando existe, deixa entrar só os caminhos dela;
3. segredos reconhecidos (valores de atribuições como `api_key`, `token` ou `password`, e chaves privadas) viram um marcador, sempre;
4. as entidades de PII ligadas e os seus padrões viram `[MASKED:<rótulo>]`;
5. as ferramentas externas de PII, se houver, recebem uma cópia dos arquivos já mascarados e podem mascarar mais.

O provider não vê um segredo reconhecido nem um valor das entidades ligadas.

### Por que não existe "mascarar tudo"

Mascarar exige reconhecer o que é sensível, e isso só se faz por padrões ou por outro programa que leia os dados (outro terceiro). Mascarar todo literal deixaria a revisão sem sentido. Como todo mascaramento por padrão, o do JGates não pega tudo: a garantia total é não enviar o arquivo, com `excludes` ou com a lista `include`.

### Configurar o mascaramento

```yaml
extensions:
  semantic-gate:
    provider: openai
    apiKeyEnv: MINHA_CHAVE_DE_API
    include: ["src/**"]          # opcional: só estes caminhos vão ao provider
    excludes: ["src/fixtures/**"]
    masking:
      pii:                       # cada entidade liga e desliga; o que não está aqui fica no padrão
        cpf: false
        ip-address: true
      patterns:                  # expressões regulares próprias; o trecho casado vira [MASKED:<label>]
        - id: employee-id
          regex: "EMP-\\d{6}"
          label: employee-id     # opcional: o padrão é o id
          flags: "i"             # opcional: i, m, s e u
      tools: [corp-dlp]          # ferramentas de .jgates/pii.yml, em ordem
      onMatch: mask              # mask (padrão) ou block
```

- `masking.pii`: `cpf`, `cnpj`, `credit-card`, `phone` e `email` vêm ligadas; `ip-address` vem desligada, porque o código tem muitos IPs que não são dado pessoal. Qualquer uma pode ser desligada. O e-mail e o IP são reconhecidos só aqui: o detector de PII do gate ainda não os conhece. Casos de fronteira: `@scope/pacote`, `pacote@1.2.3`, `usuario@localhost` e `icone@2x.png` não são e-mail; um remoto SSH como `git@host.com:org/repo.git` é mascarado, e uma versão com quatro partes (`1.2.3.4`) também, quando `ip-address` está ligada.
- `masking.patterns`: o `id` é único; a regex não pode casar com um texto vazio.
- Segredos e a exclusão dos arquivos de segredo não se desligam: padrões e ferramentas só acrescentam.
- `masking.onMatch: block`: com qualquer achado (das entidades, dos padrões ou de uma ferramenta), nada é enviado, e o resultado diz o motivo (estado `blocked`).
- Uma regex inválida, um id repetido ou uma ferramenta que não existe em `.jgates/pii.yml` deixam o bloco inválido, com o caminho do campo (por exemplo `extensions.semantic-gate.masking.patterns[0].regex`), e nada é enviado.
- `result.semantic.context.masked` traz a contagem por rótulo (entidades, `secret`, padrões e ferramentas), nunca os valores; `result.semantic.context.tools` traz o que cada ferramenta disse (detectou, mudou, contagem).
- O `jgates ci` não roda o semantic gate. O adaptador aceita a pasta da configuração separada do projeto (`configDir`), para que, num uso governado, o `jgates.yml` e o `.jgates/pii.yml` venham só da política.

### Ferramentas externas de PII

Uma ferramenta é definida uma vez, em `.jgates/pii.yml`, e usada por nome:

```yaml
# .jgates/pii.yml
schemaVersion: 1
tools:
  corp-dlp:
    command: node
    args: ["{configDir}/tools/corp-dlp-adapter.mjs"]
    timeoutSeconds: 30           # padrão 60
    passEnv: [CORP_DLP_TOKEN]    # variáveis repassadas, só pelo nome
```

A ferramenta roda sem shell, com um ambiente mínimo (`PATH`, `HOME`, idioma, pasta temporária) mais o `passEnv` (um nome que falta no ambiente vem do [cofre do usuário](#a-chave-de-api), só para essa ferramenta). O diretório de trabalho é a cópia, não o projeto: `{configDir}` em `command` e `args` vira a pasta da configuração.

O contrato:

- O JGates escreve uma cópia dos arquivos numa pasta temporária, com a mesma árvore de caminhos relativos, e roda a ferramenta com essa pasta como diretório de trabalho e em `JGATES_MASK_DIR`. `JGATES_MASK_FILES` aponta para um arquivo, fora da pasta, com um caminho relativo por linha. `JGATES_MASK_MODE` diz o uso: `context` (contexto do semantic gate; a cópia já vem com as máscaras internas), `check` (só detectar: nada pode mudar) ou `fix` (corrigir a cópia de arquivos do projeto).
- No contexto do semantic gate, cada arquivo da cópia traz o que o provider veria dele (o diff, ou o conteúdo). Quando há mais de uma parte, elas vêm separadas por uma linha `@@jgates-mask-part <parte>@@`, que a ferramenta não pode mudar.
- A ferramenta edita os arquivos no lugar e, no fim, escreve no stdout uma linha JSON, o status (schema em `jgates/schemas/pii/mask-tool-status.schema.json`):

  ```json
  {"jgatesMask":1,"status":"ok","detected":true,"changed":true,"counts":{"employee-id":3},"files":["src/app.js"],"message":"3 ids"}
  ```

  `counts`, `files` (os arquivos em que achou algo) e `message` são opcionais. Sucesso é saída 0 com `status: "ok"`; outra saída ou `status: "error"` é erro. A mensagem não pode trazer um valor sensível: o JGates mascara nela os formatos embutidos (CPF, CNPJ, cartão, telefone, e-mail) e os segredos antes de mostrá-la, mas um valor de formato próprio não é reconhecido, e a mensagem é cortada em 300 caracteres.
- O JGates confere o que a ferramenta fez: só os arquivos listados podem mudar, nenhum arquivo é criado ou apagado, nenhum link; `changed` precisa bater com o que mudou, e `changed: true` exige `detected: true`. No modo `check`, qualquer mudança é inconsistente.
- Várias ferramentas rodam em ordem, cada uma sobre o resultado da anterior.
- Sem garantia, nada é enviado: erro, tempo esgotado, saída sem o status, status inválido ou inconsistente, ou arquivo fora da lista mexido dão o código `MASKING_COMMAND_FAILED`; `detected: true` com `changed: false` dá `MASKING_UNRESOLVED` (a ferramenta achou algo que não tratou). Nos dois casos o estado é `unavailable`, e o resto do run segue como para qualquer semantic que falhou.

Uma CLI que já existe e não fala esse status entra por um adaptador: um script curto que chama a CLI e traduz o resultado. Um exemplo em Node, sem dependências, para uma CLI hipotética `corp-dlp scan --json <arquivo>` que responde `{"findings":[{"start":10,"end":21,"type":"employee-id"}]}`:

```js
// tools/corp-dlp-adapter.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = process.env.JGATES_MASK_DIR;
const mode = process.env.JGATES_MASK_MODE; // context | check | fix
const files = fs.readFileSync(process.env.JGATES_MASK_FILES, "utf8").split(/\r?\n/).filter(Boolean);
const counts = {};
const found = [];
let changed = false;
try {
  for (const file of files) {
    const full = path.join(dir, file);
    const report = JSON.parse(execFileSync("corp-dlp", ["scan", "--json", full], { encoding: "utf8" }));
    if (report.findings.length === 0) continue;
    found.push(file);
    let text = fs.readFileSync(full, "utf8");
    // From the end, so the earlier positions stay valid.
    for (const f of [...report.findings].sort((a, b) => b.start - a.start)) {
      counts[f.type] = (counts[f.type] ?? 0) + 1;
      text = text.slice(0, f.start) + `[MASKED:${f.type}]` + text.slice(f.end);
    }
    if (mode !== "check") {
      fs.writeFileSync(full, text);
      changed = true;
    }
  }
  console.log(JSON.stringify({ jgatesMask: 1, status: "ok", detected: found.length > 0, changed, counts, files: found }));
} catch {
  console.log(JSON.stringify({ jgatesMask: 1, status: "error", detected: false, changed: false, message: "corp-dlp failed" }));
  process.exitCode = 1;
}
```

## Os prompts

Os textos do prompt são arquivos do pacote `semantic-gate`; o código só os monta:

| Arquivo | O que é |
| --- | --- |
| `semantic-gate/templates/system-prompt.md` | O prompt de sistema (o papel do revisor e os limites dele). |
| `semantic-gate/templates/semantic-review-skill.md` | Os critérios da revisão: bloqueios, eixos, tetos de nota e severidades. |

No pacote instalado, a pasta é `templates/` dentro do pacote. `semantic-gate prompts` mostra os caminhos absolutos em uso, e `semantic-gate prompts --export <pasta>` copia os dois arquivos para você editar (não sobrescreve um arquivo que já existe sem `--force`).

O projeto troca ou estende cada um em `prompts`, com `mode: replace` (o arquivo do projeto toma o lugar do texto do pacote) ou `mode: append` (o arquivo do projeto vem depois dele):

```yaml
extensions:
  semantic-gate:
    provider: openai
    apiKeyEnv: MY_API_KEY
    prompts:
      review: { mode: append, file: .jgates/semantic-review.md }
      system: { mode: replace, file: .jgates/semantic-system.md }
```

```markdown
<!-- .jgates/semantic-review.md -->
## Project Criteria

- Money values are never floats: block a change that adds one.
- Every public endpoint checks the tenant of the caller.
```

- `file` é relativo à pasta da configuração (o projeto ou, num uso governado, a política de CI, o mesmo `configDir` do mascaramento) e precisa ficar dentro dela. Arquivo que não existe, caminho fora da pasta, modo diferente de `replace` ou `append`, ou chave diferente de `system` e `review` deixam o bloco inválido, e nada é enviado.
- O contrato da saída (o JSON que o resultado lê) não é personalizável: fecha sempre o prompt, e um prompt de sistema personalizado termina sempre com `Return valid JSON only. Do not include Markdown fences.`, para a resposta seguir legível pelo parser.
- Os arquivos de prompt vão como foram escritos: o mascaramento vale para o contexto da revisão, não para eles. Escreva os prompts em inglês, como os do pacote, ou na língua que o modelo escolhido entende melhor.
- `result.semantic.prompts` e `result.provenance.semanticPrompts` trazem o `sha256` dos prompts em vigor (prompt de sistema e critérios juntos) e, para cada um, de onde veio (`default`, `project` ou `policy`), o modo, o arquivo e o `sha256` do texto. Outro arquivo de prompt dá outro hash, então um resultado diz com que prompt foi feito.

## O resultado

A conclusão fica em `result.semantic`, ao lado da decisão e sem alterá-la. O estado é um destes:

| Estado | Significa |
| --- | --- |
| `completed` | A revisão rodou e traz nota e observações. |
| `not-configured` | Foi pedida com `--semantic`, mas não há provider configurado. |
| `unavailable` | O provider não respondeu ou recusou. |
| `timeout` | Passou do `timeoutSeconds`. |
| `budget-exhausted` | Passou do `maxCalls` (uma chamada por trecho de contexto). |
| `blocked` | `masking.onMatch: block` e o mascaramento achou algo; nada foi enviado (`code: MASKING_BLOCKED`). |

Quando o mascaramento impede o envio, `result.semantic.code` diz por quê: `MASKING_COMMAND_FAILED` ou `MASKING_UNRESOLVED` (estado `unavailable`) e `MASKING_BLOCKED` (estado `blocked`).

`result.semantic.effective` traz o provider em vigor (`kind`: `provider`, `connection`, `other` ou `unknown`), se as preferências foram lidas (`preferences`: `used` ou `ignored`, no `jgates ci`) e, para `baseUrl`, `model` e `apiKeyEnv`, o valor e a origem (`project`, `user`, `default` ou `unset`), além dos nomes dos cabeçalhos extras de uma conexão.

Um provider indisponível, um timeout, um orçamento esgotado ou um bloqueio do mascaramento nunca aprovam nem reprovam o gate. A interface mostra o estado do semantic gate num cartão em Ferramentas, que edita os campos essenciais como descrito em [preferências e conexões](#preferências-e-conexões).

## Limites

- O smoke com um provider real ainda não foi feito; os testes usam um provider falso e não gastam tokens. Veja [limitações](limitacoes.pt-BR.md).
- O pedido é a flag `--semantic`, não um campo do `plan.json`: um `jgates run --plan` não carrega o pedido, e o hash do plano não muda por causa da revisão.
- O custo é seu: `maxCalls` limita as chamadas e `costPerCall`, quando informado, faz o resultado trazer o custo total (chamadas vezes o valor).

## Usar com um agente

O contexto para agente e o ciclo de correção estão em [agentes](agentes.pt-BR.md). A revisão semântica é complementar a eles, não substitui o gate determinístico.
