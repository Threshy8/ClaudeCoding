-- ============================================================
-- Australia Post Freight Costs
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create table if not exists auspost_freight_costs (
  id              uuid primary key default gen_random_uuid(),
  consignment_id  text not null,
  lodgement_date  date not null,
  shopify_ref     text,              -- CUSTOMER REFDOC from AusPost (SCC reference, not Shopify order ID)
  amount          numeric(12, 2) not null default 0,
  fsc             numeric(12, 2) not null default 0,
  total_cost      numeric(12, 2) not null default 0,
  service_type    text,              -- 'Express Post with Signature' / 'Parcel Post with Signature'
  to_state        text,              -- destination state if available
  synced_at       timestamptz default now(),

  unique (consignment_id)
);

create index if not exists auspost_freight_lodgement_idx on auspost_freight_costs(lodgement_date);
create index if not exists auspost_freight_ref_idx on auspost_freight_costs(shopify_ref);

-- RLS
alter table auspost_freight_costs enable row level security;
create policy "Allow all for anon" on auspost_freight_costs for all using (true) with check (true);
