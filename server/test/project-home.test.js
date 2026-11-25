'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Dependency injection keeps the tests independent of a running database.
for (const path of ['../config/db', '../controllers/renovation.controller']) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports: {} };
}
const { createHomeController } = require('../controllers/project-home.controller');
function response() { return { code: 200, status(n) { this.code=n; return this; }, json(p) { this.payload=p; return this; } }; }
function fixtures({ denied=false, missing=false, cover='cover.jpg', main=true }={}) {
  const handlers = {};
  for (const name of ['getProjectMembers','getProjectTodos','getProjectDesignDocuments','getProjectHandovers','getProjectMaterials']) handlers[name] = async (_,res) => res.status(200).json({data: []});
  handlers.getProjectDetail = async (_,res) => denied ? res.status(404).json({message:'项目不存在'}) : res.status(200).json({data:{project:{id:7,floor_plan_image:'floor.jpg'}}});
  handlers.getProjectDesignDocuments = async (_,res) => res.status(200).json({data:[
    {category:'layout_plan',is_current:1},
    {category:'layout_plan',is_current:0},
    {category:'construction_drawing',is_current:1,status:'voided'},
    {id:19,category:'rendering',space_key:'3',is_current:1,status:'confirmed',file_type:'image',mime_type:'image/jpeg',file_url:'main-file.jpg',preview_url:'main-preview.jpg'},
  ]});
  if (missing) handlers.getProjectMembers = async () => { throw Error('offline'); };
  let queries=0;
  const database = {async query(sql,args) {
    queries++;
    assert.equal(args[0],7);
    if (sql.includes('FROM project_spaces WHERE')) return [[{id:3,project_id:7,name:'客厅',main_design_document_id:main?19:null}]];
    if (sql.includes('FROM project_space_images')) throw Error('homepage must not read legacy space images');
    if (sql.includes('COUNT(*)')) return [[{total:2}]];
    if (sql.includes('FROM project_showcases')) {
      assert.match(sql,/owner_user_id=\?/);
      assert.match(sql,/status='published'/);
      assert.equal(args[1],8);
      return [cover ? [{cover_image:cover}] : []];
    }
    throw Error(sql);
  }};
  return {handler:createHomeController(handlers,database), queries:()=>queries};
}
const req={params:{id:'7'},user:{id:8}};
test('denied projects do not query subresources',async()=>{
  const f=fixtures({denied:true}),res=response(); await f.handler(req,res);
  assert.equal(res.code,404); assert.equal(f.queries(),0);
});
test('counts current documents and uses authorized showcase cover',async()=>{
  const f=fixtures(),res=response(); await f.handler(req,res);
  assert.equal(res.payload.data.cover_url,'cover.jpg');
  assert.deepEqual(res.payload.data.document_counts,{layout_plan:1,rendering:1,original_floor_plan:1});
  assert.equal(res.payload.data.product_count,2);
  assert.equal(res.payload.data.spaces[0].images[0].image_url,'main-preview.jpg');
});
test('section failures stay unavailable, and cover falls back to selected main design image',async()=>{
  const f=fixtures({missing:true,cover:null}),res=response(); await f.handler(req,res);
  assert.equal(res.code,200); assert.equal(res.payload.data.members,null);
  assert.deepEqual(res.payload.data.unavailable,['members']);
  assert.equal(res.payload.data.cover_url,'main-preview.jpg');
});
test('space without selected main image stays empty instead of using a different rendering',async()=>{
  const f=fixtures({cover:null,main:false}),res=response(); await f.handler(req,res);
  assert.deepEqual(res.payload.data.spaces[0].images,[]);
  assert.equal(res.payload.data.cover_url,'floor.jpg');
});
