# Mascotes do Semantic

O gate Semantic tem quatro mascotes próprios. São personagens SVG planos e contornados, de uma família diferente dos
seis mascotes do Quality; os mascotes do Quality nunca mostram trabalho de IA e estes nunca mostram um domínio do Quality.

| Mascote | Responsabilidade | Etapas que mostra |
|---|---|---|
| Batedor (Scout) | Análise: mapear o código e planejar a cobertura | `reconnaissance`, `coverage-planning`, `semantic-context` |
| Rastreador (Tracker) | Investigação: caçar problemas candidatos | `hunting`, `hunt`, `semantic-review` |
| Desafiante (Challenger) | Validação adversarial: tentar refutar a cobertura e os candidatos | `coverage-critic`, `refutation`, `validate` |
| Verificador (Verifier) | Relatório: verificação independente dos registros finais | `verification` e qualquer etapa de relatório |

Cada etapa pertence a exatamente um mascote. O id da etapa é lido sem o prefixo do módulo (`security-audit/hunting`
vira `hunting`).

## De onde vem o agrupamento

- **Auditoria de segurança da Cloudflare** (fluxo fixado em `jgates/vendor/cloudflare-security-audit/prompts`):
  reconhecimento e planejamento de cobertura só montam um retrato e um plano (Batedor); a caça é a única fase que gera
  candidatos (Rastreador); o crítico de cobertura e a refutação por candidato são contextos independentes cujo trabalho é
  desmentir (Desafiante); a verificação reconfere cada registro mantido em contexto novo antes do relatório (Verificador).
- **Revisão geral** (os prompts do Semantic em `semantic-gate/templates`, executados pelas etapas `hunt` / `validate` do
  módulo de investigação embutido): `hunt` examina e reporta candidatos (Rastreador), `validate` julga cada candidato em
  contexto novo (Desafiante). A etapa de coleta de contexto vai para o Batedor.
- Um id de etapa que não está na lista também recebe um mascote, escolhido pelo papel: etapa em modo de verificação ou id de
  relatório/resumo vai para o Verificador, etapa `validate` para o Desafiante, id sobre reconhecimento/plano/contexto/escopo
  para o Batedor, o resto para o Rastreador. Um módulo novo aparece sem mudança de código.

Os prompts explicam por que são quatro mascotes e não um por prompt: os seis prompts da Cloudflare se reduzem às quatro
responsabilidades acima, e a revisão geral as reaproveita.

## Estados

Aguardando, trabalhando, concluído, incompleto, falhou e cancelado. Um selo no canto repete o estado, então a cor não é o
único sinal.

- `concluído` exige todas as etapas do mascote completas. Etapa ausente, orçamento esgotado ou etapa não executada mostram
  `incompleto`; etapa inválida, com tempo esgotado ou com erro mostra `falhou`.
- Uma execução que não está mais rodando nunca deixa um mascote aguardando ou trabalhando.
- Uma execução cancelada nunca mostra um mascote como concluído: etapas que terminaram antes do cancelamento mostram
  `incompleto` (a evidência é mantida, a execução não está completa) e as demais mostram `cancelado`.

## Acessibilidade e temas

Todo SVG tem `role="img"` e um rótulo acessível com o mascote e o estado, em inglês e português. As cores vêm das variáveis
do tema do app, então os temas claro e escuro usam o mesmo desenho; o tamanho segue `--sem-mascot-size` e encolhe com o
contêiner. A animação (agulha, varredura da lente, faísca, carimbo) só roda enquanto trabalha e é desligada com
`prefers-reduced-motion`.
