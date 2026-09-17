#!/usr/bin/env python3
"""Build an auditable, no-write HC28 import package and dry-run report."""
from __future__ import annotations
import hashlib, json, shutil, sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'outputs/furniture_brand_site_research_20260913/hc28_full_gold_v1.json'
AUDIT = ROOT / 'outputs/furniture_brand_site_research_20260913/hc28_gold_quality_audit_v1_1.json'
OUT = ROOT / 'outputs/furniture_brand_site_research_20260913/hc28-import-package-20260917'

def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def value(record, key):
    return (record.get('fields', {}).get(key, {}).get('gold_answer') or {}).get('normalized_value')

def urls(record):
    found = [record.get('product_url'), record.get('final_url')]
    for item in (record.get('images', {}).get('correct_assets') or []): found.append(item.get('url'))
    for item in (record.get('material_resource', {}).get('images') or []): found.append(item.get('url'))
    for item in (record.get('attachments') or []): found.append(item.get('url'))
    for item in (record.get('variant_image_links') or []):
        if isinstance(item, dict): found.append(item.get('url'))
    return [u for u in dict.fromkeys(found) if u]

def main():
    records = json.loads(SOURCE.read_text())
    audit = json.loads(AUDIT.read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'records').mkdir(exist_ok=True)
    for old in (OUT / 'records').glob('*.json'): old.unlink()
    checks, failures = [], []
    ids = [r.get('product_id') for r in records]
    checks.append(('product_id 唯一', len(ids) == len(set(ids)), f'{len(ids)} records'))
    fingerprints = [r.get('content_fingerprint_sha256') for r in records]
    checks.append(('内容指纹完整且唯一', all(fingerprints) and len(fingerprints) == len(set(fingerprints)), f'{len(fingerprints)} fingerprints'))
    all_urls = [u for r in records for u in urls(r)]
    allowed_hosts = {'www.hc28maison.com', 'hc28study.oss-cn-beijing.aliyuncs.com'}
    bad_urls = [u for u in all_urls if urlparse(u).scheme != 'https' or urlparse(u).hostname not in allowed_hosts]
    checks.append(('来源与素材 URL 白名单', not bad_urls, f'{len(all_urls)} URLs; allowed_hosts={sorted(allowed_hosts)}; bad={len(bad_urls)}'))
    variant_ids = [v.get('variant_id') for r in records for v in (r.get('variants') or [])]
    checks.append(('variant_id 唯一', len(variant_ids) == len(set(variant_ids)), f'{len(variant_ids)} variants'))
    checks.append(('原始质量审计无错误', not audit.get('errors'), f"errors={len(audit.get('errors') or [])}"))

    ndjson = []
    summaries = []
    for r in records:
        pid = r['product_id']
        raw_path = OUT / 'records' / f'{pid}.json'
        raw_path.write_text(json.dumps(r, ensure_ascii=False, indent=2) + '\n')
        materials = value(r, 'materials') or {}
        item = {
            'import_record_version': 'hc28-gold-import-v1',
            'source_external_id': pid,
            'brand': r.get('brand'),
            'source_url': r.get('product_url'),
            'final_url': r.get('final_url'),
            'content_fingerprint_sha256': r.get('content_fingerprint_sha256'),
            'product_name': value(r, 'product_name'),
            'model': value(r, 'model'),
            'category': value(r, 'category'),
            'description': value(r, 'description'),
            'designer': value(r, 'designer'),
            'design_year': value(r, 'year'),
            'variants': r.get('variants') or [],
            'assets': r.get('images', {}).get('correct_assets') or [],
            'material_codes': materials.get('option_codes') or [],
            'evidence_ref': f'records/{pid}.json',
            'intended_state': 'pending_review',
            'import_mode': 'no_crawl_no_publish',
        }
        ndjson.append(item)
        summaries.append({'product_id': pid, 'source_url': r.get('product_url'), 'fingerprint': r.get('content_fingerprint_sha256'), 'variants': len(r.get('variants') or []), 'assets': len(r.get('images', {}).get('correct_assets') or []), 'material_codes': len(materials.get('option_codes') or [])})
    (OUT / 'import-records.ndjson').write_text(''.join(json.dumps(x, ensure_ascii=False, sort_keys=True) + '\n' for x in ndjson))
    manifest = {'package_version':'hc28-gold-import-v1','generated_at':'2026-09-17','source_file':str(SOURCE.relative_to(ROOT)),'source_sha256':sha(SOURCE),'record_count':len(records),'variant_count':sum(x['variants'] for x in summaries),'asset_count':sum(x['assets'] for x in summaries),'material_code_count':sum(x['material_codes'] for x in summaries),'quality_audit':audit,'checks':[{'name':n,'passed':p,'detail':d} for n,p,d in checks],'records':summaries,'write_performed':False,'production_import_status':'not_started'}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    failures = [f'{n}: {d}' for n,p,d in checks if not p]
    report = ['# HC28 导入 dry-run 报告', '', '- 生成时间：2026-09-17', '- 模式：只读；未连接生产数据库；未发起采集；未发布产品', f'- 原始文件 SHA-256：`{sha(SOURCE)}`', '', '## 结论', '', 'PASS' if not failures else 'FAIL', '', '## 校验结果', '']
    report += [f'- {"PASS" if p else "FAIL"}：{n}（{d}）' for n,p,d in checks]
    report += ['', '## 数据规模', '', f'- 产品：{len(records)}', f'- 变体：{sum(x["variants"] for x in summaries)}', f'- 产品/变体图片：{sum(x["assets"] for x in summaries)}', f'- 材质代码：{sum(x["material_codes"] for x in summaries)}', '', '## 生产导入前置条件', '', '- 当前包明确标记为 `no_crawl_no_publish`，只允许落入待审核候选。', '- 仓库现有管理 API 没有“从本地金标准批量创建候选”的导入端点；dry-run 不会伪造生产写入。', '- 需要先通过受控导入适配器把本包转换为生产候选记录，再由管理 Web 审核后发布。']
    if failures: report += ['', '## 阻断项', ''] + [f'- {x}' for x in failures]
    (OUT / 'dry-run-report.md').write_text('\n'.join(report) + '\n')
    print(json.dumps({'out': str(OUT), 'manifest_sha256': sha(OUT/'manifest.json'), 'checks_passed': sum(p for _,p,_ in checks), 'checks_total': len(checks), 'production_write': False}, ensure_ascii=False))
    return 0 if not failures else 2

if __name__ == '__main__': sys.exit(main())
