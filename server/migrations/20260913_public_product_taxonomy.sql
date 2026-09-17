CREATE TABLE IF NOT EXISTS public_product_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id BIGINT UNSIGNED DEFAULT NULL,
  category_code VARCHAR(80) NOT NULL,
  name VARCHAR(80) NOT NULL,
  level TINYINT UNSIGNED NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_public_product_category_code (category_code),
  KEY idx_public_product_category_parent (parent_id,sort_order),
  CONSTRAINT fk_public_product_category_parent FOREIGN KEY (parent_id) REFERENCES public_product_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_source_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  external_key VARCHAR(120) NOT NULL,
  name VARCHAR(120) NOT NULL,
  source_url VARCHAR(1000) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ingestion_source_category (source_id,external_key),
  CONSTRAINT fk_ingestion_source_category_source FOREIGN KEY (source_id) REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_category_mappings (
  source_category_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  approved_by VARCHAR(80) NOT NULL,
  approved_at DATETIME NOT NULL,
  PRIMARY KEY (source_category_id,category_id),
  CONSTRAINT fk_ingestion_category_mapping_source FOREIGN KEY (source_category_id) REFERENCES product_ingestion_source_categories(id),
  CONSTRAINT fk_ingestion_category_mapping_category FOREIGN KEY (category_id) REFERENCES public_product_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS public_product_category_relations (
  product_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  source_category_id BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id,category_id),
  KEY idx_public_product_category_relation (category_id,product_id),
  CONSTRAINT fk_public_product_category_product FOREIGN KEY (product_id) REFERENCES public_product_library_products(id),
  CONSTRAINT fk_public_product_category_category FOREIGN KEY (category_id) REFERENCES public_product_categories(id),
  CONSTRAINT fk_public_product_category_source FOREIGN KEY (source_category_id) REFERENCES product_ingestion_source_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO public_product_categories (parent_id,category_code,name,level,sort_order,status) VALUES
  (NULL,'furniture','家具',1,10,'active'),
  (NULL,'lighting','灯具',1,20,'active'),
  (NULL,'curtains','窗帘',1,30,'active'),
  (NULL,'rugs','地毯',1,40,'active'),
  (NULL,'artwork','装饰画',1,50,'active'),
  (NULL,'accessories','饰品',1,60,'active')
ON DUPLICATE KEY UPDATE name=VALUES(name),level=VALUES(level),sort_order=VALUES(sort_order);

INSERT INTO public_product_categories (parent_id,category_code,name,level,sort_order,status)
SELECT parent.id,child.category_code,child.name,2,child.sort_order,'active'
FROM public_product_categories parent
JOIN (
  SELECT 'furniture.sofa' category_code,'沙发' name,10 sort_order UNION ALL
  SELECT 'furniture.lounge-chair','休闲椅',20 UNION ALL
  SELECT 'furniture.chair-stool','椅凳',30 UNION ALL
  SELECT 'furniture.coffee-side-table','茶几与边几',40 UNION ALL
  SELECT 'furniture.table','桌',50 UNION ALL
  SELECT 'furniture.bed','床',60 UNION ALL
  SELECT 'furniture.living-dining-storage','厅餐柜与书柜',70 UNION ALL
  SELECT 'furniture.bedroom-storage','卧室柜',80
) child ON parent.category_code='furniture'
ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id),name=VALUES(name),level=VALUES(level),sort_order=VALUES(sort_order);
