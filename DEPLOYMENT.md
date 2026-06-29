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
