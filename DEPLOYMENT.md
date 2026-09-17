# Backend Deployment

This repository contains a Node/Express backend in `server/`.

## Required Runtime

- Node.js 20+
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
