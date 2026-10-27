# JGates: usar com agentes de IA

O JGates não hospeda um agente. Ele dá a um agente (ou a um script de CI) contratos estáveis e evidências: um plano que se revisa, um resultado vinculado ao estado do código e um resumo seguro das falhas. Os limites de tentativas, de tempo e de custo ficam na orquestração externa.

## O ciclo

1. O agente pede o plano e o resultado em saída estruturada.
2. Recebe as falhas, as evidências, os arquivos e o comando para reproduzir.
3. Corrige o código no workspace ou no branch apropriado.
4. Executa de novo e recebe um resultado vinculado ao estado novo.
5. Para quando os requisitos estão satisfeitos ou o orçamento do agente acaba.

```bash
jgates plan --json
```

```bash
jgates run --no-interactive --json --events-jsonl eventos.jsonl
```

Regras da automação: `--no-interactive` nunca espera por entrada (um dado que falta vira erro estruturado com a instrução de correção); `--json` imprime exatamente um documento no stdout, com o progresso humano no stderr; `--events-jsonl` grava os eventos em um arquivo separado, com `runId`, `sequence` e `type`. O código de saída diz a decisão: 0 aprovado, 1 reprovado, 2 incompleto, 3 uso ou configuração inválida, 4 erro interno, 130 cancelado (veja [primeiros passos](primeiros-passos.pt-BR.md)).

## Contexto para o agente

```bash
jgates report <runId> --agent-context
```

O comando (e o botão "Copiar para o agente" da interface, que usa a mesma função) gera um resumo em texto: a instrução de política congelada, a decisão, o que ficou incompleto ou reduzido, as etapas, as métricas, os achados com arquivo e linha e a seção "Como reproduzir". Esse resumo:

- tem o mascaramento aplicado: nenhum valor de segredo ou de dado pessoal;
- não envia nada a um provider;
- marca comentários do código, README, logs de scanner e mensagens de erro como **dados**, entre delimitadores, e diz ao agente para não tratá-los como instruções. Delimitadores não eliminam a injeção de prompt; eles só tornam a fronteira explícita.

Para integrar a um fluxo de revisão de código, o mesmo resultado sai em SARIF:

```bash
jgates report <runId> --format sarif --out resultado.sarif
```

## O que o agente não deve fazer

Corrigir o gate em vez do código. Por isso o resultado mostra quando a política mudou:

- um run com `reduced: true` (por `--skip`, por exemplo) **nunca** encerra o ciclo como aprovado; ele mostra o que foi desligado;
- o resultado guarda em `provenance` os hashes da configuração, da política e dos templates, para comparar com os do ciclo anterior; desligar uma regra, ampliar um `exclude` ou criar um waiver muda esses hashes, e é uma nova revisão do plano, não prova de que o código passou nos critérios anteriores;
- o resumo para o agente começa com a instrução de política congelada: corrigir o código, não editar `jgates.yml`, a pasta `.jgates/`, limiares, regras, waivers nem baseline, e, se um critério parecer errado, descrever o problema e parar;
- waivers precisam de regra, caminho, motivo e validade, e um waiver vencido não se aplica.

No modo local o usuário pode mudar a própria política. Proteção contra o autor do código mudar o gate exige a política externa e o [modo governado](seguranca.pt-BR.md).

## Dados pessoais nos arquivos do projeto

O `jgates pii check` encontra dados pessoais nos arquivos do próximo commit sem mostrar o valor, e o `jgates pii fix` os corrige pela ferramenta que o projeto configura, só depois de confirmação ou `--yes`, guardando os originais para o `jgates pii fix --undo`. Um agente roda `pii fix --yes` só quando o usuário autorizou, nunca usa `--diff` numa execução automatizada (ele mostra os valores), não contorna com `--no-verify` o gancho opcional `jgates hooks install pre-commit` e não tenta recuperar um valor dos arquivos. Veja [segurança](seguranca.pt-BR.md#dados-pessoais-nos-arquivos-do-projeto).

## As skills

O repositório traz três skills: `jgates/skill/SKILL.md` (o ciclo do `jgates`, inclusive o `jgates ci`), `use-jgates-quality` e `use-jgates-semantic` (os comandos de cada componente). Um agente nunca edita a política de CI nem o hash dela para fazer um job passar. Os comandos do JGates seguem o contrato acima; o semantic gate entra só quando pedido (veja [semantic gate](semantic-gate.pt-BR.md)).
