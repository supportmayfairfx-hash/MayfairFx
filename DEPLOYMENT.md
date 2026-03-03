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
5. Do **not** set `VITE_API_BASE` on Vercel for production.
   - Frontend calls `/api/*` on the same Vercel origin.
   - `Frontend/vercel.json` rewrites those paths to your Render backend.
   - This keeps auth cookies first-party (required for Safari/iPhone reliability).
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

## 6) Bitcart deployment (required for live deposits)

Important:
- Bitcart cannot run on Vercel static hosting.
- Keep this architecture:
  - Frontend: Vercel (e.g. `app.yourdomain.com`)
  - Backend: Render (e.g. `investment-backend.onrender.com`)
  - Bitcart: Docker VPS (e.g. `pay.yourdomain.com`)

### A) DNS

1. Point `pay.yourdomain.com` to your VPS IP (A record).
2. Keep your frontend domain on Vercel.

### B) Install Bitcart on VPS

Run on Ubuntu VPS:

```bash
sudo su -
apt-get update && apt-get install -y git
if [ -d "bitcart-docker" ]; then
  echo "existing bitcart-docker folder found, pulling instead of cloning."
  cd bitcart-docker && git pull && cd ..
fi
if [ ! -d "bitcart-docker" ]; then
  echo "cloning bitcart-docker"
  git clone https://github.com/bitcart/bitcart-docker bitcart-docker
fi
export BITCART_HOST=pay.yourdomain.com
export BITCART_CRYPTOS=btc,bnb,eth,ltc,trx
cd bitcart-docker
./setup.sh
```

### C) Configure Bitcart app

1. Open `https://pay.yourdomain.com`.
2. Create wallets for enabled coins.
3. Create a store (example: `Trade Fix`).
4. Generate store API key.
5. Configure webhook:
   - URL: `https://YOUR-BACKEND-DOMAIN/api/bitcart/webhook`
   - Secret: a strong random value

### D) Render backend env vars for Bitcart

Set in Render service env:

- `BITCART_ENABLED=true`
- `BITCART_API_URL=https://pay.yourdomain.com/api`
- `BITCART_API_KEY=...`
- `BITCART_STORE_ID=...`
- `BITCART_INVOICE_PATH=/invoices`
- `BITCART_AUTH_SCHEME=token` (or `bearer` if your instance requires it)
- `BITCART_WEBHOOK_URL=https://YOUR-BACKEND-DOMAIN/api/bitcart/webhook`
- `BITCART_WEBHOOK_SECRET=...`
- `BITCART_REDIRECT_URL=https://YOUR-FRONTEND-DOMAIN/dashboard`

Redeploy backend after setting env vars.

### E) End-to-end test

1. Open Home page and submit a deposit.
2. Confirm you get `Continue to Bitcart Payment`.
3. Complete payment in Bitcart checkout.
4. Confirm status updates in Admin panel: `Deposit Admin (Bitcart)`.
