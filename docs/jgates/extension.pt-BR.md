# JGates: suas ferramentas e imagens

O JGates traz uma imagem de ferramentas completa, com as ferramentas de Python, TypeScript e JavaScript, Go, Rust e .NET. Quando o seu projeto precisa de uma ferramenta ou de uma linguagem que a imagem não tem, você a estende. Nada é instalado na sua máquina: a ferramenta mora numa imagem de contêiner que você descreve no projeto, e o JGates a constrói em cima da dele.

Uma extensão tem duas partes, mais uma opcional:

1. **Obter a ferramenta**: uma imagem pronta que já existe, ou linhas que você acrescenta ao `.jgates/image/Dockerfile`, que o JGates constrói em cima da imagem de ferramentas.
2. **Registrar a ferramenta** no `.jgates/tools.yml` com o adaptador `generic-command`: o comando, os argumentos, como ler o resultado e o que ela verifica.
3. **Uma linguagem que o JGates não conhece** (opcional): declare o componente com essa linguagem na tela Workspace, ponha o toolchain dela no Dockerfile e registre as ferramentas. As verificações do componente passam a rodar como as demais.

Use um descritor para um linter integrado cujo programa venha na imagem do JGates e cujas evidências e formato de saída sejam compatíveis com o motor de descritores. O descritor define a ativação, a faixa de perfis, o leitor da saída e a confiança. Use `generic-command` para uma ferramenta ou um comando específico do seu projeto. [Consulte o catálogo integrado](tools.pt-BR.md).

## Adicionar uma ferramenta pela interface

Na tela Ferramentas, **Adicionar ferramenta** oferece dois caminhos: uma ferramenta do catálogo e **Própria**. O segundo é um diálogo de seis passos (teclado primeiro; `Esc` fecha e devolve o foco):

1. **Como obter**: uma imagem pronta (o JGates confere que o motor a tem e que é `linux/amd64`) ou instalar no ambiente do JGates com pip ou uv, npm, apt, ou um binário baixado de um endereço `https` com o SHA-256. Uma prévia mostra as linhas do Dockerfile que serão acrescentadas.
2. **Como executar**: o comando, os argumentos (um por linha, sem shell) e o componente em que roda.
3. **Como ler o resultado**: SARIF (recomendado para análise e segurança), JUnit (testes), Checkstyle, ou só passou ou falhou.
4. **O que verifica**: as capacidades do catálogo, agrupadas por categoria, mais uma nova capacidade própria sua.
5. **Revisão**: a entrada exata do `tools.yml` e as linhas do Dockerfile, com um diff quando os arquivos existem, e os efeitos (rede, build).
6. **Testar agora**: constrói a imagem se preciso, roda a ferramenta uma vez numa cópia do projeto e mostra o que o relatório deu, ou por que não pôde ser lido. Salvar não depende do teste, mas uma ferramenta não testada fica marcada como "não testada" até a primeira execução bem-sucedida.

Quando você declara um componente numa linguagem para a qual o JGates ainda não tem verificações (C++, por exemplo), o diálogo oferece adicionar uma ferramenta própria para ela, com o componente já escolhido.

## Adicionar uma ferramenta pela linha de comando

```bash
jgates tools add-custom bandit --install pip:bandit==1.8.0 --command bandit --arg -r --arg "{workspace}" --arg -f --arg sarif --arg -o --arg "{output}/bandit.sarif" --report sarif:bandit.sarif --capability sast --dry-run
jgates tools build-extension --yes
jgates tools test bandit
```

- `add-custom <id>` escreve a entrada do `tools.yml` e, com `--install`, as linhas do Dockerfile. `--dry-run` só imprime o diff dos dois arquivos. Os métodos de `--install` são `pip:<pacote>`, `npm:<pacote>`, `apt:<pacote>` e `binary:<endereço https>#sha256=<hex>` (repita a opção para mais de um). `--image <referência>` usa uma imagem pronta no lugar (ela já precisa estar no motor; use uma coisa ou a outra). `--arg` se repete para cada argumento; `{workspace}` é o projeto sincronizado, `{component}` a pasta do componente e `{output}` a pasta onde a ferramenta escreve o relatório. `--capability` diz o que ela verifica (veja `jgates tools list`), `--component` a limita a um componente, `--network` deixa que use a rede quando roda e `--timeout` define os segundos até ela ser interrompida.
- `build-extension` constrói a imagem a partir do `.jgates/image/Dockerfile`. Usa a rede (as linhas de instalação) e avisa antes de começar; pede confirmação num terminal, e `--yes` dispensa a pergunta.
- `test <id>` constrói a imagem se estiver desatualizada (`--no-build` dispensa isso), roda a ferramenta uma vez e mostra os achados, ou por que o relatório não pôde ser lido.

A ferramenta aparece como "ferramenta própria" e **nunca conta como capacidade validada** na [matriz de compatibilidade](compatibility.pt-BR.md): a revisão a lista com as capacidades que você escolheu.

## Os arquivos

```yaml
# .jgates/tools.yml
schemaVersion: 1
tools:
  bandit:
    adapter: generic-command
    image: extension          # extension | tools | <referência da imagem>
    command: bandit
    args: ["-r", "{workspace}", "-f", "sarif", "-o", "{outputDir}/bandit.sarif"]
    capabilities: [sast]
    config:
      effects: { readsCode: true, writesOutputs: true, mayChangeCode: false, executesProjectCode: false, usesNetwork: false }
      evidence: { kind: sarif, file: bandit.sarif, failOn: error }
```

```dockerfile
# .jgates/image/Dockerfile
ARG JGATES_TOOLS
FROM ${JGATES_TOOLS}
USER root
RUN UV_TOOL_DIR=/opt/jgates-ext/uv UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --force --no-cache 'bandit==1.8.0'
USER 10001:10001
```

No arquivo, os marcadores são `{workspace}`, `{outputDir}` e `{componentRoot}`: o `add-custom` os escreve no lugar do que você digita como `{workspace}`, `{output}` e `{component}`.

Uma instalação explícita via pip pode substituir, na sua imagem de extensão, um executável herdado da imagem base. Se a compilação de um Dockerfile antigo falhar porque o executável já existe, acrescente `--force` ao comando `uv tool install` e reconstrua a imagem.

O Dockerfile precisa começar com essas duas linhas: o JGates preenche `JGATES_TOOLS` com a imagem de ferramentas que ele fixa, e recusa um Dockerfile que não as tenha. Mantenha a última linha, para a ferramenta rodar com um usuário sem privilégios. A imagem se chama `jgates-ext-<workspace>:<hash>` e leva os rótulos do JGates; projetos com o mesmo Dockerfile a compartilham.

## Como o resultado é lido

O `evidence.kind` da entrada diz como:

| `evidence.kind` | O JGates lê | A verificação falha quando |
| --- | --- | --- |
| `sarif` | SARIF 2.1.0: regra, mensagem, arquivo, linha, severidade, impressões digitais | há achados no nível de `failOn` ou acima (`error`, `warning` ou `note`; padrão `error`) |
| `junit` | XML JUnit: casos com status, duração e texto da falha | algum caso falhou ou deu erro (`failOn: failure` ou `error`) |
| `checkstyle` | XML Checkstyle: arquivo, linha e severidade | há achados no nível de `failOn` ou acima (padrão `error`) |
| `exit-code` | só o código de saída | o código não está em `successExitCodes` |

Um relatório ausente ou ilegível é `invalid`, nunca `passed`. Os achados de ferramentas próprias aparecem nos resultados, nas linhas de base, nas dispensas e na exportação SARIF como os demais, marcados como "ferramenta própria". Sem relatório (`exit-code`), uma capacidade de segurança, arquitetura ou testes continua sem prova. Veja [adaptadores](adapters.pt-BR.md#comando-genérico).

## Quando a imagem fica desatualizada

O JGates tira uma impressão digital do Dockerfile, dos arquivos ao lado dele (o contexto do build se limita a `.jgates/image/`) e do digest da imagem de ferramentas. Quando a impressão muda, os passos que usam a imagem ficam bloqueados com o motivo `EXTENSION_OUTDATED` e a ação "Reconstruir a imagem" (interface) ou `jgates tools build-extension` (linha de comando). Depois de uma atualização do JGates a base muda, então a imagem é reconstruída uma vez e a tela diz por quê. O `jgates status` lista as imagens de extensão.

O build é uma preparação, nunca parte de uma execução, e pode usar a rede. O Dockerfile é seu: o JGates mostra o que vai construir e nunca constrói durante uma execução.

## No CI

O `jgates ci` segue a política de quem controla o pipeline. Com `execution.extensionImage: forbid`, qualquer imagem de extensão (o `.jgates/image` do projeto e qualquer ferramenta numa imagem que não seja a de ferramentas) é recusada. Com `pinned`, só imagens prontas nomeadas por digest (`nome@sha256:...`) são aceitas, uma imagem construída do Dockerfile do projeto não tem digest fixo e é recusada, e a imagem de ferramentas do job precisa ser a que este JGates fixa. Veja [CI](ci.pt-BR.md#imagens-e-extensões).
