# JGates: o mapa de cobertura ASVS

O mapa de cobertura ASVS lista todos os requisitos do OWASP ASVS 5.0.0 para um nível escolhido e coloca cada um em um de
cinco estados, construídos a partir do que as validações do projeto realmente executaram. Ele organiza evidências e
mostra lacunas. **Ele nunca diz que um projeto atende ao padrão, não mostra nota, percentual nem selo e não tem
portão**: a frase em cada tela e em cada saída é "Este mapa mostra o que foi examinado, não se o
projeto atende ao padrão."

## Os cinco estados

| Estado | O que significa | Por que um requisito está nele |
|---|---|---|
| examinado | Pelo menos uma verificação que o mapeamento liga ao requisito rodou até o fim nas execuções que o mapa lê | A verificação procurou violações de parte do requisito. A linha nomeia a verificação, o que ela cobre, o que ela deixa de fora e quantos achados dela estão abertos |
| não examinado | Uma verificação mapeada poderia rodar neste projeto e não rodou | Foi desligada, não foi selecionada, falhou, estourou o tempo, foi bloqueada, ou não há execução Semantic do seu método. A linha dá o motivo de cada verificação; uma execução anterior ao registro das linguagens varridas diz "valide de novo" |
| sem suporte | Nenhuma verificação do JGates está mapeada ao requisito, ou as verificações mapeadas existem só para outras stacks | Sem mapeamento significa sem suporte: nada é deduzido do nome de uma ferramenta, de um número CWE ou de uma subdimensão |
| não se aplica | Você registrou que ele não se aplica, com um motivo | Só a sua decisão faz isso; a proposta de um modelo nunca faz |
| aguardando evidência | Não dá para estabelecer a partir do repositório: precisa de um sistema implantado ou de uma pessoa (um documento, um processo, uma configuração operacional), e nenhuma verificação está mapeada | O mapeamento diz que tipo de evidência ele espera |

**Examinado não é atendido.** Um requisito é examinado quando uma verificação procurou violações de parte dele. Um
requisito examinado por uma verificação determinística diz isso; um examinado só por uma unidade Semantic diz "revisão
do código por IA" e é contado à parte em todos os totais. Uma verificação reaproveitada do cache conta, e a linha diz
"reaproveitada".

### As verificações de um requisito aberto

Um requisito aberto lista as verificações mapeadas a ele, cada uma com o seu status:

| Status | O que significa |
|---|---|
| executada | Rodou até o fim nas execuções que o mapa lê |
| não executada | Poderia rodar neste projeto e não rodou (desligada, falhou, estourou o tempo, sem execução Semantic do seu método...) |
| sem suporte neste projeto | Deveria rodar nas linguagens do projeto, mas não consegue: a linguagem existe mas não foi varrida, a capacidade não tem linha validada na matriz para a stack do projeto, a ferramenta disse que não pode rodar neste projeto, ou a regra é desconhecida nesta instalação |
| deixada de fora (somente determinísticas) | Uma verificação Semantic, deixada de fora por "somente determinísticas" |

Uma verificação de uma linguagem que o projeto não tem (uma regra Go ou Rust num projeto só com C#) não é listada e
não conta em nada: ela não tem relação com este projeto. Quando todas as verificações mapeadas a um requisito são desse
tipo, o requisito continua sem suporte e o motivo nomeia as linguagens do projeto e as linguagens para as quais as
verificações existem, por exemplo "nenhuma verificação do JGates cobre isto em C# (existem para: Go, Rust)". Isso
depende de uma execução Quality: sem ela as linguagens do projeto são desconhecidas e todas as verificações são
listadas. A saída `--json` mantém essa verificação, com `"relevant": false` e o código `LANGUAGE_ABSENT`; todas as
outras têm `"relevant": true`.

## A regra do mapeamento

O mapeamento é conservador por construção, porque um mapeamento otimista é uma afirmação falsa.

- Um arquivo de dados revisado por capítulo (`jgates/packs/asvs/jgates-asvs-map/5.0.0/V01.json` a `V17.json`), com uma
  entrada por requisito. Um requisito só ganha uma verificação por uma entrada que diz o que ela cobre, o que ela deixa
  de fora e por que ela tem relação com o requisito. O mapeamento cita os requisitos só pelo id e nunca reproduz o texto.
- Uma entrada só conta depois que uma revisão independente (outro contexto que tenta refutá-la) a marca como
  `reviewed`; uma entrada pendente se comporta como não mapeada.
- Uma verificação só conta como executada quando de fato rodou. Uma capacidade conta quando a sua etapa terminou e a
  linha da matriz é validada; uma regra do Semgrep conta quando a etapa do Semgrep terminou, a execução usou esta versão
  do pacote e pelo menos um arquivo da linguagem da regra foi varrido (um requisito mapeado só a regras de linguagens que
  o projeto não tem fica sem suporte para ele); uma unidade Semantic conta quando a execução do seu método terminou e o
  bloco de classe de ataque ou a categoria foi examinado.
- A ordem da decisão é fixa: o seu "não se aplica", depois examinado, não examinado, aguardando evidência e sem suporte.

## Como as regras do Semgrep e a auditoria Semantic alimentam o mapa

As regras do pacote Semgrep que acompanha o JGates (veja [integrações do Quality](quality-integrations.pt-BR.md)) são a
principal fonte determinística para codificação e injeção, tratamento de arquivos, partes do front-end web, criptografia
e comunicação segura; o mapa mostra, por linguagem, o que elas cobrem. A auditoria de segurança do Semantic (veja [os
métodos do Semantic](semantic-methods.pt-BR.md)) alimenta os requisitos de autorização, lógica de negócio e isolamento de
dados pelo seu registro de cobertura, sempre com a base "revisão do código por IA" e só para blocos cujas unidades foram
examinadas naquela execução. O `insecure-defaults` alimenta a configuração, as verificações de dependências alimentam os
requisitos de dependências, o Gitleaks alimenta segredos, e o ZAP e o Schemathesis alimentam requisitos de execução
quando um alvo rodou.

## O comando

```bash
jgates coverage asvs [--level 1|2|3] [--run <id>] [--semantic-run <id>] [--state <state>] [--chapter <id>] [--subdimension <id>] [--deterministic-only] [--json]
jgates coverage asvs level <1|2|3>
jgates coverage asvs not-applicable <requirement|section|chapter> --reason "<text>" [--preview] [--yes]
jgates coverage asvs not-applicable <requirement|section|chapter> --remove
jgates coverage asvs undo <token>
```

- Sem subcomando, imprime os totais e depois os requisitos agrupados por capítulo. `--level` mostra outro nível só
  naquela chamada, sem mudar a escolha do projeto (o nível 1 tem 70 requisitos, o 2 tem 253, o 3 tem 345). `--run` e
  `--semantic-run` nomeiam as execuções a ler; por padrão lê a última execução concluída do Quality e a última de cada
  método do Semantic, e avisa quando elas analisaram revisões diferentes. `--deterministic-only` deixa de fora as
  unidades do Semantic. `--state`, `--chapter` e `--subdimension` filtram as linhas.
- Sai com 0 sempre que conseguiu montar o mapa, e nunca com um código que signifique que o projeto reprova no padrão.
- `level`, `not-applicable` e `undo` escrevem no projeto. Cada um mostra a entrada e a mudança antes e pergunta;
  `--preview` não escreve nada, `--yes` escreve sem perguntar, `--json` nunca pergunta. Cada escrita imprime um token de
  desfazer, e `undo <token>` devolve o arquivo ao que era. Eles são recusados no modo governado.
- O mapa é calculado a partir das execuções guardadas a cada vez. Nunca é guardado numa execução e não chama nem o
  motor de contêineres nem o git.

## A tela

**Validações > Mapa de cobertura ASVS** mostra a versão e o nível (uma chave de três posições que grava a escolha do
projeto), as execuções que ele lê, com links, a chave "só determinístico", um contador por estado (cada um é um filtro,
sem percentual e sem nota de corte) e os requisitos agrupados por capítulo e seção ou por subdimensão de Segurança. Abrir
uma linha mostra as verificações (quais rodaram, a base, o que cada uma cobre e deixa de fora, os achados abertos, com
link para o resultado) ou o tipo de evidência que ela espera. "Não se aplica" numa linha, numa seção ou num capítulo abre
um diálogo com o motivo obrigatório e a entrada que será escrita, e depois oferece desfazer; fica desativado, com o
motivo, no modo governado. O resultado do Quality, o do Semantic e a visão geral têm link para ele.

## O arquivo do projeto `.jgates/asvs.json`

```json
{
  "version": "5.0.0",
  "level": 1,
  "notApplicable": [
    { "id": "V17", "reason": "O produto não usa WebRTC.", "recorded": "2026-11-14" }
  ]
}
```

Ele guarda a versão do ASVS, o nível escolhido (nível 1 enquanto o arquivo não disser outro) e as entradas "não se
aplica": um requisito, uma seção ou um capítulo, com motivo de 3 a 300 caracteres e a data em que foi registrado. Não
há data final, porque a aplicabilidade não expira. Ele é escrito entrada por entrada, com prévia e desfazer; recusa um
arquivo que mudou desde a leitura e nunca é reescrito quando não pode ser lido. Pertence ao projeto, como as dispensas;
nada sobre ele é guardado em outro lugar.

## Fonte e licença do texto

O texto dos requisitos é o texto oficial do OWASP ASVS 5.0.0, distribuído sem alterações em
`jgates/vendor/owasp-asvs/`:

> OWASP Application Security Verification Standard 5.0.0, Copyright © 2008-2025 The OWASP Foundation, sob a licença
> [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/).
> Fonte: <https://github.com/OWASP/ASVS> (versão `v5.0.0_release`).

A licença vale só para essa pasta; o código, as telas e o mapeamento do JGates seguem a licença do próprio projeto. O texto
e os nomes de capítulos e seções aparecem em inglês nos dois idiomas da interface, marcados como inglês, porque uma
tradução seria uma adaptação e não o texto oficial. A tela, a saída em texto e o bloco `source` da saída JSON trazem a
atribuição.

## O que o mapa nunca afirma

- Que um requisito está atendido, cumprido ou aprovado, ou que o projeto atende ao padrão ou tem algum atestado dele.
- Um percentual, uma nota ou um selo.
- Que um requisito foi examinado quando a sua verificação não rodou, ou quando a execução usou outra versão do pacote.
- Que um requisito não se aplica porque um modelo disse isso.
- Que uma verificação cobre mais do que a sua linha diz: cada linha informa o que a verificação deixa de fora.

Veja também as [integrações do Quality](quality-integrations.pt-BR.md), [os métodos do Semantic](semantic-methods.pt-BR.md)
e a [segurança](security.pt-BR.md).
