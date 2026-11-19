# JGates: armazenamento e limpeza

Tudo o que o JGates cria na sua máquina fica na [pasta de dados](data-folder.pt-BR.md) ou no motor de contêineres, e todo objeto do motor leva o rótulo `org.jgates.managed=true`. A limpeza seleciona os objetos por esse rótulo, nunca pelo nome: uma imagem ou um volume sem o rótulo nunca é tocado, mesmo que o nome pareça de JGates.

## O que ocupa espaço

| O quê | Onde | Volta com |
| --- | --- | --- |
| A imagem de ferramentas do JGates | o motor (uma imagem) | `jgates setup` |
| Dados de segurança (bases de vulnerabilidades) | o volume `jgates-data` | `jgates tools update-data` |
| Versões de linguagens e navegadores que um projeto fixa | o volume `jgates-toolchains` | `jgates deps prepare` |
| Caches de pacotes | o volume `jgates-cache` | a próxima instalação |
| O bundle do CodeQL (se você o preparou) | o volume `jgates-codeql` | `jgates tools prepare-codeql` |
| A cópia sincronizada de cada projeto | o volume `jgates-<workspace>-src` | a próxima execução |
| As dependências de cada componente | os volumes `jgates-<workspace>-deps-<componente>` | `jgates deps prepare` |
| Suas imagens próprias | o motor (uma imagem por workspace) | `jgates tools build-extension` |
| Execuções, logs, rascunhos, planos | a pasta de dados | não são recriados |

A imagem é o maior item: cerca de 5 GB para baixar e uns 13 GB descompactada, como a última construção da imagem mediu. O `jgates setup` confere se o disco tem espaço para os dois, mais uma margem, antes de baixar, e responde `DISK_LOW` quando não tem.

A imagem Linux amd64 fixada mede 4,52 GB compactada e 12,52 GB descompactada. Os totais incluem as camadas da imagem, antes das dependências dos projetos e das bases de avisos.

## Ver os números

```bash
jgates status
```

A última linha mostra o disco que o JGates usa e o que está livre. A tela **Armazenamento** da interface (`#/preferences/storage`) mostra o mesmo por categoria, conta uma só vez as camadas de imagem compartilhadas e oferece os botões abaixo.

## Limpar o que não está em uso

```bash
jgates clean --dry-run
jgates clean --yes
```

Sem escopo, o `clean` remove tudo o que não está em uso: as imagens de outras versões do JGates, os volumes e as imagens próprias de workspaces cuja pasta não existe mais, contêineres parados do JGates, redes deixadas por execuções, execuções antigas (a retenção do [`gc`](data-folder.pt-BR.md#ver-e-limpar)) e a pasta antiga de ferramentas de versões anteriores. Ele sempre lista antes cada objeto com o tamanho e o motivo, e não remove nada sem `--yes` (ou a sua resposta num terminal). Sem terminal e sem `--yes`, continua sendo uma simulação.

Um objeto em uso é pulado e aparece como "em uso": a imagem que esta versão do JGates fixa, um contêiner em execução, um volume que um contêiner do JGates em execução usa, uma execução em andamento. Cada remoção é relatada linha a linha com o espaço liberado; o código de saída é 2 quando algo ficou.

Um escopo limita o que é limpo:

```bash
jgates clean --images --dry-run
jgates clean --toolchains --dry-run
jgates clean --caches --dry-run
jgates clean --data --dry-run
jgates clean --orphans --dry-run
jgates clean --runs --dry-run
jgates clean --workspace <id> --dry-run
```

- `--images`: imagens do JGates que não estão em uso (voltam com `jgates setup`);
- `--data`: os volumes de dados de segurança (as verificações que precisam deles ficam `incomplete` com `DATA_MISSING` até o `jgates tools update-data`);
- `--toolchains`: o volume de versões de linguagens e navegadores;
- `--caches`: os caches de pacotes compartilhados;
- `--workspace <id>`: os volumes e as imagens próprias de um workspace (o id é `ws_` seguido de 16 dígitos hexadecimais; veja `jgates workspaces list`);
- `--orphans`: os objetos de workspaces cuja pasta sumiu;
- `--runs`: só a retenção das execuções.

A interface faz o mesmo: cada linha da tela Armazenamento tem Remover, Limpar ou Atualizar, toda ação mostra antes a lista e o total, e há o botão "Limpar o que não está em uso".

A imagem do sidecar do quality gate antigo (`jgates/quality-sidecar:latest`) foi construída à mão e não tem rótulo do JGates, então nunca é removida por padrão. Ela é listada à parte, e `jgates clean --legacy-sidecar --yes` a remove.

## Remover tudo o que o JGates criou

```bash
jgates uninstall --dry-run
jgates uninstall --yes
```

O `uninstall` remove todo objeto que o JGates rotulou (contêineres, redes, volumes e imagens), a pasta antiga de ferramentas e a pasta de dados (execuções, histórico, rascunhos). Sem `--yes`, só lista. Antes de remover a pasta de dados, ele confere que ela realmente é uma (não a sua pasta pessoal, a raiz de um disco, um link ou uma pasta que guarda um projeto).

- `--keep-config-notes` mantém as preferências e a lista de workspaces conhecidos na pasta de dados.
- O cofre de chaves de API (o `secrets.json` do usuário, veja [segurança](security.pt-BR.md#o-cofre-de-chaves-do-usuário)) só é removido com `--include-key-store`, e só depois de uma confirmação à parte num terminal.
- **Os seus projetos nunca são tocados.** O `uninstall` lista o que o JGates deixou neles (`jgates.yml`, `.jgates/`, um gancho do Git instalado, com o comando que remove o gancho) e deixa isso com você.
- A última linha diz como remover o próprio programa `jgates`, conforme o jeito como ele foi instalado.

```bash
jgates uninstall --keep-config-notes --dry-run
jgates uninstall --include-key-store --dry-run
```

Na interface, **Remover tudo do JGates…** na tela Armazenamento pede que você digite a palavra mostrada antes de remover qualquer coisa.

## Retenção das execuções

O `jgates gc` aplica a retenção às execuções da pasta de dados (30 dias, 2 GiB por workspace e 10 GiB no total, por padrão) e é a parte de execuções do `clean`; veja a [pasta de dados](data-folder.pt-BR.md#ver-e-limpar).
