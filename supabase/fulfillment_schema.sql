-- ============================================================
-- 3PL Fulfilment Cost Tracking
-- Run in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create table if not exists fulfillment_invoices (
  id                  uuid primary key default gen_random_uuid(),
  invoice_ref         text,
  invoice_date        date not null,
  period_description  text,
  units_shipped       integer,
  total_ex_gst        numeric(10,2) not null default 0,
  total_gst           numeric(10,2) not null default 0,
  total_inc_gst       numeric(10,2) not null default 0,
  created_at          timestamptz default now()
);

create index if not exists fulfillment_invoices_date_idx on fulfillment_invoices(invoice_date);

create table if not exists fulfillment_line_items (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references fulfillment_invoices(id) on delete cascade,
  description   text not null,
  category      text not null check (category in ('inbound', 'outbound', 'other')),
  cost_type     text not null default 'fixed' check (cost_type in ('variable', 'fixed')),
  quantity      numeric(10,2),
  unit_rate     numeric(10,4),
  amount_ex_gst numeric(10,2) not null default 0,
  gst           numeric(10,2) not null default 0,
  created_at    timestamptz default now()
);

create index if not exists fulfillment_line_items_invoice_idx  on fulfillment_line_items(invoice_id);
create index if not exists fulfillment_line_items_category_idx on fulfillment_line_items(category);
create index if not exists fulfillment_line_items_cost_type_idx on fulfillment_line_items(cost_type);

-- RLS
alter table fulfillment_invoices   enable row level security;
alter table fulfillment_line_items enable row level security;

create policy "Allow all for anon" on fulfillment_invoices   for all using (true) with check (true);
create policy "Allow all for anon" on fulfillment_line_items for all using (true) with check (true);

-- ============================================================
-- Migrations (run if tables already exist)
-- ============================================================

-- Add due_date to invoices
alter table fulfillment_invoices add column if not exists due_date date;

-- Add delivery to category constraint + variable_type column
alter table fulfillment_line_items drop constraint if exists fulfillment_line_items_category_check;
alter table fulfillment_line_items add constraint fulfillment_line_items_category_check
  check (category in ('inbound', 'outbound', 'delivery', 'other'));

alter table fulfillment_line_items add column if not exists variable_type text;

-- Add packaging category + supplier column + sku_mapping
alter table fulfillment_line_items drop constraint if exists fulfillment_line_items_category_check;
alter table fulfillment_line_items add constraint fulfillment_line_items_category_check
  check (category in ('inbound', 'outbound', 'delivery', 'packaging', 'other'));

alter table fulfillment_line_items add column if not exists sku_mapping text;
alter table fulfillment_invoices add column if not exists supplier text default 'scc';

-- Add pdf_url to store original invoice PDF link (Supabase Storage)
alter table fulfillment_invoices add column if not exists pdf_url text;

-- Packaging SKU Map — maps box codes to product SKUs
create table if not exists packaging_sku_map (
  id               uuid primary key default gen_random_uuid(),
  box_code         text not null,
  box_description  text,
  skus             text[],
  notes            text,
  created_at       timestamptz default now()
);

alter table packaging_sku_map enable row level security;
create policy "Allow all for anon" on packaging_sku_map for all using (true) with check (true);
