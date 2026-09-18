'use strict';

function createWorkerMonitor(db, env = process.env) {
  const instanceId=String(env.INGESTION_WORKER_INSTANCE_ID||'i-wz9iovg5qn2n2hc6yvvu').trim();
  const staleSeconds=Math.max(30,Number(env.INGESTION_WORKER_STALE_SECONDS||60));
  const noProgressSeconds=Math.max(300,Number(env.INGESTION_JOB_NO_PROGRESS_SECONDS||900));
  const restartWindowMinutes=Math.max(5,Number(env.INGESTION_WORKER_RESTART_WINDOW_MINUTES||15));
  const restartThreshold=Math.max(2,Number(env.INGESTION_WORKER_RESTART_ALERT_COUNT||4));
  async function collect(){
    const [[workers],[restartRows],[jobs],[lifecycleRows],[pendingRows]]=await Promise.all([
      db.query(`SELECT worker_id,instance_id,hostname,status,process_id,version_sha,capabilities,started_at,heartbeat_at,last_error,TIMESTAMPDIFF(SECOND,heartbeat_at,NOW()) heartbeat_age_seconds FROM product_ingestion_workers WHERE instance_id=? ORDER BY heartbeat_at DESC LIMIT 1`,[instanceId]),
      db.query(`SELECT COUNT(*) restart_count FROM product_ingestion_workers WHERE instance_id=? AND started_at>=DATE_SUB(NOW(),INTERVAL ? MINUTE)`,[instanceId,restartWindowMinutes]),
      db.query(`SELECT id,status,current_stage,current_url,checkpoint_index,pages_fetched,candidates_found,heartbeat_at,TIMESTAMPDIFF(SECOND,COALESCE(heartbeat_at,updated_at),NOW()) progress_age_seconds FROM product_ingestion_jobs WHERE status IN ('discovery_approved','discovering','queued','running') ORDER BY id`),
      db.query('SELECT desired_state,observed_state,idle_since,last_action,action_started_at,last_error,updated_at FROM product_ingestion_worker_lifecycle WHERE instance_id=?',[instanceId]),
      db.query("SELECT COUNT(*) total FROM product_ingestion_worker_commands WHERE status IN ('queued','running')"),
    ]);
    const worker=workers[0]||null,alerts=[],lifecycle=lifecycleRows[0]||null,pending=jobs.length+Number(pendingRows[0]?.total||0);
    const intentionallyStopped=lifecycle?.desired_state==='stopped'&&lifecycle?.observed_state==='Stopped'&&pending===0;
    if(!intentionallyStopped&&(!worker||worker.status!=='online'||Number(worker.heartbeat_age_seconds)>staleSeconds)) alerts.push({key:`worker-heartbeat:${instanceId}`,type:'WORKER_HEARTBEAT_OR_DB_TUNNEL_STALE',severity:'critical',instance_id:instanceId,message:'抓取 Worker 心跳失联；Worker、PM2 或 SSH 数据库隧道可能不可用。',details:{worker,lifecycle,pending}});
    const restartCount=Number(restartRows[0]?.restart_count||0);
    if(restartCount>=restartThreshold) alerts.push({key:`worker-restart-churn:${instanceId}`,type:'WORKER_RESTART_CHURN',severity:'warning',instance_id:instanceId,message:`抓取 Worker 在 ${restartWindowMinutes} 分钟内已启动 ${restartCount} 次。`,details:{restart_count:restartCount,window_minutes:restartWindowMinutes}});
    for(const job of jobs){const age=Number(job.progress_age_seconds||0);if(['running','discovering'].includes(job.status)&&age>noProgressSeconds)alerts.push({key:`job-no-progress:${job.id}`,type:'INGESTION_JOB_NO_PROGRESS',severity:'warning',instance_id:instanceId,job_id:Number(job.id),message:`抓取任务 #${job.id} 已 ${age} 秒没有进度。`,details:{status:job.status,stage:job.current_stage,url:job.current_url,checkpoint:Number(job.checkpoint_index||0),pages:Number(job.pages_fetched||0),candidates:Number(job.candidates_found||0),progress_age_seconds:age}});}
    return {worker,restart_count:restartCount,jobs,lifecycle,pending_work:pending,alerts};
  }
  async function evaluate(){const snapshot=await collect(),keys=snapshot.alerts.map(item=>item.key);for(const alert of snapshot.alerts)await db.query(`INSERT INTO product_ingestion_worker_alerts (alert_key,alert_type,severity,instance_id,job_id,message,details,status,first_seen_at,last_seen_at,resolved_at) VALUES (?,?,?,?,?,?,?,'active',NOW(),NOW(),NULL) ON DUPLICATE KEY UPDATE alert_type=VALUES(alert_type),severity=VALUES(severity),message=VALUES(message),details=VALUES(details),first_seen_at=IF(status='resolved',NOW(),first_seen_at),status='active',last_seen_at=NOW(),resolved_at=NULL`,[alert.key,alert.type,alert.severity,alert.instance_id,alert.job_id||null,alert.message,JSON.stringify(alert.details||{})]);if(keys.length)await db.query(`UPDATE product_ingestion_worker_alerts SET status='resolved',resolved_at=NOW() WHERE status='active' AND alert_key NOT IN (${keys.map(()=>'?').join(',')})`,keys);else await db.query("UPDATE product_ingestion_worker_alerts SET status='resolved',resolved_at=NOW() WHERE status='active'");return snapshot;}
  async function status(){const snapshot=await collect();const [alerts]=await db.query(`SELECT id,alert_key,alert_type,severity,instance_id,job_id,message,details,status,first_seen_at,last_seen_at,resolved_at FROM product_ingestion_worker_alerts WHERE status='active' ORDER BY FIELD(severity,'critical','warning'),first_seen_at`);return{...snapshot,alerts};}
  return{collect,evaluate,status};
}
function startWorkerMonitor(db,env=process.env){const monitor=createWorkerMonitor(db,env),intervalMs=Math.max(15000,Number(env.INGESTION_WORKER_MONITOR_INTERVAL_MS||30000));let previous='';const run=async()=>{try{const result=await monitor.evaluate(),current=result.alerts.map(a=>a.key).sort().join(',');if(current!==previous){if(current)console.error('Product ingestion worker alert:',result.alerts.map(a=>({type:a.type,message:a.message})));else if(previous)console.log('Product ingestion worker alerts resolved');previous=current;}}catch(error){console.error('Product ingestion worker monitor failed:',error.code||error.message);}};run();const timer=setInterval(run,intervalMs);timer.unref?.();return{monitor,stop:()=>clearInterval(timer)};}
module.exports={createWorkerMonitor,startWorkerMonitor};
