'use strict';

const { runRecoveryLoop, createSqlRecoveryAuditStore } = require('./product-ingestion-recovery');
const { proposeRecoveryStrategy } = require('./product-ingestion-recovery-ai');
const { createRecoveryActionHandlers } = require('./product-ingestion-recovery-actions');

async function runConfiguredRecovery({ input, trustedValidation, requestScope, db, fetchImpl, env, request }) {
  if (!trustedValidation?.rules?.length) {
    const error = new Error('配置化恢复运行前必须提供程序端可信验收规则'); error.code = 'RECOVERY_TRUSTED_VALIDATION_REQUIRED'; throw error;
  }
  return runRecoveryLoop({
    input,
    proposeStrategy: evidencePack => proposeRecoveryStrategy(evidencePack, { fetchImpl, env }),
    handlerFactory: evidencePack => createRecoveryActionHandlers({ evidencePack, requestScope, ...(request ? { request } : {}) }),
    trustedValidation,
    auditStore: db ? createSqlRecoveryAuditStore(db) : null,
  });
}

module.exports = { runConfiguredRecovery };
