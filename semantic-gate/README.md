# semantic-gate

`semantic-gate` is the AI semantic gate of [JGates](../README.md): it asks a model to review the code (correctness, tests, security, maintainability, architecture, performance) against an objective you write, and reports a score and observations. It complements the deterministic [quality gate](../quality-gate/README.md); it does not replace it.

## How JGates uses it

In `jgates`, the semantic review is optional and separate from the decision. It runs only when `jgates.yml` configures a provider (the `extensions.semantic-gate` block) and the run asks for it with `jgates run --semantic`. Its conclusion is stored next to the decision and never approves or fails the run. The configuration keeps only the name of the environment variable that holds the API key. See [the semantic gate in JGates](../docs/jgates/semantic-gate.en.md).

## Direct use

```bash
semantic-gate setup
semantic-gate status
semantic-gate run --scope changed --objective-file .quality/objective.md --json
semantic-gate run --scope full --objective-file .quality/objective.md --json
semantic-gate run --scope paths --path docs --objective-file .quality/objective.md --json
semantic-gate run --ci --scope changed --objective-file .quality/objective.md
```

- `setup` is an interactive assistant for provider, model and key; `status` shows the effective provider, model, threshold and credential status. `init` creates `.semantic-gate.json`, and `config`, `auth` and `models` manage the configuration, the local keys and the model list. `prompts` shows and exports the prompt files (see below).
- API keys come from the environment variable (the provider's default name, or `--api-key-env`) or from the user key store, which the environment always wins over. `semantic-gate auth set <NAME|provider> --key-stdin` stores a key by variable name (`auth set openrouter` stores `OPENROUTER_API_KEY`), `auth list` shows name, state, source and date but never any character of a key, and `auth unset` removes it. The store is `secrets.json` in the user configuration folder (`SEMANTIC_GATE_HOME`, `%APPDATA%\semantic-gate` or `~/.config/semantic-gate`), outside every project, `0600` in a `0700` folder; JGates (`jgates secrets`) uses the same file. A `command` provider that declares `apiKeyEnv` gets that one name from the store, no other. The CLI providers use their own login.
- The objective comes from `--objective-file <path>` or `--objective-stdin`.
- `--scope changed` (the default) reviews what changed in Git (`--base <ref> --head <ref>` set the range), `full` reviews the whole project and `paths` reviews the folders given with `--path`.
- Files are filtered with `.gitignore`, `.jgates.ignore` and `.semantic-gate.ignore`, and with `--exclude`, `--include` and `--ignore-file`.
- `--json` forces JSON output; `--ci` is the headless mode for pipelines and implies JSON.
- The results are `semantic-result.json`, `semantic-result.md` and the raw provider responses under `.quality/semantic-gate/`. Each result carries `scoreAppliesTo`: never present the score of a changed scope as the score of the whole project.
- Providers include `openrouter`, `openai`, `anthropic`, `gemini`, `ollama`, `openai-compatible`, `opencode-api`, a custom `command`, and the CLIs `codex-cli`, `claude-code`, `gemini-cli` and `opencode`. `semantic-gate --help` lists them all; the table below says what each one needs.

## Providers

Checked against each provider's official documentation on 2026-10-27; the example models were current ids on that date.

| Provider | Calls | Needs | Example model |
| --- | --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-5.5` |
| `openai` | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` | `gpt-6-astra` |
| `anthropic` | `https://api.anthropic.com/v1/messages`, API version `2026-10-21` | `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) | `claude-opus-5-5`, `claude-sonnet-5-5` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, key in the `x-goog-api-key` header | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-3.8-flash`, `gemini-4-argon` |
| `ollama` | `http://127.0.0.1:11434/api/chat` (or `OLLAMA_HOST`, or `--base-url`) | an Ollama server with the model pulled | a name from `ollama list` |
| `openai-compatible` | `<base-url>/chat/completions` | `--base-url` and `SEMANTIC_GATE_API_KEY` (or `--api-key-env`) | the name the server exposes |
| `opencode-api` | `https://opencode.ai/inference/openai/v1/chat/completions` (OpenCode Zen) | `OPENCODE_API_KEY` | `kimi-k3` |
| `codex-cli` | `codex exec [-m <model>] --sandbox <mode> --skip-git-repo-check -` | Codex CLI 0.122.0 or newer | `gpt-6-astra` |
| `claude-code` | `claude --print [--model <model>] --tools "" --strict-mcp-config` | Claude Code 2.1.0 or newer | `sonnet`, `claude-sonnet-5-5` |
| `gemini-cli` | `gemini [--model <model>] --approval-mode default --output-format text` | Gemini CLI 0.30.0 or newer | `gemini-3.8-flash` |
| `opencode` | `opencode run --agent semantic-gate-review [--model <model>] --format default` (`--standalone` on OpenCode 2) | OpenCode 1.2.0 or newer | `opencode/kimi-k3` |
| `command` | the `--command` and `--command-args` you give | a CLI that reads the prompt from stdin or a `{prompt}` argument | — |

- The temperature is sent only when you set it (`temperature` in the config or `SEMANTIC_GATE_TEMPERATURE`). Current reasoning models reject any value but their default, and the `anthropic` provider never sends it (API version `2026-10-21` removed it).
- The CLI presets send the prompt on stdin, which avoids the operating system's argument-length limits. Before the review, `semantic-gate` runs `<cli> --version`; a CLI that is missing, older than the minimum, or whose version cannot be read stops the run before the model is called (exit code 2), with the version found, the minimum and the update command (`npm install -g @openai/codex@latest`, `claude update`, `npm install -g @google/gemini-cli@latest`, `opencode upgrade`). A wrapper script that does not answer `--version` uses the `command` provider.
- A gateway (a LiteLLM proxy or another) is not embedded: run it on its own and either create a named connection for it (below) or point `openai-compatible` at it, as in `--provider openai-compatible --base-url http://localhost:4000/v1 --model <gateway model name> --api-key-env LITELLM_API_KEY`. See [the gateway section](../docs/jgates/semantic-gate.en.md#a-gateway-litellm-or-another).

### Provider preferences and connections

The global `config.json` (next to the key store, outside every project) also keeps the user's provider preferences, which `jgates providers` manages and `semantic-gate` reads:

```json
{
  "providers": { "openrouter": { "baseUrl": "https://proxy.example.com/api/v1", "model": "anthropic/claude-sonnet-5.5", "apiKeyEnv": "TEAM_OPENROUTER_KEY" } },
  "connections": {
    "litellm-local": { "type": "openai-compatible", "baseUrl": "http://localhost:4000/v1", "model": "review", "apiKeyEnv": "LITELLM_API_KEY", "headers": { "X-Team": "core" } }
  }
}
```

- Per known provider: base URL, default model and key name. A field set by the project (`.semantic-gate.json`), the environment or a flag wins; the preference comes next, then the provider's default (and the preference also wins over the flat `baseUrl`/`model`/`apiKeyEnv` keys of the same global file).
- A named connection (`^[a-z0-9][a-z0-9-]{0,62}$`, never the name of a known provider) is used with `--provider <name>`: the call goes to its base URL with its extra headers and the key of its `apiKeyEnv` (default `<NAME>_API_KEY`; with no key set, no `Authorization` header is sent). `semantic-gate models list <name>` lists its models.
- The rules are checked again when the config is read and before any call: `http` only for loopback (`localhost`, `127.0.0.0/8`, `::1`) unless `allowInsecureHttp: true` confirms it, no user, password, query or fragment in the URL, and no header with a credential name (`Authorization`, `Cookie`, `*-key`, `*-token`, `*-secret`) or a `Bearer ...` value. A broken entry is left out.

## Prompts

The prompt texts are files; the code only assembles them:

- `templates/system-prompt.md`: the system prompt;
- `templates/semantic-review-skill.md`: the review rubric.

`semantic-gate prompts` shows the absolute paths in use (and the project files, if any); `--json` gives them as JSON. `semantic-gate prompts --export <dir>` copies the two files to edit; it refuses to overwrite an existing file unless `--force` is given.

A project replaces or extends each one in `.semantic-gate.json` (or in the global config), with `mode: replace` or `mode: append` and a `file` relative to the config file that sets it:

```json
{
  "prompts": {
    "review": { "mode": "append", "file": ".semantic-gate/review.md" },
    "system": { "mode": "replace", "file": ".semantic-gate/system.md" }
  }
}
```

The output contract (the JSON the result parser reads) is not customizable: it always closes the prompt, and a customized system prompt always ends with the instruction to return JSON only. A missing file stops the run before any provider call (exit code 3). In JGates the same settings live in `jgates.yml > extensions.semantic-gate.prompts`, and the hash of the prompts in effect goes to the provenance of the result; see [the semantic gate in JGates](../docs/jgates/semantic-gate.en.md#the-prompts).

## Care with the CLI providers

The `claude-code`, `gemini-cli` and `opencode` presets keep the CLI from editing the project: Claude Code runs with no tools and no MCP servers; Gemini CLI runs headless with `--approval-mode default`, so whatever needs approval (edits, shell) is denied; OpenCode runs as the `semantic-gate-review` agent, which `semantic-gate` defines in `OPENCODE_CONFIG_CONTENT` with every permission denied (an inline config you already pass there is kept). Custom `--command-args` replace the preset, and these guards with it.

With `--provider codex-cli`, the Codex CLI runs with `--sandbox read-only` and `--skip-git-repo-check` by default: the review only reads, it never writes. Write access is opt-in: `--codex-sandbox workspace-write` or `--codex-sandbox danger-full-access`, and `--codex-bypass-sandbox` removes the sandbox altogether. `--no-codex-skip-git-repo-check` makes Codex require a Git repository.

The review sends code to the provider you chose. JGates masks recognized secrets and personal data in the context it builds, but masking by pattern does not catch everything: do not send a repository with sensitive data to a provider you do not trust.

## Development

```bash
npm run test:build
```

rebuilds `dist/` and runs the tests. `npm test` runs them against the files already built. The tests use a fake provider and spend no tokens.

## Documentation

- [Getting started](../docs/jgates/primeiros-passos.en.md) and [the semantic gate in JGates](../docs/jgates/semantic-gate.en.md).
- [Using JGates with AI agents](../docs/jgates/agentes.en.md) and [security](../docs/jgates/seguranca.en.md).
- [Known limitations](../docs/jgates/limitacoes.en.md): the check with a real provider has not been done yet.
