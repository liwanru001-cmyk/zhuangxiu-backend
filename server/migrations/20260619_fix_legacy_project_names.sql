-- 修复早期项目没有 project_name 字段/默认值编码异常产生的历史项目名。
UPDATE renovation_projects
SET project_name = '装修项目'
WHERE project_name IS NULL
   OR TRIM(project_name) = ''
   OR project_name = 'è£…ä¿®é¡¹ç›®';
