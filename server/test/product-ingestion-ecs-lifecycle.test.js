'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createEcsLifecycleController}=require('../services/product-ingestion-ecs-lifecycle');

function database({jobs=0,commands=0,state={},worker={status:'online',age:1}}={}){
  const writes=[];
  const query=async(sql)=>{
    writes.push(sql);
    if(sql.includes('COUNT(*) total FROM product_ingestion_jobs'))return[[{total:jobs}]];
    if(sql.includes('COUNT(*) total FROM product_ingestion_worker_commands'))return[[{total:commands}]];
    if(sql.includes('SELECT * FROM product_ingestion_worker_lifecycle'))return[[state]];
    if(sql.includes('FROM product_ingestion_workers'))return[[worker]];
    return[{affectedRows:1}];
  };
  return{writes,query,getConnection:async()=>({query:async sql=>sql.includes('GET_LOCK')?[[{acquired:1}]]:[[{released:1}]],release(){}})};
}
const env={INGESTION_ECS_LIFECYCLE_ENABLED:'true',INGESTION_WORKER_INSTANCE_ID:'i-fixed',INGESTION_WORKER_REGION_ID:'cn-test',INGESTION_ECS_CONTROLLER_RAM_ROLE:'ControllerRole',INGESTION_WORKER_IDLE_STOP_SECONDS:'900'};

test('fixed ECS controller starts the existing instance when durable work is queued',async()=>{
  const db=database({jobs:1,state:{}});let started=0;
  const client={describeInstances:async()=>({body:{instances:{instance:[{status:'Stopped'}]}}}),startInstance:async()=>{started++;}};
  const result=await createEcsLifecycleController(db,env,{client}).tick();
  assert.equal(result.action,'start');assert.equal(started,1);
});

test('fixed ECS controller stops only a healthy idle worker and never creates an instance',async()=>{
  const db=database({state:{idle_since:new Date(Date.now()-16*60*1000)}});let stopped=0;
  const client={describeInstances:async()=>({body:{instances:{instance:[{status:'Running'}]}}}),stopInstance:async()=>{stopped++;}};
  const result=await createEcsLifecycleController(db,env,{client}).tick();
  assert.equal(result.action,'stop');assert.equal(stopped,1);assert.equal(typeof client.createInstance,'undefined');
});
