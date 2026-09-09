const { readDetails } = require('./product-details');
function materialPayload(body) {
 const out={};
 for(const [k,n] of Object.entries({brand:120,kind:30,series:120,name:120,code:80,description:1000})) {
  if(typeof body[k] !== 'string' || body[k].length>n) throw new Error('材质字段格式或长度不正确');
  out[k]=body[k].trim();if(k!=='description'&&!out[k])throw new Error('请填写品牌、类别、系列、名称及编号');
 }
 if(!['fabric','leather','wood','metal','other'].includes(out.kind))throw new Error('请选择有效的材质类别');
 if(!['active','paused','discontinued'].includes(body.status))throw new Error('请选择有效的供应状态');out.status=body.status;
 if(!Array.isArray(body.image_urls)||body.image_urls.length>12)throw new Error('材质图片最多12张');
 out.image_urls=body.image_urls.map(s=>{let u;try{u=new URL(s)}catch{throw new Error('图片链接不正确')};if(typeof s!=='string'||s.length>1000||!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('图片链接不正确');return s});return out;
}
function mapMaterial(r) { return {...r,id:Number(r.id),merchant_user_id:Number(r.merchant_user_id),revision:Number(r.revision),image_urls:readDetails(r.image_urls)||[]}; }
function references(details) {
 const d=readDetails(details);if(!d)return [];
 return [...(d.material_groups||[]).flatMap(g=>g.material_ids.map(id=>({id,key:`group:${g.part}:${id}`}))),
 ...(d.configurations||[]).flatMap(c=>(c.material_options||[]).flatMap(g=>g.material_ids.map(id=>({id,key:`option:${c.id}:${g.part}:${id}`})))),
 ...(d.configurations||[]).flatMap(c=>(c.parts||[]).filter(p=>p.material_id).map(p=>({id:p.material_id,key:`config:${c.id}:${p.part}:${p.material_id}`})))];
}
function rejectPersonalReferences(d) { if(references(d).length)throw new Error('自录产品不能调用商家材质库，请独立填写材质和色卡'); }
async function materialRows(db,owner,ids) {
 if(!ids.length)return [];const [rows]=await db.query(`SELECT * FROM merchant_materials WHERE merchant_user_id=? AND id IN (${ids.map(()=>'?').join(',')})`,[owner,...ids]);return rows.map(mapMaterial);
}
async function validateReferences(db,details,owner,existing) {
 const d=readDetails(details);if(!d)return details;const refs=references(d);if(!refs.length)return JSON.stringify(d);
 const ids=[...new Set(refs.map(x=>x.id))];const rows=await materialRows(db,owner,ids);const byId=new Map(rows.map(m=>[m.id,m]));const old=new Set(references(existing).map(r=>r.key));
 for(const r of refs){const m=byId.get(r.id);if(!m)throw new Error('只能调用本商家的材质库');if(m.status!=='active'&&!old.has(r.key))throw new Error('暂停供应或停产的材质不能新增选用');}
 for(const c of d.configurations)for(const p of c.parts)if(p.material_id){const g=(d.material_groups||[]).find(g=>g.part===p.part);if(!g?.material_ids.includes(p.material_id))throw new Error('所选材质不在该产品部位的可用范围内');const m=byId.get(p.material_id);
 // Store a stable selection snapshot; live updates are returned separately.
 const oldPart=readDetails(existing)?.configurations?.find(x=>x.id===c.id)?.parts?.find(x=>x.part===p.part&&x.material_id===p.material_id);
 const snapshot=oldPart&&Number(p.material_revision)===Number(oldPart.material_revision)?oldPart:{material:m.series,color:m.name,code:m.code,swatch_url:m.image_urls[0]||'',material_revision:m.revision};
 for(const k of ['material','color','code','swatch_url','material_revision'])p[k]=snapshot[k];
 }
 for(const c of d.configurations)for(const option of c.material_options||[]){const group=(d.material_groups||[]).find(g=>g.part===option.part);
 if(!group||option.material_ids.some(id=>!group.material_ids.includes(id)))throw new Error('配置可选材质不在产品可用范围内');}
 return JSON.stringify(d);
}
async function hydrateProducts(db,products) {
 const owners=new Map();for(const p of products){const ids=references(p.product_details).map(r=>r.id);if(ids.length&&p.merchant_user_id){const key=Number(p.merchant_user_id);owners.set(key,[...new Set([...(owners.get(key)||[]),...ids])]);}}
 const all=new Map();for(const [owner,ids] of owners)all.set(owner,new Map((await materialRows(db,owner,ids)).map(m=>[m.id,m])));
 return products.map(p=>{const d=readDetails(p.product_details);if(!references(d).length)return {...p,product_details:d};const map=all.get(Number(p.merchant_user_id))||new Map();const out=structuredClone(d);
 const publicMaterial=id=>{const m=map.get(id);return m?{id:m.id,brand:m.brand,kind:m.kind,series:m.series,name:m.name,code:m.code,status:m.status,description:m.description,image_urls:m.image_urls,revision:m.revision}:{id,status:'unavailable'};};
 out.material_groups=(out.material_groups||[]).map(g=>({...g,materials:g.material_ids.map(publicMaterial)}));
 for(const c of out.configurations)for(const part of c.parts)if(part.material_id){part.live_material=publicMaterial(part.material_id);part.material_changed=part.live_material.revision!==part.material_revision;}
 out.material_warnings=[...new Set(references(d).map(r=>r.id))].map(publicMaterial).filter(m=>m.status!=='active').map(m=>({id:m.id,name:m.name||'原材质',code:m.code||'',status:m.status}));
 return {...p,product_details:out};});
}
module.exports={materialPayload,mapMaterial,references,rejectPersonalReferences,validateReferences,hydrateProducts};
