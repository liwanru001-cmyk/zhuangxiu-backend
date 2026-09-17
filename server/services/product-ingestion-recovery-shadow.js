'use strict';

const cheerio = require('cheerio');
const { buildRecoveryEvidencePack, planRecovery, createSqlRecoveryAuditStore, cloneSafe } = require('./product-ingestion-recovery');
const { proposeRecoveryStrategy } = require('./product-ingestion-recovery-ai');
const { evidenceRequest } = require('./product-ingestion-recovery-contracts');

const ELIGIBLE_CODES = new Set([
  'NO_PRODUCTS_DISCOVERED', 'CLASSIFICATION_UNCERTAIN', 'PAGE_HTTP_STATUS', 'NOT_HTML',
  'EXTRACTION_FAILED', 'PAGE_PROCESS_TIMEOUT', 'BODY_TOO_LARGE',
]);

function eligible(error) {
  const code = String(error?.code || 'EXTRACTION_FAILED');
  return ELIGIBLE_CODES.has(code) || code.startsWith('INGESTION_AI_');
}

function htmlEvidence(html) {
  if (!html) return null;
  const $ = cheerio.load(String(html));
  return {
    title: $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 300),
    h1: $('h1').first().text().replace(/\s+/g, ' ').trim().slice(0, 300),
    canonical: $('link[rel="canonical"]').attr('href') || '',
    json_ld_count: $('script[type="application/ld+json"]').length,
    image_count: $('img').length,
    link_count: $('a[href]').length,
    main_text_excerpt: $('main,article,body').first().text().replace(/\s+/g, ' ').trim().slice(0, 3000),
  };
}

function riskLevel(plan) {
  if (plan.actions.some(action => action.type === 'POST_SAME_ORIGIN_PUBLIC_API')) return 'high';
  if (plan.actions.some(action => action.type.includes('TLS') || action.type.includes('HUMAN'))) return 'high';
  return plan.counts.network ? 'medium' : 'low';
}

function createShadowRecoveryPlanner(db, dependencies = {}) {
  const propose = dependencies.proposeStrategy || (pack => proposeRecoveryStrategy(pack));
  const audit = createSqlRecoveryAuditStore(db);
  return async function planShadow({ job, sourceUrl, candidateId = null, failure, page = null, initialResult = null, evidence = null }) {
    if (String(job.recovery_mode || 'off') !== 'shadow' || !eligible(failure)) return { status: 'not_applicable' };
    const url = new URL(sourceUrl || job.base_url).toString();
    const snapshots=(evidence?.snapshots||[]).slice(0,5);
    const observed = { failure: { code: failure.code || 'EXTRACTION_FAILED', message: String(failure.message || failure).slice(0, 500) }, page: htmlEvidence(page?.html), context: cloneSafe({...evidence,snapshots:undefined}) };
    const evidenceItems=[{ evidence_id: 'E001', kind: 'bounded_page_and_pipeline_summary', source_url: url, locator: candidateId ? `candidate:${candidateId}` : `job:${job.id}`, observed }];
    if(page?.html)snapshots.unshift({url:page.url||url,status:page.status||null,content_type:page.contentType||'text/html',content:String(page.html),truncated:false});
    for(const [index,snapshot] of snapshots.slice(0,5).entries())evidenceItems.push({evidence_id:`H${String(index+1).padStart(3,'0')}`,kind:'html_snapshot',source_url:snapshot.url||url,locator:'authorized_page_snapshot',observed:{status:snapshot.status||null,content_type:snapshot.content_type||'text/html',content:String(snapshot.content||'').slice(0,131072),truncated:Boolean(snapshot.truncated)||String(snapshot.content||'').length>131072}});
    const pack = buildRecoveryEvidencePack({
      failure: { type: failure.code || 'EXTRACTION_FAILED', stage: candidateId ? 'candidate_extraction' : 'url_discovery', message: String(failure.message || failure).slice(0, 500) },
      source: { url, job_id: Number(job.id), candidate_id: candidateId, page_role: candidateId ? 'candidate' : 'site_entry' },
      initial_result: cloneSafe(initialResult || {}), evidence: evidenceItems,
      authorized_scope: { allowed_hosts: job.scope_snapshot?.allowed_hosts || [new URL(job.base_url).hostname], allowed_path_prefixes: job.scope_snapshot?.allowed_path_prefixes || ['/'], budget_limits: { max_actions: 12, max_network_requests: 4, max_browser_actions: 5, max_response_bytes: 5242880, max_duration_ms: 30000 } },
    });
    let attemptId = null;
    try {
      attemptId = await audit.beginAttempt(pack);
      const strategy = await propose(pack);
      const plan = planRecovery(pack, strategy);
      const request=plan.readiness.ready&&plan.counts.network===0?null:evidenceRequest(pack,plan,plan.readiness);
      await audit.markShadowReady(attemptId, strategy, plan, riskLevel(plan),request);
      return { status: 'awaiting_business_review', attempt_id: attemptId };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return { status: 'already_exists' };
      const planRejected=String(error.code||'').startsWith('RECOVERY_')&&!['RECOVERY_AI_NOT_CONFIGURED','RECOVERY_AI_REQUEST_FAILED','RECOVERY_AI_UPSTREAM_INVALID'].includes(error.code);
      if(planRejected)await audit.rejectPlan(attemptId,error);else await audit.failAttempt(attemptId,error);
      return { status: planRejected?'plan_rejected':'execution_failed', attempt_id: attemptId || null, error_code: error.code || 'RECOVERY_SHADOW_FAILED' };
    }
  };
}

module.exports = { createShadowRecoveryPlanner, eligible, htmlEvidence, riskLevel, ELIGIBLE_CODES };
