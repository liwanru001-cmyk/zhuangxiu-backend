'use strict';

const Ecs = require('@alicloud/ecs20140526');
const OpenApi = require('@alicloud/openapi-client');
const Credential = require('@alicloud/credentials').default;

function createEcsLifecycleController(db, env = process.env, dependencies = {}) {
  const enabled=String(env.INGESTION_ECS_LIFECYCLE_ENABLED||'false').toLowerCase()==='true';
  const instanceId=String(env.INGESTION_WORKER_INSTANCE_ID||'i-wz9iovg5qn2n2hc6yvvu').trim();
  const regionId=String(env.INGESTION_WORKER_REGION_ID||'cn-shenzhen').trim();
  const role=String(env.INGESTION_ECS_CONTROLLER_RAM_ROLE||'YinnkhomeIngestionControllerRole').trim();
  const idleSeconds=Math.max(300,Number(env.INGESTION_WORKER_IDLE_STOP_SECONDS||900));
  let client=dependencies.client||null;
  function ecs(){if(!client){const credential=new Credential({type:'ecs_ram_role',roleName:role,disableIMDSv1:true});client=new Ecs.default(new OpenApi.Config({credential,regionId,endpoint:`ecs.${regionId}.aliyuncs.com`}));}return client;}
  async function workCount(){const [[jobs],[commands]]=await Promise.all([
    db.query("SELECT COUNT(*) total FROM product_ingestion_jobs WHERE status IN ('discovery_approved','discovering','queued','running')"),
    db.query("SELECT COUNT(*) total FROM product_ingestion_worker_commands WHERE status IN ('queued','running')"),
  ]);return Number(jobs[0]?.total||0)+Number(commands[0]?.total||0);}
  async function describe(){const response=await ecs().describeInstances(new Ecs.DescribeInstancesRequest({regionId,instanceIds:JSON.stringify([instanceId])}));const instance=response.body?.instances?.instance?.[0];if(!instance)throw new Error(`Fixed ingestion ECS not found: ${instanceId}`);return instance.status;}
  async function ensureRow(){await db.query(`INSERT INTO product_ingestion_worker_lifecycle (instance_id,region_id,desired_state) VALUES (?,?,'running') ON DUPLICATE KEY UPDATE region_id=VALUES(region_id)`,[instanceId,regionId]);}
  async function record(observed,fields={}){await db.query(`UPDATE product_ingestion_worker_lifecycle SET observed_state=?,desired_state=COALESCE(?,desired_state),idle_since=?,last_action=COALESCE(?,last_action),action_started_at=COALESCE(?,action_started_at),last_error=? WHERE instance_id=?`,[observed,fields.desired_state||null,fields.idle_since===undefined?null:fields.idle_since,fields.last_action||null,fields.action_started_at||null,fields.last_error||null,instanceId]);}
  async function tick(){if(!enabled)return{enabled:false};await ensureRow();const connection=await db.getConnection();let locked=false;try{const[locks]=await connection.query("SELECT GET_LOCK('zxw:ingestion-ecs-lifecycle',0) acquired");locked=Number(locks[0]?.acquired)===1;if(!locked)return{enabled:true,skipped:'locked'};const pending=await workCount();const observed=await describe();const[stateRows]=await db.query('SELECT * FROM product_ingestion_worker_lifecycle WHERE instance_id=?',[instanceId]);const state=stateRows[0]||{};
      if(pending>0){await record(observed,{desired_state:'running',idle_since:null});if(observed==='Stopped'){await db.query("UPDATE product_ingestion_worker_lifecycle SET last_action='start',action_started_at=NOW(),last_error=NULL WHERE instance_id=?",[instanceId]);await ecs().startInstance(new Ecs.StartInstanceRequest({instanceId}));return{enabled:true,pending,observed,action:'start'};}return{enabled:true,pending,observed,action:null};}
      if(observed!=='Running'){await record(observed,{desired_state:'stopped',idle_since:state.idle_since||new Date()});return{enabled:true,pending,observed,action:null};}
      if(!state.idle_since){await db.query("UPDATE product_ingestion_worker_lifecycle SET desired_state='running',observed_state=?,idle_since=NOW(),last_error=NULL WHERE instance_id=?",[observed,instanceId]);return{enabled:true,pending,observed,idle_seconds:0};}
      const idle=Math.max(0,Math.floor((Date.now()-new Date(state.idle_since).getTime())/1000));if(idle<idleSeconds){await record(observed,{desired_state:'running',idle_since:state.idle_since});return{enabled:true,pending,observed,idle_seconds:idle};}
      const[workers]=await db.query(`SELECT status,TIMESTAMPDIFF(SECOND,heartbeat_at,NOW()) age FROM product_ingestion_workers WHERE instance_id=? ORDER BY heartbeat_at DESC LIMIT 1`,[instanceId]);const healthy=workers[0]?.status==='online'&&Number(workers[0]?.age)<=90;if(!healthy)return{enabled:true,pending,observed,idle_seconds:idle,action:null,blocked:'worker_unhealthy'};
      await db.query("UPDATE product_ingestion_worker_lifecycle SET desired_state='stopped',last_action='stop',action_started_at=NOW(),last_error=NULL WHERE instance_id=?",[instanceId]);await ecs().stopInstance(new Ecs.StopInstanceRequest({instanceId,forceStop:false,stoppedMode:'StopCharging'}));return{enabled:true,pending,observed,action:'stop'};
    }catch(error){await ensureRow().catch(()=>{});await db.query('UPDATE product_ingestion_worker_lifecycle SET last_error=? WHERE instance_id=?',[String(error.message||error).slice(0,1000),instanceId]).catch(()=>{});throw error;}finally{if(locked)await connection.query("SELECT RELEASE_LOCK('zxw:ingestion-ecs-lifecycle')").catch(()=>{});connection.release();}}
  async function status(){await ensureRow();const[rows]=await db.query('SELECT *,TIMESTAMPDIFF(SECOND,idle_since,NOW()) idle_seconds FROM product_ingestion_worker_lifecycle WHERE instance_id=?',[instanceId]);return{enabled,instance_id:instanceId,region_id:regionId,idle_stop_seconds:idleSeconds,...rows[0]};}
  return{tick,status,workCount};
}

function startEcsLifecycleController(db,env=process.env){const controller=createEcsLifecycleController(db,env);if(String(env.INGESTION_ECS_LIFECYCLE_ENABLED||'false').toLowerCase()!=='true')return{controller,stop:()=>{}};const intervalMs=Math.max(30000,Number(env.INGESTION_ECS_LIFECYCLE_INTERVAL_MS||60000));const run=()=>controller.tick().then(result=>{if(result.action)console.log('Ingestion ECS lifecycle action:',result);}).catch(error=>console.error('Ingestion ECS lifecycle failed:',error.code||error.message));run();const timer=setInterval(run,intervalMs);timer.unref?.();return{controller,stop:()=>clearInterval(timer)};}

module.exports={createEcsLifecycleController,startEcsLifecycleController};
