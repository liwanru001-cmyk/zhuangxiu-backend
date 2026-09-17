'use strict';

// One-shot, idempotent import of the audited HC28 package into pending candidates.
// It intentionally never starts a crawler and never publishes a product.
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const packageFile = process.argv[2] || '/tmp/hc28-import-records.ndjson';
const apply = process.argv.includes('--apply');
const actor = 'hc28-audited-import';

function categoryFor(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('chair')) return 'chair';
  if (v.includes('table')) return 'table';
  if (v.includes('bed')) return 'bed';
  if (v.includes('cabinet')) return 'cabinet';
  return 'sofa';
}

function legacyPayload(record) {
  const assets = (record.assets || []).filter(item => item && item.url);
  const imageUrls = assets.filter(item => !/dimension|drawing/i.test(String(item.role || ''))).slice(0, 5).map(item => item.url);
  const configurations = (record.variants || []).map((variant, index) => {
    const d = variant.dimensions_normalized_mm || {};
    return {
      id: String(variant.variant_id || `variant-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '_'),
      name: String(variant.category || variant.model_code || `配置 ${index + 1}`).slice(0, 120),
      code: String(variant.model_code || '').slice(0, 500), shape: 'box',
      dimensions: { width: d.width || null, depth: d.depth || null, height: d.height || null },
      dimension_unit: 'mm', dimension_note: String(variant.dimensions_raw || ''),
      parts: [{ part: '官网材料选项', material: '见材料选项代码', color: '', code: '', swatch_url: '' }],
      material_options: [], image_urls: imageUrls.slice(0, 5), image_url: imageUrls[0] || '', drawing_url: '', drawing_name: '',
      unit: '件', price_state: 'unknown', currency: 'CNY', price: null, includes: '',
    };
  });
  return {
    product_schema_version: 1, name: record.product_name || record.source_external_id,
    brand: record.brand || 'HC28 maison', description: record.description || '',
    cover_url: imageUrls[0] || '', product_group: 'soft_furnishings', product_type: 'furniture',
    product_details: { schema_version: 1, product_kind: 'furniture', furniture_type: categoryFor(record.category),
      model: record.model || '', source_url: record.source_url, configurations,
      customization: { enabled: true, fields: ['material', 'color'], limits: 'HC28 官网材料选项代码；待审核', pricing_note: '' } },
  };
}

async function main() {
  await db.schemaReady;
  const records = fs.readFileSync(packageFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const conn = await db.getConnection();
  let sourceId, jobId, inserted = 0, updated = 0;
  try {
    await conn.beginTransaction();
    const [sources] = await conn.query('SELECT * FROM product_ingestion_sources WHERE brand_name=? AND base_url=? LIMIT 1 FOR UPDATE', ['HC28 maison', 'https://www.hc28maison.com/']);
    if (sources[0]) sourceId = sources[0].id;
    else {
      const [r] = await conn.query(`INSERT INTO product_ingestion_sources
        (brand_name,base_url,allowed_hosts,allowed_asset_hosts,allowed_path_prefixes,product_group,product_type,adapter_key,status,max_pages_per_run,max_products_per_run,request_interval_ms,obey_robots,manual_review_required,notes,created_by)
        VALUES (?,?,?,?,?,'soft_furnishings','furniture','universal_web_v1','active',500,500,2000,1,1,?,?)`,
        ['HC28 maison','https://www.hc28maison.com/','["www.hc28maison.com"]','["www.hc28maison.com","hc28study.oss-cn-beijing.aliyuncs.com"]','["/"]','Audited local HC28 import; no crawl; pending review',actor]);
      sourceId = r.insertId;
    }
    const [jobs] = await conn.query('SELECT id FROM product_ingestion_jobs WHERE source_id=? AND reason=? ORDER BY id DESC LIMIT 1 FOR UPDATE', [sourceId, 'HC28 audited local import 20260917']);
    if (jobs[0]) jobId = jobs[0].id;
    else {
      const [r] = await conn.query(
        `INSERT INTO product_ingestion_jobs
          (source_id,status,job_mode,seed_urls,max_pages,max_products,request_interval_ms,reason,scope_snapshot,created_by,started_at,finished_at)
          VALUES (?,'completed','detail_capture',?,500,500,2000,?,?,?,NOW(),NOW())`,
        [
          sourceId,
          JSON.stringify(records.map(x => x.source_url)),
          'HC28 audited local import 20260917',
          JSON.stringify({
            source_id: sourceId,
            seed_urls: records.map(x => x.source_url),
            no_crawl: true,
            import_manifest: 'hc28-import-package-20260917'
          }),
          actor
        ]
      );

      jobId = r.insertId;
    }
    for (const record of records) {
      const payload = legacyPayload(record);
      const sourceUrlHash = require('crypto').createHash('sha256').update(record.source_url).digest('hex');
      const [existing] = await conn.query('SELECT id,published_product_id FROM product_ingestion_candidates WHERE source_id=? AND source_url_hash=? FOR UPDATE', [sourceId, sourceUrlHash]);
      if (existing[0]?.published_product_id) continue;
      const values = [jobId, sourceId, record.source_url, sourceUrlHash, record.source_external_id, record.content_fingerprint_sha256, 200, 'application/json', JSON.stringify({ imported_from: record.evidence_ref, no_crawl: true }), JSON.stringify(record), JSON.stringify(payload), 1, '[]', JSON.stringify({ product_type: 'furniture' })];
      if (existing[0]) {
        await conn.query(`UPDATE product_ingestion_candidates SET job_id=?,content_fingerprint=?,raw_http_status=?,raw_content_type=?,raw_html=?,extracted_payload=?,normalized_payload=?,product_schema_version=?,generated_fields=?,classification_suggestion=?,validation_status='valid',validation_issues='[]',review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?`, [...values.slice(0,1), ...values.slice(5), existing[0].id]);
        updated++;
      } else {
        await conn.query(`INSERT INTO product_ingestion_candidates
          (job_id,source_id,source_url,source_url_hash,source_external_id,content_fingerprint,raw_http_status,raw_content_type,raw_html,extracted_payload,normalized_payload,product_schema_version,generated_fields,classification_suggestion,validation_status,validation_issues,review_status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'valid','[]','pending')`, values);
        inserted++;
      }
    }
    await conn.commit();
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', source_id: sourceId, job_id: jobId, inserted, updated, total: records.length, published: 0 }));
  } catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); await db.end(); }
}

if (!apply) { console.error('Refusing to write without --apply'); process.exit(2); }
main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
