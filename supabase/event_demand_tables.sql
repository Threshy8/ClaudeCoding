-- Event Demand Reports
-- Run this in the Supabase SQL editor.

CREATE TABLE event_demand_reports (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text        NOT NULL,
  event_start  date        NOT NULL,
  event_end    date        NOT NULL,
  order_count  int,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE event_demand_lines (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id      uuid          NOT NULL REFERENCES event_demand_reports(id) ON DELETE CASCADE,
  product_name   text          NOT NULL,
  sku            text,
  total_qty      int           NOT NULL DEFAULT 0,
  total_revenue  numeric(12,2) NOT NULL DEFAULT 0,
  standard_qty   int           NOT NULL DEFAULT 0,
  express_qty    int           NOT NULL DEFAULT 0,
  location       text,
  created_at     timestamptz   DEFAULT now()
);

CREATE INDEX ON event_demand_lines(report_id);
