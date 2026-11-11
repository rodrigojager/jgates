# JGates: problemas comuns

Cada erro do JGates traz um código (`error.code`), uma mensagem e uma instrução de correção (`error.fix`). Esta página reúne os mais frequentes. Na dúvida, comece pelo estado de prontidão da máquina:

```bash
jgates status
```

O `status` mostra o motor de contêineres, a imagem de ferramentas, a idade dos dados de vulnerabilidades e o que o projeto atual tem pronto. O `jgates doctor` vai além: classifica o que o plano do projeto não tem como essencial, opcional ou não usado e oferece preparar (veja [primeiros passos](getting-started.pt-BR.md)). Nenhum dos dois instala um scanner, um linter ou um executor de testes na sua máquina, porque nenhum é necessário lá.

## A execução terminou "incomplete" (saída 2)

Incompleto não é reprovado: significa que falta evidência. Veja o motivo de cada etapa no resultado; os códigos estão na [lista de motivos](#códigos-de-motivo) abaixo.

- **`TOOL_MISSING` e `TOOL_UNAVAILABLE`.** A imagem de ferramentas desta versão do JGates não tem a ferramenta, ou a versão dela está fora da faixa que o adaptador aceita. Rode `jgates setup` para baixar a imagem que esta versão fixa. Uma ferramenta nunca é instalada no computador.
- **Etapa `blocked`.** Falta no projeto um arquivo de configuração (o ESLint sem `eslint.config`, por exemplo) ou o provedor de cobertura (`@vitest/coverage-v8`, `pytest-cov`). Cobertura não medida é "não medida", nunca 0%.
- **`INPUTS_CHANGED`.** Um arquivo analisado mudou durante a execução. Rode de novo sem mexer no código.
- **Cobertura parcial de arquitetura.** O grafo de imports não resolveu uma dependência (um alias, por exemplo). Isso é uma lacuna de cobertura, nunca uma aprovação: ajuste a configuração do alias.

## O motor de contêineres

- **`ENGINE_NOT_INSTALLED`.** Nenhum motor compatível com o Docker foi encontrado. Instale um (Docker Desktop, Rancher Desktop, Podman Desktop ou o Docker Engine no Linux), ou aponte `JGATES_CONTAINER_RUNTIME` para o executável dele, e rode `jgates setup`.
- **`ENGINE_STOPPED`.** O motor está instalado, mas não está rodando. Inicie-o (num terminal, `jgates setup --yes` o inicia quando isso não pede senha de administrador) e rode de novo.
- **O `docker` pede `sudo` no Linux.** O seu usuário precisa entrar no grupo `docker` (`sudo usermod -aG docker $USER` e uma sessão nova). O JGates não faz isso por você.
- **`ENGINE_LOST`.** O motor parou durante a execução, então as verificações que estavam rodando ficam incompletas. Inicie-o e rode de novo.
- **`UNSUPPORTED_PLATFORM`.** O motor roda outra plataforma que não Linux amd64 (um motor arm64, por exemplo). O JGates usa só imagens `linux/amd64` nesta versão.
- **Pouca memória (`ENGINE_LOW_MEMORY`).** Um passo pede 4 GB de memória e 2 CPUs por padrão. Aumente a memória do motor (Docker Desktop: Settings, Resources; no Windows com WSL 2 o limite também pode ser definido no `.wslconfig`) e rode `jgates status` para ver o novo valor.
- **A imagem (`IMAGE_MISSING`, `IMAGE_PULL_FAILED`, `IMAGE_VERSION_MISMATCH`).** Rode `jgates setup`: ele baixa a imagem que esta versão fixa e reaproveita o que já chegou. Atrás de um registro que você não alcança, use [`jgates tools export` e `import`](getting-started.pt-BR.md#máquinas-offline).
- **`DISK_LOW`.** O download precisa de espaço para a imagem compactada e descompactada mais uma margem. Libere espaço ou rode `jgates clean` (veja [armazenamento e limpeza](storage.pt-BR.md)).

## Windows e WSL

- **O Docker Desktop está esperando o WSL.** O backend padrão do Docker Desktop é o WSL 2, que o Windows precisa ter habilitado; siga as páginas de instalação da Docker e da Microsoft e depois rode `jgates status`.
- **Memória.** O WSL 2 pega o limite de memória do lado do Windows. Se `ENGINE_LOW_MEMORY` aparecer numa máquina com muita RAM, aumente o limite em Resources do Docker Desktop ou em `%UserProfile%\.wslconfig`.
- **"O Git recusou o repositório" / `detected dubious ownership`.** A pasta pertence a outra conta (muitas vezes o grupo Administradores, quando um terminal elevado a criou), e o Git se recusa a lê-la a partir do seu usuário. O resultado passa então a valer para o conteúdo da pasta, não para um commit, e a mensagem traz o comando que o Git sugere: `git config --global --add safe.directory <pasta>`. Rode-o uma vez, ou assuma a posse da pasta.
- **Maiúsculas e minúsculas.** Os sistemas de arquivos do Windows e do macOS ignoram a diferença entre maiúsculas e minúsculas nos nomes, e a cópia do seu projeto no volume é Linux e não ignora. Um import como `from Utils import x` que acha `utils.py` no Windows falha no contêiner. A falha é real: corrija a caixa no código, e o projeto passa a funcionar também em servidores Linux.
- **Termos do Docker Desktop.** O Docker Desktop tem termos de licença próprios, que dependem de quem o usa. Rancher Desktop, Podman Desktop e Docker Engine também funcionam com o JGates.

## Códigos de motivo

O JGates explica por que algo não rodou com um código fixo, um texto no seu idioma e uma ação. O texto cru do motor só aparece nos detalhes.

- **`ENGINE_NOT_INSTALLED`**: sem motor; instale um ou defina `JGATES_CONTAINER_RUNTIME`.
- **`ENGINE_STOPPED`**: o motor está parado; inicie-o.
- **`ENGINE_LOW_MEMORY`**: o motor tem menos memória do que uma verificação do plano precisa; aumente-a nos recursos do motor.
- **`DISK_LOW`**: falta espaço livre para baixar as ferramentas; abra o Armazenamento ou libere espaço.
- **`IMAGE_MISSING`**: a imagem de ferramentas não foi baixada; `jgates setup`.
- **`IMAGE_PULLING`**: o download está em andamento; continue configurando.
- **`IMAGE_PULL_FAILED`**: o download parou; `jgates setup` de novo.
- **`IMAGE_VERSION_MISMATCH`**: a imagem é de outra versão do JGates; `jgates setup`.
- **`TOOL_MISSING`**: uma ferramenta que o plano precisa não está na imagem; a imagem desta versão é a única correção.
- **`ENGINE_LOST`**: o motor parou durante a execução; inicie-o e rode de novo.
- **`UNSUPPORTED_PLATFORM`**: o motor não é Linux amd64.
- **`DEPENDENCIES_NOT_READY`**: as dependências de um componente não estão preparadas; `jgates deps status`.
- **`DEPENDENCIES_FAILED`**: a instalação falhou; leia o log e rode `jgates deps prepare` de novo.
- **`DATA_MISSING`**: uma base de vulnerabilidades nunca foi baixada; `jgates tools update-data`.
- **`DATA_STALE`**: ela é mais velha que `execution.dataMaxAgeDays`; `jgates tools update-data`.
- **`CUSTOMER_SUPPLIED`**: o CodeQL é seu para preparar; `jgates tools prepare-codeql`.
- **`EXTENSION_OUTDATED`**: a sua imagem própria mudou; `jgates tools build-extension`.
- **`SERVICES_NOT_READY`**: um serviço não ficou saudável a tempo; veja [serviços](services.pt-BR.md).
- **`SERVICES_REQUIRED`**: uma verificação precisa de serviços e nenhum está configurado; veja [serviços](services.pt-BR.md).
- **`NOT_APPLICABLE_TO_PROJECT`**: a verificação não se aplica a este projeto; ela nunca bloqueia.
- **`HOST_EXECUTION_REFUSED`**: um passo rodaria fora do contêiner, então o JGates o recusou. Não há ação para você: reporte como um defeito.

## O plano é recusado (saída 3)

- **`PLAN_EMPTY`.** Nada foi selecionado. Revise o perfil, o escopo e o `--only`.
- **`PLAN_NOT_APPROVABLE`.** O plano tem um bloqueio (`CONFIG_INVALID` com `arquivo:linha`, um requisito sem cobertura, `EVIDENCE_MISSING` num comando genérico). Rode `jgates plan` e leia "Como resolver".
- **`PLAN_STALE`, `PLAN_TAMPERED`.** Um plano salvo (`--plan`) não confere mais com o projeto ou foi alterado. Gere o plano de novo.
- **`PLAN_WITH_FLAGS`.** `--plan` não combina com as opções que montam o plano.
- **`OPTION_NOT_SUPPORTED`.** Num projeto com `jgates.yml`, as opções antigas (`--bridge-mode` e afins) não se aplicam; escolha por perfil, `--skip` ou `--only`.
- **`CONFIG_EXISTS`.** Já existe uma configuração. O `jgates init` não a sobrescreve.

```bash
jgates config validate
jgates plan
```

## A configuração não salva

- **`REVISION_CONFLICT`.** O arquivo mudou no disco desde que você o abriu. A interface mostra a base, a sua e a versão atual; escolha qual manter. Pela CLI, passe o novo `--if-match`.
- **`STRUCTURED_EDIT_UNAVAILABLE`.** O formulário estruturado de TOML não está disponível; o texto continua editável.
- **`GOVERNED_LOCKED`.** O servidor detectou o modo governado (`JGATES_POLICY_DIR`). A edição é bloqueada de propósito.
- **Edição visual recusada em JS.** Uma configuração dinâmica (função, spread, import calculado) só pode ser editada como texto.

## A interface

- Peça um link novo com `jgates ui`; o link de entrada é de uso único e vale 10 minutos. O servidor responde só em loopback, e um proxy ou um nome de host diferente recebe 421.
- Uma execução por vez: a segunda recebe 409 enquanto a primeira não terminou.
- Os controles marcados como indisponíveis e o filtro por componente que não aparece estão em [limitações](limitations.pt-BR.md).

## Espaço em disco e cache

- Rode `jgates status` para ver o espaço que o JGates usa e `jgates clean --dry-run` para ver o que não está em uso (veja [armazenamento e limpeza](storage.pt-BR.md)).
- Rode `jgates gc --dry-run` para ver o que a retenção das execuções apagaria (veja a [pasta de dados](data-folder.pt-BR.md)).
- Um resultado "reaproveitado" de uma execução anterior vem do cache. Para forçar uma execução de verdade, use `jgates run --no-cache`.
- Os maiores itens são a imagem de ferramentas e os volumes de dependências. Apagar os dados de vulnerabilidades só faz o próximo `jgates setup` ou `jgates tools update-data` baixá-los de novo.

## macOS

O macOS não foi testado numa máquina real (veja [limitações](limitations.pt-BR.md)). Se algo falhar, anote o comando, o `runId` e a saída do `jgates status`.
