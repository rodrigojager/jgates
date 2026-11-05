import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromJGatesStage, fromJGatesDecision, JGatesEventAdapter, STATUSES } from '../ui/src/mascots/actors/status.js';

test('full stage contract: completion is not an implicit approval', () => {
  assert.equal(fromJGatesStage({ state: 'pending' }), 'waiting');
  assert.equal(fromJGatesStage({ state: 'running' }), 'processing');
  assert.equal(fromJGatesStage({ state: 'completed' }), 'finished');
  assert.equal(fromJGatesStage({ state: 'completed', blockingViolations: 0 }), 'finished');
  assert.equal(fromJGatesStage({ state: 'completed', interpreted: true, blockingViolations: 0 }), 'passed');
  assert.equal(fromJGatesStage({ state: 'completed', blockingViolations: 2 }), 'failed');
  assert.equal(fromJGatesStage({ state: 'completed', interpreted: false, blockingViolations: 0 }), 'incomplete');
  assert.equal(fromJGatesStage({ state: 'completed', interpreted: true, blockingViolations: 0, selfReported: true }, { selfReportedSatisfies: false }), 'incomplete');
  for (const state of ['blocked', 'error', 'timeout', 'cancelled', 'disabled', 'not_applicable']) assert.equal(fromJGatesStage({ state }), state);
  assert.throws(() => fromJGatesStage({ state: 'mystery' }));
});

test('decision contract refuses reduced or incomplete success', () => {
  for (const decision of ['passed', 'failed', 'incomplete', 'invalid', 'cancelled']) assert.equal(fromJGatesDecision(decision), decision);
  assert.equal(fromJGatesDecision({ decision: 'passed', reduced: true }), 'incomplete');
  assert.equal(fromJGatesDecision({ decision: 'passed', complete: false }), 'incomplete');
  assert.throws(() => fromJGatesDecision({}));
});

test('actual runner events remain neutral without full result and require explicit ID bindings', () => {
  const updates = [];
  const a = new JGatesEventAdapter({ bindings: { 'gitleaks-api': 'security', 'gitleaks-api#secrets': 'security' }, onUpdate: u => updates.push(u) });
  const event = (sequence, type, data = {}, runId = 'run-a') => ({ schemaVersion: 1, runId, sequence, type, data });
  assert.equal(a.accept(event(1, 'run-started')).length, 6);
  assert.equal(a.accept(event(2, 'step-started', { step: 'gitleaks-api' }))[0].status, 'processing');
  // Current executor emits step-finished before stage, and does not emit violation counts.
  assert.equal(a.accept(event(3, 'step-finished', { step: 'gitleaks-api', status: 'succeeded' }))[0].status, 'finished');
  assert.equal(a.accept(event(4, 'stage', { step: 'gitleaks-api', stageId: 'gitleaks-api#secrets', state: 'completed' }))[0].status, 'finished');
  assert.equal(a.accept(event(5, 'stage', { stageId: 'gitleaks-api#secrets', state: 'completed' }), { stageResults: { 'gitleaks-api#secrets': { state: 'completed', interpreted: true, blockingViolations: 1 } } })[0].status, 'failed');
  assert.deepEqual(a.accept(event(5, 'stage', { state: 'completed' })), []);
  assert.deepEqual(a.accept(event(3, 'step-started', { step: 'gitleaks-api' })), []);
  assert.deepEqual(a.accept(event(6, 'step-started', { step: 'unknown-quality-name' })), []);
  const final = a.accept(event(7, 'run-finished'), { decision: { decision: 'failed' } });
  assert.equal(final[0].scope, 'run'); assert.equal(a.statuses.get('quality'), 'waiting');
  assert.equal(a.statuses.get('security'), 'failed');
  assert.deepEqual(a.accept(event(8, 'step-started', { step: 'gitleaks-api' }, 'another-run')), []);
  assert.equal(a.accept(event(1, 'run-started', {}, 'run-b')).length, 6);
  assert.deepEqual(a.accept(event(1, 'run-started', {}, 'run-a')), []);
  assert.equal(a.runId, 'run-b');
  assert.throws(() => a.accept({ schemaVersion: 2 }));
  assert.ok(Object.keys(STATUSES).length >= 13);
});
