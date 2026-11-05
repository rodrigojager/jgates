/** Pure adapter. No rendering, network, React or JGates runtime dependency. */
export const DOMAINS = Object.freeze({
  quality: { label: 'Qualidade', color: '#ee8162', detail: 'Código limpo, peça por peça', capability: 'lint · duplication · file-size' },
  security: { label: 'Segurança', color: '#46c6b6', detail: 'Um olhar atento ao que importa', capability: 'sast · secrets · pii' },
  dependencies: { label: 'Dependências', color: '#f3b745', detail: 'Cada pacote no seu lugar', capability: 'dependencies · licenses' },
  tests: { label: 'Testes', color: '#a6d981', detail: 'Uma verificação de cada vez', capability: 'unit · coverage' },
  architecture: { label: 'Arquitetura', color: '#b991e5', detail: 'Tudo encontra seu lugar', capability: 'architecture' },
  infrastructure: { label: 'Infraestrutura', color: '#86a9e9', detail: 'O ritmo que sustenta tudo', capability: 'iac' },
});

export const STATUSES = Object.freeze({
  waiting: { label: 'Aguardando', tone: 'neutral', description: 'Na fila, pronto para começar.' },
  processing: { label: 'Verificando', tone: 'active', description: 'Concentrado na avaliação em andamento.' },
  passed: { label: 'Aprovado', tone: 'success', description: 'Sucesso confirmado pelo resultado.' },
  failed: { label: 'Problemas encontrados', tone: 'danger', description: 'A avaliação encontrou violações no código.' },
  incomplete: { label: 'Incompleto', tone: 'warning', description: 'Faltam evidências para concluir a avaliação.' },
  blocked: { label: 'Bloqueado', tone: 'warning', description: 'Um pré-requisito impede a execução.' },
  error: { label: 'Erro da ferramenta', tone: 'danger', description: 'A ferramenta falhou; não é um diagnóstico do código.' },
  timeout: { label: 'Tempo esgotado', tone: 'warning', description: 'O limite de tempo da execução foi atingido.' },
  cancelled: { label: 'Cancelado', tone: 'neutral', description: 'Atividade encerrada por cancelamento.' },
  finished: { label: 'Concluído · sem decisão', tone: 'neutral', description: 'A etapa terminou. A decisão ainda não foi informada.' },
  disabled: { label: 'Desativado', tone: 'muted', description: 'Verificação desativada na configuração.' },
  not_applicable: { label: 'Não aplicável', tone: 'muted', description: 'Esta verificação não se aplica ao escopo.' },
  invalid: { label: 'Configuração inválida', tone: 'warning', description: 'A configuração precisa ser corrigida antes de executar.' },
});

export function assertStatus(status) {
  if (!Object.hasOwn(STATUSES, status)) throw new TypeError(`Unknown mascot status: ${status}`);
  return status;
}

/** A completed stage is not sufficient evidence of success. */
export function fromJGatesStage(stage, { selfReportedSatisfies = true } = {}) {
  if (!stage || typeof stage.state !== 'string') throw new TypeError('A StageResult with state is required');
  if (stage.state === 'pending') return 'waiting';
  if (stage.state === 'running') return 'processing';
  if (stage.state !== 'completed') return assertStatus(stage.state);
  if (stage.interpreted === false || (stage.selfReported === true && !selfReportedSatisfies)) return 'incomplete';
  if (Number.isFinite(stage.blockingViolations) && stage.blockingViolations > 0) return 'failed';
  if (stage.interpreted === true && stage.blockingViolations === 0) return 'passed';
  return 'finished';
}

export function fromJGatesDecision(result) {
  const decision = typeof result === 'string' ? result : result?.decision;
  if (!['passed', 'failed', 'incomplete', 'invalid', 'cancelled'].includes(decision)) throw new TypeError('Explicit JGates decision required');
  if (decision === 'passed' && (result?.reduced === true || result?.complete === false)) return 'incomplete';
  return decision;
}

/** Explicit bindings: IDs are supplied by the host, never guessed from names.
 * Actual runner stage events omit violations/interpreted. Enrich from result.json,
 * or leave the visual neutral until an explicit decision is supplied.
 */
export class JGatesEventAdapter {
  constructor({ bindings = {}, onUpdate = () => {} } = {}) {
    this.bindings = bindings;
    this.onUpdate = onUpdate;
    this.runId = null;
    this.sequence = 0;
    this.statuses = new Map();
    this.retiredRuns = new Set();
  }
  accept(event, { stageResults = {}, decision } = {}) {
    if (event?.schemaVersion !== 1 || typeof event.runId !== 'string' || !Number.isInteger(event.sequence) || event.sequence < 1) throw new TypeError('Invalid JGates v1 event');
    if (this.runId !== event.runId) {
      if (this.retiredRuns.has(event.runId)) return [];
      if (this.runId !== null && event.type !== 'run-started') return [];
      if (this.runId !== null) this.retiredRuns.add(this.runId);
      this.runId = event.runId; this.sequence = 0; this.statuses.clear();
    }
    if (event.sequence <= this.sequence) return [];
    this.sequence = event.sequence;
    const data = event.data ?? {};
    const binding = this.bindings[data.stageId] ?? this.bindings[data.step];
    const domains = binding ? (Array.isArray(binding) ? binding : [binding]) : [];
    const changes = [];
    const update = (domain, status) => {
      if (!Object.hasOwn(DOMAINS, domain)) throw new TypeError(`Unknown domain: ${domain}`);
      this.statuses.set(domain, status);
      const change = { domain, status, reason: data.reason ?? '', runId: event.runId, sequence: event.sequence };
      changes.push(change); this.onUpdate(change);
    };
    if (event.type === 'run-started') Object.keys(DOMAINS).forEach(d => update(d, 'waiting'));
    else if (event.type === 'step-started') domains.forEach(d => update(d, 'processing'));
    else if (event.type === 'stage') {
      const stage = stageResults[data.stageId] ?? { state: data.state };
      domains.forEach(d => update(d, fromJGatesStage(stage)));
    } else if (event.type === 'step-finished') {
      domains.filter(d => this.statuses.get(d) === 'processing' || !this.statuses.has(d)).forEach(d => update(d, 'finished'));
    } else if (event.type === 'step-skipped') {
      const status = data.cause === 'cancelled' ? 'cancelled' : 'blocked';
      domains.forEach(d => update(d, status));
    } else if (event.type === 'cancel-requested') {
      Object.keys(DOMAINS).filter(d => ['processing', 'waiting'].includes(this.statuses.get(d))).forEach(d => update(d, 'cancelled'));
    } else if (event.type === 'run-finished' && decision !== undefined) {
      // Run-level outcome is returned separately; do not paint every category red
      // because one other category failed. Category results come from full stages.
      changes.push({ scope: 'run', status: fromJGatesDecision(decision), runId: event.runId, sequence: event.sequence });
    }
    return changes;
  }
}
