module.exports = {
  apps: [{
    name: 'yinnkhome-ingestion-worker',
    script: 'product-ingestion-worker.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV:'production', APP_RUNTIME_ROLE:'ingestion-worker', INGESTION_GLOBAL_CONCURRENCY:'1' },
    env_production: { NODE_ENV:'production', APP_RUNTIME_ROLE:'ingestion-worker', INGESTION_GLOBAL_CONCURRENCY:'1' },
    error_file: './logs/worker-error.log',
    out_file: './logs/worker-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '3072M',
    kill_timeout: 30000,
  }],
};
