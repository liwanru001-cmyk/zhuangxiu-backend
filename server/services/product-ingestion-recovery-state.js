'use strict';

const STATES = Object.freeze({
  PLANNING: 'planning',
  BUSINESS_REVIEW: 'awaiting_business_review',
  LOCAL_READY: 'ready_to_execute',
  EVIDENCE_APPROVAL: 'awaiting_evidence_approval',
  ACQUIRING_EVIDENCE: 'acquiring_evidence',
  SYSTEM_REVIEW: 'system_review',
  EXECUTING: 'executing',
  VALIDATING: 'validating',
  REINTEGRATING: 'reintegrating',
  RESUMED: 'resumed',
  NO_IMPROVEMENT: 'no_improvement',
  EXECUTION_FAILED: 'execution_failed',
  PLAN_REJECTED: 'plan_rejected',
  MANUAL_REVIEW: 'manual_review',
  SUPERSEDED: 'superseded',
  EXHAUSTED: 'exhausted',
});

const TRANSITIONS = Object.freeze({
  planning: ['awaiting_business_review', 'plan_rejected', 'execution_failed'],
  awaiting_business_review: ['ready_to_execute', 'awaiting_evidence_approval', 'system_review', 'manual_review'],
  ready_to_execute: ['executing', 'manual_review'],
  awaiting_evidence_approval: ['acquiring_evidence', 'manual_review'],
  acquiring_evidence: ['superseded', 'execution_failed', 'manual_review'],
  system_review: ['ready_to_execute', 'awaiting_evidence_approval', 'manual_review'],
  executing: ['validating', 'execution_failed'],
  validating: ['reintegrating', 'no_improvement', 'execution_failed'],
  reintegrating: ['resumed', 'no_improvement', 'execution_failed'],
  no_improvement: ['awaiting_evidence_approval', 'superseded', 'manual_review', 'exhausted'],
  execution_failed: ['awaiting_evidence_approval', 'superseded', 'manual_review', 'exhausted'],
  plan_rejected: ['superseded', 'manual_review', 'exhausted'],
  manual_review: ['superseded', 'exhausted'],
  superseded: [], resumed: [], exhausted: [],
});

const LEGACY_STATE = Object.freeze({
  shadow_ready: STATES.BUSINESS_REVIEW,
  awaiting_approval: STATES.EVIDENCE_APPROVAL,
  validation_failed: STATES.NO_IMPROVEMENT,
  failed: STATES.EXECUTION_FAILED,
  validated: STATES.REINTEGRATING,
});

function canonicalState(value) { return LEGACY_STATE[value] || value; }
function canTransition(from, to) { return (TRANSITIONS[canonicalState(from)] || []).includes(canonicalState(to)); }
function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error(`异常恢复状态不能从 ${from} 进入 ${to}`);
    error.code = 'RECOVERY_STATE_TRANSITION_INVALID'; error.status = 409; throw error;
  }
  return canonicalState(to);
}

function nextAction(status) {
  const state = canonicalState(status);
  return ({
    planning: 'wait_for_plan', awaiting_business_review: 'business_review', ready_to_execute: 'execute_existing_data',
    awaiting_evidence_approval: 'approve_bounded_evidence', acquiring_evidence: 'wait_for_evidence', system_review: 'system_review',
    executing: 'wait_for_execution', validating: 'wait_for_validation', reintegrating: 'wait_for_reintegration',
    no_improvement: 'revise_or_manual', execution_failed: 'retry_or_manual', plan_rejected: 'revise_or_manual',
    manual_review: 'human_takeover', superseded: 'open_child_attempt', resumed: 'follow_main_job', exhausted: 'human_takeover',
  })[state] || 'human_takeover';
}

module.exports = { STATES, TRANSITIONS, LEGACY_STATE, canonicalState, canTransition, assertTransition, nextAction };
