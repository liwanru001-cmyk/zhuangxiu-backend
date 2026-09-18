const db = require('../config/db');

const requiredColumns = Object.freeze({
  ...require('./independent-project-schema').requiredColumns,
  product_ingestion_sources: [
    'id',
    'allowed_hosts',
    'allowed_asset_hosts',
    'allowed_path_prefixes',
    'status',
    'manual_review_required',
    'recovery_mode',
  ],
  product_ingestion_jobs: [
    'id',
    'source_id',
    'job_mode',
    'seed_urls',
    'discovered_urls',
    'discovery_summary',
    'scope_snapshot',
    'approved_at',
  ],
  product_ingestion_candidates: [
    'id',
    'job_id',
    'source_url_hash',
    'normalized_payload',
    'classification_suggestion',
    'classification_override',
    'validation_status',
    'review_status',
    'review_note',
    'published_product_id',
    'published_version_id',
    'published_at',
    'product_schema_version',
  ],
  product_ingestion_recovery_attempts: [
    'id','job_id','candidate_id','parent_attempt_id','attempt_no','evidence_pack_id','strategy_id','schema_version','status','next_action',
    'evidence_pack','ai_strategy','safety_plan','readiness','evidence_request','evidence_acquisition_result','execution_result','validation_result','reintegration_result',
    'outcome_class','risk_level','review_decision','review_note','reviewed_by','reviewed_at',
    'failure_code','last_error','started_at','finished_at','created_at',
  ],
  product_ingestion_recovery_events: ['id','attempt_id','event_type','action_id','event_payload','created_at'],
  public_product_library_products: ['id','source_id','source_url_hash','status','archived_at','archived_by','deleted_at','deleted_by','lifecycle_updated_by','current_version_id'],
  public_product_library_versions: ['id','product_id','candidate_id','version_no','product_payload','product_schema_version','asset_status','asset_count','assets_archived_at','published_at'],
  public_product_library_configurations: ['id','version_id','configuration_key','configuration_payload'],
  public_product_library_assets: ['id','content_hash','storage_uri','content_type','byte_size'],
  public_product_library_version_assets: ['id','version_id','asset_id','payload_path'],
  public_product_categories: ['id','parent_id','category_code','name','level','status'],
  product_ingestion_source_categories: ['id','source_id','external_key','name','source_url','evidence_type','evidence_payload','last_seen_at'],
  product_ingestion_category_mappings: ['source_category_id','category_id','approved_by'],
  public_product_category_relations: ['product_id','category_id','source_category_id'],
  product_ingestion_discovered_product_categories: ['job_id','product_url_hash','source_category_id'],
  product_ingestion_candidate_categories: ['candidate_id','category_id','assigned_by','assignment_type'],
  product_ingestion_candidate_classification_changes: ['id','candidate_id','new_product_group','new_product_type','changed_by','changed_at'],
  product_ingestion_category_mapping_changes: ['id','source_category_id','previous_category_ids','new_category_ids','affected_candidates','affected_products','skipped_overrides','changed_by','changed_at'],
  product_ingestion_candidate_category_changes: ['id','batch_key','candidate_id','previous_category_ids','new_category_ids','changed_by','changed_at'],
  product_ingestion_robots_snapshots: ['id','source_id','host','content_hash','content','status_code','parser_name','parser_version','last_checked_at'],
  product_ingestion_request_decisions: ['id','source_id','job_id','purpose','url_hash','decision','reason_code','matched_rule','robots_snapshot_id','created_at'],
  public_product_category_overrides: ['product_id','updated_by','updated_at'],
  product_ingestion_site_rule_feedback: ['id','workflow_id','rule_id','decision','error_types','issues','note','page_url','created_by'],
  project_scheme_products: ['id','source_type','public_product_id','public_product_version_id','public_product_configuration_id','public_configuration_key','product_snapshot','snapshot_schema_version','snapshot_created_at'],
  project_action_notifications: ['item_id', 'event_type', 'payload'],
  project_inspection_step_records: [
    'task_id',
    'progress_item_id',
    'inspection_id',
    'member_role',
  ],
  project_inspections: [
    'title',
    'template_code',
    'client_request_id',
    'algorithm_version',
    'calculation_summary',
    'row_version',
    'calculated_at',
  ],
  project_inspection_items: [
    'id',
    'inspection_id',
    'project_id',
    'item_key',
    'result',
  ],
  project_inspection_item_images: [
    'id',
    'inspection_item_id',
    'image_url',
    'uploaded_by',
  ],
  project_progress_change_requests: [
    'id',
    'project_id',
    'entity_type',
    'target_id',
    'proposed_payload',
    'submitted_by',
    'submitted_role',
    'status',
  ],
});

async function checkRuntimeSchema(executor = db) {
  const [rows] = await executor.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (?)`,
    [Object.keys(requiredColumns)]
  );
  const actual = new Map();
  for (const row of rows) {
    if (!actual.has(row.TABLE_NAME)) actual.set(row.TABLE_NAME, new Set());
    actual.get(row.TABLE_NAME).add(row.COLUMN_NAME);
  }
  const missing = [];
  for (const [table, columns] of Object.entries(requiredColumns)) {
    for (const column of columns) {
      if (!actual.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { checkRuntimeSchema, requiredColumns };
