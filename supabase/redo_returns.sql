-- Redo API returns — captures returns processed by Redo that aren't in Shopify's refund objects
create table if not exists redo_returns (
  id                uuid primary key default gen_random_uuid(),
  redo_return_id    text not null,
  shopify_order_name text not null,
  sku               text not null,
  product_name      text not null default 'Unknown',
  quantity_returned integer not null check (quantity_returned > 0),
  refund_amount     numeric(12, 2) not null default 0,
  return_type       text,
  status            text,
  return_date       date not null,
  updated_at        timestamptz,
  store             text not null default 'au',
  synced_at         timestamptz default now(),

  unique (redo_return_id, sku)
);

create index if not exists redo_returns_date_idx on redo_returns(return_date);
create index if not exists redo_returns_store_idx on redo_returns(store);

alter table redo_returns enable row level security;
create policy "Allow all for anon" on redo_returns for all using (true) with check (true);
