-- ============================================================
-- The Watch Box Co. — COGS Manager
-- Supabase / PostgreSQL Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- Table: purchases
-- Manually logged stock purchases
-- ============================================================
create table if not exists purchases (
  id            uuid primary key default gen_random_uuid(),
  sku           text not null,
  product_name  text not null,
  quantity      integer not null check (quantity > 0),
  unit_cost     numeric(12, 2) not null check (unit_cost >= 0),
  purchase_date date not null,
  supplier_notes text,
  created_at    timestamptz default now()
);

-- Index for SKU lookups (used in COGS calculations)
create index if not exists purchases_sku_idx on purchases(sku);
create index if not exists purchases_date_idx on purchases(purchase_date);

-- ============================================================
-- Table: products
-- Current/latest unit cost per SKU (auto-updated on purchase)
-- ============================================================
create table if not exists products (
  id               uuid primary key default gen_random_uuid(),
  sku              text unique not null,
  product_name     text not null,
  current_unit_cost numeric(12, 2) not null,
  updated_at       timestamptz default now()
);

-- ============================================================
-- Table: shopify_sales
-- Synced from Shopify — never manually edited
-- ============================================================
create table if not exists shopify_sales (
  id               uuid primary key default gen_random_uuid(),
  shopify_order_id text not null,
  sku              text not null,
  product_name     text not null,
  quantity_sold    integer not null check (quantity_sold > 0),
  sale_price       numeric(12, 2) not null,
  line_revenue     numeric(12, 2),          -- exact line total (qty × price − discount), avoids rounding from sale_price × qty
  order_date       date not null,
  store            text not null default 'au',  -- 'au' or 'us'
  synced_at        timestamptz default now(),

  -- Unique constraint for idempotent upsert
  unique (shopify_order_id, sku)
);

-- Indexes for period-based queries
create index if not exists shopify_sales_sku_idx on shopify_sales(sku);
create index if not exists shopify_sales_order_date_idx on shopify_sales(order_date);
create index if not exists shopify_sales_store_idx on shopify_sales(store);

-- ============================================================
-- Table: shopify_refunds
-- Refund line items synced from Shopify — keyed by refund_date
-- so period queries subtract returns by when they happened,
-- not when the original order was placed (matches Shopify analytics)
-- ============================================================
create table if not exists shopify_refunds (
  id                uuid primary key default gen_random_uuid(),
  shopify_order_id  text not null,
  shopify_refund_id text not null,
  sku               text not null,
  product_name      text not null,
  quantity_refunded integer not null check (quantity_refunded > 0),
  refund_subtotal   numeric(12, 2) not null default 0,
  refund_date       date not null,
  store             text not null default 'au',
  synced_at         timestamptz default now(),

  -- One row per (refund, sku) — quantities aggregated across line items of same SKU
  unique (shopify_refund_id, sku)
);

create index if not exists shopify_refunds_sku_idx   on shopify_refunds(sku);
create index if not exists shopify_refunds_date_idx  on shopify_refunds(refund_date);
create index if not exists shopify_refunds_store_idx on shopify_refunds(store);

-- ============================================================
-- Row Level Security (RLS)
-- Using anon key from backend — enable RLS and add policies
-- ============================================================

-- purchases
alter table purchases enable row level security;
create policy "Allow all for anon" on purchases for all using (true) with check (true);

-- products
alter table products enable row level security;
create policy "Allow all for anon" on products for all using (true) with check (true);

-- shopify_sales
alter table shopify_sales enable row level security;
create policy "Allow all for anon" on shopify_sales for all using (true) with check (true);

-- shopify_refunds
alter table shopify_refunds enable row level security;
create policy "Allow all for anon" on shopify_refunds for all using (true) with check (true);

-- ============================================================
-- Sample data (optional — remove before production)
-- ============================================================

-- insert into purchases (sku, product_name, quantity, unit_cost, purchase_date, supplier_notes)
-- values
--   ('ROL-SUB-124060', 'Rolex Submariner 124060', 1, 15200.00, '2026-01-15', 'Grey Street Watches, inv #1001'),
--   ('ROL-DJ-126300',  'Rolex Datejust 126300',   2, 8400.00,  '2026-01-20', 'Sydney Dealer, inv #2204'),
--   ('AP-ROO-15400',   'AP Royal Oak 15400',       1, 28500.00, '2026-02-01', 'Direct purchase');

-- ============================================================
-- Xero OAuth tokens
-- ============================================================

CREATE TABLE IF NOT EXISTS xero_tokens (
  id SERIAL PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMP,
  tenant_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Capital Expenses
-- ============================================================

CREATE TABLE IF NOT EXISTS capital_expenses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  purchase_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- App Settings (key-value store for manual overrides etc.)
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
