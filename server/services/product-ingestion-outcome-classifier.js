'use strict';

const OUTCOME_CATEGORIES = Object.freeze([
  'SUCCESS',
  'POLICY_BLOCKED',
  'RATE_LIMITED',
  'ACCESS_RESTRICTED',
  'HUMAN_CHALLENGE',
  'JS_RENDER_REQUIRED',
  'TEMPORARY_NETWORK_FAILURE',
  'UPSTREAM_UNAVAILABLE',
  'REDIRECT_SCOPE_REVIEW',
  'EVIDENCE_INSUFFICIENT',
  'AI_OUTPUT_INVALID',
  'AI_BUDGET_EXHAUSTED',
  'RULE_INVALID',
  'RULE_UNVERIFIABLE',
  'TEMPLATE_DRIFT',
  'FIELD_EXTRACTION_FAILED',
  'UNKNOWN_FAILURE',
]);

const CONTRACT = Object.freeze({
  SUCCESS:{retryability:'none',next_action:'CONTINUE',terminal:false},
  POLICY_BLOCKED:{retryability:'none',next_action:'STOP_POLICY',terminal:true},
  RATE_LIMITED:{retryability:'wait',next_action:'WAIT_AND_PROBE',terminal:false},
  ACCESS_RESTRICTED:{retryability:'alternate_channel',next_action:'ASSESS_BOUNDED_EVIDENCE',terminal:false},
  HUMAN_CHALLENGE:{retryability:'alternate_channel',next_action:'ASSESS_BOUNDED_EVIDENCE',terminal:false},
  JS_RENDER_REQUIRED:{retryability:'alternate_channel',next_action:'USE_RENDERED_CHANNEL',terminal:false},
  TEMPORARY_NETWORK_FAILURE:{retryability:'bounded',next_action:'RETRY_WITH_BACKOFF',terminal:false},
  UPSTREAM_UNAVAILABLE:{retryability:'wait',next_action:'WAIT_AND_PROBE',terminal:false},
  REDIRECT_SCOPE_REVIEW:{retryability:'none',next_action:'STOP_SCOPE_REVIEW',terminal:true},
  EVIDENCE_INSUFFICIENT:{retryability:'evidence',next_action:'ACQUIRE_BOUNDED_EVIDENCE',terminal:false},
  AI_OUTPUT_INVALID:{retryability:'bounded',next_action:'RETRY_FORMAT_ONLY',terminal:false},
  AI_BUDGET_EXHAUSTED:{retryability:'none',next_action:'STOP_BUDGET',terminal:true},
  RULE_INVALID:{retryability:'rule',next_action:'REVISE_RULE',terminal:false},
  RULE_UNVERIFIABLE:{retryability:'none',next_action:'STOP_RULE_UNVERIFIABLE',terminal:true},
  TEMPLATE_DRIFT:{retryability:'rule',next_action:'REMAP_TEMPLATE',terminal:false},
  FIELD_EXTRACTION_FAILED:{retryability:'evidence',next_action:'DIAGNOSE_FIELD_EVIDENCE',terminal:false},
  UNKNOWN_FAILURE:{retryability:'none',next_action:'STOP_UNCLASSIFIED',terminal:true},
});

function numericStatus(input) {
  return Number(input?.http_status || input?.status_code || input?.response?.status || input?.response?.statusCode || 0) || null;
}

function classifyCategory(input = {}) {
  if (input.success === true) return 'SUCCESS';
  const code=String(input.code || input.error_code || input.reason_code || input.obstacle_code || '').toUpperCase();
  const status=numericStatus(input);
  const dynamicSignals=Array.isArray(input.dynamic_signals)?input.dynamic_signals:[];
  if (['ROBOTS_DISALLOW','POLICY_BLOCKED'].includes(code)) return 'POLICY_BLOCKED';
  if (status===429 || ['ROBOTS_RATE_LIMITED','RATE_LIMITED'].includes(code)) return 'RATE_LIMITED';
  if (['HUMAN_VERIFICATION_REQUIRED','CAPTCHA_REQUIRED','CHALLENGE_PAGE'].includes(code)) return 'HUMAN_CHALLENGE';
  if ([401,403].includes(status) || ['ROBOTS_ACCESS_DENIED','LOGIN_REQUIRED','ACCESS_RESTRICTED'].includes(code)) return 'ACCESS_RESTRICTED';
  if (dynamicSignals.includes('script_shell') || ['JS_RENDER_REQUIRED','DYNAMIC_RENDER_REQUIRED'].includes(code)) return 'JS_RENDER_REQUIRED';
  if (['DOMAIN_NOT_ALLOWED','PATH_NOT_ALLOWED','TOO_MANY_REDIRECTS','READ_ONLY_POST_REDIRECT_DENIED','REDIRECT_SCOPE_REVIEW'].includes(code)) return 'REDIRECT_SCOPE_REVIEW';
  if (status && status>=500) return 'UPSTREAM_UNAVAILABLE';
  if (['ECONNRESET','ECONNREFUSED','ETIMEDOUT','FETCH_TIMEOUT','UND_ERR_SOCKET','PAGE_PROCESS_TIMEOUT','ENOTFOUND','DNS_LOOKUP_FAILED'].includes(code)) return 'TEMPORARY_NETWORK_FAILURE';
  if (code==='SITE_COGNITION_AI_BUDGET_EXHAUSTED' || code==='AI_BUDGET_EXHAUSTED') return 'AI_BUDGET_EXHAUSTED';
  if (code.includes('AI_SCHEMA') || code.includes('AI_OUTPUT') || code==='PUBLIC_WEB_EVIDENCE_OUTPUT_INVALID' || code==='PUBLIC_WEB_EVIDENCE_OUTPUT_MISSING') return 'AI_OUTPUT_INVALID';
  if (code==='SITE_RULE_TEMPLATE_STALE' || code==='TEMPLATE_DRIFT') return 'TEMPLATE_DRIFT';
  if (['SITE_RULE_INVALIDATED','SITE_RULE_NOT_FROZEN','SITE_RULE_VALIDATION_FAILED'].includes(code)) return 'RULE_INVALID';
  if (['RULE_UNVERIFIABLE','SITE_COGNITION_EXHAUSTED'].includes(code)) return 'RULE_UNVERIFIABLE';
  if (['NO_PRODUCTS_DISCOVERED','SAMPLE_ONLY_PRODUCT_DISCOVERY','EVIDENCE_INSUFFICIENT','RECOVERY_INPUT_ARTIFACT_MISSING'].includes(code)) return 'EVIDENCE_INSUFFICIENT';
  if (code.includes('FIELD_') || code.includes('EXTRACTION_FAILED') || code.includes('CONFIGURATIONS_NOT_FOUND')) return 'FIELD_EXTRACTION_FAILED';
  return 'UNKNOWN_FAILURE';
}

function classifyIngestionOutcome(input = {}, context = {}) {
  const category=classifyCategory(input),contract=CONTRACT[category];
  return {
    schema_version:'ingestion-outcome-v1',
    category,
    stage:String(context.stage || input.stage || 'unknown').slice(0,80),
    retryability:contract.retryability,
    next_action:contract.next_action,
    terminal:contract.terminal,
    error_code:String(input.code || input.error_code || input.reason_code || '').slice(0,80) || null,
    http_status:numericStatus(input),
  };
}

module.exports={OUTCOME_CATEGORIES,CONTRACT,classifyIngestionOutcome};
