# JGates: the semantic gate

The semantic gate asks an AI model for a review of the code (correctness, tests, security, maintainability, architecture, performance). In JGates it is **optional and separate from the decision**: it never runs by default, never comes from a template, and what it concludes neither approves nor fails the core. The `semantic-gate` command can also be used directly.

## When it runs

Only when two things happen together:

1. the project configures a provider in `jgates.yml`, in the `extensions.semantic-gate` block;
2. the run asks for the review with `--semantic`.

Without the flag, JGates never calls a provider. `jgates init` writes no provider.

```yaml
extensions:
  semantic-gate:
    provider: openai
    model: a-model
    scope: changed
    apiKeyEnv: MY_API_KEY
    maxCalls: 4
    timeoutSeconds: 120
```

```bash
jgates run --semantic
```

The block accepts `provider`, `model`, `scope` (`changed`, `full` or `paths`), `paths`, `excludes`, `include`, `masking` (see below), `prompts` (see [the prompts](#the-prompts)), `objective`, `timeoutSeconds`, `maxContextChars`, `maxCalls`, `threshold`, `baseUrl`, `allowInsecureHttp`, `apiKeyEnv`, `command`, `commandArgs`, `commandPromptMode`, `commandOutput`, `costPerCall` and `enabled: false` to turn it off. An unknown key is a problem of the block (state `invalid`). `provider` is a provider of the table below or the name of a [connection](#preferences-and-connections) of your preferences. The project's `baseUrl` follows the same rule as the preferences (`http` only for loopback; `allowInsecureHttp: true` confirms another host).

## The API key

The configuration keeps **only the name** of the variable (`apiKeyEnv`, or the provider's default name from the table below), never the value. There are three ways to give the key:

1. **CLI login.** The CLI providers (`codex-cli`, `claude-code`, `gemini-cli`, `opencode`) use the CLI's own login and need no key.
2. **Environment variable.** Export the variable in the environment where `jgates run` runs. This is the CI way: `jgates ci` uses only the environment (the pipeline's secrets) and never reads the key store.
3. **User key store.** Store the key once through the **Preferences > Providers and keys** screen of `jgates ui` or with `jgates secrets`, and it works for every project on your machine. The store is outside every project (see [security](seguranca.en.md#the-user-key-store)), and the environment variable, when set, wins over the store.

```bash
jgates secrets set <NAME>
jgates secrets test <NAME>
jgates secrets unset <NAME>
```

`set` reads the value from the terminal without showing it, or from stdin when it is not a terminal (`printf %s "$KEY" | jgates secrets set <NAME>`); the value is never taken as an argument. `jgates secrets list` shows each name with its state (set or unset), its source (environment, store or none) and the date of the last write, never the value: the text shows `********`, and the JSON not even that. `test` lists the provider's models with the key, without sending a prompt or spending a token (for `openai-compatible`, with the address in `SEMANTIC_GATE_BASE_URL`). `semantic-gate auth set|list|unset` works on the same store.

On the screen, each provider and each connection shows its key with the state: `********` and the date it was saved, the environment variable in effect, or not set. **Save key** and **Change key** open a password field without autocomplete that is emptied after saving; **Remove key** asks for a confirmation; **Test** lists the provider's models with the key, without spending a token. When the environment variable is set, the screen says it takes precedence. The screen never shows the stored value, and in the governed mode or while editing the CI policy it only reads.

A stored value enters only the environment of what declares the name: the semantic-gate provider (`apiKeyEnv` or the provider's default name) and the external PII tools that list the name in `passEnv`. No other process of the run gets the value, and it does not appear in `result.json`, the logs or the events.

## The providers

The table was checked against each provider's official documentation on 2026-10-27. The example models were current ids on that date; use the one you have.

| Provider | What the semantic gate calls | What it needs | Example model |
| --- | --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-5.5` |
| `openai` | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` | `gpt-6-astra` |
| `anthropic` | `https://api.anthropic.com/v1/messages`, API version `2026-10-21` | `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) | `claude-opus-5-5`, `claude-sonnet-5-5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, with the key in the `x-goog-api-key` header | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-3.8-flash`, `gemini-4-argon` |
| `ollama` | `http://127.0.0.1:11434/api/chat` (or `OLLAMA_HOST`, or `baseUrl`) | an Ollama server with the model pulled | a name from `ollama list` |
| `openai-compatible` | `<baseUrl>/chat/completions` | `baseUrl` and `SEMANTIC_GATE_API_KEY` (or the variable in `apiKeyEnv`) | the name the server exposes |
| `opencode-api` | `https://opencode.ai/inference/openai/v1/chat/completions` (OpenCode Zen) | `OPENCODE_API_KEY` | `kimi-k3` |
| `codex-cli` | `codex exec [-m <model>] --sandbox <mode> --skip-git-repo-check -` | Codex CLI 0.122.0 or newer, logged in | `gpt-6-astra` |
| `claude-code` | `claude --print [--model <model>] --tools "" --strict-mcp-config` | Claude Code 2.1.0 or newer, logged in | `sonnet`, `claude-sonnet-5-5` |
| `gemini-cli` | `gemini [--model <model>] --approval-mode default --output-format text` | Gemini CLI 0.30.0 or newer, logged in | `gemini-3.8-flash` |
| `opencode` | `opencode run --agent semantic-gate-review [--model <model>] --format default` (with `--standalone` on OpenCode 2) | OpenCode 1.2.0 or newer, with the model's provider configured | `opencode/kimi-k3` |
| `command` | the command and arguments you configure | `command`, plus `commandArgs` and `commandPromptMode` if needed | — |

- **Temperature.** It is sent only when you set it (`temperature` in `.semantic-gate.json` or `SEMANTIC_GATE_TEMPERATURE`); without it, the model's default applies. Current reasoning models (OpenAI from GPT-5 on, Claude from 4.7 on) reject a value other than the default, and Anthropic API version `2026-10-21` removed the parameter: the `anthropic` provider never sends it.
- **OpenCode Zen.** `opencode-api` talks to the models Zen serves through chat completions (Kimi, GLM, DeepSeek, Qwen Max and the free ones). Zen's Claude, GPT and Gemini models use other API formats; for them, use the `opencode` CLI or the vendor's provider.
- **The CLI prompt goes through standard input.** A review prompt easily passes the limit of one argument (128 KiB on Linux; 32 KiB for the whole command line on Windows). `gemini-cli` runs without its interface because its input comes from a pipe, and reads up to 8 MB of it; `--prompt` is not used. `opencode` without a subcommand opens its interface; the headless mode is `opencode run`.
- **CLI versions.** Before the review, the semantic gate runs `<cli> --version`. When the CLI is not installed, its version cannot be read, or it is older than the minimum in the table, it stops without calling the model (`semantic-gate` exits with code 2; in `jgates run`, the state is `unavailable`), and the message gives the version found, the minimum and the command to update: `npm install -g @openai/codex@latest`, `claude update`, `npm install -g @google/gemini-cli@latest` or `opencode upgrade`. A script of yours that does not answer `--version` uses the `command` provider.
- **The CLIs do not edit the project.** `claude-code` runs with no tools at all (`--tools ""`) and no MCP servers. `gemini-cli` runs with `--approval-mode default`: with no one to approve, whatever needs approval (editing a file, running a shell) is denied, even when your settings pick another default mode. `opencode` runs as the `semantic-gate-review` agent, which the semantic gate defines in `OPENCODE_CONFIG_CONTENT` with every permission denied (a configuration you already pass in that variable is kept and only gains the agent). `codex-cli` runs with `--sandbox read-only` by default; it writes only when you ask for it with `--codex-sandbox workspace-write` or `--codex-sandbox danger-full-access` (`--codex-bypass-sandbox` removes the sandbox).

## Preferences and connections

The provider preferences are yours, not the project's: they live in the global `config.json` of `semantic-gate`, next to the key store (`SEMANTIC_GATE_HOME`, else `%APPDATA%\semantic-gate` on Windows, else `$XDG_CONFIG_HOME/semantic-gate`), and apply to every project on the machine. They keep, per known provider, the base URL (the provider's own, replaceable by a proxy), the default model and the key name; and **named connections** of type `openai-compatible` (a gateway: LiteLLM, vLLM, a team proxy, Ollama under `/v1`), with a base URL, the key name in the store, a default model and extra headers with no secret. A project uses a connection with `provider: <name>`.

```bash
jgates providers set <provider> --base-url <url> --model <model> --key-env <NAME>
jgates providers add <name> --base-url <url> --model <model> --key-env <NAME> --header X-Team=core
jgates providers test <name>
jgates providers remove <name>
```

- `jgates providers list` shows each provider and each connection with the value of each field and where it comes from (your preference or the provider's default), and the state of the key (set in the environment or in the store, or missing), never its value. With `--json`, each field is `{ "value", "origin" }`.
- `set` changes a known provider or a connection; an empty value (`--model ""`) removes the field and goes back to the default. `remove` deletes a connection, or the preferences of a known provider.
- `test` lists the models of the provider or connection with the base URL, the headers and the key of the preferences, sending no prompt and spending no token.
- **Precedence, field by field:** the project's value (`jgates.yml`), then your preference, then the provider's default. A project may pin only the model and inherit the base URL and the key from your preferences. The semantic gate state (the card in the interface and `result.semantic.effective`) shows where each value came from: `project`, `user`, `default` or `unset`.
- **`jgates ci` ignores the preferences:** only the policy and the pipeline's environment count. A project that uses a connection in CI gets the state `invalid`, and the reason says so; in CI, use `provider: openai-compatible` with the `baseUrl` in the project or in the policy.
- **A connection name** has lowercase letters, digits and `-` (`^[a-z0-9][a-z0-9-]{0,62}$`) and cannot be the name of a known provider (`openai`, `claude`, `ollama`, `command`...). Its key is the variable of `--key-env`; without it, `<NAME>_API_KEY` (for `litellm-local`, `LITELLM_LOCAL_API_KEY`), and a connection with no key set calls the gateway without `Authorization`.
- **Security.** The base URL is `http` or `https`, with no user, password, query or fragment; `http` is accepted only for loopback (`localhost`, `127.0.0.0/8`, `::1`) or with the explicit confirmation `--allow-http`, because the key would travel in clear text. Changing the base URL drops the confirmation given for the old one. An extra header with a credential name (`Authorization`, `Cookie`, `*-key`, `*-token`, `*-secret`) or with a `Bearer ...` value is refused: the credential goes in the key store. Each refused field comes in the message with its name (`baseUrl`, `headers.X-Api-Key`, `name`), and nothing is written.
- **Through the interface.** The **Preferences > Providers and keys** screen does what `jgates providers` does: Configure (base URL, default model, with the provider's model list when the key is set, key name and headers), Test, Add connection and Remove connection. In the project, the semantic gate card in **Tools** edits the essential fields of `extensions.semantic-gate` (on, provider or connection, model, scope, limits and the optional base URL) with the forms engine: the file is the source, each change is a minimal patch of `jgates.yml`, and a file that changed meanwhile is a revision conflict. Masking and prompts stay in the file.
- `semantic-gate` reads the same preferences: `semantic-gate models list <name>` lists the models of a connection, and `--provider <name>` uses it. In `.semantic-gate.json`, in the environment and in the flags, the values win over the preferences the same way.

## A gateway (LiteLLM or another)

The semantic gate does not embed LiteLLM or any other gateway. It would bring Python and many dependencies into a tool that is dependency-free Node today, and it is one more server to run; LiteLLM has also had malicious versions published on PyPI (1.82.7 and 1.82.8, on 2026-03-24). If you want one central point for keys, quotas, logs or switching models, run the gateway on its own and create a connection for it (or point the `openai-compatible` provider at it in the project).

With the LiteLLM proxy, for example:

```yaml
# the proxy's config.yaml
model_list:
  - model_name: review
    litellm_params:
      model: anthropic/claude-sonnet-5-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

```bash
litellm --config config.yaml   # listens on http://0.0.0.0:4000
```

Create the connection once, with the gateway's `model_name`, and store the gateway's key (the master key or a virtual key, not the vendor's) with `jgates secrets set LITELLM_API_KEY`:

```bash
jgates providers add litellm-local --base-url http://localhost:4000/v1 --model <model_name> --key-env LITELLM_API_KEY
```

`jgates providers test litellm-local` checks the address and the key by listing the models the gateway exposes. Each project then uses the connection by name:

```yaml
# jgates.yml
extensions:
  semantic-gate:
    provider: litellm-local
```

The project may pin a `model` other than the connection's default. Without a connection, the same goes in the project: `provider: openai-compatible`, `baseUrl: http://localhost:4000/v1`, `model: review` and `apiKeyEnv: LITELLM_API_KEY` (the CI way, which does not read the preferences). Through `semantic-gate` directly, `--provider litellm-local` uses the connection, and `--provider openai-compatible --base-url http://localhost:4000/v1 --model review --api-key-env LITELLM_API_KEY` does the same without it. Any other gateway with OpenAI-style `/chat/completions` and `/models` works the same way.

Pin the gateway's version and check where its package or image comes from. The gateway receives the same context as the provider, already masked: trust it as you would trust the provider.

## What the provider receives

Before building the prompt, JGates filters and masks the context, in this order:

1. files that usually hold secrets (`.env`, `.npmrc`, keys and certificates, `~/.aws/credentials`) leave the context, whatever the configuration says;
2. the `excludes` list removes whatever else you want, and the `include` list, when present, lets in only its paths;
3. recognized secrets (values of assignments such as `api_key`, `token` or `password`, and private keys) become a placeholder, always;
4. the enabled PII entities and your own patterns become `[MASKED:<label>]`;
5. the external PII tools, if any, receive a copy of the already masked files and may mask more.

The provider does not see a recognized secret nor a value of an enabled entity.

### Why there is no "mask everything"

Masking requires recognizing what is sensitive, which is done only by patterns or by another program that reads the data (another third party). Masking every literal would make the review pointless. Like any masking by pattern, the one in JGates does not catch everything: the full guarantee is not sending the file, with `excludes` or with the `include` list.

### Configure the masking

```yaml
extensions:
  semantic-gate:
    provider: openai
    apiKeyEnv: MY_API_KEY
    include: ["src/**"]          # optional: only these paths go to the provider
    excludes: ["src/fixtures/**"]
    masking:
      pii:                       # each entity turns on and off; what is not here keeps its default
        cpf: false
        ip-address: true
      patterns:                  # your own regular expressions; the matched text becomes [MASKED:<label>]
        - id: employee-id
          regex: "EMP-\\d{6}"
          label: employee-id     # optional: defaults to the id
          flags: "i"             # optional: i, m, s and u
      tools: [corp-dlp]          # tools of .jgates/pii.yml, in order
      onMatch: mask              # mask (default) or block
```

- `masking.pii`: `cpf`, `cnpj`, `credit-card`, `phone` and `email` are on; `ip-address` is off, because code holds many IPs that are not personal data. Any of them can be turned off. E-mail and IP are recognized only here: the PII detector of the gate does not know them yet. Edge cases: `@scope/package`, `package@1.2.3`, `user@localhost` and `icon@2x.png` are not e-mails; an SSH remote such as `git@host.com:org/repo.git` is masked, and so is a four-part version (`1.2.3.4`) when `ip-address` is on.
- `masking.patterns`: the `id` is unique; the regex may not match an empty text.
- Secrets and the exclusion of secret files cannot be turned off: patterns and tools only add.
- `masking.onMatch: block`: with any finding (from the entities, the patterns or a tool), nothing is sent and the result says why (state `blocked`).
- An invalid regex, a repeated id or a tool that does not exist in `.jgates/pii.yml` make the block invalid, with the field path (for example `extensions.semantic-gate.masking.patterns[0].regex`), and nothing is sent.
- `result.semantic.context.masked` carries the count per label (entities, `secret`, patterns and tools), never the values; `result.semantic.context.tools` carries what each tool said (detected, changed, counts).
- `jgates ci` does not run the semantic gate. The adapter accepts a configuration folder apart from the project (`configDir`), so that, in a governed use, `jgates.yml` and `.jgates/pii.yml` come only from the policy.

### External PII tools

A tool is defined once, in `.jgates/pii.yml`, and used by name:

```yaml
# .jgates/pii.yml
schemaVersion: 1
tools:
  corp-dlp:
    command: node
    args: ["{configDir}/tools/corp-dlp-adapter.mjs"]
    timeoutSeconds: 30           # default 60
    passEnv: [CORP_DLP_TOKEN]    # variables passed on, by name only
```

The tool runs without a shell, with a minimal environment (`PATH`, `HOME`, locale, temp folder) plus `passEnv` (a name missing from the environment comes from the [user key store](#the-api-key), for that tool only). The working directory is the copy, not the project: `{configDir}` in `command` and `args` becomes the configuration folder.

The contract:

- JGates writes a copy of the files in a temporary folder, with the same tree of relative paths, and runs the tool with that folder as working directory and in `JGATES_MASK_DIR`. `JGATES_MASK_FILES` points to a file, outside the folder, with one relative path per line. `JGATES_MASK_MODE` says the use: `context` (the semantic-gate context; the copy already carries the internal masks), `check` (detect only: nothing may change) or `fix` (correct the copy of project files).
- In the semantic-gate context, each file of the copy holds what the provider would see of it (the diff, or the content). When there is more than one part, they are separated by a `@@jgates-mask-part <part>@@` line, which the tool may not change.
- The tool edits the files in place and, at the end, writes one JSON line to stdout, the status (schema in `jgates/schemas/pii/mask-tool-status.schema.json`):

  ```json
  {"jgatesMask":1,"status":"ok","detected":true,"changed":true,"counts":{"employee-id":3},"files":["src/app.js"],"message":"3 ids"}
  ```

  `counts`, `files` (the files where it found something) and `message` are optional. Success is exit code 0 with `status: "ok"`; any other exit code or `status: "error"` is an error. The message must not carry a sensitive value: JGates masks the built-in shapes (CPF, CNPJ, card, phone, e-mail) and secrets in it before showing it, but a value of your own format is not recognized, and the message is cut at 300 characters.
- JGates checks what the tool did: only listed files may change, no file is created or removed, no link; `changed` must match what changed, and `changed: true` requires `detected: true`. In `check` mode, any change is inconsistent.
- Several tools run in order, each one on the result of the previous one.
- Without a guarantee, nothing is sent: an error, a timeout, output without the status, an invalid or inconsistent status, or a file outside the list touched give the code `MASKING_COMMAND_FAILED`; `detected: true` with `changed: false` gives `MASKING_UNRESOLVED` (the tool found something it did not treat). In both cases the state is `unavailable`, and the rest of the run goes on as for any failed semantic review.

An existing CLI that does not speak this status comes in through an adapter: a short script that calls the CLI and translates its result. An example in Node, without dependencies, for a hypothetical CLI `corp-dlp scan --json <file>` that answers `{"findings":[{"start":10,"end":21,"type":"employee-id"}]}`:

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

## The prompts

The texts of the prompt are files of the `semantic-gate` package; the code only assembles them:

| File | What it is |
| --- | --- |
| `semantic-gate/templates/system-prompt.md` | The system prompt (the role of the reviewer and its boundaries). |
| `semantic-gate/templates/semantic-review-skill.md` | The review rubric: hard blockers, axes, score caps and severities. |

In an installed package the folder is `templates/` inside the package. `semantic-gate prompts` shows the absolute paths in use, and `semantic-gate prompts --export <folder>` copies the two files for you to edit (it does not overwrite an existing file without `--force`).

A project replaces or extends each one in `prompts`, with `mode: replace` (the project file takes the place of the packaged text) or `mode: append` (the project file goes after it):

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

- `file` is relative to the configuration folder (the project, or the CI policy in a governed use, the same `configDir` as the masking) and must stay inside it. A missing file, a path outside the folder, a mode other than `replace` or `append`, or a key other than `system` and `review` make the block invalid, and nothing is sent.
- The output contract (the JSON the result reads) is not customizable: it always closes the prompt, and a customized system prompt always ends with `Return valid JSON only. Do not include Markdown fences.`, so the answer stays parseable.
- The prompt files are sent as written: the masking applies to the review context, not to them.
- `result.semantic.prompts` and `result.provenance.semanticPrompts` carry the `sha256` of the prompts in effect (system prompt and rubric together) and, for each one, where it came from (`default`, `project` or `policy`), the mode, the file and the `sha256` of its text. A different prompt file gives a different hash, so a result tells with which prompt it was made.

## The result

The conclusion is stored in `result.semantic`, next to the decision and without changing it. The state is one of these:

| State | Means |
| --- | --- |
| `completed` | The review ran and carries a score and observations. |
| `not-configured` | It was requested with `--semantic`, but no provider is configured. |
| `unavailable` | The provider did not answer or refused. |
| `timeout` | It went past `timeoutSeconds`. |
| `budget-exhausted` | It went past `maxCalls` (one call per context chunk). |
| `blocked` | `masking.onMatch: block` and the masking found something; nothing was sent (`code: MASKING_BLOCKED`). |

When the masking prevents sending, `result.semantic.code` says why: `MASKING_COMMAND_FAILED` or `MASKING_UNRESOLVED` (state `unavailable`) and `MASKING_BLOCKED` (state `blocked`).

`result.semantic.effective` carries the provider in effect (`kind`: `provider`, `connection`, `other` or `unknown`), whether the preferences were read (`preferences`: `used`, or `ignored` in `jgates ci`) and, for `baseUrl`, `model` and `apiKeyEnv`, the value and its origin (`project`, `user`, `default` or `unset`), plus the names of the extra headers of a connection.

An unavailable provider, a timeout, an exhausted budget or a masking block never approves or fails the gate. The interface shows the semantic gate state in a card in Tools, which edits the essential fields as described in [preferences and connections](#preferences-and-connections).

## Limits

- The smoke with a real provider has not been done yet; the tests use a fake provider and spend no tokens. See [limitations](limitacoes.en.md).
- The request is the `--semantic` flag, not a field of `plan.json`: a `jgates run --plan` does not carry the request, and the plan hash does not change because of the review.
- The cost is yours: `maxCalls` limits the calls and `costPerCall`, when informed, makes the result carry the total cost (calls times the value).

## Using it with an agent

The agent context and the fix cycle are in [agents](agentes.en.md). The semantic review complements them; it does not replace the deterministic gate.
