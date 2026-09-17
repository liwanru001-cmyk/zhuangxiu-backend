# Backend Deployment

This repository contains a Node/Express backend in `server/`.

## Required Runtime

- Node.js 22.x (must match CI and `PRODUCTION_NODE_MAJOR`)
- MySQL 8+
- PM2 for process management
- Nginx or another reverse proxy in front of the backend

## Environment

Create `server/.env` on the production host from `server/.env.example`.

Required values:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `JWT_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_TOKEN_VERSION`
- `ADMIN_JWT_EXPIRES_IN`
- `INGESTION_GLOBAL_CONCURRENCY`
- `INGESTION_AI_API_KEY`
- `INGESTION_AI_BASE_URL`
- `INGESTION_AI_MODEL`
- `INGESTION_CHROME_PATH`
- `REDIS_URL`

Generate `ADMIN_PASSWORD_HASH` locally; never store the plaintext password in
Git or in the deployment workflow:

```sh
cd server
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'replace-with-the-new-password'
```

Incrementing `ADMIN_TOKEN_VERSION` invalidates every administrator token issued
with an older version. Tokens created before versioning was introduced are also
rejected. The default administrator token lifetime is 8 hours.

## GitHub Actions Secrets

Add these secrets to the GitHub repository:

- `SSH_HOST`: deployment server hostname or IP
- `SSH_PORT`: SSH port, usually `22`
- `SSH_USER`: SSH username
- `SSH_PRIVATE_KEY`: private key that can SSH into the server
- `APP_DIR`: absolute deployment path, for example `/var/www/zhuangxiu`

The workflow deploys on pushes to `main` when files under `server/` change.

## First Server Setup

On the server, install Node.js, MySQL, Nginx, and PM2. Then create the app directory and the production env file:

```sh
sudo mkdir -p /var/www/zhuangxiu
sudo chown -R "$USER":"$USER" /var/www/zhuangxiu
```

After the first deployment clone, create:

```sh
/var/www/zhuangxiu/server/.env
```

Use `server/.env.example` as the template.

## Manual Start

```sh
cd /var/www/zhuangxiu/server
npm ci --omit=dev
mkdir -p uploads logs
pm2 startOrReload ecosystem.config.cjs --env production
pm2 save
curl http://127.0.0.1:3001/health
```

Deployment smoke checks run with `APP_RUNTIME_MODE=smoke`. This mode is only for
the temporary validation process: it does not run schema initialization,
product-ingestion recovery, presentation workers, or scheduled evaluations.

Before migrations, deployment runs `npm run check:production-contract --
--connectivity`. It validates the pinned Node major, administrator settings,
bounded ingestion concurrency, AI configuration, Chromium, Redis, storage, and
the configured fallback font. Connectivity checks are read-only: Redis `PING`,
Chromium launch/close, and OSS bucket metadata when OSS storage is enabled.

Product ingestion uses MySQL advisory-lock slots shared by every backend
process. `INGESTION_GLOBAL_CONCURRENCY=2` is the initial production limit; a
job that cannot obtain a slot remains queued and retries without being marked
failed.

Applied migration files are immutable. `scripts/run-pending-migrations.js`
compares every recorded SHA-256 checksum with the file in the release and
stops before applying pending migrations when any historical file has drifted.

Database backups are stored outside the deployed application at
`<APP_DIR>.private/db-backups` with directory mode `0700` and file mode `0600`.
They must never be placed below `server/storage`, `server/uploads`, or
`server/public`, because those directories may be served over HTTP.

## Nginx Example

```nginx
server {
    listen 80;
    server_name api.example.com;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Docker

Build the backend image:

```sh
docker build -t zhuangxiu-backend ./server
```

Run it with an env file:

```sh
docker run --env-file ./server/.env -p 3001:3001 zhuangxiu-backend
```
