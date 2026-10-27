# JGates: o editor das ferramentas

Cada ferramenta tem uma área própria na interface (`#/tools`, depois a ferramenta). O editor mexe nos arquivos de configuração **reais** do projeto (`pyproject.toml`, `eslint.config.js`, `.jscpd.json`...): o texto do arquivo é a fonte; o formulário é uma projeção validada dele. Nada fica guardado num formato paralelo do JGates.

## A área de uma ferramenta

- **Opções** (a aba padrão): formulário dos campos suportados, com valor padrão, exemplo, unidade e limites. "Usar valor herdado" é um controle separado de `false`, `0` ou vazio. Os grupos "Uso comum" e "Avançado" evitam uma página com centenas de opções, e a busca acha regra, descrição e caminho do campo.
- **Arquivos**: os arquivos vinculados à ferramenta, com editor de texto, erros de sintaxe, diff e salvar. Mostra "compartilhado com pytest" quando outra instância usa o mesmo arquivo. A edição textual existe mesmo quando não há formulário.
- **Configuração efetiva**: os valores resolvidos e de onde vieram, incluindo flags e variáveis de ambiente que prevalecem sobre o arquivo. Se a resolução não puder ser completa, a tela diz que é parcial e por quê; ela nunca inventa uma configuração final.
- **Execução** (recolhida): versão, runtime, comando, contexto, rede e o relatório esperado.

Hoje há formulário para o Ruff e o pytest (adaptadores com "configuração assistida"). Para os demais, a aba Arquivos é a porta de entrada.

## Arquivos reais, com revisão

Um arquivo vinculado tem um **id de vínculo** (`primary`, por exemplo), que é o que a interface e o CLI usam. Nunca se passa um caminho livre: um vínculo fora da raiz do projeto, um symlink que escapa dela ou uma raiz externa não declarada são recusados. Os mesmos comandos servem à automação:

```bash
jgates tools inspect ruff-api
jgates tools config read ruff-api --file primary
jgates tools config validate ruff-api --file primary
```

`read` devolve o texto e uma `revision` (o sha256 do conteúdo). Para gravar, informe a revisão que você leu:

```bash
jgates tools config write ruff-api --file primary --from ./novo-pyproject.toml --if-match <sha256>
```

- Se o arquivo mudou entre a leitura e a gravação (outro editor, outra aba, o seu IDE), a resposta é um conflito (`REVISION_CONFLICT`) com a base, a sua versão e a atual para comparar. Nada é sobrescrito em silêncio. `--if-match absent` cria um arquivo que ainda não existe.
- A gravação é atômica (arquivo temporário no mesmo disco e troca) e preserva a codificação, o BOM, as quebras de linha (CRLF ou LF) e as permissões. Latin-1 e UTF-16 nunca viram UTF-8 sem aviso.
- Dois adaptadores no mesmo arquivo compartilham a revisão: salvar o Ruff não apaga a seção do pytest no mesmo `pyproject.toml`.
- Arquivos somente leitura, gerados, de pacote ou do modo governado aparecem com o motivo; o JGates não grava neles.

## Formulário e texto

1. O arquivo é lido sem executar nada, e os campos suportados são extraídos.
2. Uma alteração no formulário vira uma intenção por campo (`set` ou herdar), nunca um arquivo reescrito do zero.
3. O codec do formato calcula a menor emenda sobre o texto original: comentários, ordem, campos desconhecidos e código avançado ficam como estavam.
4. A interface mostra o diff antes de salvar; salvar usa a revisão acima.
5. Salvar invalida o plano e as prévias que dependem do arquivo.

Um valor que o formulário não reconhece (por exemplo um `select` com um plugin que ele não conhece) fica somente leitura, com o motivo e a posição no arquivo, e o formulário não o apaga. O formulário também não inventa padrões: o que não está no arquivo aparece como "herdado".

Os formatos: JSON e JSONC por árvore e posições (JSON estrito nunca vira JSONC), YAML por intervalos (`anchors` e `aliases` preservados, com aviso quando um valor compartilhado afeta vários consumidores) e TOML pelo helper do sidecar Python (`tomlkit`). Sem Python ou sem o `tomlkit`, o formulário do TOML fica desabilitado e a edição de texto continua.

## Validação

A validação roda ao digitar e antes de salvar: JSON e YAML dizem a linha e a coluna do erro; TOML usa o helper. Para os formatos sem validador (JSONC, INI, XML, JS e outros), a interface e o `tools config validate` dizem **"indisponível"**, e nunca "válido". Realce de sintaxe não prova validade.

Um texto inválido não se perde: o buffer fica, o erro aparece e a edição visual suspende. O rascunho é salvo automaticamente na pasta de dados (não no projeto). Salvar uma configuração ativa inválida é uma escolha explícita no editor de texto (`--allow-invalid` no CLI), e ela bloqueia o plano com `CONFIG_INVALID` (arquivo e linha) até ser corrigida: nada executa sobre uma configuração quebrada.

Antes de executar, se há rascunhos que o plano usaria, a interface oferece "Salvar e usar a nova versão" ou "Usar a versão salva". Um buffer que não está no plano nunca é executado.

## O que nunca é executado

Abrir ou editar um arquivo **não executa código do projeto**:

- um `eslint.config.js`, `vitest.config.ts` ou semelhante é lido por análise estática (sem `eval`, `require` ou `import`);
- só os trechos reconhecidos (objetos literais, propriedades estáticas, wrappers conhecidos) têm edição visual; funções, `spread`, imports, variáveis de ambiente e condicionais ficam preservados, e a edição visual ambígua é bloqueada com a opção "Editar arquivo";
- editar um `csproj` ou outro XML nunca avalia o MSBuild;
- inspeções que precisariam executar a ferramenta (como imprimir a configuração efetiva do ESLint) são tarefa do runner, com efeitos declarados, nunca um efeito de digitar.

Uma regra nunca é desligada porque o formulário não reconheceu o valor: na dúvida, o campo vira texto.
