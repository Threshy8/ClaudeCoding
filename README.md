# The Watch Box Co. — COGS & Inventory Manager

A full-stack web app that tracks stock purchases, syncs sales from Shopify, calculates true COGS using the **average cost method**, and exports Xero-ready journal entries for month-end accounting.

## The Problem It Solves

Xero records all stock purchases as COGS immediately. But COGS should only be recognised when items **actually sell**. This app:

1. Tracks what you've purchased (manually logged)
2. Auto-pulls what's sold from Shopify
3. Calculates true COGS vs inventory asset value (average cost method)
4. Exports a journal entry CSV for your accountant to post in Xero each month

---

## Project Structure

```
/
├── frontend/          # React app (CRA)
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api.js
│   │   └── components/
│   │       ├── Dashboard.jsx
│   │       ├── PurchasesTab.jsx
│   │       ├── SalesCogsTab.jsx
│   │       └── JournalTab.jsx
│   └── package.json
│
├── backend/           # Node.js / Express API
│   ├── src/
│   │   ├── index.js
│   │   ├── db/supabase.js
│   │   └── routes/
│   │       ├── purchases.js
│   │       ├── products.js
│   │       ├── sync.js      ← Shopify sync
│   │       ├── cogs.js      ← COGS calculations
│   │       └── journal.js   ← Xero CSV export
│   ├── .env.example
│   └── package.json
│
└── supabase/
    └── schema.sql     ← Run this in Supabase SQL Editor
```

---

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor → New Query**
3. Paste and run the contents of `supabase/schema.sql`
4. Copy your **Project URL** and **anon public key** from Project Settings → API

### 2. Backend

```bash
cd backend
cp .env.example .env
# Fill in your credentials in .env
npm install
npm run dev   # starts on port 3001
```

#### Backend `.env` variables:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SHOPIFY_STORE_URL` | Your store URL, e.g. `https://the-watch-box-co.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Custom app access token (shpat_...) — **recommended** |
| *or* `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | OAuth credentials (alternative) |
| `PORT` | Backend port (default 3001) |
| `FRONTEND_URL` | CORS origin (default http://localhost:3000) |

#### Shopify setup (choose one):

**Option A — Custom app (simplest):**
1. Shopify Admin → **Settings** → **Apps and sales channels** → **Develop apps** → **Create an app**
2. Configure **Admin API scopes**: `read_orders`, `read_products`
3. **Install app** → **Reveal token once** → Copy the Admin API access token (starts with `shpat_`)
4. Add `SHOPIFY_ACCESS_TOKEN=shpat_...` to your `.env`

**Option B — OAuth client credentials:**
1. Create app in Shopify Partner Dashboard (for your own stores)
2. Use `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` in `.env` (token auto-refreshes)

### 3. Frontend

```bash
cd frontend
npm install
npm start   # starts on port 3000
```

The CRA proxy in `package.json` forwards `/api/*` to `http://localhost:3001` in development.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/purchases` | List all purchases |
| `POST` | `/api/purchases` | Add a purchase |
| `DELETE` | `/api/purchases/:id` | Delete a purchase |
| `GET` | `/api/products` | List products with current costs |
| `POST` | `/api/sync/shopify` | Sync orders from Shopify |
| `GET` | `/api/cogs/summary?period=YYYY-MM` | COGS summary + SKU breakdown |
| `GET` | `/api/journal/export?period=YYYY-MM` | Download Xero journal CSV |

---

## COGS Calculation Method

**Average Cost (AVCO):**

- `avg_unit_cost` = total cost of all purchases for SKU ÷ total units purchased
- `COGS` = units sold in period × avg_unit_cost
- `Inventory value` = (total purchased − total sold all time) × avg_unit_cost

---

## Deployment

### Backend → Railway

1. Create new project at [railway.app](https://railway.app)
2. Deploy from GitHub repo, select `/backend` as root
3. Set all environment variables in Railway dashboard
4. Note the public URL (e.g. `https://watchbox-backend.railway.app`)

### Frontend → Vercel

1. Import repo at [vercel.com](https://vercel.com), select `/frontend` as root
2. Set `REACT_APP_API_URL` = your Railway backend URL
3. Deploy

---

## Xero Journal Import Instructions

1. Accounting → Manual Journals → Import
2. Upload the downloaded `xero-journal-YYYY-MM.csv`
3. Verify account codes match your chart of accounts:
   - **1500** — Inventory Asset (credit)
   - **5000** — Cost of Goods Sold (debit)
4. Review and Post
