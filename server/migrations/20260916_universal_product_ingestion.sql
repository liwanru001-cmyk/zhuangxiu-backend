UPDATE product_ingestion_sources SET adapter_key='universal_web_v1'
WHERE adapter_key<>'universal_web_v1';

UPDATE product_ingestion_jobs
SET scope_snapshot=JSON_SET(scope_snapshot,'$.adapter_key','universal_web_v1')
WHERE scope_snapshot IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(scope_snapshot,'$.adapter_key'))<>'universal_web_v1';
