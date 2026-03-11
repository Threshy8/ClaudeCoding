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
  quantity      numeric(10,2),
  unit_rate     numeric(10,4),
  amount_ex_gst numeric(10,2) not null default 0,
  gst           numeric(10,2) not null default 0,
  created_at    timestamptz default now()
);

create index if not exists fulfillment_line_items_invoice_idx  on fulfillment_line_items(invoice_id);
create index if not exists fulfillment_line_items_category_idx on fulfillment_line_items(category);

-- RLS
alter table fulfillment_invoices  enable row level security;
alter table fulfillment_line_items enable row level security;

create policy "Allow all for anon" on fulfillment_invoices  for all using (true) with check (true);
create policy "Allow all for anon" on fulfillment_line_items for all using (true) with check (true);
