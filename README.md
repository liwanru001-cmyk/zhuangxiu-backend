# 装修好烦

装修 App 项目，包含 Flutter 客户端和 Node/Express 后端。

## Backend

后端位于 `server/`，生产部署说明见 `DEPLOYMENT.md`。

```sh
cd server
npm ci
cp .env.example .env
npm start
```

健康检查：

```sh
curl http://127.0.0.1:3001/health
```
