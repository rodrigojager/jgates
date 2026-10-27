# JGates: segurança

O JGates lê e executa ferramentas sobre código que pode não ser confiável, e tem uma interface local. Esta página diz o que ele protege, como, e o que **não** promete. Os limites que ainda existem estão em [limitações](limitacoes.pt-BR.md).

## Repositório não confiável

- Descobrir e editar a configuração **não executa código** do projeto. Ler um `eslint.config.js` é só parsear o texto.
- O plano mostra, antes de qualquer execução, quais etapas executam código do projeto (testes, ESLint, Vitest, pytest). Uma etapa assim nunca vem do cache.
- O runner local não é um sandbox. Isolamento forte só existe no runner de container e, para uma garantia contra o autor do código, na política externa e no [modo governado](#modo-governado). `network: false` no runner local não é anunciado como garantia.
- O runner de container usa a imagem fixada por digest em `.jgates/lock.json`, rede desligada, sistema de arquivos somente leitura, o workspace montado só para leitura, usuário sem privilégio, `--cap-drop ALL` e `no-new-privileges`. Ele recusa `--privileged` e o `docker.sock`.

## Servidor e interface locais

`jgates ui` sobe um servidor só no loopback (`127.0.0.1`). Ele valida em cada pedido:

- o cabeçalho `Host` (421 se não for o esperado), a origem e `Sec-Fetch-Site` (403);
- a sessão, por um cookie `HttpOnly` e `SameSite=Strict`, obtida com um link de uso único dentro de um arquivo do launcher (`0600`); o segredo nunca é impresso no terminal;
- o token anti-CSRF no cabeçalho `X-JGates-CSRF` em toda mutação (403);
- o tipo, o tamanho e o esquema JSON do corpo (415, 413, 400).

A política de conteúdo (`script-src 'self'`, `style-src 'self'`) proíbe script e estilo embutidos. A interface nunca renderiza HTML vindo de relatório ou de log: o conteúdo é escapado.

A interface não recebe caminhos livres. Cada arquivo editável tem um id de vínculo, resolvido no servidor para um caminho canônico; um vínculo fora do workspace, um symlink que escapa dele e uma raiz externa não declarada são recusados, e a gravação confere a revisão (409 `REVISION_CONFLICT` se o arquivo mudou).

## Segredos e dados pessoais

- Segredos nunca entram na configuração. O semantic gate recebe só o **nome** da variável de ambiente (`apiKeyEnv`); o valor vem do ambiente ou do [cofre do usuário](#o-cofre-de-chaves-do-usuário).
- Os achados de segredo e de PII não trazem o valor bruto: ele é mascarado no adaptador, no `result.json`, no SARIF e no contexto para agente.
- O contexto do semantic gate é mascarado antes de sair da máquina: segredos e arquivos de segredo sempre; as entidades de PII, os padrões e as ferramentas externas como o projeto configura (`extensions.semantic-gate.masking`). Uma ferramenta externa que falha ou responde de forma inconsistente faz o JGates não enviar nada. Veja [o semantic gate](semantic-gate.pt-BR.md#o-que-o-provider-recebe).
- A [pasta de dados](pasta-de-dados.pt-BR.md) tem permissão só do usuário (`0700` nas pastas, `0600` nos arquivos em sistemas POSIX). Não existe uma cópia de depuração com segredos.
- A configuração é lida com limites: 1 MiB, 64 níveis, 50 aliases, YAML sem tags executáveis e sem interpolação de comandos.

## O cofre de chaves do usuário

As chaves de API gravadas pela tela **Preferências > Providers e chaves** do `jgates ui`, pelo `jgates secrets set` ou pelo `semantic-gate auth set` ficam num único arquivo do usuário, **fora de qualquer projeto** e fora da [pasta de dados](pasta-de-dados.pt-BR.md): `secrets.json` na pasta de configuração do semantic-gate (`SEMANTIC_GATE_HOME`, senão `%APPDATA%\semantic-gate` no Windows, senão `$XDG_CONFIG_HOME/semantic-gate`, por padrão `~/.config/semantic-gate`). A pasta tem permissão `0700` e o arquivo `0600` em sistemas POSIX; a gravação é atômica (um arquivo temporário renomeado por cima).

- Nada dessas chaves vai para o projeto, para resultados, logs, cache, rascunhos, histórico ou desfazer.
- A variável de ambiente vence o cofre, e a listagem diz de onde vem cada valor. O `jgates ci` nunca lê nem grava o cofre: no CI, só o ambiente conta.
- O valor só entra no ambiente do processo que declara o nome (o provider pelo `apiKeyEnv` ou pelo nome padrão; uma ferramenta de PII pelo `passEnv`).
- Nenhuma saída devolve o valor, nem parte dele: as listagens mostram nome, estado, origem e data.
- Pela tela, o valor é digitado num campo de senha sem autocompletar, que volta vazio depois de salvar, e não fica na página nem no armazenamento do navegador; uma chave guardada aparece como `********` com a data. O servidor local não registra o corpo dessas requisições e nenhuma resposta repete o valor. A gravação pede a sessão, a origem e o token CSRF como as outras rotas, e fica bloqueada no modo governado (`JGATES_POLICY_DIR`) e ao editar a política de CI (`jgates ui --policy`).
- Um arquivo `0600` **não é** um cofre do sistema operacional: qualquer programa que roda com o seu usuário consegue lê-lo, e ele vai junto num backup da pasta pessoal. Numa máquina compartilhada ou sem disco cifrado, prefira a variável de ambiente vinda de um gerenciador de segredos. O uso do Keychain, do Credential Manager e do libsecret está no backlog.

## Dados pessoais nos arquivos do projeto

Para que um dado pessoal (CPF, CNPJ, cartão, telefone, ou o que uma ferramenta sua reconhece) não suba para o git, o JGates verifica e corrige os arquivos do projeto, sempre por um comando explícito. O `jgates run` continua sem mexer no projeto.

```bash
jgates pii check
jgates pii check --staged
jgates pii fix --dry-run --diff <path>
jgates pii fix --yes <path>
jgates pii fix --undo <fixId>
```

- **Escopo.** Sem opção, o que vai entrar no próximo commit: os arquivos alterados e os não rastreados. `--staged` cobre só o que está no índice, `--changed` só os rastreados alterados, `--all` todo o projeto (fora os ignorados pelo Git), e caminhos cobrem os arquivos indicados (uma pasta cobre o que está nela). Arquivos binários e maiores que 8 MiB ficam de fora, listados.
- **`jgates pii check`** detecta com o detector interno (as entidades ligadas no `pii.yml`) e com as ferramentas de `fix.tools` no modo `check`, sobre uma cópia temporária, sem mudar nada. Sai 0 sem achado, 1 com achado e 2 se um detector não terminou, com os arquivos e a contagem por rótulo. O valor encontrado nunca aparece na saída, no JSON (`--json`) nem em log. Com `--staged`, lê o conteúdo do índice, que é o que vai para o commit.
- **`jgates pii fix`** corrige só por uma ferramenta indicada em `fix.tools`: o detector interno só detecta. Sem ferramenta configurada, o comando explica isso, sai com 3 e não muda nada. Com ferramenta:
  1. copia os arquivos do escopo para uma pasta temporária dentro da [pasta de dados](pasta-de-dados.pt-BR.md) e roda nela as ferramentas, em ordem, no modo `fix`, com o [mesmo protocolo do semantic gate](semantic-gate.pt-BR.md#ferramentas-externas-de-pii);
  2. mostra os arquivos que mudariam e a contagem por rótulo; `--diff` mostra o diff no terminal (nunca gravado em log ou resultado) e `--dry-run` para aí;
  3. pergunta (ou aceita `--yes`) e aplica arquivo por arquivo, por escrita atômica, só se o arquivo do projeto ainda tem os bytes da cópia; um arquivo que mudou nesse meio tempo é pulado e listado;
  4. guarda os originais para `jgates pii fix --undo [<fixId>]`, que restaura byte a byte (um arquivo mudado depois da correção não é sobrescrito).
- **Nada é aplicado** se uma ferramenta falha, estoura o tempo, não devolve o status, devolve um status inválido ou inconsistente, mexe num arquivo fora da lista, cria, apaga ou troca um arquivo por link, ou muda um arquivo do projeto fora da cópia enquanto roda. O comando sai com 2 e diz o motivo.
- **Códigos de saída do `pii fix`.** 0 quando tudo foi aplicado ou não havia o que corrigir; 1 quando sobra algo (uma prévia com `--dry-run`, uma mudança não confirmada, um arquivo pulado ou recusado); 2 quando uma ferramenta falhou e nada foi aplicado; 3 para uso ou configuração (inclusive sem `fix.tools`). Sem `--yes` e sem terminal (um script, um agente) nada é aplicado: o comando mostra o resumo e sai com 1.
- **`--staged`** recusa, e lista, um arquivo com parte das mudanças fora do índice: não dá para corrigir só a parte do índice sem risco. Os arquivos corrigidos voltam ao índice (`git add` só deles), e o `--undo` desse fix devolve ao índice o conteúdo anterior.
- **Os originais contêm o dado pessoal.** Ficam em `workspaces/<id>/pii-fix/<fixId>/`, com permissão só do usuário, por 7 dias (`fix.backupRetentionDays`); depois disso o `jgates gc --yes` os apaga, e o próximo `jgates pii fix` do mesmo projeto também.
- **O histórico do git não é limpo.** Corrigir o arquivo não tira do histórico um valor que já foi commitado: ele continua nos commits anteriores e em qualquer clone. Para reescrever o histórico, use o [`git filter-repo`](https://github.com/newren/git-filter-repo) e trate o dado como exposto.

```yaml
# .jgates/pii.yml
schemaVersion: 1
tools:
  corp-dlp:
    command: node
    args: ["{configDir}/tools/corp-dlp-adapter.mjs"]
    timeoutSeconds: 60
fix:
  tools: [corp-dlp]        # em ordem; vazio: pii fix não muda nada
  includes: ["**"]
  excludes: ["vendor/**"]  # valem para pii check e pii fix
  backupRetentionDays: 7
```

## Gancho do Git antes do commit

Opcional: um gancho `pre-commit` (`<hook>` é `pre-commit`) que barra (ou corrige) um commit com dados pessoais nos arquivos do stage. Fica desligado até você instalar.

```bash
jgates hooks install <hook>
jgates hooks uninstall <hook>
```

- **`hook.mode`** no `.jgates/pii.yml` decide o que o gancho faz, lido quando você roda `install`: `block` (o padrão) roda `jgates pii check --staged` e barra o commit com a lista e a dica `jgates pii fix --staged`; `fix` roda `jgates pii fix --staged --yes`, devolve os arquivos corrigidos ao índice e deixa o commit seguir; `off` não grava gancho. No modo `fix` sem ferramenta de correção (`fix.tools`), o gancho avisa e cai no comportamento do `block`: dado pessoal nunca passa em silêncio.
- **Nunca substitui o seu.** Com um gancho `pre-commit` que o jgates não gravou, ou com `core.hooksPath` definido, o `install` não muda nada e mostra a linha para você acrescentar ao seu gancho.
- **A marca.** O gancho tem a linha `# jgates-hook: pre-commit`; o `uninstall` tira só um gancho com essa marca.
- **Qual jgates roda.** O gancho guarda o caminho absoluto do node e do arquivo do CLI que rodou o `install` (sem procurar no `PATH`), então roda o mesmo jgates que o instalou. Se esse arquivo sumir, o gancho barra o commit e manda rodar `install` de novo ou `uninstall`. Mudou ou atualizou o jgates de lugar: rode `install` de novo.
- **Windows.** O gancho é um script `sh`, que o Git para Windows roda no Git Bash; os caminhos são gravados com barras normais.
- `git commit --no-verify` pula o gancho, como em qualquer gancho do Git.

## Cadeia de suprimentos

As dependências diretas ficam em versões travadas no lockfile, com origem e integridade conferidas; as ferramentas Python usam `==`; toda imagem tem a base por digest e todo binário baixado na construção é conferido por `sha256`. O teste `jgates/tests/server-routes-security.test.js` confere essas travas (lockfile, digests das imagens, versões Python), e as licenças estão em `THIRD_PARTY_NOTICES.md`. Nenhum pacote é publicado: o produto é o repositório no GitHub.

## Resultado falso ou antigo

Um resultado é vinculado ao plano, à configuração e ao estado do código (`analyzed`, `provenance`). Se um arquivo analisado muda durante o run, o resultado é marcado como `stale` e um `passed` vira `incomplete` (`INPUTS_CHANGED`). Um run reduzido (`reduced`, por `--skip`, por exemplo) nunca aparece como equivalente a um completo. Logs e hashes locais não substituem a confiança no executor.

## Modo governado

O `jgates ci` é o modo governado: as regras vêm de uma política externa conferida por SHA-256, o commit é analisado numa cópia limpa e o job não escolhe as próprias regras (sem `--skip`, `--waiver`, `--plan` e afins). O JGates não afrouxa esse modo e a interface, quando o detecta, bloqueia a edição. Os scanners nativos ficam fora do `jgates ci` (a ponte endurecida os cobre), e o que vem de ferramentas que executam código do projeto é marcado como autodeclarado. Detalhes em [CI](ci.pt-BR.md). Para impedir que o autor do código mude o gate, use a política externa e um runner controlado.

## Telemetria

Nenhuma telemetria é enviada pelo JGates. O Semgrep roda com `--metrics=off`; para os scanners de terceiros, o JGates não alega um controle que não tem.

## Reportar um problema

Não coloque segredos em issues. Descreva o comando, a saída de `jgates doctor` e o `runId`.

```bash
jgates doctor
```
