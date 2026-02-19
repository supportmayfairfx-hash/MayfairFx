# Deploy: Render Backend + Vercel Frontend (Free)

This repo is split:
- `Backend/` -> Render Web Service
- `Frontend/` -> Vercel Project

## 1) Push code to GitHub

Both Render and Vercel will deploy from your GitHub repo.

## 2) Deploy backend to Render

1. In Render, click `New +` -> `Blueprint`.
2. Select this repo. Render will detect `render.yaml` at repo root.
3. Create the service.
4. Set backend environment variables in Render:
   - `CORS_ORIGINS=https://YOUR-FRONTEND.vercel.app`
   - `JWT_SECRET=...` (strong random secret)
   - `ADMIN_API_KEY=...`
   - `DATABASE_URL=...` (Render Postgres URL if you use Postgres)
   - `FREECRYPTOAPI_KEY=...` (optional)
   - `AUTH_CODE_AUTO_GENERATE=true` (optional)

Notes:
- `TRUST_PROXY=1`, `AUTH_COOKIE_SAMESITE=none`, and `AUTH_COOKIE_SECURE=true` are already set in `render.yaml`.
- After deploy, confirm health check:
  - `https://YOUR-BACKEND.onrender.com/health`

## 3) Deploy frontend to Vercel

1. In Vercel, click `Add New...` -> `Project`.
2. Import the same GitHub repo.
3. Set `Root Directory` to `Frontend`.
4. Build settings should be auto-detected from `Frontend/vercel.json`.
5. Add environment variable in Vercel:
   - `VITE_API_BASE=https://YOUR-BACKEND.onrender.com`
6. Deploy.

## 4) Connect frontend <-> backend

After frontend deploy, copy the exact Vercel URL and put it into Render backend env:
- `CORS_ORIGINS=https://YOUR-FRONTEND.vercel.app`

If you have multiple frontend domains, separate with commas:
- `CORS_ORIGINS=https://a.vercel.app,https://b.vercel.app`

Redeploy Render after updating env vars.

## 5) Verify production

1. Open frontend URL.
2. Test API from browser:
   - `GET https://YOUR-BACKEND.onrender.com/health`
   - `GET https://YOUR-BACKEND.onrender.com/api/markets/snapshot`
3. Test login flow (cookies/cors):
   - Register -> login -> refresh page -> confirm session persists.
