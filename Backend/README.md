# Backend

Small Express API that proxies market data so API keys stay server-side.

## Setup

```bat
cd Backend
npm.cmd install
copy .env.example .env
```

Edit `.env` and set `FREECRYPTOAPI_KEY`.
Also set `DATABASE_URL` and `JWT_SECRET`.
For cross-origin frontend deployments, also set:
- `CORS_ORIGINS` (comma-separated allowed origins)
- `TRUST_PROXY=1` (behind Render/proxy)
- `AUTH_COOKIE_SAMESITE=none`
- `AUTH_COOKIE_SECURE=true`

## Run

```bat
npm.cmd run dev
```

Health check: `http://localhost:8787/health`

Markets snapshot: `http://localhost:8787/api/markets/snapshot`

Auth:
- POST `http://localhost:8787/api/auth/register`
- POST `http://localhost:8787/api/auth/login`
- POST `http://localhost:8787/api/auth/logout`
- GET `http://localhost:8787/api/auth/me`
- GET `http://localhost:8787/api/auth/status`

## DB Notes

This backend prefers `DATABASE_URL` (Postgres). If Postgres is unreachable (common when port 5432 is blocked),
it automatically falls back to a local file DB at `Backend/data/auth-store.json` so login can still work in dev.

Admin (for Telegram bot):
- POST `http://localhost:8787/api/auth/admin/auth-codes` (set a specific code)
- POST `http://localhost:8787/api/auth/admin/generate-auth-code` (generate + store a code)
- GET `http://localhost:8787/api/auth/admin/active-auth-code?email=user@gmail.com` (lookup active code)
