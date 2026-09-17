'use strict';

const Ajv = require('ajv');

const ACTION_TYPES = Object.freeze([
  'GET_SAME_ORIGIN_PAGE',
  'PARSE_SCOPED_DOM',
  'PARSE_CSS_BACKGROUND_IMAGE',
  'EXCLUDE_RELATED_PRODUCTS',
  'CLASSIFY_PAGE_ROLE',
  'EXTRACT_SCOPED_LIGHTBOX_CANDIDATES',
  'PRESERVE_MISSING_FIELDS',
  'PARSE_REPEATED_PRODUCT_BLOCKS',
  'DEDUPLICATE_NAME_MODEL_IMAGE',
  'GET_SITE_ROOT',
  'INSPECT_SAME_ORIGIN_SCRIPT_REFERENCES',
  'PROPOSE_PUBLIC_API_PROFILE',
  'POST_SAME_ORIGIN_PUBLIC_API',
  'MAP_API_FIELDS_TO_FROZEN_SCHEMA',
  'GET_EXACT_URL_ONCE',
  'GET_SAME_HANDLE_PUBLIC_JSON_ONCE',
  'CHECK_CURRENT_OFFICIAL_SITEMAP',
  'MARK_STALE_BASELINE',
  'TLS_VERIFY_REQUIRED',
  'STOP_BEFORE_CONTENT_EXTRACTION',
  'RECORD_CERTIFICATE_ERROR',
  'QUEUE_HUMAN_TRUST_CHAIN_REVIEW',
]);

const NETWORK_ACTIONS = Object.freeze(new Set([
  'GET_SAME_ORIGIN_PAGE', 'GET_SITE_ROOT', 'POST_SAME_ORIGIN_PUBLIC_API',
  'GET_EXACT_URL_ONCE', 'GET_SAME_HANDLE_PUBLIC_JSON_ONCE', 'CHECK_CURRENT_OFFICIAL_SITEMAP',
]));

const STRATEGY_SCHEMA = {
  $id: 'ai-recovery-strategy-v1.0',
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'strategy_id', 'diagnosis', 'scope', 'actions', 'budget', 'expected_validation', 'stop_conditions', 'human_intervention_conditions'],
  properties: {
    schema_version: { const: 'ai-recovery-strategy-v1.0' },
    strategy_id: { type: 'string', minLength: 3, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
    diagnosis: {
      type: 'object', additionalProperties: false, required: ['failure_type', 'summary', 'evidence_refs'],
      properties: {
        failure_type: { type: 'string', minLength: 3, maxLength: 160 },
        summary: { type: 'string', minLength: 1, maxLength: 1000 },
        evidence_refs: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
      },
    },
    scope: {
      type: 'object', additionalProperties: false, required: ['level', 'allowed_hosts', 'allowed_path_prefixes'],
      properties: {
        level: { enum: ['page', 'template', 'site_profile'] },
        template_fingerprint: { type: 'string', maxLength: 160 },
        allowed_hosts: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 253 } },
        allowed_path_prefixes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^/' } },
      },
    },
    actions: {
      type: 'array', minItems: 1, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false, required: ['action_id', 'type', 'evidence_refs'],
        properties: {
          action_id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9._:-]+$' },
          type: { enum: ACTION_TYPES },
          target_url: { type: 'string', maxLength: 1000 },
          method: { enum: ['GET', 'POST'] },
          purpose: { enum: ['page', 'product', 'sitemap', 'site_profile', 'diagnosis'] },
          parameters: { type: 'object', additionalProperties: true },
          parameter_source: { enum: ['none', 'evidence', 'previous_action'] },
          evidence_refs: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
          output_key: { type: 'string', maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
        },
      },
    },
    budget: {
      type: 'object', additionalProperties: false,
      required: ['max_actions', 'max_network_requests', 'max_browser_actions', 'max_response_bytes', 'max_duration_ms'],
      properties: {
        max_actions: { type: 'integer', minimum: 1, maximum: 12 },
        max_network_requests: { type: 'integer', minimum: 0, maximum: 4 },
        max_browser_actions: { type: 'integer', minimum: 0, maximum: 8 },
        max_response_bytes: { type: 'integer', minimum: 1, maximum: 5242880 },
        max_duration_ms: { type: 'integer', minimum: 100, maximum: 60000 },
      },
    },
    expected_validation: {
      type: 'array', minItems: 1, maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['check_id', 'description'],
        properties: {
          check_id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
          description: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
    stop_conditions: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 300 } },
    human_intervention_conditions: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(STRATEGY_SCHEMA);

function validationError(message, details = []) {
  const error = new Error(message);
  error.code = 'RECOVERY_STRATEGY_SCHEMA_INVALID';
  error.details = details;
  return error;
}

function validateRecoveryStrategy(strategy) {
  if (!validate(strategy)) {
    const details = (validate.errors || []).map((item) => `${item.instancePath || '/'} ${item.message}`).slice(0, 20);
    throw validationError(`AI 恢复策略不符合 Schema：${details.join('；')}`, details);
  }
  if (new Set(strategy.actions.map((item) => item.action_id)).size !== strategy.actions.length) {
    throw validationError('AI 恢复策略的 action_id 必须唯一', ['/actions action_id must be unique']);
  }
  const actionSignatures = strategy.actions.map((item) => JSON.stringify({
    type:item.type,
    target_url:item.target_url || null,
    method:item.method || null,
    purpose:item.purpose || null,
    parameters:item.parameters || null,
    parameter_source:item.parameter_source || null,
  }));
  if (new Set(actionSignatures).size !== actionSignatures.length) {
    throw validationError('AI 恢复策略包含重复动作', ['/actions contains duplicate operations']);
  }
  return strategy;
}

module.exports = { ACTION_TYPES, NETWORK_ACTIONS, STRATEGY_SCHEMA, validateRecoveryStrategy };
